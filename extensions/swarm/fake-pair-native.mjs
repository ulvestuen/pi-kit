// Stand-in for native pair CLIs. These probes run as ordinary files and child
// processes, deliberately ignoring the harness flags so only the OS can stop them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const send = (value) => console.log(JSON.stringify(value));
if (args.includes("--help")) {
  console.log("--restricted --permission-prompts --strict-mcp-config --output-format --resume --json --sandbox --ignore-user-config --ignore-rules resume --process-per-session");
  process.exit(0);
}
const role = process.env.PI_SWARM_NAME;
const claude = args.includes("--print");
const sessionFile = join(process.env.HOME, "fixture-session");
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
  assert.equal(process.cwd(), "/workspace");
  assert.equal(process.env.PI_SWARM_TOKEN, undefined);
  assert.equal(existsSync(".git/HEAD"), false);
  const outside = /Outside: (\/[^\n]+)/.exec(prompt)?.[1];
  if (outside) {
    assert.equal(existsSync(outside), false);
    assert.notEqual(spawnSync("/bin/sh", ["-c", 'echo changed >> "$1"', "probe", outside]).status, 0);
    if (existsSync("escape") || phase === "Implement") assert.throws(() => writeFileSync("escape", "changed"), { code: "ENOENT" });
  }
  if (phase === "Implement") {
    assert.throws(() => writeFileSync(".git/HEAD", "changed"), { code: "EROFS" });
    writeFileSync("README.md", "implemented inside sandbox\n");
  } else if (phase === "Do") writeFileSync("sample.txt", "delivered inside sandbox\n");
  else if (phase !== "Address audit") {
    assert.throws(() => writeFileSync("forbidden", "changed"), { code: "EROFS" });
    assert.notEqual(spawnSync("/bin/sh", ["-c", "echo changed >> ./forbidden"]).status, 0);
  }
  if (phase === "Audit") {
    assert.match(prompt, /\+implemented inside sandbox/);
    assert.equal(readFileSync("README.md", "utf8"), "implemented inside sandbox\n");
  }
  if (phase === "Verify") assert.equal(readFileSync("sample.txt", "utf8"), "delivered inside sandbox\n");
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
      assert.equal(params.cwd, "/workspace");
      assert.deepEqual(params.mcpServers, []);
      sessionId = session(params.sessionId);
      rpc({ id, result: { sessionId } });
    } else if (method === "session/prompt") {
      const prompt = params.prompt[0].text;
      pending = { id, prompt };
      rpc({ id: "approval", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "test", title: "Try sandboxed task file", rawInput: { path: "sample.txt" } }, options: [{ kind: "allow_once", optionId: "once" }] } });
    } else if (id === "approval") {
      assert.equal(result.outcome.optionId, "once");
      const text = report(pending.prompt);
      rpc({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      rpc({ id: pending.id, result: { stopReason: "end_turn" } });
    }
  }
}
