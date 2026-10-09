import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore,
  type AssistantMessage, type Context, type Model,
  type StreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionEvent, type ExtensionAPI,
  type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "./index.ts";
import { progressLines, roles, runBatch, type Details } from "./runner.ts";

const model: Model<any> = {
  type: "chat", api: "pi-kit-test", provider: "pi-kit-test", id: "fixture", name: "Fixture",
  baseUrl: "http://unused.invalid", reasoning: true, input: ["text"],
  contextWindow: 128000, maxTokens: 8192,
  cost: { input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0 },
};
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const modelRegistry = new ModelRegistry(modelRuntime);
const parent = { cwd: process.cwd(), model, modelRegistry, thinkingLevel: "high" as const, projectTrusted: false };

function message(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: model.api,
    provider: model.provider, model: model.id, timestamp: Date.now(), stopReason,
    usage: { input: 11, output: 6, cacheRead: 3, cacheWrite: 0, totalTokens: 20,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0, total: 0.033 } },
  };
}

function fakeSession(prompt: (emit: (event: AgentSessionEvent) => void, task: string) => Promise<void>) {
  let listener = (_event: AgentSessionEvent) => {};
  let release = () => {};
  return {
    messages: [message("Final fixture answer")],
    disposed: false,
    unsubscribed: false,
    aborts: 0,
    subscribe(fn: typeof listener) { listener = fn; return () => { this.unsubscribed = true; }; },
    async prompt(task: string) { await prompt((event) => listener(event), task); },
    async abort() { this.aborts++; release(); },
    dispose() { this.disposed = true; },
    wait() { return new Promise<void>((resolve) => { release = resolve; }); },
  };
}

test("real SDK sessions restrict tools, inherit model/auth/thinking, retain instructions, and isolate history/resources", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-kit-sdk-"));
  const agentDir = path.join(dir, "agent");
  const contexts: TranscriptContext[] = [];
  modelRegistry.registerProvider("pi-kit-test", {
    apiKey: "non-secret-fixture", api: model.api,
    streamSimple: (_model, context, options) => {
      contexts.push(JSON.parse(JSON.stringify(context)));
      assert.equal(options?.apiKey, "non-secret-fixture");
      const stream = createAssistantMessageEventStream();
      const toolResult = context.messages.find((m) => m.role === "toolResult");
      const final = message(toolResult ? "Found: asymmetric evidence ✓" : "intermediate text", toolResult ? "stop" : "toolUse");
      if (!toolResult) final.content = [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "evidence.txt" } }];
      stream.push({ type: "start", partial: final });
      stream.push({ type: "done", reason: final.stopReason as "stop" | "toolUse", message: final });
      stream.end();
      return stream;
    },
  });
  await mkdir(agentDir);
  await writeFile(path.join(dir, "AGENTS.md"), "Always cite local evidence.");
  await writeFile(path.join(dir, "evidence.txt"), "asymmetric evidence ✓");
  await mkdir(path.join(dir, ".pi", "extensions"), { recursive: true });
  await writeFile(path.join(dir, ".pi", "extensions", "must-not-load.ts"), "throw new Error('inherited extension');");
  const updates: Details[] = [];
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
  try {
    const result = await runBatch([{ role: "scout", task: "Find evidence." }, { role: "critic", task: "Check the evidence." }], {
      parent: { ...parent, cwd: dir, agentDir }, concurrency: 2, timeoutMs: 5000,
      onUpdate: (d) => updates.push(d),
      createSession: async (options) => {
        assert.notEqual(options.modelRuntime, modelRuntime);
        assert.deepEqual(await options.modelRuntime!.listCredentials(), []);
        assert.equal(options.model, model);
        assert.equal(options.sessionManager?.getSessionFile(), undefined);
        assert.deepEqual(options.resourceLoader?.getExtensions().extensions, []);
        assert.deepEqual(options.resourceLoader?.getSkills().skills, []);
        assert.deepEqual(options.resourceLoader?.getPrompts().prompts, []);
        assert.match(options.resourceLoader!.getAgentsFiles().agentsFiles.map((f) => f.content).join("\n"), /Always cite local evidence/);
        const child = await createAgentSession(options);
        assert.deepEqual(child.session.getActiveToolNames(), ["read", "grep", "find", "ls"]);
        assert.equal(child.session.thinkingLevel, "high");
        assert.equal(child.session.messages.length, 0);
        sessions.push(child.session);
        return child;
      },
    });
    assert.equal(result.results[0].status, "completed", JSON.stringify(result.results));
    assert.deepEqual(result.results.map((r) => [r.status, r.answer, r.tools, r.tokens, r.cost]), [
      ["completed", "Found: asymmetric evidence ✓", 1, 40, 0.066],
      ["completed", "Found: asymmetric evidence ✓", 1, 40, 0.066],
    ]);
    assert.notEqual(sessions[0].sessionId, sessions[1].sessionId);
    assert.equal(contexts.length, 4);
    assert.equal(contexts.filter((c) => !c.messages.some((m) => m.role === "assistant")).length, 2);
    assert.ok(contexts.every((c) => c.messages.filter((m) => m.role === "user").length === 1));
    for (const context of contexts) {
      const prompt = getCurrentSystemPrompt(context.messages);
      assert.match(prompt, /expert coding assistant/);
      assert.match(prompt, /<rules>/);
      assert.match(prompt, /Always cite local evidence/);
      assert.match(prompt, /read-only exploration agent|independent critic/);
      assert.equal(prompt.split("Do not delegate further or launch nested Pi sessions.").length - 1, 1);
    }
    assert.ok(contexts.some((c) => c.messages.some((m) => m.role === "toolResult" && m.content.some((part) => part.type === "text" && part.text.includes("asymmetric evidence")))));
    assert.ok(updates.some((d) => d.results.some((r) => r.status === "running")));
    assert.deepEqual(updates[0].results.map((r) => r.status), ["queued", "queued"], "snapshots must not mutate after delivery");
  } finally {
    modelRegistry.unregisterProvider("pi-kit-test");
    await rm(dir, { recursive: true, force: true });
  }
});

