/**
 * Adapter from the spawn job/backends machinery to fleet's synchronous
 * SpawnFn contract.
 *
 * fleet/orchestrator/critic need a call that waits for a child result, parses
 * JSONL, enforces their own timeouts through AbortSignal, and returns stdout.
 * spawn jobs are backend-managed and normally detached. This adapter launches
 * the labeled pi child as a spawn job, records it in the spawn registry, polls
 * the backend until terminal, streams log deltas, and kills/stamps the job when
 * the runner aborts. Unlabeled helper commands (for example git worktree add)
 * are delegated to the provided fallback SpawnFn.
 */

import type { AgentDefinition } from "../fleet/registry.ts";
import type {
  SpawnFn,
  SpawnOutcome,
  SpawnRequest,
} from "../fleet/runner.ts";
import type { SpawnConfig } from "./config.ts";
import {
  isTerminal,
  loadJobs,
  saveJobs,
  uniqueJobName,
  type SpawnBackend,
  type SpawnBackendName,
  type SpawnJob,
} from "./jobs.ts";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_OUTPUT_MAX_BYTES = Number.POSITIVE_INFINITY;
const ERROR_TAIL_BYTES = 16 * 1024;
const NO_OUTPUT = "(no output yet)";

export interface SpawnToolingSpawnOptions {
  /** Spawn extension configuration shared with the selected backend. */
  config: SpawnConfig;
  /** Backend registry, normally from spawn/host.ts createBackends(). */
  backends: Record<SpawnBackendName, SpawnBackend>;
  /** Backend to use for runner children. Defaults to config.backend. */
  backend?: SpawnBackendName;
  /** Delegate for unlabeled helper commands. */
  fallback?: SpawnFn;
  /** Registry/job-name prefix so internal jobs are recognizable. */
  jobNamePrefix?: string;
  /** Poll cadence while waiting for detached backend completion. */
  pollIntervalMs?: number;
  /** Maximum log bytes to read back into fleet's stdout transcript. */
  outputMaxBytes?: number;
  /**
   * Pid recorded as the launched jobs' owner (SpawnJob.parentPid), so
   * session-start cleanup in *other* pi processes can tell these jobs are
   * not stale while this process lives. Defaults to process.pid.
   */
  parentPid?: number;
  /** Test hooks. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRegistryError?: (message: string) => void;
}

export interface CleanupSpawnToolingJobsOptions {
  config: SpawnConfig;
  backends: Record<SpawnBackendName, SpawnBackend>;
  /** Prefix originally passed as jobNamePrefix. */
  jobNamePrefix: string;
  /** Liveness probe for a job's recorded parentPid. Defaults to a signal-0
   * check on this host. Injectable for tests. */
  isParentAlive?: (pid: number) => boolean;
  now?: () => number;
  onRegistryError?: (message: string) => void;
  onError?: (message: string) => void;
}

/** Whether a pid exists on this host (EPERM still means "exists"). */
function defaultIsParentAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

function pseudoAgent(label: string | undefined): AgentDefinition {
  const name = label?.trim() || "sub-agent";
  return {
    name,
    description: "Internal spawn-tooling runner child.",
    systemPrompt: "",
    source: "(spawn runner adapter)",
  };
}

function taskPreview(request: SpawnRequest): string {
  const args = request.args.join(" ");
  return `${request.command}${args ? ` ${args}` : ""}`;
}

function normalizeOutput(text: string): string {
  return text === NO_OUTPUT ? "" : text;
}

function statusExit(job: SpawnJob): number | null {
  if (job.status === "done") return job.exitCode ?? 0;
  if (job.status === "failed") return job.exitCode ?? 1;
  return null;
}

function statusStderr(job: SpawnJob): string {
  if (job.status === "done") return "";
  const code = job.exitCode === undefined ? "" : ` (exit ${job.exitCode})`;
  return `spawn job ${job.name} ended with status ${job.status}${code}`;
}

/**
 * The stderr reported back to the runner for a finished job: the status
 * line plus the child's captured stderr, so a failed sub-agent explains
 * itself instead of surfacing as a bare exit code.
 */
async function reportStderr(
  backend: SpawnBackend,
  job: SpawnJob,
): Promise<string> {
  const base = statusStderr(job);
  if (job.status === "done") return base;
  let detail = "";
  try {
    detail = (await backend.errorOutput(job, ERROR_TAIL_BYTES)).trim();
  } catch {
    // Best-effort: the status line alone still reports the failure.
  }
  return detail ? `${base}\n${detail}` : base;
}

/**
 * Kill/stamp stale internal synchronous jobs after a parent session restart.
 *
 * "Stale" means the recorded parent process is gone: this runs on every
 * session_start, including inside spawned child pi processes (which load the
 * same extensions) and in concurrently started sessions, so a running job
 * whose parentPid is still alive is someone's live sub-agent — leave it
 * alone. Jobs without a parentPid predate ownership tracking and are
 * treated as stale, matching the old behavior.
 */
