import { execFile } from "node:child_process";
import { RpcWorker, type PiCommand, type RpcWorkerOptions } from "./driver.ts";

export const DEFAULT_TURN_TIMEOUT_MS = 60 * 60_000;
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

export function requireNativePlatform(harness: Exclude<Harness, "pi">) {
  if (process.platform === "win32") throw new Error(`${harness} workers require process-group cleanup, which Swarm does not support on Windows.`);
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
  onRecord(record: TranscriptEvent, live?: boolean): void;
  onIdleExit(reason: string): void;
}): WorkerAdapter {
  let started = false;
  let stopping = false;
  let shutdown: Promise<void> | undefined;
  let finish: ((result: TurnResult) => void) | undefined;
  let text = "";
  const worker = new RpcWorker({
    ...options,
    onEvent(event) {
      if (stopping) return;
      switch (event?.type) {
        case "agent_settled":
          finish?.(event.aborted ? { type: "cancelled" } : { type: "completed", text });
          break;
        case "message_end":
          if (event.message?.role === "assistant") {
            text = event.message.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") ?? "";
          }
          options.onRecord(event);
          break;
        case "tool_execution_end":
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
    return shutdown ??= worker.stop();
  };
  return {
    // The coordinator already runs this Pi.
    async preflight() {},
    async deliver(prompt) {
      if (stopping) return { type: "cancelled" };
      text = "";
      const turn = new Promise<TurnResult>((resolve) => { finish = resolve; });
      const resolve = finish!;
      try {
        if (!worker.running) {
          worker.start(started ? ["--continue"] : []);
          started = true;
        }
        void worker.prompt(prompt).then((disposition) => {
          if (disposition === "handled") resolve({ type: "completed", text });
        }, (error: Error) => resolve(failed(/timed out/.test(error.message) ? "timeout" : "exit", error.message)));
        const result = await turn;
        if (result.type === "failed" && worker.running && !stopping) await worker.stop();
        return result;
      } finally {
        finish = undefined;
      }
    },
    stop,
  };
}
