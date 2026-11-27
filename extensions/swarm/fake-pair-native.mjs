// Stand-in for native pair CLIs, including their session and approval protocols.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const send = (value) => console.log(JSON.stringify(value));
if (args.includes("--help")) {
  console.log("--output-format --resume --json resume --process-per-session --dangerously-skip-permissions --dangerously-bypass-approvals-and-sandbox --sandbox");
  process.exit(0);
}
const role = process.env.PI_SWARM_NAME;
const claude = args.includes("--print");
assert.ok(args.includes(claude || args[0] === "acp" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox"));
assert.ok(!args.some((arg) => /--restricted|--tools|--mcp-config|mcp_servers\.swarm_board/.test(arg)));
assert.equal(process.env.PI_SWARM_TOKEN, undefined);
const sessionFile = join(process.env.HOME, `${role}-fixture-session`);
function session(resume) {
  if (resume) {
    assert.equal(readFileSync(sessionFile, "utf8"), resume);
    return resume;
  }
  assert.equal(existsSync(sessionFile), false);
  const id = randomUUID();
  writeFileSync(sessionFile, id);
  return id;
}
function report(prompt) {
  const phase = /Phase: (.*?)\. Round:/.exec(prompt)?.[1];
  const outside = /Outside: (\/[^\n]+)/.exec(prompt)?.[1];
  if (phase === "Implement") {
    assert.ok(existsSync(".git/HEAD"));
    assert.equal(spawnSync("/bin/sh", ["-c", 'printf "wrote outside\n" > "$1"', "probe", outside]).status, 0);
    writeFileSync("README.md", "implemented in checkout\n");
  } else if (phase === "Do") writeFileSync("sample.txt", "delivered in task directory\n");
  if (phase === "Audit") {
    assert.match(prompt, /\+implemented in checkout/);
    assert.equal(readFileSync("README.md", "utf8"), "implemented in checkout\n");
  }
  if (phase === "Verify") assert.equal(readFileSync("sample.txt", "utf8"), "delivered in task directory\n");
  return JSON.stringify({ report: `${role}: ${phase}`, verdict: phase === "Verify" ? "accept" : "approve" });
}

if (args[0] !== "acp") {
  const resume = args.findIndex((arg) => arg === "--resume" || arg === "resume");
  const id = session(resume < 0 ? undefined : args[resume + 1]);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = report(Buffer.concat(chunks).toString());
  if (claude) {
    send({ type: "system", subtype: "init", session_id: id });
    send({ type: "result", subtype: "success", is_error: false, session_id: id, result: text });
  } else {
    send({ type: "thread.started", thread_id: id });
    send({ type: "item.completed", item: { type: "agent_message", text } });
    send({ type: "turn.completed" });
  }
} else {
  let sessionId, pending;
  const rpc = (value) => send({ jsonrpc: "2.0", ...value });
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params, result } = JSON.parse(line);
    if (method === "initialize") rpc({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
    else if (method === "session/new" || method === "session/resume") {
      assert.equal(realpathSync(params.cwd), process.cwd());
      assert.deepEqual(params.mcpServers, []);
      sessionId = session(params.sessionId);
      rpc({ id, result: { sessionId } });
    } else if (method === "session/prompt") {
      const prompt = params.prompt[0].text;
      pending = { id, prompt };
      rpc({ id: "approval", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "test", title: "Access task file", rawInput: { path: "sample.txt" } }, options: [{ kind: "allow_once", optionId: "once" }] } });
    } else if (id === "approval") {
      assert.equal(result.outcome.optionId, "once");
      const text = report(pending.prompt);
      rpc({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      rpc({ id: pending.id, result: { stopReason: "end_turn" } });
    }
  }
}
