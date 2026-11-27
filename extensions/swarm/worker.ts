import { execFile } from "node:child_process";
import { RpcWorker, type PiCommand, type RpcWorkerOptions } from "./driver.ts";

export const DEFAULT_TURN_TIMEOUT_MS = 60 * 60_000;
export const PI_WRITE_DENIED = "Swarm permission denied: only regular task files and directories inside the assigned workspace are writable.";
export const HARNESSES = ["pi", "claude", "codex", "agy"] as const;
export type Harness = (typeof HARNESSES)[number];
export type Failure = "missing-binary" | "unsupported-cli" | "auth" | "permission" | "timeout" | "lost-session" | "protocol" | "exit";
export type TurnResult =
  | { type: "completed"; text: string }
  | { type: "cancelled" }
  | { type: "failed"; failure: Failure; reason: string };

export interface WorkerAdapter {
  preflight(): Promise<void>;
  deliver(text: string): Promise<TurnResult>;
  stop(): Promise<void>;
}

export type TranscriptEvent = { type: string; [key: string]: unknown };

export function failed(failure: Failure, reason: string): TurnResult & { type: "failed" } {
  return { type: "failed", failure, reason };
}

export function requireNativeOptIn(harness: Exclude<Harness, "pi">, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") throw new Error(`${harness} workers require process-group cleanup, which Swarm does not support on Windows.`);
  if (env.SWARM_TRUST_NATIVE_CONFIG !== "1") throw new Error(`${harness} is disabled. Set SWARM_TRUST_NATIVE_CONFIG=1 before starting Pi only if you trust the checkout, native configuration, and startup hooks.`);
}

export async function probe(cli: PiCommand, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return new Promise<{ ok: boolean; output: string; code?: string | number | null; killed?: boolean }>((resolve) => {
    const child = execFile(cli.command, [...cli.args, ...args], { cwd, env, timeout: 8_000, killSignal: "SIGKILL", windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: stdout + "\n" + stderr, code: error?.code, killed: error?.killed });
    });
    child.stdin?.end();
  });
}

/** Keep Pi's persistent RPC child, including its private --continue after a crash. */
export function piWorker(options: Omit<RpcWorkerOptions, "onEvent" | "onExit"> & {
  managedTimeoutMs?: number;
  onRecord(record: TranscriptEvent, live?: boolean): void;
  onIdleExit(reason: string): void;
}): WorkerAdapter {
  const { managedTimeoutMs } = options;
  const managed = managedTimeoutMs !== undefined;
  let started = false;
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  let finish: ((result: TurnResult) => void) | undefined;
  let text = "";
  let stopReason: string | undefined;
  let writeDenied = false;
  const worker = new RpcWorker({
    ...options,
    onEvent(event) {
      if (stopping || (managed && !finish)) return;
      switch (event?.type) {
        case "agent_settled":
          // Pi settles after retries and even after a provider error. Only the final assistant outcome counts.
          finish?.(event.aborted || (managed && stopReason === "aborted") ? { type: "cancelled" }
            : managed && writeDenied ? failed("permission", PI_WRITE_DENIED)
            : managed && stopReason !== "stop" ? failed("exit", "Pi did not produce a successful final assistant message.")
            : { type: "completed", text });
          break;
        case "message_end":
          if (event.message?.role === "assistant") {
            stopReason = event.message.stopReason;
            text = event.message.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") ?? "";
          }
          options.onRecord(event);
          break;
        case "tool_execution_end":
          if (managed && event.isError && ["task_edit", "task_write"].includes(event.toolName)
              && event.result?.content?.some((part: any) => part.type === "text" && part.text.includes(PI_WRITE_DENIED))) writeDenied = true;
          options.onRecord(event);
          break;
        case "agent_start":
        case "tool_execution_start":
        case "auto_retry_start":
        case "auto_retry_end":
        case "compaction_end":
        case "extension_error":
          options.onRecord(event);
          break;
        case "message_update": {
          const e = event.assistantMessageEvent;
          if (e?.type === "text_delta" || e?.type === "thinking_delta") options.onRecord({ type: "delta", kind: e.type, delta: e.delta }, true);
          break;
        }
      }
    },
    onExit({ code, signal, expected, stderr }) {
      if (expected || stopping) return;
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      const reason = `exit ${signal ?? code}${tail ? `: ${tail}` : ""}`;
      if (finish) finish(failed("exit", reason));
      else options.onIdleExit(reason);
    },
  });
  const stop = () => {
    stopping = true;
    finish?.({ type: "cancelled" });
    return shutdown ??= worker.stop(managed ? 350 : undefined);
  };
  return {
    // The coordinator already runs this Pi; explicit model selections are checked at setup.
    async preflight() {},
    async deliver(prompt) {
      if (stopping) return { type: "cancelled" };
      text = "";
      stopReason = undefined;
      writeDenied = false;
      const turn = new Promise<TurnResult>((resolve) => { finish = resolve; });
      const resolve = finish!;
      const timer = managed ? setTimeout(() => resolve(failed("timeout", `Pi turn exceeded ${Math.ceil(managedTimeoutMs / 1000)}s; it was not replayed.`)), managedTimeoutMs) : undefined;
      try {
        if (!worker.running) {
          worker.start(started && !managed ? ["--continue"] : []);
          started = true;
        }
        void worker.prompt(prompt).then((disposition) => {
          if (disposition === "handled") resolve(managed ? failed("protocol", "Pi handled the workflow prompt without running a turn.") : { type: "completed", text });
        }, (error: Error) => resolve(failed(/timed out/.test(error.message) ? "timeout" : "exit", error.message)));
        const result = await turn;
        if (result.type === "failed") {
          if (managed) await stop();
          else if (worker.running && !stopping) await worker.stop();
        }
        return result;
      } finally {
        clearTimeout(timer);
        finish = undefined;
      }
    },
    stop,
  };
}
