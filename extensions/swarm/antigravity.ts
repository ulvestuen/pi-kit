import { spawn } from "node:child_process";
import { LineSplitter, type PiCommand } from "./driver.ts";
import { DEFAULT_TURN_TIMEOUT_MS, failed, probe, requireNativePlatform, type TranscriptEvent, type TurnResult, type WorkerAdapter } from "./worker.ts";

interface Options {
  cli: PiCommand;
  cwd: string;
  preflightCwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  effort?: string;
  rules: string;
  board: { url: string; token: string };
  timeoutMs?: number;
  onRecord(record: TranscriptEvent): void;
  revokeBoard(): void;
}

const args = ["acp", "--disable-telemetry", "--process-per-session", "--dangerously-skip-permissions", "--sandbox=false"];
const cancelled = { type: "cancelled" } as const;
const protocol = () => failed("protocol", "agy sent an unexpected ACP message.");
const acpCancelled = { outcome: { outcome: "cancelled" } };

export function antigravityWorker(options: Options): WorkerAdapter {
  const { cli, cwd, env, model, effort, onRecord, board } = options;
  let sessionId: string | undefined;
  let stopped = false;
  let active: { stop(): void; done: Promise<TurnResult> } | undefined;

  return {
    async preflight() {
      requireNativePlatform("agy");
      const help = await probe(cli, ["acp", "--help"], options.preflightCwd, env);
      if (help.code === "ENOENT") throw new Error("agy [missing-binary]: put Antigravity CLI on PATH or set SWARM_AGY_BIN.");
      if (!help.ok || !["--process-per-session", "--dangerously-skip-permissions", "--sandbox"].every((flag) => help.output.includes(flag))) throw new Error("agy [unsupported-cli]: this Antigravity CLI does not expose the required ACP interface. Check `agy acp --help`.");
    },
    async deliver(prompt) {
      if (stopped) return cancelled;
      const previous = sessionId;
      const child = spawn(cli.command, [...cli.args, ...args], { cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const signal = (sig: NodeJS.Signals) => {
        if (child.pid) {
          try { process.kill(-child.pid, sig); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
        }
      };
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
          if (!prompting || msg.params?.sessionId !== sessionId) return finish(protocol());
          const choices = msg.params.options;
          if (!Array.isArray(choices)) return finish(protocol());
          // Approve the current action without persisting a rule if the CLI offers that choice.
          const allow = (kind: string) => choices.find((choice) => choice?.kind === kind && typeof choice.optionId === "string")?.optionId;
          const optionId = allow("allow_once") ?? allow("allow_always");
          write({ id: msg.id, result: optionId === undefined ? acpCancelled : { outcome: { outcome: "selected", optionId } } });
          return;
        }
        if (!pending || msg.id !== pending.id) return finish(protocol());
        if (msg.error && typeof msg.error.code === "number") {
          if (/authentication required|unauthenticated|not logged in/i.test(String(msg.error.message))) {
            return finish(failed("auth", "agy authentication required. Sign in to Antigravity CLI, then add a new worker."));
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
        if (init.protocolVersion !== 1 || init.agentCapabilities?.mcpCapabilities?.http !== true || !init.agentCapabilities?.sessionCapabilities?.resume) {
          return finish(failed("unsupported-cli", "agy must support ACP v1, exact session resume, and HTTP MCP."));
        }
        const setup = { cwd, mcpServers: [{ name: "swarm_board", type: "http", url: board.url, headers: [{ name: "x-swarm-token", value: board.token }] }] };
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
    },
  };
}
