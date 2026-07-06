/**
 * fleet runner — pure task-execution engine with injected effects.
 *
 * Owns process lifecycle, concurrency, timeouts, output handling, and
 * isolation. It never imports pi or node:child_process — a spawn function is
 * injected — so tests can drive it with fakes and other extensions can reuse
 * it in any context.
 */

import { getAgent, type AgentDefinition } from "./registry.ts";

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_BATCH = 8;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_OUTPUT_CAP_BYTES = 50 * 1024;
export const DEFAULT_PI_BINARY = "pi";

/** One sub-agent task to run. */
export interface TaskSpec {
  /** Registry name of the agent definition to run under. */
  agent: string;
  /** The prompt/task text handed to the child agent. */
  task: string;
  /** Working directory; defaults to the runner's cwd. */
  cwd?: string;
  /** Working-tree isolation. Default "none". */
  isolation?: "none" | "worktree";
  /** Per-task timeout; defaults to the runner's defaultTimeoutMs. */
  timeoutMs?: number;
}

export type TaskStatus = "ok" | "error" | "timeout" | "aborted";

export interface TaskResult {
  agent: string;
  status: TaskStatus;
  /** Final assistant message (model-visible, capped at outputCapBytes). */
  output: string;
  /** Where the untruncated transcript landed, when a saver was provided. */
  fullOutputPath?: string;
  truncated: boolean;
  durationMs: number;
  exitCode?: number;
  /** Task branch, when the task ran with worktree isolation. */
  branch?: string;
  /** Worktree path, when the task ran with worktree isolation. */
  worktreePath?: string;
}

export type RunnerEvent =
  | { type: "task_start"; index: number; agent: string; task: string }
  | { type: "task_update"; index: number; agent: string; chunk: string }
  | { type: "task_end"; index: number; agent: string; result: TaskResult };

/** Request handed to the injected spawn function. */
export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  /** Abort to kill the child (SIGTERM, then SIGKILL after a grace period). */
  signal: AbortSignal;
  /** Streaming stdout chunks, for progress reporting. */
  onOutput?: (chunk: string) => void;
  /**
   * Human-readable identity of a sub-agent child, e.g. "1-implementer".
   * Set only for the pi child itself (not auxiliary spawns like git), so
   * spawn wrappers can attach per-agent visibility such as tmux windows.
   */
  label?: string;
}

export interface SpawnOutcome {
  /** Process exit code; null when killed by a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnOutcome>;

export interface RunnerOptions {
  /** Injected process spawner. */
  spawn: SpawnFn;
  /** Base working directory for tasks that do not set their own. */
  cwd: string;
  /** The pi binary to invoke. Default "pi". */
  piBinary?: string;
  /** Concurrency pool size. Default 4. */
  maxConcurrent?: number;
  /** Maximum tasks per batch. Default 8. */
  maxBatch?: number;
  /** Default per-task timeout. Default 10 minutes. */
  defaultTimeoutMs?: number;
  /** Cap on model-visible output per task. Default 50 KB. */
  outputCapBytes?: number;
  /** External abort (wire to ctx.signal). */
  signal?: AbortSignal;
  /** Progress events: task_start / task_update / task_end. */
  onEvent?: (e: RunnerEvent) => void;
  /**
   * Persist a task's full transcript; returns the path recorded in
   * TaskResult.fullOutputPath. Omit to skip persisting transcripts.
   */
  saveFullOutput?: (
    index: number,
    spec: TaskSpec,
    content: string,
  ) => Promise<string> | string;
  /**
   * Directory under which worktrees are created. Required for tasks with
   * isolation: "worktree".
   */
  worktreeRoot?: string;
  /** Timestamp source, injectable for tests. */
  now?: () => number;
}

/** Build the pi CLI argument list for one child invocation.
 *
 * The child-process contract with pi's non-interactive mode is pinned here:
 * `--mode json` selects single-shot print mode with a JSONL event stream,
 * `--no-session` keeps children out of the session directory, and the agent
 * definition supplies system prompt, model, thinking level, and tools.
 */
export function buildPiArgs(def: AgentDefinition, spec: TaskSpec): string[] {
  const args = ["--mode", "json", "--no-session"];
  args.push("--system-prompt", def.systemPrompt);
  if (def.model) args.push("--model", def.model);
  if (def.thinkingLevel) args.push("--thinking", def.thinkingLevel);
  if (def.tools && def.tools.length > 0) {
    args.push("--tools", def.tools.join(","));
  }
  args.push(spec.task);
  return args;
}

