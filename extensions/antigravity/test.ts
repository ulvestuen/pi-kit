import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
  createModels,
  getSupportedThinkingLevels,
  normalizeContext,
  Type,
  type AssistantMessageEvent,
  type Context,
  type Message,
  type Tool,
} from "@earendil-works/pi-ai";
import { clearStatusCache, probeAntigravity } from "./acp-client.ts";
import { modelFromDiscovery, parseDiscoveredModels, resolveAcpThoughtLevel } from "./catalog.ts";
import antigravityExtension from "./index.ts";
import { buildToolMapping, sanitizeToolArguments } from "./mcp-server.ts";
import { createAntigravityProvider, PROVIDER_ID } from "./provider.ts";
import { disposeAllAntigravitySessions, streamAntigravity } from "./stream.ts";

// Creates an executable fake `agy` CLI implementing the subset of `agy acp --stdio`
// used by the provider, including actually spawning the `mcpServers` stdio bridge.
function createFakeAgyBinary(dir: string): string {
  const scriptPath = join(dir, "fake-agy.mjs");
  const script = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] !== "acp") {
  process.stderr.write("fake-agy only supports acp\\n");
  process.exit(2);
}

const mode = process.env.FAKE_AGY_MODE || "ok";
if (mode === "unauth") {
  process.stderr.write("not authenticated: run agy acp --login\\n");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

let sessionSeq = 0;
let permSeq = 0;
const sessions = new Map();
const pendingClientReqs = new Map();

function askClient(method, params) {
  const id = "perm-" + (++permSeq);
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pendingClientReqs.set(id, { resolve, reject }));
}

function startMcpClient(spec) {
  const childEnv = { ...process.env };
  for (const entry of spec.env || []) {
    childEnv[entry.name] = entry.value;
  }
  const proc = spawn(spec.command, spec.args || [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  let rpcId = 0;
  const waiters = new Map();
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) {
        waiters.delete(msg.id);
        if (msg.error) w.reject(new Error(msg.error.message || "mcp error"));
        else w.resolve(msg.result);
      }
    }
  });
  const call = (method, params) => {
    const id = ++rpcId;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    return new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
  };
  const close = () => {
    try { proc.kill("SIGTERM"); } catch {}
  };
  return { call, close };
}

