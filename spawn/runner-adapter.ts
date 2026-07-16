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
import type { KillResult } from "@pi-kit/agent-types";

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
  /** Hard deadline in ms. When the poll loop exceeds this, the job is killed
   * and the outcome reports as timed out. Omit for no hard deadline.
   */
  deadlineMs?: number;
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
      const kr = await backend.kill(job);
      // KillResult branch 1 — stopped: backend confirmed the process is
      // no longer running.  Stamp killed immediately.
      if (kr.stopped) {
        job.status = "killed";
        job.updatedAt = now();
        dirty = true;
        cleaned++;
      // KillResult branch 2 — alreadyComplete: backend says the process
      // already exited before the kill.  Refresh from done marker to
      // discover the real terminal status (done/failed).
      } else if (kr.alreadyComplete) {
        try {
          await backend.refresh(job);
        } catch {
          // Best-effort.
        }
        if (!isTerminal(job.status)) {
          // Backend confirmed completion but refresh could not resolve
          // the status; mark lost so it does not stay "running" forever.
          job.status = "lost";
        }
        job.updatedAt = now();
        dirty = true;
        cleaned++;
      // KillResult branch 3 — warned / unconfirmed: kill signal sent but
      // backend cannot confirm the process stopped.  Refresh from done
      // markers; mark lost if still nonterminal.
      } else {
        try {
          await backend.refresh(job);
        } catch {
          // Best-effort.
        }
        if (!isTerminal(job.status)) {
          job.status = "lost";
        }
        job.updatedAt = now();
        dirty = true;
        cleaned++;
        options.onError?.(
          `could not kill stale spawn job ${job.name}: ${kr.message ?? "unknown"}`,
        );
      }
    } catch (e: any) {
      // Kill threw — equivalent to branch 3 (warned/unconfirmed).
      // Mark lost so the job does not stay "running" forever.
      if (!isTerminal(job.status)) {
        job.status = "lost";
      }
      job.updatedAt = now();
      dirty = true;
      cleaned++;
      options.onError?.(
        `could not kill stale spawn job ${job.name}: ${e?.message ?? e}`,
      );
    }
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
  const deadlineMs = options.deadlineMs;
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

  /**
   * Send the kill command via the backend and stamp the registry.
   *
   * ADR §6/§9 define three exhaustive branches after backend.kill():
   *
   *  1. **stopped** (KillResult.stopped === true)
   *     The backend confirmed the process is no longer running.
   *     → Stamp "killed" immediately. No done-marker probe needed.
   *
   *  2. **alreadyComplete** (KillResult.alreadyComplete === true, stopped false)
   *     The backend says the process already exited before the kill.
   *     → Refresh from the done marker to discover the real terminal
   *       status (done/failed). If the marker is missing or corrupt
   *       (refresh cannot resolve), stamp "lost" so the job never
   *       stays "running" forever.
   *
   *  3. **warned / unconfirmed** (both stopped and alreadyComplete false)
   *     The kill signal was sent but the backend cannot confirm the
   *     process stopped — it may still be running ("nonterminal") or
   *     it may have exited during the race ("terminal" after refresh).
   *     → Refresh from done markers. If still nonterminal, stamp "lost"
   *       to prevent the job from staying "running" forever. If the
   *       refresh resolves to a terminal status, use that.
   *
   * A thrown exception from backend.kill() is caught and converted to a
   * warned/unconfirmed KillResult (stopped=false, no alreadyComplete),
   * following the same path as branch 3.
   */
  async function killAndStamp(job: SpawnJob): Promise<KillResult> {
    // Terminal jobs need no kill; treat as alreadyComplete.
    if (isTerminal(job.status)) {
      return { stopped: false, alreadyComplete: true };
    }
    let result: KillResult;
    try {
      result = await backend.kill(job);
    } catch (e: any) {
      // KillResult branch 3 entry: convert thrown error to warned/unconfirmed.
      result = { stopped: false, message: e?.message ?? String(e) };
    }
    if (result.alreadyComplete && !result.stopped) {
      // KillResult branch 2 — alreadyComplete: refresh from done marker to discover
      // the real terminal status (done/failed).  If the marker cannot
      // resolve, stamp lost so the job never stays "running".
      try {
        await backend.refresh(job);
      } catch {
        // Best-effort; the backend already confirmed completion.
      }
      if (!isTerminal(job.status)) {
        // Backend confirmed completion but refresh could not resolve the
        // status (missing/corrupt marker); mark lost.
        job.status = "lost";
      }
      job.updatedAt = now();
      await saveJob(job);
      return result;
    }
    if (result.stopped) {
      // KillResult branch 1 — stopped: backend confirms the process is gone.
      // Stamp killed immediately per ADR §6/§9.
      job.status = "killed";
      job.updatedAt = now();
      await saveJob(job);
      return result;
    }
    // KillResult branch 3 — warned / unconfirmed: backend could not confirm stop
    // and the job is not already complete.  The process may still be
    // running (nonterminal) or may have exited during the race (terminal
    // after refresh).  Refresh from done markers; if still nonterminal,
    // stamp "lost" so the job does not stay "running" forever.
    try {
      await backend.refresh(job);
    } catch {
      // Best-effort.
    }
    if (!isTerminal(job.status)) {
      job.status = "lost";
    }
    job.updatedAt = now();
    await saveJob(job);
    return result;
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
        compactJsonEvents: true,
      });
      launched.parentPid = parentPid;
      jobs.push(launched);
      return { result: launched, dirty: true };
    });

    let stdout = "";
    let streamed = "";
    const startedAt = now();

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
        if (request.signal.aborted || (deadlineMs !== undefined && now() - startedAt >= deadlineMs)) {
          await killAndStamp(job);
          await streamOutput();
          const deadlineReason = request.signal.aborted
            ? "spawn job aborted"
            : `spawn job exceeded hard deadline of ${deadlineMs} ms`;
          return {
            exitCode: null,
            stdout,
            stderr: `${deadlineReason}\n${await reportStderr(backend, job)}`,
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