/** git arguments that create a task worktree on a new branch. */
export function buildWorktreeArgs(branch: string, path: string): string[] {
  return ["worktree", "add", "-b", branch, path];
}

/** Derive a unique branch name / worktree directory name for a task. */
export function worktreeBranchName(index: number, startedAt: number): string {
  return `fleet/task-${index + 1}-${startedAt}`;
}

export interface ParsedPiOutput {
  /** Text of the final assistant message. */
  text: string;
  /** Error message when the run ended in an error/aborted stop reason. */
  errorMessage?: string;
}

/**
 * Extract the final assistant message from a pi `--mode json` JSONL stream.
 * Tolerant of non-JSON lines; the last assistant `message_end` event wins.
 */
export function parsePiJsonOutput(stdout: string): ParsedPiOutput {
  let lastAssistant: any = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      lastAssistant = event.message;
    }
  }

  if (!lastAssistant) {
    return { text: "", errorMessage: "no assistant message in child output" };
  }

  if (
    lastAssistant.stopReason === "error" ||
    lastAssistant.stopReason === "aborted"
  ) {
    return {
      text: "",
      errorMessage:
        lastAssistant.errorMessage || `child ${lastAssistant.stopReason}`,
    };
  }

  const text = (lastAssistant.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  return { text };
}

/** Cap a string at a byte budget (UTF-8), marking whether it was cut. */
export function capOutput(
  text: string,
  capBytes: number,
): { output: string; truncated: boolean } {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (code > 0xffff) i++;
    if (bytes > capBytes) {
      return {
        output: `${text.slice(0, i)}\n[... output truncated at ${capBytes} bytes ...]`,
        truncated: true,
      };
    }
  }
  return { output: text, truncated: false };
}

interface ResolvedOptions {
  spawn: SpawnFn;
  cwd: string;
  piBinary: string;
  maxConcurrent: number;
  maxBatch: number;
  defaultTimeoutMs: number;
  outputCapBytes: number;
  signal?: AbortSignal;
  onEvent?: (e: RunnerEvent) => void;
  saveFullOutput?: RunnerOptions["saveFullOutput"];
  worktreeRoot?: string;
  now: () => number;
}

function resolveOptions(options: RunnerOptions): ResolvedOptions {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`maxConcurrent must be at least 1 (got: ${maxConcurrent})`);
  }
  if (!Number.isFinite(maxBatch) || maxBatch < 1) {
    throw new Error(`maxBatch must be at least 1 (got: ${maxBatch})`);
  }
  if (!options.cwd) {
    throw new Error("runner cwd is required");
  }
  return {
    spawn: options.spawn,
    cwd: options.cwd,
    piBinary: options.piBinary ?? DEFAULT_PI_BINARY,
    maxConcurrent: Math.floor(maxConcurrent),
    maxBatch: Math.floor(maxBatch),
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputCapBytes: options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
    signal: options.signal,
    onEvent: options.onEvent,
    saveFullOutput: options.saveFullOutput,
    worktreeRoot: options.worktreeRoot,
    now: options.now ?? Date.now,
  };
}

function validateTasks(
  registry: Map<string, AgentDefinition>,
  tasks: TaskSpec[],
  opts: ResolvedOptions,
): void {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("At least one task is required");
  }
  if (tasks.length > opts.maxBatch) {
    throw new Error(
      `Batch of ${tasks.length} tasks exceeds the maximum of ${opts.maxBatch}; split it into smaller batches`,
    );
  }
  const known = [...registry.values()].map((d) => d.name).sort();
  for (const spec of tasks) {
    if (!spec.task || !spec.task.trim()) {
      throw new Error("Every task needs non-empty task text");
    }
    if (!getAgent(registry, spec.agent)) {
      throw new Error(
        `Unknown agent "${spec.agent}". Known agents: ${known.join(", ") || "(none)"}`,
      );
    }
    if (spec.isolation === "worktree" && !opts.worktreeRoot) {
      throw new Error(
        'isolation "worktree" requires a worktreeRoot in runner options',
      );
    }
  }
}