async function handlePrompt(msg) {
  const { sessionId, prompt } = msg.params;
  const sess = sessions.get(sessionId);
  if (!sess) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown session" } });
    return;
  }
  sess.cancelled = false;
  const text = (prompt || []).filter((p) => p.type === "text").map((p) => p.text).join("\\n");
  const images = (prompt || []).filter((p) => p.type === "image");

  if (text.includes("TRIGGER_ERROR")) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "context_length_exceeded: prompt too long" } });
    return;
  }

  if (text.includes("TRIGGER_CRASH")) {
    process.stderr.write("fatal backend crash\\n");
    process.exit(1);
  }

  if (text.includes("TRIGGER_EMPTY")) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 10 } },
    });
    return;
  }

  if (text.includes("TRIGGER_SLOW")) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Starting..." } } } });
    await new Promise((r) => setTimeout(r, 2000));
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: sess.cancelled ? "cancelled" : "end_turn" },
    });
    return;
  }

  if (text.includes("TRIGGER_BUILTIN_DENY")) {
    const builtinPerm = await askClient("session/request_permission", {
      sessionId,
      toolCall: { sessionUpdate: "tool_call", toolCallId: "builtin-1", name: "run_command", args: { CommandLine: "rm -rf /" } },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BUILTIN_OUTCOME:" + builtinPerm?.outcome?.optionId } },
      },
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 25 } },
    });
    return;
  }

  if (text.includes("TRIGGER_TOOL_ROUNDTRIP")) {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about reading..." } } } });
    const perm = await askClient("session/request_permission", {
      sessionId,
      toolCall: { sessionUpdate: "tool_call", toolCallId: "acp_call_1", name: "mcp_pi_read", args: { path: "foo.ts", toolSummary: "Read foo.ts" } },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    if (perm?.outcome?.optionId !== "allow") {
      throw new Error("Expected allow for mcp_pi_read");
    }
    const mcpResult = await sess.mcp.call("tools/call", {
      name: "read",
      arguments: { path: "foo.ts", toolSummary: "Read foo.ts" },
    });
    const toolText = (mcpResult.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const toolImages = (mcpResult.content || []).filter((c) => c.type === "image").length;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "FINAL:" + toolText + "|IMG:" + toolImages + "|SID:" + sessionId },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 40, cachedReadTokens: 50, cachedWriteTokens: 0, thoughtTokens: 15, totalTokens: 190 },
      },
    });
    return;
  }

  if (text.includes("TRIGGER_TWO_TOOLS")) {
    await askClient("session/request_permission", {
      sessionId,
      toolCall: { sessionUpdate: "tool_call", toolCallId: "acp_call_a", name: "mcp_pi_alpha" },
      options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
    });
    const r1 = await sess.mcp.call("tools/call", { name: "alpha", arguments: { k: "1" } });
    await askClient("session/request_permission", {
      sessionId,
      toolCall: { sessionUpdate: "tool_call", toolCallId: "acp_call_b", name: "mcp_pi_beta" },
      options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
    });
    const r2 = await sess.mcp.call("tools/call", { name: "beta", arguments: { k: "2" } });
    const t1 = r1.content?.[0]?.text ?? "";
    const t2 = r2.content?.[0]?.text ?? "";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BOTH:" + t1 + "+" + t2 } } },
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 20, cachedReadTokens: 10, cachedWriteTokens: 0, totalTokens: 80 } },
    });
    return;
  }

  if (text.includes("TRIGGER_CODEMODE")) {
    await askClient("session/request_permission", {
      sessionId,
      toolCall: { sessionUpdate: "tool_call", toolCallId: "cm_1", name: "mcp_pi_codemode" },
      options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }],
    });
    const r = await sess.mcp.call("tools/call", {
      name: "codemode",
      arguments: { code: "return 21 * 2;", toolSummary: "Compute answer" },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "CM:" + (r.content?.[0]?.text ?? "") } } },
    });
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 30, outputTokens: 12, cachedReadTokens: 0, cachedWriteTokens: 0, totalTokens: 42 } },
    });
    return;
  }

  // Default echo response including thought chunk, Unicode emoji/CJK, sessionId, model, thoughtLevel, image count, and prompt length.
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking 🧠..." } } },
  });
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "ECHO[" + sessionId + "|" + sess.model + "|" + sess.thoughtLevel + "|imgs=" + images.length + "]: " + text.slice(0, 120) + " 🚀日本語",
        },
      },
    },
  });
  send({
    jsonrpc: "2.0",
    id: msg.id,
    result: {
      stopReason: "end_turn",
      usage: { inputTokens: 25, outputTokens: 15, cachedReadTokens: 5, cachedWriteTokens: 0, thoughtTokens: 6, totalTokens: 45 },
    },
  });
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Response to our server->client request (e.g. session/request_permission)
  if (msg.id !== undefined && !msg.method) {
    const p = pendingClientReqs.get(msg.id);
    if (p) {
      pendingClientReqs.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Fake Antigravity ACP", version: "1.5.12-test" },
        agentCapabilities: {
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
        },
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    try {
      const sessionId = "sess-" + (++sessionSeq);
      let mcp = null;
      const servers = msg.params?.mcpServers || [];
      if (servers.length > 0) {
        mcp = startMcpClient(servers[0]);
        await mcp.call("initialize", { protocolVersion: "2024-11-05" });
        await mcp.call("tools/list", {});
      }
      sessions.set(sessionId, {
        id: sessionId,
        cwd: msg.params?.cwd,
        model: "gemini-4-neon",
        thoughtLevel: "high",
        mcp,
        cancelled: false,
      });
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId,
          models: {
            availableModels: [
              { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
              { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
              { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
              { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
              { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
              { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
              { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
              { modelId: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
              { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
              { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
            ],
            currentModelId: "gemini-4-neon-high",
          },
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: "gemini-4-neon",
              options: [
                { value: "gemini-4-neon", name: "Gemini 4 Neon" },
                { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
                { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
                { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
              ],
            },
            {
              id: "thought_level",
              category: "thought_level",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
                { value: "xhigh", name: "Extra" },
              ],
            },
          ],
          _meta: {
            antigravity: {
              tier: { name: "Google AI Pro", id: "g1-pro-tier" },
            },
          },
        },
      });
    } catch (err) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(err?.message ?? err) } });
    }
    return;
  }

  if (msg.method === "session/set_config_option") {
    const sess = sessions.get(msg.params?.sessionId);
    if (sess) {
      if (msg.params?.configId === "model") sess.model = msg.params.value;
      if (msg.params?.configId === "thought_level") sess.thoughtLevel = msg.params.value;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    return;
  }

  if (msg.method === "session/cancel") {
    const sess = sessions.get(msg.params?.sessionId);
    if (sess) sess.cancelled = true;
    return;
  }

  if (msg.method === "session/prompt") {
    handlePrompt(msg).catch((err) => {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: err.message } });
    });
  }
});

