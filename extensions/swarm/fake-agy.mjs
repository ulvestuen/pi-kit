// ACP fixture: all board calls still go through Swarm's authenticated HTTP server.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.includes("--help")) {
  console.log("agy acp --process-per-session --disable-telemetry");
  process.exit(0);
}
const log = (record) => {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(record) + "\n");
};
const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const sessionId = "session-7ad6";
const configOptions = [
  { id: "models", category: "model", type: "select", currentValue: "default", options: [{ group: "primary", options: [{ value: "gemini-test" }] }] },
  { id: "thinking", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "high" }] },
];
let board, turn;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  const reply = (result) => out({ id, result });
  if (method === "initialize") {
    reply({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } } });
  } else if (method === "session/new" || method === "session/resume") {
    board = params.mcpServers.find(({ name }) => name === "swarm_board");
    log({ method, cwd: process.cwd(), requestedCwd: params.cwd, id: params.sessionId, pid: process.pid, args: process.argv.slice(2), tokenInEnv: Boolean(process.env.PI_SWARM_TOKEN) });
    if (method === "session/resume" && (params.sessionId !== sessionId || process.env.FAKE_AGY_LOST)) {
      out({ id, error: { code: -32000, message: "No session found" } });
    } else reply({ ...(method === "session/new" ? { sessionId } : {}), configOptions });
  } else if (method === "session/set_config_option") {
    configOptions.find((entry) => entry.id === params.configId).currentValue = params.value;
    reply({ configOptions });
  } else if (method === "session/prompt") {
    turn = id;
    log({ method, text: params.prompt[0].text, model: configOptions[0].currentValue, effort: configOptions[1].currentValue });
    out({ id: "permission-1", method: "session/request_permission", params: { sessionId, toolCall: {
      toolCallId: "tool-1", title: "Read README.md", rawInput: { path: "README.md", ...(process.env.FAKE_AGY_ECHO ? { debug: board.headers[0].value } : {}) },
    }, options: [
      { kind: "allow_always", optionId: "persistent" }, { kind: "allow_once", optionId: "single" }, { kind: "reject_once", optionId: "deny-single" },
    ] } });
  } else if (id === "permission-1") {
    log({ method: "decision", outcome: result.outcome });
    const body = result.outcome.optionId === "single" ? "Read approved once" : "Read denied";
    const response = await fetch(board.url, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(board.headers.map(({ name, value }) => [name, value])) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_post", arguments: { from: "human", kind: "result", body } } }) });
    if (!response.ok || (await response.json()).result?.isError) throw new Error("Board post failed");
    out({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } } } });
    out({ id: turn, result: { stopReason: "end_turn" } });
  }
}
