import { readFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

export const roles = ["scout", "planner", "implementer", "critic", "auditor"] as const;
export type Role = (typeof roles)[number];
export interface Task {
  role: Role;
  task: string;
  cwd?: string;
  model?: string;
}
export interface Progress extends Task {
  id: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
  activity: string;
  tools: number;
  tokens: number;
  cost: number;
  elapsedMs: number;
  answer: string;
  error?: string;
}
export interface Details {
  results: Progress[];
}
type Child = Pick<AgentSession, "subscribe" | "prompt" | "abort" | "dispose" | "messages">;
type SessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: Child }>;
type Parent = Pick<CreateAgentSessionOptions, "model" | "thinkingLevel" | "agentDir"> & {
  cwd: string;
  modelRegistry: ModelRegistry;
  projectTrusted: boolean;
};

export async function loadRole(role: Role) {
  if (!roles.includes(role)) throw new Error(`Unknown role: ${role}`);
  const raw = await readFile(new URL(`./roles/${role}.md`, import.meta.url), "utf8");
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const description = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1].trim();
  const tools = frontmatter?.[1].match(/^tools:\s*(.+)$/m)?.[1].split(",").map((s) => s.trim());
  if (!frontmatter || !description || !tools?.length || tools.some((tool) => !tool)) {
    throw new Error(`Invalid role definition: ${role}`);
  }
  return { role, description, tools, prompt: raw.slice(frontmatter[0].length).trim() };
}

async function childOptions(
  task: Task,
  parent: Parent,
): Promise<CreateAgentSessionOptions> {
  const role = await loadRole(task.role);
  const cwd = path.resolve(parent.cwd, task.cwd ?? ".");
  const agentDir = parent.agentDir ?? getAgentDir();
  let model = parent.model;
  if (task.model) {
    const slash = task.model.indexOf("/");
    if (slash < 1) throw new Error("Model must be provider/model-id");
    model = parent.modelRegistry?.find(task.model.slice(0, slash), task.model.slice(slash + 1));
    if (!model) throw new Error(`Unknown model: ${task.model}`);
  }
  if (!model) throw new Error("No active model for subagent");
  if (model.api === "pi-virtual") throw new Error("Choose a physical provider/model-id for subagents; parent virtual routers cannot be inherited");
  const registry = parent.modelRegistry;
  const providerId = model.provider;
  // Pi 1.x exposes the parent's registry, not its ModelRuntime. Delegate auth
  // and requests through the public facade; never copy or persist credentials.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider({
    id: providerId,
    name: registry.getProviderDisplayName(providerId),
    getModels: () => [model],
    auth: { apiKey: {
      name: "Parent Pi authentication",
      check: async () => registry.hasConfiguredAuth(model)
        ? { type: registry.isUsingOAuth(model) ? "oauth" : "api_key" } : undefined,
      resolve: () => registry.getProviderAuth(providerId),
    } },
    stream: registry.stream.bind(registry),
    streamSimple: registry.streamSimple.bind(registry),
  });
  // Trust in the parent's cwd does not grant trust to another worktree or folder.
  const settingsManager = SettingsManager.inMemory({}, {
    projectTrusted: parent.projectTrusted && cwd === path.resolve(parent.cwd),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPromptOverride: (base) => [
      ...base,
      role.prompt,
      "Do not delegate further or launch nested Pi sessions. Complete the assigned task directly.",
    ],
  });
  await resourceLoader.reload();
  return {
    cwd,
    agentDir,
    model,
    modelRuntime,
    thinkingLevel: parent.thinkingLevel,
    tools: role.tools,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  };
}

