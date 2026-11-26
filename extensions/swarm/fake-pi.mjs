#!/usr/bin/env node
// Test stand-in for `pi --mode rpc`: speaks the JSONL protocol, records its argv/cwd, and acts on scripted rules
// read from FAKE_PI_SCRIPT (JSON). On each prompt it emits agent_start … agent_settled; a rule whose `when` text
// appears in the prompt posts `post` to the board through the worker API (PI_SWARM_URL/PI_SWARM_TOKEN), like
// board_post would. `delayMs` holds the run open so tests can mention a working member.

import { appendFileSync, readFileSync } from "node:fs";

const name = process.env.PI_SWARM_NAME ?? "worker";
const script = process.env.FAKE_PI_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_PI_SCRIPT, "utf8")) : {};
const rules = script[name] ?? [];
const log = process.env.FAKE_PI_LOG;
const out = (record) => process.stdout.write(JSON.stringify(record) + "\n");
if (log) appendFileSync(log, JSON.stringify({ name, event: "start", argv: process.argv.slice(2), cwd: process.cwd() }) + "\n");

let busy = Promise.resolve();
async function run(message) {
  if (log) appendFileSync(log, JSON.stringify({ name, event: "prompt", message }) + "\n");
  out({ type: "agent_start" });
  out({ type: "message_end", message: { role: "user", content: message } });
  const rule = rules.find((r) => message.includes(r.when));
  if (rule?.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
  if (rule?.exit) process.exit(rule.exit);
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
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `@${name} done\u2028ok` }] } });
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