process.on("SIGTERM", () => {
  for (const s of sessions.values()) s.mcp?.close();
  process.exit(0);
});
`;
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

const tempDir = mkdtempSync(join(tmpdir(), "pi-agy-test-"));
const fakeAgy = createFakeAgyBinary(tempDir);

afterEach(() => {
  disposeAllAntigravitySessions();
  clearStatusCache();
});

after(() => {
  disposeAllAntigravitySessions();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(messages: Message[], systemPrompt = "You are Pi.", tools?: Tool[]) {
  const ctx: Context = { systemPrompt, messages, ...(tools ? { tools } : {}) };
  return normalizeContext(ctx);
}

describe("catalog & thinking levels", () => {
  it("parses clean base models and per-model thinkingLevelMaps from ACP session metadata", () => {
    const discovered = parseDiscoveredModels({
      models: {
        availableModels: [
          { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
          { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
          { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
          { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
          { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
          { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
          { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
          { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
        ],
      },
      configOptions: [
        {
          id: "model",
          options: [
            { value: "gemini-4-neon", name: "Gemini 4 Neon" },
            { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
            { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
          ],
        },
        {
          id: "thought_level",
          currentValue: "high",
          options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
        },
      ],
    });

    assert.equal(discovered.length, 3);

    const neon = modelFromDiscovery(discovered[0]);
    assert.deepEqual(getSupportedThinkingLevels(neon), ["low", "medium", "high", "xhigh"]);
    assert.equal(resolveAcpThoughtLevel(neon, "xhigh"), "xhigh");
    assert.equal(resolveAcpThoughtLevel(neon, "max"), "xhigh");

    const flash = modelFromDiscovery(discovered[1]);
    assert.deepEqual(getSupportedThinkingLevels(flash), ["low", "medium", "high"]);
    assert.equal(resolveAcpThoughtLevel(flash, "xhigh"), "high");

    const oss = modelFromDiscovery(discovered[2]);
    assert.deepEqual(getSupportedThinkingLevels(oss), ["medium"]);
    assert.equal(resolveAcpThoughtLevel(oss, "high"), "medium");
  });
});

describe("mcp tool mapping & argument sanitization", () => {
  it("sanitizes names, resolves collisions, and strips undeclared toolSummary", () => {
    const tools: Tool[] = [
      {
        name: "read",
        description: "Read file",
        parameters: Type.Object({ path: Type.String() }),
      },
      {
        name: "mcp.jira-search",
        description: "Search Jira",
        parameters: Type.Object({ q: Type.String(), toolSummary: Type.Optional(Type.String()) }),
      },
      {
        name: "mcp_jira_search",
        description: "Collision tool",
        parameters: Type.Object({ q: Type.String() }),
      },
    ];

    const mapping = buildToolMapping(tools);
    assert.equal(mapping.piToMcp.get("read"), "read");
    assert.equal(mapping.piToMcp.get("mcp.jira-search"), "mcp_jira_search");
    assert.equal(mapping.piToMcp.get("mcp_jira_search"), "mcp_jira_search_2");
    assert.equal(mapping.mcpToPi.get("mcp_jira_search_2"), "mcp_jira_search");

    assert.deepEqual(
      sanitizeToolArguments({ path: "a.ts", toolSummary: "Read a.ts" }, mapping.declaredKeysByMcpName.get("read")),
      { path: "a.ts" },
    );
    assert.deepEqual(
      sanitizeToolArguments(
        { q: "bug", toolSummary: "keep me" },
        mapping.declaredKeysByMcpName.get("mcp_jira_search"),
      ),
      { q: "bug", toolSummary: "keep me" },
    );
  });
});

describe("antigravity provider auth, discovery, and streaming", () => {
  const testEnv = { PI_ANTIGRAVITY_COMMAND: fakeAgy };

  it("discovers models, reports subscription auth, and registers cleanly in Pi Models", async () => {
    const status = await probeAntigravity(testEnv, undefined, { bypassCache: true });
    assert.equal(status.available, true);
    assert.equal(status.loggedIn, true);
    assert.equal(status.subscription, true);
    assert.equal(status.tierName, "Google AI Pro");
    assert.deepEqual(
      status.models.map((m) => m.id),
      ["gemini-4-neon", "gemini-3.8-flash", "claude-opus-5-5", "gpt-oss-120b-medium"],
    );

    const provider = createAntigravityProvider();
    const models = createModels({
      authContext: {
        env: async (name) => (name === "PI_ANTIGRAVITY_COMMAND" ? fakeAgy : process.env[name]),
        fileExists: async () => false,
      },
    });
    models.setProvider(provider);

    const authCheck = await models.checkAuth(PROVIDER_ID);
    assert.equal(authCheck?.type, "oauth");
    assert.match(authCheck?.source ?? "", /Google AI Pro/);

    const refresh = await models.refresh({ providers: [PROVIDER_ID], allowNetwork: true, force: true });
    assert.equal(refresh.errors.size, 0);
    const available = await models.getAvailable(PROVIDER_ID);
    assert.equal(available.length, 4);

    // OAuth login() refuses to steal credentials and directs user to `agy`.
    await assert.rejects(
      () => provider.auth.oauth!.login({} as never),
      /agy/,
    );
  });

  it("reports unconfigured when agy is not logged in", async () => {
    const status = await probeAntigravity(
      { PI_ANTIGRAVITY_COMMAND: fakeAgy, FAKE_AGY_MODE: "unauth" },
      undefined,
      { bypassCache: true },
    );
    assert.equal(status.loggedIn, false);
    assert.match(status.detail ?? "", /agy/);
  });

  it("streams thinking, text, Unicode, usage, and instrumentation hooks", async () => {
    const model = modelFromDiscovery({
      id: "gemini-4-neon",
      name: "Gemini 4 Neon",
      thoughtLevels: ["low", "medium", "high", "xhigh"],
      imageInput: true,
    });

    const events: AssistantMessageEvent[] = [];
    let sawPayload = false;
    let sawResponse = false;
    let providerEvents = 0;

    const stream = streamAntigravity(
      model,
      makeContext([{ role: "user", content: "Hello world", timestamp: Date.now() }]),
      {
        env: testEnv,
        reasoning: "xhigh",
        sessionId: "t-basic",
        onPayload: (payload) => {
          sawPayload = Boolean(payload);
          return undefined;
        },
        onResponse: (res) => {
          sawResponse = res.status === 200;
        },
        onProviderStreamEvent: () => {
          providerEvents++;
        },
      },
    );

    for await (const ev of stream) events.push(ev);
    const msg = await stream.result();

    assert.equal(sawPayload, true);
    assert.equal(sawResponse, true);
    assert.ok(providerEvents >= 2);
    assert.equal(events[0].type, "start");
    assert.equal(events[events.length - 1].type, "done");
    assert.equal(msg.stopReason, "stop");
    assert.equal(msg.providerThinkingLevel, "xhigh");
    assert.equal(msg.content[0].type, "thinking");
    assert.equal(msg.content[1].type, "text");
    assert.match((msg.content[1] as { text: string }).text, /Hello world 🚀日本語/);
    assert.equal(msg.usage.input, 25);
    assert.equal(msg.usage.output, 15);
    assert.equal(msg.usage.cacheRead, 5);
    assert.equal(msg.usage.reasoning, 6);
    assert.equal(msg.usage.totalTokens, 45);
  });

  it("handles empty responses cleanly with balanced start -> done", async () => {
    const model = modelFromDiscovery({
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      thoughtLevels: ["low", "medium", "high"],
      imageInput: true,
    });

    const events: AssistantMessageEvent[] = [];
    const stream = streamAntigravity(
      model,
      makeContext([{ role: "user", content: "TRIGGER_EMPTY", timestamp: Date.now() }]),
      { env: testEnv, sessionId: "t-empty" },
    );
    for await (const ev of stream) events.push(ev);
    const msg = await stream.result();

    assert.deepEqual(
      events.map((e) => e.type),
      ["start", "done"],
    );
    assert.equal(msg.stopReason, "stop");
    assert.deepEqual(msg.content, []);
  });

  it("bridges Pi tool calls via suspended MCP (including image tool results) in one live ACP turn", async () => {
    const model = modelFromDiscovery({
      id: "gemini-4-neon",
      name: "Gemini 4 Neon",
      thoughtLevels: ["low", "medium", "high", "xhigh"],
      imageInput: true,
    });
    const tools: Tool[] = [
      { name: "read", description: "Read file", parameters: Type.Object({ path: Type.String() }) },
    ];

    const u1: Message = { role: "user", content: "TRIGGER_TOOL_ROUNDTRIP", timestamp: Date.now() };
    const s1 = streamAntigravity(model, makeContext([u1], "Host prompt", tools), {
      env: testEnv,
      reasoning: "high",
      sessionId: "t-tool",
    });
    const m1 = await s1.result();

    assert.equal(m1.stopReason, "toolUse", `Expected toolUse, got ${m1.stopReason}: ${m1.errorMessage}`);
    const tc = m1.content.find((b) => b.type === "toolCall");
    assert.ok(tc && tc.type === "toolCall");
    assert.equal(tc.id, "acp_call_1");
    assert.equal(tc.name, "read");
    // `toolSummary` injected by agy must be stripped because `read` didn't declare it.
    assert.deepEqual(tc.arguments, { path: "foo.ts" });

    // Pi executes `read` and returns text + image back into turn 2.
    const tr1: Message = {
      role: "toolResult",
      toolCallId: tc.id,
      toolName: "read",
      content: [
        { type: "text", text: "FILE_CONTENT_OK" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: Date.now(),
    };
    const s2 = streamAntigravity(model, makeContext([u1, m1, tr1], "Host prompt", tools), {
      env: testEnv,
      reasoning: "high",
      sessionId: "t-tool",
    });
    const m2 = await s2.result();

    assert.equal(m2.stopReason, "stop");
    const finalText = m2.content.find((b) => b.type === "text");
    assert.ok(finalText && finalText.type === "text");
    assert.match(finalText.text, /FINAL:FILE_CONTENT_OK\|IMG:1\|SID:sess-1/);
    assert.equal(m2.usage.totalTokens, 190);

    // Follow-up linear user turn reuses the exact same ACP sessionId (`sess-1`) and updates thought_level.
    const u2: Message = { role: "user", content: "Follow up", timestamp: Date.now() };
    const s3 = streamAntigravity(model, makeContext([u1, m1, tr1, m2, u2], "Host prompt", tools), {
      env: testEnv,
      reasoning: "low",
      sessionId: "t-tool",
    });
    const m3 = await s3.result();
    const followText = m3.content.find((b) => b.type === "text");
    assert.ok(followText && followText.type === "text");
    assert.match(followText.text, /ECHO\[sess-1\|gemini-4-neon\|low\|imgs=0\]/);
  });

  it("handles multi-step sequential tool calls and Pi codemode tool", async () => {
    const model = modelFromDiscovery({
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      thoughtLevels: ["low", "medium", "high"],
      imageInput: true,
    });
    const tools: Tool[] = [
      { name: "alpha", description: "Alpha", parameters: Type.Object({ k: Type.String() }) },
      { name: "beta", description: "Beta", parameters: Type.Object({ k: Type.String() }) },
      { name: "codemode", description: "Run JS", parameters: Type.Object({ code: Type.String() }) },
    ];

    // Two sequential MCP calls in a single ACP turn.
    const u1: Message = { role: "user", content: "TRIGGER_TWO_TOOLS", timestamp: Date.now() };
    const a1 = await streamAntigravity(model, makeContext([u1], "Pi", tools), { env: testEnv, sessionId: "t-two" }).result();
    assert.equal(a1.stopReason, "toolUse", `Expected toolUse, got ${a1.stopReason}: ${a1.errorMessage}`);
    const tc1 = a1.content.find((b) => b.type === "toolCall")!;
    assert.equal(tc1.type === "toolCall" && tc1.name, "alpha");

    const tr1: Message = { role: "toolResult", toolCallId: tc1.type === "toolCall" ? tc1.id : "", toolName: "alpha", content: [{ type: "text", text: "A1" }], isError: false, timestamp: Date.now() };
    const a2 = await streamAntigravity(model, makeContext([u1, a1, tr1], "Pi", tools), { env: testEnv, sessionId: "t-two" }).result();
    assert.equal(a2.stopReason, "toolUse");
    const tc2 = a2.content.find((b) => b.type === "toolCall")!;
    assert.equal(tc2.type === "toolCall" && tc2.name, "beta");

    const tr2: Message = { role: "toolResult", toolCallId: tc2.type === "toolCall" ? tc2.id : "", toolName: "beta", content: [{ type: "text", text: "B2" }], isError: false, timestamp: Date.now() };
    const a3 = await streamAntigravity(model, makeContext([u1, a1, tr1, a2, tr2], "Pi", tools), { env: testEnv, sessionId: "t-two" }).result();
    assert.equal(a3.stopReason, "stop");
    assert.match((a3.content.find((b) => b.type === "text") as { text: string }).text, /BOTH:A1\+B2/);

    // Codemode tool round-trip.
    const uCm: Message = { role: "user", content: "TRIGGER_CODEMODE", timestamp: Date.now() };
    const cm1 = await streamAntigravity(model, makeContext([uCm], "Pi", tools), { env: testEnv, sessionId: "t-cm" }).result();
    assert.equal(cm1.stopReason, "toolUse");
    const cmCall = cm1.content.find((b) => b.type === "toolCall")!;
    assert.ok(cmCall.type === "toolCall");
    assert.equal(cmCall.name, "codemode");
    assert.deepEqual(cmCall.arguments, { code: "return 21 * 2;" });

    const cmRes: Message = { role: "toolResult", toolCallId: cmCall.id, toolName: "codemode", content: [{ type: "text", text: "Script completed: 42" }], isError: false, timestamp: Date.now() };
    const cm2 = await streamAntigravity(model, makeContext([uCm, cm1, cmRes], "Pi", tools), { env: testEnv, sessionId: "t-cm" }).result();
    assert.equal(cm2.stopReason, "stop");
    assert.match((cm2.content.find((b) => b.type === "text") as { text: string }).text, /CM:Script completed: 42/);
  });

  it("strictly denies non-Pi built-in tools requested via session/request_permission", async () => {
    const model = modelFromDiscovery({
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      thoughtLevels: ["low", "medium", "high"],
      imageInput: true,
    });
    const msg = await streamAntigravity(
      model,
      makeContext([{ role: "user", content: "TRIGGER_BUILTIN_DENY", timestamp: Date.now() }]),
      { env: testEnv, sessionId: "t-deny" },
    ).result();

    assert.equal(msg.stopReason, "stop");
    const txt = msg.content.find((b) => b.type === "text") as { text: string };
    assert.equal(txt.text, "BUILTIN_OUTCOME:deny");
  });

  it("replays history cleanly on cross-provider handoff and passes user images", async () => {
    const model = modelFromDiscovery({
      id: "gemini-4-neon",
      name: "Gemini 4 Neon",
      thoughtLevels: ["low", "medium", "high", "xhigh"],
      imageInput: true,
    });

    const history: Message[] = [
      { role: "user", content: "Earlier question to OpenAI", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier OpenAI answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-6.1-sol",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this screenshot" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        timestamp: 3,
      },
    ];

    const msg = await streamAntigravity(model, makeContext(history), { env: testEnv, sessionId: "t-handoff" }).result();
    assert.equal(msg.stopReason, "stop");
    const txt = (msg.content.find((b) => b.type === "text") as { text: string }).text;
    assert.match(txt, /imgs=1/);
    assert.match(txt, /Prior conversation history/);
  });

  it("converts AbortSignal into aborted result and surfaces backend errors", async () => {
    const model = modelFromDiscovery({
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      thoughtLevels: ["low", "medium", "high"],
      imageInput: true,
    });

    const ac = new AbortController();
    const slowStream = streamAntigravity(
      model,
      makeContext([{ role: "user", content: "TRIGGER_SLOW", timestamp: Date.now() }]),
      { env: testEnv, signal: ac.signal, sessionId: "t-abort" },
    );
    setTimeout(() => ac.abort(), 150);
    const abortedMsg = await slowStream.result();
    assert.equal(abortedMsg.stopReason, "aborted");
    assert.match(abortedMsg.errorMessage ?? "", /aborted/i);

    const overflowMsg = await streamAntigravity(
      model,
      makeContext([{ role: "user", content: "TRIGGER_ERROR", timestamp: Date.now() }]),
      { env: testEnv, sessionId: "t-err" },
    ).result();
    assert.equal(overflowMsg.stopReason, "error");
    assert.match(overflowMsg.errorMessage ?? "", /context_length_exceeded/);

    const crashMsg = await streamAntigravity(
      model,
      makeContext([{ role: "user", content: "TRIGGER_CRASH", timestamp: Date.now() }]),
      { env: testEnv, sessionId: "t-crash" },
    ).result();
    assert.equal(crashMsg.stopReason, "error");
    assert.match(crashMsg.errorMessage ?? "", /exited unexpectedly/);
  });

  it("registers the provider and /antigravity-status command via ExtensionAPI", () => {
    let registeredProviderId: string | undefined;
    let registeredCommand: string | undefined;
    let shutdownRegistered = false;

    antigravityExtension({
      registerProvider(provider: { id: string }) {
        registeredProviderId = provider.id;
      },
      registerCommand(name: string) {
        registeredCommand = name;
      },
      on(event: string) {
        if (event === "session_shutdown") shutdownRegistered = true;
      },
    } as never);

    assert.equal(registeredProviderId, "antigravity");
    assert.equal(registeredCommand, "antigravity-status");
    assert.equal(shutdownRegistered, true);
  });
});