test("child prompts preserve configured additions without extending project trust or accumulating role instructions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-kit-prompts-"));
  const agentDir = path.join(dir, "agent");
  const cwd = path.join(dir, "project");
  const otherCwd = path.join(dir, "other-project");
  const prompts: string[] = [];
  modelRegistry.registerProvider("pi-kit-test", {
    apiKey: "non-secret-fixture", api: model.api,
    streamSimple: (_model, context) => {
      prompts.push(getCurrentSystemPrompt(context.messages));
      const stream = createAssistantMessageEventStream();
      const final = message("Prompt fixture finished");
      stream.push({ type: "start", partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
      stream.end();
      return stream;
    },
  });
  try {
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, "AGENTS.md"), "GLOBAL_CONTEXT_FIXTURE");
    await writeFile(path.join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL_APPEND_FIXTURE");
    for (const project of [cwd, otherCwd]) {
      await mkdir(path.join(project, ".pi"), { recursive: true });
      await writeFile(path.join(project, "AGENTS.md"), "PROJECT_CONTEXT_FIXTURE");
      await writeFile(path.join(project, ".pi", "SYSTEM.md"), "PROJECT_BASE_FIXTURE");
      await writeFile(path.join(project, ".pi", "APPEND_SYSTEM.md"), "PROJECT_APPEND_FIXTURE");
    }
    const cases = [
      { projectTrusted: false, customBase: false, childCwd: cwd, base: /expert coding assistant/, append: "GLOBAL_APPEND_FIXTURE" },
      { projectTrusted: false, customBase: true, childCwd: cwd, base: /GLOBAL_BASE_FIXTURE/, append: "GLOBAL_APPEND_FIXTURE" },
      { projectTrusted: true, customBase: true, childCwd: cwd, base: /PROJECT_BASE_FIXTURE/, append: "PROJECT_APPEND_FIXTURE" },
      { projectTrusted: true, customBase: true, childCwd: otherCwd, base: /GLOBAL_BASE_FIXTURE/, append: "GLOBAL_APPEND_FIXTURE" },
    ];
    for (const scenario of cases) {
      if (scenario.customBase) await writeFile(path.join(agentDir, "SYSTEM.md"), "GLOBAL_BASE_FIXTURE");
      prompts.length = 0;
      const result = await runBatch(Array.from({ length: 2 }, () => ({
        role: "implementer" as const, task: "Inspect prompt delivery.", cwd: scenario.childCwd,
      })), {
        parent: { ...parent, cwd, agentDir, projectTrusted: scenario.projectTrusted },
        concurrency: 1, timeoutMs: 5000,
      });
      assert.deepEqual(result.results.map((r) => r.status), ["completed", "completed"], JSON.stringify(result));
      assert.equal(prompts.length, 2);
      for (const prompt of prompts) {
        assert.match(prompt, scenario.base);
        assert.match(prompt, /GLOBAL_CONTEXT_FIXTURE/);
        assert.match(prompt, /PROJECT_CONTEXT_FIXTURE/);
        assert.equal(prompt.split(scenario.append).length - 1, 1);
        assert.equal(prompt.split("You implement exactly one task.").length - 1, 1);
        assert.equal(prompt.split("Do not delegate further or launch nested Pi sessions.").length - 1, 1);
        if (scenario.append === "GLOBAL_APPEND_FIXTURE") {
          assert.doesNotMatch(prompt, /PROJECT_BASE_FIXTURE|PROJECT_APPEND_FIXTURE/);
        } else {
          assert.doesNotMatch(prompt, /GLOBAL_BASE_FIXTURE|GLOBAL_APPEND_FIXTURE/);
        }
      }
    }
  } finally {
    modelRegistry.unregisterProvider("pi-kit-test");
    await rm(dir, { recursive: true, force: true });
  }
});