export async function cleanupSpawnToolingJobs(
  options: CleanupSpawnToolingJobsOptions,
): Promise<number> {
  const now = options.now ?? Date.now;
  const isParentAlive = options.isParentAlive ?? defaultIsParentAlive;
  const prefix = `${options.jobNamePrefix}-`;
  const jobs = loadJobs(options.config.logDir, options.onRegistryError);
  let cleaned = 0;
  let dirty = false;
  for (const job of jobs) {
    if (job.status !== "running" || !job.name.startsWith(prefix)) continue;
    if (job.parentPid !== undefined && isParentAlive(job.parentPid)) continue;
    const backend = options.backends[job.backend];
    if (!backend) {
      options.onError?.(
        `could not clean stale spawn job ${job.name}: unknown backend ${job.backend}`,
      );
      continue;
    }
    try {
      await backend.kill(job);
    } catch (e: any) {
      options.onError?.(
        `could not kill stale spawn job ${job.name}: ${e?.message ?? e}`,
      );
    }
    job.status = "killed";
    job.updatedAt = now();
    cleaned++;
    dirty = true;
  }
  if (dirty) saveJobs(options.config.logDir, jobs);
  return cleaned;
}

/**
 * Create a fleet-compatible SpawnFn whose labeled pi children run through the
 * spawn backend machinery and whose unlabeled helper commands use fallback.
 */
export function createSpawnToolingSpawn(
  options: SpawnToolingSpawnOptions,
): SpawnFn {
  const backendName = options.backend ?? options.config.backend;
  const backend = options.backends[backendName];
  if (!backend) {
    throw new Error(`Unknown spawn backend "${backendName}"`);
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const outputMaxBytes = options.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
  const parentPid = options.parentPid ?? process.pid;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let registryChain: Promise<unknown> = Promise.resolve();

  async function withJobs<T>(
    fn: (jobs: SpawnJob[]) => Promise<{ result: T; dirty: boolean }> | { result: T; dirty: boolean },
  ): Promise<T> {
    const run = registryChain.then(async () => {
      const jobs = loadJobs(options.config.logDir, options.onRegistryError);
      const { result, dirty } = await fn(jobs);
      if (dirty) saveJobs(options.config.logDir, jobs);
      return result;
    });
    registryChain = run.catch(() => undefined);
    return run;
  }

  async function saveJob(job: SpawnJob): Promise<void> {
    await withJobs((jobs) => {
      const index = jobs.findIndex((candidate) => candidate.name === job.name);
      if (index === -1) jobs.push(job);
      else jobs[index] = job;
      return { result: undefined, dirty: true };
    });
  }

  async function killAndStamp(job: SpawnJob): Promise<void> {
    if (isTerminal(job.status)) return;
    try {
      await backend.kill(job);
    } finally {
      job.status = "killed";
      job.updatedAt = now();
      await saveJob(job);
    }
  }

  return async (request: SpawnRequest): Promise<SpawnOutcome> => {
    // The fleet runner labels only the pi sub-agent child. Auxiliary commands
    // such as git worktree setup must remain ordinary helper processes.
    if (!request.label) {
      if (!options.fallback) {
        throw new Error(
          `spawn tooling received unlabeled helper command without a fallback: ${request.command}`,
        );
      }
      return options.fallback(request);
    }

    if (request.signal.aborted) {
      return { exitCode: null, stdout: "", stderr: "spawn job aborted before launch" };
    }

    const unavailable = await backend.available();
    if (unavailable) {
      throw new Error(`Backend "${backendName}" is not usable here: ${unavailable}`);
    }

    const job = await withJobs(async (jobs) => {
      const jobName = uniqueJobName(
        `${options.jobNamePrefix ?? "runner"}-${request.label}`,
        (candidate) => jobs.some((existing) => existing.name === candidate),
        now(),
      );
      const launched = await backend.launch({
        jobName,
        agent: pseudoAgent(request.label),
        task: taskPreview(request),
        cwd: request.cwd,
        command: request.command,
        args: request.args,
      });
      launched.parentPid = parentPid;
      jobs.push(launched);
      return { result: launched, dirty: true };
    });

    let stdout = "";
    let streamed = "";

    const streamOutput = async () => {
      const latest = normalizeOutput(await backend.output(job, outputMaxBytes));
      stdout = latest;
      if (latest.length > streamed.length && latest.startsWith(streamed)) {
        const delta = latest.slice(streamed.length);
        streamed = latest;
        request.onOutput?.(delta);
      } else if (latest !== streamed) {
        streamed = latest;
        // If a backend returns a truncated/non-prefix tail, emit the available
        // chunk rather than silently hiding progress.
        request.onOutput?.(latest);
      }
    };

    const onAbort = () => {
      // Wake-up is bounded by pollIntervalMs; actual kill is awaited in-loop so
      // the returned outcome and registry state are consistent.
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      for (;;) {
        if (request.signal.aborted) {
          await killAndStamp(job);
          await streamOutput();
          return {
            exitCode: null,
            stdout,
            stderr: await reportStderr(backend, job),
          };
        }

        const changed = await backend.refresh(job);
        if (changed) await saveJob(job);
        await streamOutput();

        if (isTerminal(job.status)) {
          await saveJob(job);
          return {
            exitCode: statusExit(job),
            stdout,
            stderr: await reportStderr(backend, job),
          };
        }

        await sleep(pollIntervalMs);
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
  };
}
