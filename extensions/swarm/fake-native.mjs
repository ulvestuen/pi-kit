#!/usr/bin/env node
// Stand-in for both native CLIs. Exercise the authenticated MCP transport, not direct store access.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const name = process.env.PI_SWARM_NAME;
if (process.env.FAKE_NATIVE_LOG) appendFileSync(process.env.FAKE_NATIVE_LOG, JSON.stringify({ name, event: "invoked" }) + "\n");
if (args.includes("--version")) { console.log("fake 9.9.9"); process.exit(0); }
if (args.includes("--help")) {
  console.log("--resume --output-format --permission-mode --tools --setting-sources --settings --restricted --strict-mcp-config --mcp-config --effort --json --sandbox --ignore-user-config --ignore-rules --skip-git-repo-check --no-session-persistence --ephemeral resume SESSION_ID PROMPT");
  process.exit(0);
}
if (args[1] === "status") {
  const ready = name !== "logged-out";
  console.log(args[0] === "auth" ? JSON.stringify({ loggedIn: ready }) : ready ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(ready ? 0 : 1);
}

const harness = args.includes("--print") ? "claude" : "codex";
const resumeIndex = args.indexOf(harness === "claude" ? "--resume" : "resume");
const resume = resumeIndex < 0 ? null : args[resumeIndex + 1];
const idFor = (name) => createHash("sha256").update(`${harness}/${name}`).digest("hex").slice(0, 32).replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, "$1-$2-$3-$4-$5");
const session = idFor(name);
const rules = process.env.FAKE_NATIVE_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_NATIVE_SCRIPT, "utf8"))[name] ?? [] : [];
const into = (event) => `${JSON.stringify(event)}\n`;
const out = (event) => process.stdout.write(into(event));
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const log = (value) => {
  if (process.env.FAKE_NATIVE_LOG) appendFileSync(process.env.FAKE_NATIVE_LOG, into({ name, harness, ...value }));
};
log({ event: "launch", args, cwd: process.cwd(), prompt, session, resume, pid: process.pid, hasTokenInInput: (prompt + args.join(" ")).includes(process.env.PI_SWARM_TOKEN) });
const rule = rules.find((r) => prompt.includes(r.when)) ?? {};
if ((resume && resume !== session) || rule.fail === "lost-session") {
  console.error("No conversation found with session ID");
  process.exit(1);
}
if (rule.fail === "auth") { console.error("401 Unauthorized; invalid token"); process.exit(1); }
const actualId = rule.fail === "wrong-session" ? idFor("other") : session;
const config = harness === "claude"
  ? JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.swarm_board
  : {
      url: JSON.parse(args.find((a) => a.startsWith("mcp_servers.swarm_board.url=")).split("=")[1]),
      headers: { "x-swarm-token": "${PI_SWARM_TOKEN}" },
    };
const token = process.env[config.headers["x-swarm-token"].replace(/^\$\{|\}$/g, "")];
const rpc = async (method, params) => {
  const res = await fetch(config.url, { method: "POST", headers: { "content-type": "application/json", "x-swarm-token": token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: res.status, data: await res.json() };
};
const tool = async (name, args = {}) => rpc("tools/call", { name, arguments: args });
const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
const listed = await rpc("tools/list");
if (init.status !== 200 || !listed.data.result?.tools?.some((entry) => entry.name === "board_post")) throw new Error("board handshake failed");
if (harness === "claude") out({ type: "system", subtype: "init", session_id: actualId, mcp_servers: [{ name: "swarm_board", status: "connected" }], model: args.includes("--model") ? args[args.indexOf("--model") + 1] : "claude-opus-5-5" });
else out({ type: "thread.started", thread_id: actualId });

if (rule.linger) {
  const helper = rule.helper && spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  process.on("SIGTERM", async () => {
    out({ type: "item.completed", item: { type: "agent_message", text: "late transcript must not appear" } });
    const result = await tool("board_post", { body: "late board post must not appear" });
    log({ event: "late", status: result.status });
  });
  log({ event: "ready-to-cancel", helperPid: helper?.pid });
  setInterval(() => {}, 1000);
} else {
  if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
  if (rule.writePath) writeFileSync(rule.writePath, rule.writeText);
  if (rule.readPath) log({ event: "file", path: rule.readPath, text: readFileSync(rule.readPath, "utf8") });
  if (rule.fail === "malformed") process.stdout.write("{not json!}\n");
  if (rule.post) {
    const result = await tool("board_post", { body: rule.post, kind: "result", from: "coordinator" });
    log({ event: "posted", from: JSON.parse(result.data.result.content[0].text).from });
  }
  if (rule.delayAfterPostMs) await new Promise((r) => setTimeout(r, rule.delayAfterPostMs));
  if (rule.read) {
    const result = await tool("board_read");
    log({ event: "read", messages: JSON.parse(result.data.result.content[0].text).messages });
  }
  const text = rule.echoToken ? `Token: ${token}` : rule.text ?? `${name} finished café\u2028✓`;
  const message = into(harness === "claude"
    ? { type: "assistant", message: { content: [{ type: "text", text }] } }
    : { type: "item.completed", item: { type: "agent_message", text } });
  const bytes = Buffer.from(message);
  const split = Math.max(1, bytes.indexOf(Buffer.from("é")) + 1);
  process.stdout.write(bytes.subarray(0, split));
  process.stdout.write(bytes.subarray(split));
  if (harness === "claude") out({ type: "result", subtype: "success", is_error: false, session_id: actualId, result: text, permission_denials: rule.fail === "permission" ? [{ tool_name: "Edit" }] : [] });
  else out({ type: "turn.completed" });
}