test("child runtimes resolve changing CLI keys, OAuth and header-only auth without storing credentials", async () => {
  for (const mode of ["runtime-key", "oauth", "headers"] as const) {
    const credentials = new InMemoryCredentialStore();
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    let revision = 1;
    let refreshes = 0;
    const requests: unknown[] = [];
    const stream = (requestModel: Model<any>, _context: TranscriptContext, options?: StreamOptions) => {
      requests.push({ apiKey: options?.apiKey, headers: options?.headers, env: options?.env, baseUrl: requestModel.baseUrl });
      const events = createAssistantMessageEventStream();
      const final = message("Authenticated fixture response");
      events.push({ type: "start", partial: final });
      events.push({ type: "done", reason: "stop", message: final });
      events.end();
      return events;
    };
    registry.registerProvider({
      id: model.provider, name: "Fixture", getModels: () => [model], stream, streamSimple: stream,
      auth: mode === "oauth" ? { oauth: {
        name: "Fixture OAuth",
        login: async () => { throw new Error("Must not log in again"); },
        refresh: async (credential) => ({ ...credential, access: `refreshed-${++refreshes}`, expires: Date.now() + 3600000 }),
        toAuth: async (credential) => ({ apiKey: credential.access, headers: { "x-fixture": String(revision) }, baseUrl: `http://endpoint-${revision}.invalid` }),
      } } : { apiKey: {
        name: "Fixture key",
        resolve: async ({ credential }) => ({
          auth: { apiKey: mode === "headers" ? undefined : credential?.key,
            headers: { "x-fixture": String(revision) }, baseUrl: `http://endpoint-${revision}.invalid` },
          env: { FIXTURE_REGION: `region-${revision}` },
        }),
      } },
    });
    if (mode === "oauth") {
      await credentials.modify(model.provider, async () => ({ type: "oauth", access: "expired", refresh: "fixture", expires: 0 }));
    } else if (mode === "runtime-key") {
      await credentials.modify(model.provider, async () => ({ type: "api_key", key: "must-not-shadow-cli-key" }));
      await runtime.setRuntimeApiKey(model.provider, "cli-key-1");
    }
    const result = await runBatch([{ role: "scout", task: "inspect" }], {
      parent: { ...parent, modelRegistry: registry }, concurrency: 1, timeoutMs: 5000,
      createSession: async (options) => {
        const childRuntime = options.modelRuntime!;
        const context: Context = { messages: [{ role: "user", content: "fixture", timestamp: 0 }] };
        assert.equal((await childRuntime.completeSimple(model, context)).stopReason, "stop");
        revision = 2;
        if (mode === "runtime-key") await runtime.setRuntimeApiKey(model.provider, "cli-key-2");
        if (mode === "oauth") {
          await credentials.modify(model.provider, async (credential) => ({ ...credential!, type: "oauth", access: "expired-again", refresh: "fixture", expires: 0 }));
        }
        assert.equal((await childRuntime.completeSimple(model, context)).stopReason, "stop");
        assert.deepEqual(await childRuntime.listCredentials(), []);
        return { session: fakeSession(async () => {}) };
      },
    });
    assert.equal(result.results[0].status, "completed", JSON.stringify(result));
    assert.deepEqual(requests, [1, 2].map((i) => ({
      apiKey: mode === "runtime-key" ? `cli-key-${i}` : mode === "oauth" ? `refreshed-${i}` : undefined,
      headers: { "x-fixture": String(i) },
      env: mode === "oauth" ? undefined : { FIXTURE_REGION: `region-${i}` },
      baseUrl: `http://endpoint-${i}.invalid`,
    })), mode);
    if (mode === "oauth") assert.equal(refreshes, 2);
  }
});

