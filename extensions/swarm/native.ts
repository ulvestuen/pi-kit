import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { LineSplitter, type PiCommand } from "./driver.ts";
import { DEFAULT_TURN_TIMEOUT_MS, failed, probe, requireNativePlatform, type TranscriptEvent, type TurnResult, type WorkerAdapter } from "./worker.ts";

type NativeHarness = "claude" | "codex";
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const COMMON_EFFORTS = ["low", "medium", "high", "xhigh"];

export function validateNativeModel(harness: NativeHarness, model?: string, effort?: string) {
  if (model && !/^[a-z0-9][a-z0-9_.-]*$/i.test(model)) throw new Error(`Use a native ${harness} model ID or alias, without a provider prefix or effort suffix.`);
  if (!effort) return;
  // Only accept explicit efforts on model IDs with known support. An alias's target may vary by account and CLI version.
  const levels = harness === "claude"
    ? /^claude-(?:opus|sonnet)-4-6$/.test(model ?? "") ? ["low", "medium", "high", "max"]
      : /^claude-(?:opus-(?:4-[78]|5(?:-5)?)|sonnet-5(?:-5)?|haiku-5-5|fable-5(?:-[12])?)$/.test(model ?? "") ? [...COMMON_EFFORTS, "max"] : []
    : /^(?:gpt-6\.1-sol|gpt-5\.4(?:-mini)?)$/.test(model ?? "") ? COMMON_EFFORTS : [];
  if (!levels.includes(effort)) {
    throw new Error(`Swarm cannot use ${harness} effort ${effort} with ${model ?? "the CLI default model"}.${levels.length ? ` Supported: ${levels.join(", ")}.` : " Pick a supported explicit model ID or omit effort."}`);
  }
}

export function nativeInvocation(harness: NativeHarness | "agy", cwd: string): PiCommand {
  const value = process.env[`SWARM_${harness.toUpperCase()}_BIN`] ?? (harness === "agy" ? undefined : process.env[`PAIR_${harness.toUpperCase()}_BIN`]) ?? harness;
  const command = value.includes("/") ? resolve(cwd, value) : value;
  return /\.(?:[cm]?js)$/i.test(command) ? { command: "node", args: [resolve(cwd, command)] } : { command, args: [] };
}

interface NativeOptions {
  harness: NativeHarness;
  cli: PiCommand;
  cwd: string;
  preflightCwd?: string;
  model?: string;
  effort?: string;
  rules: string;
  env: NodeJS.ProcessEnv;
  boardUrl?: string;
  timeoutMs?: number;
  onRecord(record: TranscriptEvent): void;
  revokeBoard(): void;
}

function launchArgs({ harness, model, effort, boardUrl }: NativeOptions, session?: string): string[] {
  const selectedModel = model ? ["--model", model] : [];
  if (harness === "claude") {
    const mcp = { mcpServers: { swarm_board: { type: "http", url: boardUrl, alwaysLoad: true, headers: { "x-swarm-token": "${PI_SWARM_TOKEN}" } } } };
    return ["--print", "--output-format", "stream-json", "--verbose",
      "--dangerously-skip-permissions", "--settings", JSON.stringify({ sandbox: { enabled: false } }),
      ...(boardUrl ? ["--mcp-config", JSON.stringify(mcp)] : []), ...selectedModel, ...(effort ? ["--effort", effort] : []),
      ...(session ? ["--resume", session] : [])];
  }
  return [...(boardUrl ? ["-c", 'shell_environment_policy.exclude=["PI_SWARM_TOKEN"]', "-c", `mcp_servers.swarm_board.url=${JSON.stringify(boardUrl)}`,
    "-c", 'mcp_servers.swarm_board.env_http_headers={"x-swarm-token"="PI_SWARM_TOKEN"}', "-c", "mcp_servers.swarm_board.required=true"] : []),
    ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
    ...selectedModel,
    ...(session ? ["resume", session] : []), "-"];
}

