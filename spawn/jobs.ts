/**
 * spawn job model — detached sub-agent jobs and their persistent registry.
 *
 * A job is one `pi` sub-agent run launched *detached* on a backend (a tmux
 * window, an exe.dev cloud VM, or a microsandbox microVM). Unlike fleet
 * tasks, jobs outlive the tool call — and the pi session — that started
 * them, so their state lives in two places the parent process does not own:
 *
 *  - a **done marker**: a file the job's run script writes its exit code to
 *    when the pi child finishes (locally for tmux/microsandbox, on the VM
 *    for exe.dev), and
 *  - a **job registry**: a JSON file under the spawn log directory that
 *    records every launched job so any later session can find it again.
 *
 * Status is always *derived*: done marker present → done/failed by exit
 * code; no marker but the runner is alive → running; no marker and no
 * runner → lost. Only "killed" is stamped directly, by spawn_kill.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentDefinition } from "../fleet/registry.ts";

export type SpawnBackendName = "tmux" | "exedev" | "microsandbox";

export const SPAWN_BACKEND_NAMES: SpawnBackendName[] = [
  "tmux",
  "exedev",
  "microsandbox",
];

export type SpawnJobStatus =
  | "running"
  | "done"
  | "failed"
  | "killed"
  | "lost";

/** One detached sub-agent job. */
export interface SpawnJob {
  /** Unique job name; also the job's directory name under logDir. */
  name: string;
  backend: SpawnBackendName;
  /** Agent registry name the job runs under. */
  agent: string;
  /** The task brief handed to the pi child. */
  task: string;
  /** Working directory the job was launched from. */
  cwd: string;
  status: SpawnJobStatus;
  exitCode?: number;
  createdAt: number;
  updatedAt: number;
  /** Local log file (tmux and microsandbox backends). */
  logPath?: string;
  /** Local done marker (tmux and microsandbox backends). */
  donePath?: string;
  /** Local stderr file (tmux and microsandbox backends). */
  errPath?: string;
  /** tmux window id (e.g. "@42") holding the job (tmux backend). */
  tmuxWindowId?: string;
  /** Host pid of the detached `msb run` process (microsandbox backend). */
  hostPid?: number;
  /** microsandbox sandbox name (microsandbox backend). */
  sandboxName?: string;
  /** exe.dev VM name (exedev backend). */
  vmName?: string;
  /** SSH destination of the VM, e.g. "pi-spawn.exe.xyz" (exedev backend). */
  sshDest?: string;
  /** Job directory on the VM, relative to $HOME (exedev backend). */
  remoteDir?: string;
}

/** Statuses that never change again; refresh skips jobs in these. */
export function isTerminal(status: SpawnJobStatus): boolean {
  return status !== "running";
}

/**
 * Derive a job's status from its done marker and a runner-aliveness probe.
 * The probe is only meaningful when no marker exists yet; callers pass
 * alive=false alongside a marker (see refreshFromLocalMarkers).
 */
export function resolveStatus(
  doneContent: string | undefined,
  alive: boolean,
): { status: SpawnJobStatus; exitCode?: number } {
  if (doneContent !== undefined) {
    const parsed = Number.parseInt(doneContent.trim(), 10);
    const exitCode = Number.isNaN(parsed) ? undefined : parsed;
    return { status: exitCode === 0 ? "done" : "failed", exitCode };
  }
  return alive ? { status: "running" } : { status: "lost" };
}

/** Job names double as directory, tmux window, and sandbox names. */
export function sanitizeJobName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "job";
}

/**
 * Derive a unique job name: the requested (or agent-derived) base plus a
 * timestamp suffix, with a counter appended on the rare collision.
 */
export function uniqueJobName(
  base: string,
  taken: (name: string) => boolean,
  now: number,
): string {
  const root = `${sanitizeJobName(base)}-${now.toString(36)}`;
  if (!taken(root)) return root;
  for (let i = 2; ; i++) {
    const candidate = `${root}-${i}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Outcome of one short-lived helper process (tmux, ssh, msb). */
export interface ExecOutcome {
  /** Process exit code; null when it could not run or was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Text piped to the child's stdin (used to ship run scripts over ssh). */
  stdin?: string;
  /** Kill the child after this long; the outcome then has exitCode null. */
  timeoutMs?: number;
}

/** Run a helper process to completion. Never throws. */
export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecOutcome>;

/** Effects for backends that keep a detached runner process on this host. */
export interface DetachEffects {
  /** Start a fully detached process; returns its pid. Throws on failure. */
  spawnDetached(command: string, args: string[]): number;
  /** Whether a pid still exists. */
  isPidAlive(pid: number): boolean;
  /** Best-effort SIGTERM of a detached process (group). Never throws. */
  killDetached(pid: number): void;
}

/** What a backend needs to launch one job. */
export interface LaunchRequest {
  jobName: string;
  agent: AgentDefinition;
  task: string;
  cwd: string;
  /**
   * Optional prebuilt command for internal synchronous runner jobs.
   * When omitted, backends build the normal spawn_agent `pi -p` invocation
   * from agent + task.
   */
  command?: string;
  args?: string[];
}

/**
 * One spawn backend: a place detached sub-agent jobs run.
 *
 * launch() starts the job and returns its initial record; refresh() updates
 * status/exitCode from the backend's markers and returns whether anything
 * changed (callers skip terminal jobs); output() reads a log tail;
 * errorOutput() reads the job's captured stderr ("" when there is none);
 * kill() best-effort stops the runner — the caller stamps status "killed".
 */
export interface SpawnBackend {
  readonly name: SpawnBackendName;
  /** Undefined when usable; otherwise a human-readable reason it is not. */
  available(): Promise<string | undefined>;
  launch(request: LaunchRequest): Promise<SpawnJob>;
  refresh(job: SpawnJob): Promise<boolean>;
  output(job: SpawnJob, maxBytes: number): Promise<string>;
  errorOutput(job: SpawnJob, maxBytes: number): Promise<string>;
  kill(job: SpawnJob): Promise<void>;
}

const REGISTRY_VERSION = 1;

interface RegistryFile {
  version: number;
  jobs: SpawnJob[];
}

/** Path of the persistent job registry inside the spawn log directory. */
export function registryPath(logDir: string): string {
  return path.join(logDir, "jobs.json");
}

/**
 * Load the job registry. A missing file is an empty registry; a corrupt
 * one is reported through onError and treated as empty rather than
 * wedging every spawn tool.
 */
export function loadJobs(
  logDir: string,
  onError?: (message: string) => void,
): SpawnJob[] {
  let raw: string;
  try {
    raw = readFileSync(registryPath(logDir), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!parsed || !Array.isArray(parsed.jobs)) {
      throw new Error("not a job registry");
    }
    return parsed.jobs;
  } catch (e: any) {
    onError?.(
      `unreadable job registry ${registryPath(logDir)} (${e?.message ?? e}); starting empty`,
    );
    return [];
  }
}

/** Persist the registry atomically (write a sibling temp file, rename). */
export function saveJobs(logDir: string, jobs: SpawnJob[]): void {
  mkdirSync(logDir, { recursive: true });
  const file = registryPath(logDir);
  const tmp = `${file}.tmp`;
  const data: RegistryFile = { version: REGISTRY_VERSION, jobs };
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}