test("bounded workers preserve input order even when siblings finish out of order", async () => {
  let running = 0;
  let peak = 0;
  const finished: number[] = [];
  const children: ReturnType<typeof fakeSession>[] = [];
  const result = await runBatch(["slow", "fast", "third"].map((task) => ({ role: "scout", task })), {
    parent, concurrency: 2, timeoutMs: 5000,
    createSession: async () => {
      const child = fakeSession(async (_emit, task) => {
        const index = ["slow", "fast", "third"].indexOf(task);
        child.messages = [message(`answer ${index}`)];
        peak = Math.max(peak, ++running);
        await delay(index === 0 ? 100 : 10);
        running--;
        finished.push(index);
      });
      children.push(child);
      return { session: child };
    },
  });
  assert.equal(peak, 2);
  assert.deepEqual(finished, [1, 2, 0]);
  assert.deepEqual(result.results.map((r) => r.answer), ["answer 0", "answer 1", "answer 2"]);
  assert.ok(children.every((c) => c.disposed && c.unsubscribed));
});

test("all bundled roles keep their explicit tool lists; cwd and provider/model overrides are resolved", async () => {
  const alternate = { ...model, provider: "fixture-provider", id: "alternate" };
  const registry = Object.create(modelRegistry) as ModelRegistry;
  registry.find = (provider: string, id: string) => provider === "fixture-provider" && id === "alternate" ? alternate : undefined;
  const lists: string[][] = [];
  await runBatch(roles.map((role) => ({ role, task: "inspect", cwd: "..", model: "fixture-provider/alternate" })), {
    parent: { ...parent, modelRegistry: registry }, concurrency: 1, timeoutMs: 5000,
    createSession: async (options) => {
      assert.equal(options.model, alternate);
      assert.equal(options.cwd, path.resolve(parent.cwd, ".."));
      lists.push(options.tools!);
      return { session: fakeSession(async () => {}) };
    },
  });
  assert.deepEqual(lists, [
    ["read", "grep", "find", "ls"], ["read", "grep", "find", "ls"],
    ["read", "bash", "edit", "write"], ["read", "grep", "find", "ls"],
    ["read", "bash", "grep", "find", "ls"],
  ]);
});

test("provider errors, truncation and empty output cannot become successful answers; siblings survive", async () => {
  let index = 0;
  const children: ReturnType<typeof fakeSession>[] = [];
  const result = await runBatch(Array.from({ length: 4 }, () => ({ role: "scout" as const, task: "inspect" })), {
    parent, concurrency: 1, timeoutMs: 5000,
    createSession: async () => {
      const child = fakeSession(async () => {});
      child.messages = [message(index === 2 ? "   " : "misleading partial answer", ["error", "length", "stop", "stop"][index++] as AssistantMessage["stopReason"])];
      children.push(child);
      return { session: child };
    },
  });
  assert.deepEqual(result.results.map((r) => r.status), ["failed", "failed", "failed", "completed"]);
  assert.deepEqual(result.results.slice(0, 3).map((r) => r.answer), ["", "", ""]);
  assert.ok(children.every((c) => c.disposed && c.unsubscribed));
});

test("parent cancellation aborts running work and skips queued sessions", async () => {
  const controller = new AbortController();
  let created = 0;
  const child = fakeSession(async () => {});
  // Abort after prompt has entered its wait, matching a user pressing Escape.
  child.prompt = async () => { const waiting = child.wait(); controller.abort(); await waiting; };
  const result = await runBatch(Array.from({ length: 3 }, () => ({ role: "auditor" as const, task: "verify" })), {
    parent, concurrency: 1, timeoutMs: 5000, signal: controller.signal,
    createSession: async () => { created++; return { session: child }; },
  });
  assert.equal(created, 1);
  assert.deepEqual(result.results.map((r) => r.status), ["cancelled", "cancelled", "cancelled"]);
  assert.equal(child.aborts, 1);
  assert.ok(child.disposed && child.unsubscribed);
});