function reportedFailure(harness: NativeHarness, output: string, resuming: boolean) {
  // Classify but don't copy native diagnostics verbatim: they can include credentials or command output.
  if (/authentication_failed|not logged in|please (?:log|sign) in|invalid (?:api key|token)|\b(?:401 Unauthorized|unauthenticated)\b/i.test(output)) return failed("auth", `${harness} authentication failed; check CLI login.`);
  if (resuming && /(?:no (?:conversation|session|thread|rollout)|(?:conversation|session|thread|rollout).{0,100}(?:not found|does not exist|missing|unavailable)|failed to (?:resume|load (?:session|thread)))/i.test(output)) return failed("lost-session", `${harness} could not resume the saved session.`);
  if (/permission_denied|permission denied|approval (?:required|policy)|not permitted|denied by (?:sandbox|policy)|read-only file system|sandbox (?:blocked|denied|violation)/i.test(output)) return failed("permission", `${harness} blocked an action under its headless permission policy.`);
  if (/model_not_found|(?:unsupported|invalid|unknown) (?:model|effort)|model.{0,100}(?:not supported|not available|does not exist)/i.test(output)) return failed("unsupported-cli", `${harness} rejected the model or effort selection.`);
  return undefined;
}

export function nativeWorker(options: NativeOptions): WorkerAdapter {
  const { harness, cli, cwd, model, onRecord, boardUrl } = options;
  let session: string | undefined;
  let stopped = false;
  let active: { done: Promise<TurnResult>; cancel: () => void } | undefined;

  return {
    async preflight() {
      requireNativePlatform(harness);
      validateNativeModel(harness, model, options.effort);
      const helpArgs = harness === "claude" ? ["--help"] : ["exec", "--help"];
      const required = harness === "claude"
        ? ["--dangerously-skip-permissions", "--output-format", "--resume"]
        : ["--json", "--dangerously-bypass-approvals-and-sandbox", "resume"];
      const help = await probe(cli, helpArgs, options.preflightCwd ?? cwd, options.env);
      if (help.code === "ENOENT") throw new Error(`${harness} [missing-binary]: put the native CLI on PATH or set SWARM_${harness.toUpperCase()}_BIN.`);
      if (!help.ok || !required.every((flag) => help.output.includes(flag))) throw new Error(`${harness} [unsupported-cli]: this version does not support Swarm's headless launch. Check '${harness} ${helpArgs.join(" ")}'.`);
    },
    async deliver(prompt) {
      if (stopped) return { type: "cancelled" };
      const previous = session;
      const args = launchArgs(options, previous);
      const child = spawn(cli.command, [...cli.args, ...args], { cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid) {
          try { process.kill(-child.pid, signal); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
        }
      };
      let outcome: TurnResult | undefined;
      let escalation: NodeJS.Timeout | undefined;
      const interrupt = (result: TurnResult) => {
        outcome = result;
        if (escalation) return;
        options.revokeBoard();
        signalGroup("SIGTERM");
        escalation = setTimeout(() => signalGroup("SIGKILL"), 350);
      };
      const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const timer = setTimeout(() => interrupt(failed("timeout", `${harness} turn exceeded ${Math.ceil(timeoutMs / 1000)}s; it was not replayed.`)), timeoutMs);
      const splitter = new LineSplitter(4 * 1024 * 1024);
      let stderr = "", diagnostic = "", text = "";
      let observed: string | undefined;
      let complete = false;
      let rejected: TurnResult | undefined;

      const identify = (id: unknown) => {
        if (typeof id !== "string" || !SESSION_ID.test(id) || ((previous ?? observed) && id !== (previous ?? observed))) {
          interrupt(failed(previous ? "lost-session" : "protocol", `${harness} did not report the expected native session ID.`));
        } else if (!observed) {
          observed = id;
          session = id;
          onRecord({ type: "native_session", sessionId: id, resumed: Boolean(previous) });
        }
      };
      const assistant = (value: unknown) => {
        if (typeof value !== "string" || !value || !observed) return;
        text = value;
        onRecord({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: value }] } });
      };
      const line = (raw: string) => {
        if (outcome || !raw.trim()) return;
        let record: any;
        try { record = JSON.parse(raw); } catch { /* handled below */ }
        if (typeof record?.type !== "string") {
          interrupt(failed("protocol", `${harness} emitted a malformed JSONL record.`));
          return;
        }
        if (harness === "claude") {
          if (record.type === "system" && record.subtype === "init") {
            identify(record.session_id);
            if (outcome) return;
            if (model?.startsWith("claude-") && typeof record.model === "string" && record.model !== model) {
              interrupt(failed("unsupported-cli", `Claude Code selected a different model than ${model}.`));
            }
            const board = Array.isArray(record.mcp_servers) && record.mcp_servers.find((m: any) => m?.name === "swarm_board");
            if (boardUrl && (!board || !["connected", "pending", "cached"].includes(board.status))) interrupt(failed("protocol", "Claude Code did not connect to the swarm board."));
          } else if (record.type === "assistant" && !record.parent_tool_use_id) {
            const content = record.message?.content;
            if (Array.isArray(content)) assistant(content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n"));
            if (record.error) diagnostic = String(record.error);
          } else if (record.type === "system" && record.subtype === "permission_denied") {
            rejected = failed("permission", "Claude Code denied a tool request under its headless permission policy.");
          } else if (record.type === "result") {
            if (record.permission_denials?.length) rejected = failed("permission", "Claude Code denied a tool request under its headless permission policy.");
            if (record.subtype === "success" && record.is_error === false) {
              identify(record.session_id);
              if (outcome) return;
              if (record.result !== text) assistant(record.result);
              complete = true;
            } else {
              diagnostic += " " + JSON.stringify([record.subtype, record.result, record.errors]).slice(-8000);
              rejected ??= reportedFailure(harness, diagnostic, Boolean(previous)) ?? failed("exit", "Claude Code reported an unsuccessful turn.");
            }
          }
        } else {
          if (record.type === "thread.started") identify(record.thread_id);
          else if (record.type === "turn.completed") complete = true;
          else if (record.type === "item.completed") {
            const item = record.item;
            if (item?.type === "agent_message") assistant(item.text);
            else if (item?.type === "command_execution") {
              if (item.status === "declined") rejected = failed("permission", "Codex declined a command under its headless permission policy.");
              else if (item.exit_code !== 0) {
                const problem = reportedFailure(harness, String(item.aggregated_output ?? ""), false);
                if (problem?.failure === "permission") rejected = problem;
              }
            } else if (item?.type === "file_change" && item.status === "failed") {
              // Codex reports both denied and unsuccessful patches as failed, without distinguishing them here.
              rejected ??= failed("exit", "Codex reported an unsuccessful file change.");
            }
          } else if (record.type === "error" || record.type === "turn.failed") {
            diagnostic = String(record.error?.message ?? record.message ?? "");
            if (record.type === "turn.failed") rejected ??= reportedFailure(harness, diagnostic, Boolean(previous)) ?? failed("exit", "Codex reported an unsuccessful turn.");
          }
        }
      };

      const done = new Promise<TurnResult>((resolve) => {
        child.once("spawn", () => { if (!outcome) onRecord({ type: "agent_start" }); });
        child.once("error", (error: NodeJS.ErrnoException) => {
          outcome ??= error.code === "ENOENT" ? failed("missing-binary", `${harness} CLI disappeared after preflight.`) : failed("exit", `${harness} could not start.`);
        });
        child.stdout.on("data", (chunk: Buffer) => {
          if (outcome) return;
          try { splitter.push(chunk, line); } catch { interrupt(failed("protocol", `${harness} emitted an oversized JSONL record.`)); }
        });
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
        child.stdin.on("error", () => undefined); // CLI may exit before reading stdin; close determines the outcome.
        child.once("close", (code, signal) => {
          if (!outcome) splitter.end(line);
          clearTimeout(timer);
          clearTimeout(escalation);
          signalGroup("SIGKILL"); // Reap helpers that outlived the CLI and no longer hold its pipes open.
          resolve(outcome ?? rejected ?? ((code === 0 && observed && complete)
            ? { type: "completed", text }
            : reportedFailure(harness, `${diagnostic}\n${stderr}`, Boolean(previous)) ?? (code === 0
              ? failed(previous && !observed ? "lost-session" : "protocol", `${harness} exited without a verified session and completed turn.`)
              : failed("exit", `${harness} exited (${signal ?? code}) before completing the turn.`))));
        });
      });
      active = { done, cancel: () => interrupt({ type: "cancelled" }) };
      child.stdin.end(`${previous ? "" : options.rules + "\n\n"}${prompt}`);
      try { return await done; } finally { active = undefined; }
    },
    async stop() {
      stopped = true;
      active?.cancel();
      await active?.done;
    },
  };
}