async function runOneTask(
  registry: Map<string, AgentDefinition>,
  spec: TaskSpec,
  index: number,
  opts: ResolvedOptions,
): Promise<TaskResult> {
  const def = getAgent(registry, spec.agent)!;
  const startedAt = opts.now();
  opts.onEvent?.({
    type: "task_start",
    index,
    agent: def.name,
    task: spec.task,
  });

  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = spec.timeoutMs ?? opts.defaultTimeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const finish = async (
    partial: Omit<TaskResult, "agent" | "durationMs">,
    transcript?: string,
  ): Promise<TaskResult> => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    const result: TaskResult = {
      agent: def.name,
      durationMs: opts.now() - startedAt,
      ...partial,
    };
    if (transcript && opts.saveFullOutput) {
      try {
        result.fullOutputPath = await opts.saveFullOutput(
          index,
          spec,
          transcript,
        );
      } catch {
        // Transcript persistence is best-effort; the result stands without it.
      }
    }
    opts.onEvent?.({ type: "task_end", index, agent: def.name, result });
    return result;
  };

  try {
    let cwd = spec.cwd ?? opts.cwd;
    let branch: string | undefined;
    let worktreePath: string | undefined;

    if (spec.isolation === "worktree") {
      branch = worktreeBranchName(index, startedAt);
      worktreePath = `${opts.worktreeRoot}/${branch.replace(/\//g, "-")}`;
      const wt = await opts.spawn({
        command: "git",
        args: buildWorktreeArgs(branch, worktreePath),
        cwd,
        signal: controller.signal,
      });
      if (wt.exitCode !== 0) {
        return finish({
          status: controller.signal.aborted
            ? timedOut
              ? "timeout"
              : "aborted"
            : "error",
          output: `git worktree add failed: ${wt.stderr.trim() || wt.stdout.trim()}`,
          truncated: false,
          exitCode: wt.exitCode ?? undefined,
        });
      }
      cwd = worktreePath;
    }

    const outcome = await opts.spawn({
      command: opts.piBinary,
      args: buildPiArgs(def, spec),
      cwd,
      signal: controller.signal,
      label: `${index + 1}-${def.name}`,
      onOutput: (chunk) =>
        opts.onEvent?.({ type: "task_update", index, agent: def.name, chunk }),
    });

    if (controller.signal.aborted) {
      return finish(
        {
          status: timedOut ? "timeout" : "aborted",
          output: timedOut
            ? `task timed out after ${timeoutMs} ms`
            : "task aborted",
          truncated: false,
          exitCode: outcome.exitCode ?? undefined,
          branch,
          worktreePath,
        },
        outcome.stdout,
      );
    }

    const parsed = parsePiJsonOutput(outcome.stdout);
    if (outcome.exitCode !== 0 || parsed.errorMessage) {
      const detail =
        parsed.errorMessage || outcome.stderr.trim() || "child process failed";
      return finish(
        {
          status: "error",
          output: `child failed (exit ${outcome.exitCode}): ${detail}`,
          truncated: false,
          exitCode: outcome.exitCode ?? undefined,
          branch,
          worktreePath,
        },
        outcome.stdout,
      );
    }

    const { output, truncated } = capOutput(parsed.text, opts.outputCapBytes);
    return finish(
      {
        status: "ok",
        output,
        truncated,
        exitCode: 0,
        branch,
        worktreePath,
      },
      outcome.stdout,
    );
  } catch (e: any) {
    if (controller.signal.aborted) {
      return finish({
        status: timedOut ? "timeout" : "aborted",
        output: timedOut
          ? `task timed out after ${timeoutMs} ms`
          : "task aborted",
        truncated: false,
      });
    }
    return finish({
      status: "error",
      output: `spawn failed: ${e?.message ?? e}`,
      truncated: false,
    });
  }
}

function abortedResult(
  spec: TaskSpec,
  index: number,
  opts: ResolvedOptions,
): TaskResult {
  const result: TaskResult = {
    agent: spec.agent,
    status: "aborted",
    output: "task aborted before start",
    truncated: false,
    durationMs: 0,
  };
  opts.onEvent?.({ type: "task_end", index, agent: spec.agent, result });
  return result;
}

/**
 * Run a batch of tasks through a FIFO concurrency pool.
 *
 * Results are returned in task order. An external abort marks queued tasks
 * "aborted" immediately and cancels running children via their spawn signal.
 */
export async function runTasks(
  registry: Map<string, AgentDefinition>,
  tasks: TaskSpec[],
  options: RunnerOptions,
): Promise<TaskResult[]> {
  const opts = resolveOptions(options);
  validateTasks(registry, tasks, opts);

  const results: TaskResult[] = new Array(tasks.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      const spec = tasks[index];
      if (opts.signal?.aborted) {
        results[index] = abortedResult(spec, index, opts);
        continue;
      }
      results[index] = await runOneTask(registry, spec, index, opts);
    }
  };

  const workers = Array.from(
    { length: Math.min(opts.maxConcurrent, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