test("timeout aborts and disposes a child instead of accepting its partial text", async () => {
  const child = fakeSession(async () => { await child.wait(); });
  const result = await runBatch([{ role: "scout", task: "wait" }], {
    parent, concurrency: 1, timeoutMs: 50,
    createSession: async () => ({ session: child }),
  });
  assert.equal(result.results[0].status, "timed_out");
  assert.equal(result.results[0].answer, "");
  assert.match(result.results[0].error!, /Timed out after 0.05s/);
  assert.ok(child.disposed && child.unsubscribed);
});

test("cancellation during async session creation disposes the late session without prompting", async () => {
  const controller = new AbortController();
  let prompted = false;
  const child = fakeSession(async () => { prompted = true; });
  const result = await runBatch([{ role: "scout", task: "wait" }], {
    parent, concurrency: 1, timeoutMs: 5000, signal: controller.signal,
    createSession: async () => { controller.abort(); await delay(10); return { session: child }; },
  });
  assert.equal(result.results[0].status, "cancelled");
  assert.equal(prompted, false);
  assert.ok(child.disposed);
});

test("invalid batch limits and unknown models do not start children", async () => {
  const options = { parent, concurrency: 1, timeoutMs: 1000, createSession: async () => { throw new Error("must not launch"); } };
  await assert.rejects(runBatch([], options), /1–8/);
  await assert.rejects(runBatch([{ role: "scout", task: "inspect" }], { ...options, concurrency: 5 }), /1 to 4/);
  const result = await runBatch([{ role: "scout", task: "inspect", model: "missing/no-model" }], options);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error!, /Unknown model/);
  const virtual = await runBatch([{ role: "scout", task: "inspect" }], { ...options, parent: { ...parent, model: { ...model, api: "pi-virtual" } } });
  assert.equal(virtual.results[0].status, "failed");
  assert.match(virtual.results[0].error!, /physical provider\/model-id/);
});

test("the extension exposes role capabilities and delegation guidance to Pi without a skill", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-kit-extension-"));
  const contexts: TranscriptContext[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  modelRegistry.registerProvider("pi-kit-test", {
    apiKey: "non-secret-fixture", api: model.api,
    streamSimple: (_model, context) => {
      contexts.push(context);
      const stream = createAssistantMessageEventStream();
      const final = message("Main agent fixture finished");
      stream.push({ type: "start", partial: final });
      stream.push({ type: "done", reason: "stop", message: final });
      stream.end();
      return stream;
    },
  });
  try {
    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [extension],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, model, modelRuntime, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(dir),
    }));
    await session.bindExtensions({});
    await session.prompt("Inspect the available delegation capabilities.");
    assert.equal(contexts.length, 1);
    const context = contexts[0];
    const tool = getCurrentTools(context.messages).find((tool) => tool.name === "subagent");
    assert.ok(tool, "subagent must be declared without loading a skill");
    for (const role of ["scout", "planner", "implementer", "critic", "auditor"]) {
      assert.match(tool.description, new RegExp(`${role}: .+Tools:`));
    }
    assert.match(tool.description, /critic:.*read-only.*Tools: read, grep, find, ls/);
    assert.match(tool.description, /auditor:.*shell access.*Tools: read, bash/);
    const prompt = getCurrentSystemPrompt(context.messages);
    assert.match(prompt, /Work directly by default/);
    assert.match(prompt, /self-contained brief/);
    assert.match(prompt, /completed status only means the child returned/);
    assert.match(prompt, /critic cannot run git or tests/);
    assert.doesNotMatch(prompt, /<available_skills>/);
  } finally {
    session?.dispose();
    modelRegistry.unregisterProvider("pi-kit-test");
    await rm(dir, { recursive: true, force: true });
  }
});