export async function runBatch(
  tasks: Task[],
  options: {
    parent: Parent;
    concurrency: number;
    timeoutMs: number;
    signal?: AbortSignal;
    onUpdate?: (details: Details) => void;
    createSession?: SessionFactory;
  },
): Promise<Details> {
  if (!tasks.length || tasks.length > 8) throw new Error("Submit 1–8 tasks per batch");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) {
    throw new Error("Concurrency must be an integer from 1 to 4");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Timeout must be positive");
  const results: Progress[] = tasks.map((task, i) => ({
    ...task, id: i + 1, status: "queued", activity: "Waiting for a worker", tools: 0,
    tokens: 0, cost: 0, elapsedMs: 0, answer: "",
  }));
  const snapshot = (): Details => ({ results: results.map((r) => ({ ...r })) });
  const update = () => options.onUpdate?.(snapshot());
  update();
  let next = 0;

  async function run(result: Progress) {
    if (options.signal?.aborted) {
      result.status = "cancelled";
      result.activity = "Cancelled before start";
      update();
      return;
    }
    const started = Date.now();
    result.status = "running";
    result.activity = "Starting isolated SDK session";
    update();
    let session: Child | undefined;
    let unsubscribe: (() => void) | undefined;
    let aborting: Promise<void> | undefined;
    let cancelled: "cancelled" | "timed_out" | undefined;
    const cancel = (reason: "cancelled" | "timed_out") => {
      cancelled ??= reason;
      if (session && !aborting) aborting = session.abort().catch(() => {});
    };
    const abort = () => cancel("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => cancel("timed_out"), options.timeoutMs);
    const tick = setInterval(() => {
      result.elapsedMs = Date.now() - started;
      update();
    }, 1000);
    // Token events can arrive much faster than a terminal can redraw.
    let lastUpdate = 0;
    const streamUpdate = () => {
      result.elapsedMs = Date.now() - started;
      if (Date.now() - lastUpdate >= 100) {
        lastUpdate = Date.now();
        update();
      }
    };
    try {
      const config = await childOptions(result, options.parent);
      if (cancelled || options.signal?.aborted) throw new Error("Cancelled during setup");
      session = (await (options.createSession ?? createAgentSession)(config)).session;
      if (cancelled || options.signal?.aborted) throw new Error("Cancelled during setup");
      unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          result.tools++;
          const target = event.args?.path ?? event.args?.command ?? "";
          result.activity = `${event.toolName} ${String(target)}`.slice(0, 180);
        } else if (event.type === "tool_execution_end") {
          result.activity = `${event.toolName} ${event.isError ? "failed" : "finished"}`;
        } else if (event.type === "message_update") {
          const delta = event.assistantMessageEvent;
          if (delta.type === "thinking_delta") result.activity = "Thinking";
          if (delta.type === "text_delta") result.activity = `Writing: ${delta.delta}`.slice(0, 180);
        } else if (event.type === "auto_retry_start") {
          result.activity = `Retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms`;
        } else if (event.type === "compaction_start") {
          result.activity = "Compacting child context";
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          result.tokens += event.message.usage.totalTokens;
          result.cost += event.message.usage.cost.total;
        }
        streamUpdate();
      });
      await session.prompt(result.task);
      if (cancelled || options.signal?.aborted) throw new Error("Cancelled");
      const last = [...session.messages].reverse().find((message) => message.role === "assistant");
      if (!last || last.role !== "assistant") throw new Error("Subagent returned no assistant message");
      if (last.stopReason !== "stop") {
        throw new Error(last.errorMessage || `Subagent stopped: ${last.stopReason}`);
      }
      const answer = last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (!answer.trim()) throw new Error("Subagent returned no final text");
      result.answer = answer;
      result.status = "completed";
      result.activity = "Finished";
    } catch (error) {
      result.status = cancelled ?? (options.signal?.aborted ? "cancelled" : "failed");
      result.error = result.status === "timed_out"
        ? `Timed out after ${options.timeoutMs / 1000}s`
        : result.status === "cancelled" ? "Cancelled" : error instanceof Error ? error.message : String(error);
      result.activity = result.error;
    } finally {
      clearTimeout(timer);
      clearInterval(tick);
      options.signal?.removeEventListener("abort", abort);
      if (session) {
        await (aborting ?? session.abort().catch(() => {}));
        unsubscribe?.();
        session.dispose();
      }
      result.elapsedMs = Date.now() - started;
      update();
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, tasks.length) }, async () => {
    while (next < results.length) await run(results[next++]);
  }));
  return snapshot();
}

export function progressLines(details: Details): string[] {
  const finished = details.results.filter((r) => r.status !== "queued" && r.status !== "running").length;
  return [
    `Subagents · ${finished}/${details.results.length} settled`,
    ...details.results.map((r) => {
      const icon = r.status === "completed" ? "✓" : r.status === "running" ? "▶" : r.status === "queued" ? "○" : "!";
      const activity = r.activity.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").slice(0, 100);
      const suffix = r.status === "completed" ? "" : ` · ${activity}`;
      return `${icon} #${r.id} ${r.role} · ${r.status} · ${Math.floor(r.elapsedMs / 1000)}s · ${r.tools} tool${r.tools === 1 ? "" : "s"} · ${r.tokens} tokens${suffix}`;
    }),
  ];
}
