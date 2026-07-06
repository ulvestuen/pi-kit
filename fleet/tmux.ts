/**
 * fleet tmux mirror — live visibility for sub-agent runs.
 *
 * Wraps a SpawnFn so that every labeled child (each sub-agent the runner
 * dispatches) gets its own tmux window streaming a human-readable rendering
 * of the child's output. Execution is untouched: the inner spawn still owns
 * the process, its stdout parsing, timeouts, and kill semantics — tmux is a
 * pure visualization layer, and any tmux failure degrades to running without
 * it.
 *
 * Like the runner, this module never imports pi or node:child_process — the
 * tmux binary invocation and log-file effects are injected, so tests drive
 * it with fakes and host.ts provides the real ones.
 */

import type { SpawnFn, SpawnOutcome, SpawnRequest } from "./runner.ts";

/** One shared session by default, so a single attach shows every agent. */
export const DEFAULT_TMUX_SESSION = "pi-agents";

/** Settings shared by every extension that mirrors sub-agents into tmux. */
export interface TmuxSettings {
  /** Mirror labeled sub-agent spawns into tmux windows. */
  tmux: boolean;
  /** tmux session that collects the agent windows. */
  tmuxSession: string;
  /** Kill each window when its task ends instead of leaving it to inspect. */
  tmuxCloseWindows: boolean;
}

/** Effects the mirror needs; host.ts provides the real implementations. */
export interface TmuxEffects {
  /** Run the tmux binary with the given arguments. Never throws. */
  tmux(args: string[]): Promise<SpawnOutcome>;
  /** Create an empty log file for one labeled run; returns its path. */
  createLogFile(label: string): string;
  /** Append text to a log file. Best-effort; must not throw. */
  appendToLog(path: string, text: string): void;
}

export interface TmuxMirrorOptions {
  /** tmux session that collects the agent windows. */
  sessionName: string;
  /** Kill each window when its task ends. Default false: windows stay. */
  closeWindows?: boolean;
  /** Reported once, on the first tmux failure; mirroring then stops. */
  onError?: (message: string) => void;
}

/** tmux window names: no dots/colons (target syntax) or whitespace. */
export function sanitizeTmuxName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "task";
}

/** Single-quote a string for POSIX shells (the tail command tmux runs). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The command a mirror window runs: follow the log from the beginning. */
export function buildTailCommand(logPath: string): string {
  return `tail -f -n +1 ${shellQuote(logPath)}`;
}

/**
 * Split streamed chunks into complete lines. flush() emits any trailing
 * partial line (a child killed mid-line still shows its last output).
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    flush() {
      if (buffer) {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

/**
 * Render one line of a pi `--mode json` JSONL stream for humans.
 * Returns null to suppress noisy events (streaming deltas and such);
 * non-JSON lines pass through untouched.
 */
export function formatPiEventLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return trimmed;
  let event: any;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }

  if (event?.type === "message_end" && event.message) {
    const parts: string[] = [];
    for (const block of event.message.content ?? []) {
      if (block?.type === "text" && typeof block.text === "string") {
        if (block.text.trim()) parts.push(block.text.trim());
      } else if (
        block?.type === "toolCall" ||
        block?.type === "toolUse" ||
        block?.type === "tool_use"
      ) {
        parts.push(`→ tool: ${block.name ?? block.toolName ?? "(unknown)"}`);
      }
    }
    if (parts.length === 0) return null;
    const role = event.message.role ?? "message";
    return `\n[${role}]\n${parts.join("\n")}`;
  }

  if (
    event?.type === "tool_execution_start" ||
    event?.type === "toolExecutionStart"
  ) {
    return `  … running ${event.toolName ?? event.name ?? "tool"}`;
  }

  return null;
}

/**
 * Wrap a SpawnFn so labeled requests are mirrored into tmux windows.
 *
 * Only requests carrying a `label` are mirrored (the runner labels the pi
 * child, not auxiliary spawns like `git worktree add`). Session and window
 * creation are serialized so concurrent tasks cannot race the initial
 * new-session. The first tmux failure disables mirroring for the rest of
 * the wrapper's lifetime and is reported via onError.
 */
export function createTmuxMirrorSpawn(
  inner: SpawnFn,
  effects: TmuxEffects,
  options: TmuxMirrorOptions,
): SpawnFn {
  let disabled = false;
  let setupChain: Promise<unknown> = Promise.resolve();

  const fail = (message: string) => {
    if (!disabled) {
      disabled = true;
      options.onError?.(message);
    }
  };

  /** Open one window tailing logPath; returns its unique window id. */
  const openWindow = async (
    windowName: string,
    logPath: string,
  ): Promise<string | undefined> => {
    const tail = buildTailCommand(logPath);
    const probe = await effects.tmux(["has-session", "-t", options.sessionName]);
    const create =
      probe.exitCode === 0
        ? ["new-window", "-d", "-t", `${options.sessionName}:`]
        : ["new-session", "-d", "-s", options.sessionName];
    const made = await effects.tmux([
      ...create,
      "-n",
      windowName,
      "-P",
      "-F",
      "#{window_id}",
      tail,
    ]);
    if (made.exitCode !== 0) {
      fail(
        `could not open tmux window "${windowName}": ${made.stderr.trim() || made.stdout.trim() || "unknown error"}`,
      );
      return undefined;
    }
    return made.stdout.trim() || undefined;
  };

  return async (request: SpawnRequest) => {
    if (!request.label || disabled) return inner(request);

    let logPath: string | undefined;
    let windowId: string | undefined;
    const label = request.label;

    // Serialize setup so parallel tasks don't race has-session/new-session.
    const setup = setupChain.then(async () => {
      try {
        logPath = effects.createLogFile(label);
        effects.appendToLog(
          logPath,
          `[fleet] ${label}\n[fleet] cwd: ${request.cwd}\n`,
        );
        windowId = await openWindow(sanitizeTmuxName(label), logPath);
      } catch (e: any) {
        fail(`tmux mirror setup failed: ${e?.message ?? e}`);
        logPath = undefined;
      }
    });
    setupChain = setup;
    await setup;

    const splitter =
      logPath !== undefined
        ? createLineSplitter((line) => {
            const rendered = formatPiEventLine(line);
            if (rendered !== null) effects.appendToLog(logPath!, `${rendered}\n`);
          })
        : null;

    const outcome = await inner(
      splitter
        ? {
            ...request,
            onOutput: (chunk) => {
              request.onOutput?.(chunk);
              splitter.push(chunk);
            },
          }
        : request,
    );

    if (splitter && logPath) {
      splitter.flush();
      effects.appendToLog(
        logPath,
        `\n[fleet] ${label}: exited ${outcome.exitCode === null ? "(killed)" : outcome.exitCode}\n`,
      );
      if (options.closeWindows && windowId) {
        await effects.tmux(["kill-window", "-t", windowId]);
      }
    }
    return outcome;
  };
}