async function captureExtension() {
  let tool: ToolDefinition<any, Details>;
  let command: { handler: (args: string, ctx: any) => Promise<void> };
  const events = new Map<string, Function>();
  await extension({
    registerTool: (value: typeof tool) => { tool = value; },
    registerCommand: (_name: string, value: typeof command) => { command = value; },
    on: (name: string, handler: Function) => { events.set(name, handler); },
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI);
  return { tool: tool!, command: command!, events };
}

test("tool renderer shows progress at narrow widths, expands answers, and command clears the UI", async () => {
  const { tool, command, events } = await captureExtension();
  const details: Details = { results: [{ role: "scout", task: "Find evidence", id: 1,
    status: "completed", activity: "Finished", tools: 3, tokens: 42, cost: 0.1,
    elapsedMs: 2500, answer: "Evidence in retry.ts:17" }] };
  const result = { content: [{ type: "text" as const, text: "answer" }], details };
  const theme = { fg: (_color: string, text: string) => text } as any;
  const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {} as any).render(60);
  const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {} as any).render(60);
  assert.match(collapsed.join("\n"), /1\/1 settled/);
  assert.match(collapsed.join("\n"), /completed/);
  assert.doesNotMatch(collapsed.join("\n"), /Evidence in/);
  assert.match(expanded.join("\n"), /Evidence in retry.ts:17/);
  assert.ok(expanded.every((line) => visibleWidth(line) <= 60));
  const partial = tool.renderResult!(result, { expanded: false, isPartial: true }, theme, {} as any).render(100);
  assert.match(partial.join("\n"), /live progress below/);
  assert.doesNotMatch(partial.join("\n"), /3 tools/);
  const expandedPartial = tool.renderResult!(result, { expanded: true, isPartial: true }, theme, {} as any).render(100);
  assert.deepEqual(expandedPartial, partial, "live widget owns per-agent progress even when tool results are expanded");
  assert.equal(await events.get("tool_result")!({ toolName: "read", details }), undefined);
  assert.equal(await events.get("tool_result")!({ toolName: "subagent", details }), undefined);
  details.results[0].status = "failed";
  assert.deepEqual(await events.get("tool_result")!({ toolName: "subagent", details }), { isError: true });
  const cleared: unknown[][] = [];
  await command.handler("clear", { mode: "tui", ui: { setWidget: (...args: unknown[]) => cleared.push(args), setStatus: (...args: unknown[]) => cleared.push(args) } });
  assert.deepEqual(cleared, [["subagents", undefined], ["subagents", undefined]]);
  details.results[0].activity = "malicious\n\u001b[2J text";
  assert.ok(progressLines(details).every((line) => !/[\x00-\x1f\x7f-\x9f]/.test(line)));
});

test("shutdown cancels pending batch, clears UI and suppresses late progress writes", async () => {
  const { tool, events } = await captureExtension();
  const writes: string[] = [];
  const ctx = { cwd: process.cwd(), model, modelRegistry, hasUI: true, mode: "tui",
    isProjectTrusted: () => false,
    ui: { setWidget: (_key: string, value: unknown) => writes.push(value ? "widget" : "clear widget"),
      setStatus: (_key: string, value: unknown) => writes.push(value ? "status" : "clear status") } } as unknown as ExtensionToolContext;
  const pending = tool.execute("fixture", { tasks: [{ role: "scout", task: "inspect" }] }, undefined, undefined, ctx);
  await events.get("session_shutdown")!({}, ctx);
  const result = await pending;
  assert.equal(result.details.results[0].status, "cancelled");
  assert.deepEqual(writes.slice(-2), ["clear widget", "clear status"]);
  assert.equal(writes.filter((w) => w === "widget").length, 2);
});

test("RPC clients receive structured updates without terminal widget calls", async () => {
  const { tool, command, events } = await captureExtension();
  assert.equal(tool.exposure, "model-only");
  const ctx = { ...parent, hasUI: true, mode: "rpc", isProjectTrusted: () => false, ui: {
    setWidget: () => { throw new Error("Terminal-only widget called in RPC"); },
    setStatus: () => { throw new Error("Terminal-only status called in RPC"); },
  } } as unknown as ExtensionToolContext;
  const updates: Details[] = [];
  const result = await tool.execute("rpc", { tasks: [{ role: "scout", task: "inspect" }] },
    AbortSignal.abort(), (update) => updates.push(update.details!), ctx);
  assert.deepEqual(updates.map((d) => d.results[0].status), ["queued", "cancelled"]);
  assert.equal(result.details.results[0].status, "cancelled");
  await command.handler("clear", ctx);
  await events.get("session_shutdown")!({}, ctx);
});
