import { spawn } from "node:child_process";
import { LineSplitter, type PiCommand } from "./driver.ts";
import type { PairSandbox } from "./pair-sandbox.ts";
import { DEFAULT_TURN_TIMEOUT_MS, failed, probe, requireNativeOptIn, type TranscriptEvent, type TurnResult, type WorkerAdapter } from "./worker.ts";

export type ApprovalChoice = "allow" | "deny";
export type ApprovalDetails = { title: string; details: string; canAllow: boolean };

interface Options {
  cli: PiCommand;
  cwd: string;
  preflightCwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  effort?: string;
  sandbox?: PairSandbox;
  rules: string;
  boardUrl: string;
  boardToken: string;
  timeoutMs?: number;
  onRecord(record: TranscriptEvent): void;
  revokeBoard(): void;
  approve(details: ApprovalDetails, decide: (choice: ApprovalChoice) => void): () => void;
}

const args = ["acp", "--disable-telemetry", "--process-per-session"];
const cancelled = { type: "cancelled" } as const;
const protocol = () => failed("protocol", "agy sent an unexpected ACP message.");
const acpCancelled = { outcome: { outcome: "cancelled" } };

export function antigravityWorker(options: Options): WorkerAdapter {
  const { cli, cwd, env, model, effort, onRecord, sandbox } = options;
  let sessionId: string | undefined;
  let stopped = false;
  let active: { stop(): void; done: Promise<TurnResult> } | undefined;

  return {
    async preflight() {
      requireNativeOptIn("agy", env);
      const help = sandbox ? await sandbox.preflight(["acp", "--help"]) : await probe(cli, ["acp", "--help"], options.preflightCwd, env);
      if (help.code === "ENOENT") throw new Error("agy [missing-binary]: put Antigravity CLI on PATH or set SWARM_AGY_BIN.");
      if (!help.ok || !help.output.includes("--process-per-session")) throw new Error("agy [unsupported-cli]: this Antigravity CLI does not expose the required ACP interface. Check `agy acp --help`.");
    },
    async deliver(prompt) {
      if (stopped) return cancelled;
      const previous = sessionId;
      let launch;
      try { launch = sandbox ? sandbox.launch(args) : { cli: { ...cli, args: [...cli.args, ...args] }, cwd, env }; }
      catch (error) { return failed("permission", (error as Error).message); }
      const child = spawn(launch.cli.command, launch.cli.args, { cwd: launch.cwd, env: launch.env, detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const signal = (sig: NodeJS.Signals) => {
        if (child.pid) {
          try { process.kill(-child.pid, sig); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
        }
      };
      const permissions = new Map<string | number, () => void>();
      let pending: { id: number; method: string; resolve(result: any): void } | undefined;
      let prompting = false;
      let nextId = 0;
      let text = "";
      let outcome: TurnResult | undefined;
      let escalation: NodeJS.Timeout | undefined;
      const write = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
      const finish = (result: TurnResult) => {
        if (outcome) return;
        outcome = result;
        clearTimeout(timer);
        for (const cleanup of permissions.values()) cleanup();
        permissions.clear();
        pending?.resolve(undefined);
        pending = undefined;
        if (result.type === "failed" || stopped) {
          options.revokeBoard();
          signal("SIGTERM");
        } else child.stdin.end();
        escalation = setTimeout(() => signal("SIGKILL"), 350);
      };
      const timeout = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const timer = setTimeout(() => finish(failed("timeout", `agy turn exceeded ${Math.ceil(timeout / 1000)}s; it was not replayed.`)), timeout);
      function request(method: string, params: object): Promise<any> {
        if (outcome) return Promise.resolve(undefined);
        return new Promise((resolve) => { pending = { id: ++nextId, method, resolve }; write({ id: nextId, method, params }); });
      }
      const splitter = new LineSplitter(4 * 1024 * 1024);
      const onLine = (line: string) => {
        if (outcome || !line.trim()) return;
        const msg = JSON.parse(line);
        if (msg?.jsonrpc !== "2.0") return finish(protocol());
        if (typeof msg.method === "string") {
          if (msg.id === undefined) {
            const update = msg.params?.update;
            if (prompting && msg.method === "session/update" && msg.params?.sessionId === sessionId && update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
              if (text.length + update.content.text.length > 4 * 1024 * 1024) return finish(protocol());
              text += update.content.text;
            }
            return;
          }
          if (typeof msg.id !== "number" && typeof msg.id !== "string") return finish(protocol());
          if (msg.method !== "session/request_permission") {
            write({ id: msg.id, error: { code: -32601, message: "Client method not supported" } });
            return;
          }
          if (!prompting || msg.params?.sessionId !== sessionId || permissions.has(msg.id) || permissions.size >= 16) return finish(protocol());
          const { toolCall, options: choices } = msg.params;
          const once = (kind: string) => Array.isArray(choices) ? choices.find((choice) => choice?.kind === kind && typeof choice.optionId === "string")?.optionId : undefined;
          const allow = once("allow_once"), deny = once("reject_once");
          const title = typeof toolCall?.title === "string" && toolCall.title.trim() ? toolCall.title : "Antigravity tool request";
          const details = JSON.stringify(toolCall?.rawInput ?? toolCall?.content ?? toolCall?.locations ?? null, null, 2);
          const canAllow = Boolean(allow && toolCall?.toolCallId && (title !== "Antigravity tool request" || details !== "null")) && details.length <= 16_000 && title.length <= 500;
          const cleanup = options.approve({ title: title.slice(0, 500), details: details.length > 16_000 ? "Request details exceed the display limit. Deny and ask the worker to narrow the operation." : details === "null" ? "Antigravity supplied no additional details." : details, canAllow }, (choice) => {
            if (!permissions.delete(msg.id) || outcome) return;
            const optionId = choice === "allow" ? allow : deny;
            onRecord({ type: "permission_decided", choice });
            write({ id: msg.id, result: optionId ? { outcome: { outcome: "selected", optionId } } : acpCancelled });
          });
          permissions.set(msg.id, cleanup);
          return;
        }
        if (!pending || msg.id !== pending.id) return finish(protocol());
        if (msg.error && typeof msg.error.code === "number") {
          if (/authentication required|unauthenticated|not logged in/i.test(String(msg.error.message))) {
            return finish(failed("auth", `agy authentication required. Sign in to Antigravity CLI, then ${sandbox ? "start a new pair run" : "add a new worker"}.`));
          }
          if (/permission denied|workspace trust|untrusted workspace/i.test(String(msg.error.message))) return finish(failed("permission", "agy refused an action under its native permission or workspace trust policy."));
          if (pending.method === "session/resume") return finish(failed("lost-session", "agy could not resume the saved session; no fresh session was started."));
          if (pending.method === "session/set_config_option") return finish(failed("unsupported-cli", "agy rejected the requested model or effort."));
          return finish(failed("protocol", `agy rejected ${pending.method} (ACP error ${msg.error.code}).`));
        }
        if (!msg.result || typeof msg.result !== "object") return finish(protocol());
        const resolve = pending.resolve;
        pending = undefined;
        resolve(msg.result);
      };
      const done = new Promise<TurnResult>((resolve) => {
        child.stdout.on("data", (chunk: Buffer) => {
          if (outcome) return;
          try { splitter.push(chunk, onLine); } catch { finish(protocol()); }
        });
        child.stdin.on("error", () => undefined);
        child.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? failed("missing-binary", "agy CLI disappeared after preflight.") : failed("exit", "agy could not start.")));
        child.once("close", (code, sig) => {
          if (!outcome) finish(failed("exit", `agy exited (${sig ?? code}) before completing the turn.`));
          clearTimeout(escalation);
          signal("SIGKILL");
          resolve(outcome!);
        });
      });
      active = { done, stop: () => finish(cancelled) };
      const run = async () => {
        onRecord({ type: "agent_start" });
        const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "pi-swarm", version: "1.0.0" } });
        if (outcome) return;
        if (init.protocolVersion !== 1 || (!sandbox && init.agentCapabilities?.mcpCapabilities?.http !== true) || !init.agentCapabilities?.sessionCapabilities?.resume) {
          return finish(failed("unsupported-cli", `agy must support ACP v1, exact session resume${sandbox ? "" : ", and HTTP MCP"}.`));
        }
        const setup = { cwd: sandbox?.cwd ?? cwd, mcpServers: sandbox ? [] : [{ name: "swarm_board", type: "http", url: options.boardUrl, headers: [{ name: "x-swarm-token", value: options.boardToken }] }] };
        const session = previous ? await request("session/resume", { ...setup, sessionId: previous }) : await request("session/new", setup);
        if (outcome) return;
        // Resume may omit the ID; when returned it must match the ID we asked for.
        const id = session.sessionId ?? previous;
        if (typeof id !== "string" || !id || (previous && id !== previous)) return finish(previous ? failed("lost-session", "agy returned a different native session ID.") : protocol());
        sessionId = id;
        onRecord({ type: "native_session", sessionId: id, resumed: Boolean(previous) });
        let config = session.configOptions;
        const find = (category: string) => Array.isArray(config) ? config.find((entry) => entry?.category === category && entry.type === "select" && typeof entry.id === "string") : undefined;
        for (const [category, value] of [["model", model], ["thought_level", effort]] as const) {
          if (!value) continue;
          const opt = find(category);
          const available = Array.isArray(opt?.options) && opt.options.flatMap((entry: any) => entry?.options ?? [entry]).some((entry: any) => entry?.value === value);
          if (!available) return finish(failed("unsupported-cli", `agy did not advertise the requested ${category === "model" ? "model" : "effort"} ID.`));
          if (opt.currentValue !== value) {
            const changed = await request("session/set_config_option", { sessionId, configId: opt.id, value });
            if (outcome) return;
            config = changed.configOptions;
          }
        }
        if ((model && find("model")?.currentValue !== model) || (effort && find("thought_level")?.currentValue !== effort)) {
          return finish(failed("unsupported-cli", "agy did not confirm the requested model and effort."));
        }
        prompting = true;
        const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: previous ? prompt : `${options.rules}\n\n${prompt}` }] });
        prompting = false;
        if (outcome) return;
        if (permissions.size) return finish(protocol());
        if (text) onRecord({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
        if (result.stopReason === "end_turn") finish({ type: "completed", text });
        else if (result.stopReason === "cancelled") finish(cancelled);
        else if (result.stopReason === "refusal") finish(failed("permission", "agy refused the turn."));
        else finish(failed("exit", "agy stopped without completing the turn."));
      };
      void run().catch(() => finish(protocol()));
      try { return await done; } finally { active = undefined; }
    },
    async stop() {
      stopped = true;
      active?.stop();
      await active?.done;
      sandbox?.cleanup();
    },
  };
}
