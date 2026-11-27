#!/usr/bin/env node
// Test stand-in for `pi --mode rpc`: speaks the JSONL protocol, records its argv/cwd, and acts on scripted rules
// read from FAKE_PI_SCRIPT (JSON). On each prompt it emits agent_start … agent_settled; a rule whose `when` text
// appears in the prompt posts `post` to the board through the worker API (PI_SWARM_URL/PI_SWARM_TOKEN), like
// board_post would. `delayMs` holds the run open so tests can mention a working member.

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

if (process.argv.includes("--version")) { console.log("1.1.0"); process.exit(0); }
if (process.argv[2] === "auth") process.exit(0);
const name = process.env.PI_SWARM_NAME ?? "worker";
const script = process.env.FAKE_PI_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_PI_SCRIPT, "utf8")) : {};
const rules = script[name] ?? [];
const log = process.env.FAKE_PI_LOG;
const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
if (log) appendFileSync(log, JSON.stringify({ name, event: "start", argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }) + "\n");

const extension = process.argv[process.argv.indexOf("-e") + 1];
let tools;

let busy = Promise.resolve();
async function run(message) {
  if (log) appendFileSync(log, JSON.stringify({ name, event: "prompt", message }) + "\n");
  out({ type: "agent_start" });
  out({ type: "message_end", message: { role: "user", content: message } });
  const rule = rules.find((r) => message.includes(r.when));
  if (rule?.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
  if (rule?.exit) process.exit(rule.exit);
  const managed = extension?.endsWith("workflow-tools.ts");
  const calls = rule?.calls ?? (rule?.writePath ? [["task_write", { path: rule.writePath, content: rule.writeText }]] : []);
  const verifyRead = managed && rule?.readPath;
  if ((calls.length || verifyRead) && !tools) {
    tools = new Map();
    if (managed) {
      const { tsImport } = await import("tsx/esm/api");
      const active = process.argv[process.argv.indexOf("--tools") + 1].split(",");
      (await tsImport(pathToFileURL(extension).href, import.meta.url)).default({ registerTool: (tool) => {
        if (active.includes(tool.name)) tools.set(tool.name, tool);
      } });
    }
  }
  for (const [toolName, input] of calls) {
    let result;
    let isError = false;
    try {
      const tool = tools.get(toolName);
      if (!tool) throw new Error(`Tool not available: ${toolName}`);
      result = await tool.execute("fixture", input);
    } catch (error) {
      isError = true;
      result = { content: [{ type: "text", text: error.message }] };
    }
    if (log) appendFileSync(log, JSON.stringify({ name, event: "tool", toolName, isError, text: result.content[0].text }) + "\n");
    out({ type: "tool_execution_end", toolCallId: "fixture", toolName, isError, result });
  }
  if (log && rule?.readPath) {
    const text = verifyRead ? (await tools.get("task_read").execute("fixture", { path: rule.readPath })).content[0].text : readFileSync(rule.readPath, "utf8");
    appendFileSync(log, JSON.stringify({ name, event: "file", text }) + "\n");
  }
  if (rule?.post) {
    out({ type: "tool_execution_start", toolCallId: "t1", toolName: "board_post", args: { body: rule.post } });
    const res = await fetch(process.env.PI_SWARM_URL + "/api/worker/board", {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-token": process.env.PI_SWARM_TOKEN },
      body: JSON.stringify({ body: rule.post, kind: rule.kind ?? "message" }),
    });
    out({ type: "tool_execution_end", toolCallId: "t1", toolName: "board_post", result: { content: [{ type: "text", text: `HTTP ${res.status}` }] }, isError: !res.ok });
  }
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done\u2028ok" } });
  const assistant = (text, stopReason) => out({ type: "message_end", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
  if (rule?.retry) {
    assistant("discard the failed attempt", "error");
    out({ type: "agent_end", messages: [] });
    out({ type: "auto_retry_start", attempt: 1 });
    out({ type: "agent_start" });
  }
  assistant(rule?.text ?? `@${name} done\u2028ok`, rule?.stopReason ?? "stop");
  if (rule?.linger) {
    if (log) appendFileSync(log, JSON.stringify({ name, event: "linger" }) + "\n");
    await new Promise(() => setInterval(() => {}, 1000));
  }
  out({ type: "agent_end", messages: [] });
  out({ type: "agent_settled", aborted: false });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === "prompt") {
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      busy = busy.then(() => run(cmd.message));
    } else if (cmd.type === "abort") {
      out({ id: cmd.id, type: "response", command: "abort", success: true });
    } else {
      out({ id: cmd.id, type: "response", command: cmd.type, success: true });
    }
  }
});
process.stdin.on("end", () => busy.then(() => process.exit(0)));
