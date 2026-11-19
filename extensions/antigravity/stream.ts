// Streaming execution engine for the Antigravity ACP provider.
// Reuses warm `agy acp` sessions across linear turns and suspends MCP `tools/call`
// requests across Pi's `streamSimple` boundary so Pi keeps 100% tool ownership.

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import {
  AcpClient,
  createIsolatedCwd,
  removeIsolatedCwd,
  type AcpNotification,
  type AcpPromptResult,
  type AcpServerRequest,
  type AcpUsage,
} from "./acp-client.ts";
import { API_ID, PROVIDER_ID, resolveAcpThoughtLevel } from "./catalog.ts";
import {
  LoopbackMcpServer,
  MCP_TOOL_PREFIX,
  piToolResultToMcp,
  type SuspendedToolCall,
} from "./mcp-server.ts";
import {
  buildIncrementalPrompt,
  buildReplayPrompt,
  buildSystemPromptAppend,
  extractEffectiveTools,
  fingerprintTools,
  isLinearPrefix,
  messageKey,
  nonSystemMessages,
  type AcpPromptBlock,
} from "./transcript.ts";

const MAX_RETAINED_SESSIONS = 2;
const SESSION_IDLE_TTL_MS = 5 * 60 * 1000;

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapAcpUsage(usage: AcpUsage | undefined): Usage {
  if (!usage) return zeroUsage();
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cachedReadTokens ?? 0;
  const cacheWrite = usage.cachedWriteTokens ?? 0;
  const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
  const mapped: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (typeof usage.thoughtTokens === "number") {
    mapped.reasoning = usage.thoughtTokens;
  }
  return mapped;
}

/**
 * Emits balanced `AssistantMessageEvent` sequences into a Pi stream:
 * `start` -> balanced `thinking_*`/`text_*`/`toolcall_*` -> single `done` or `error`.
 */
class TurnEmitter {
  readonly output: AssistantMessage;
  private readonly stream: AssistantMessageEventStream;
  private started = false;
  private finished = false;
  private openBlock: { type: "text" | "thinking"; index: number } | undefined;

  constructor(
    stream: AssistantMessageEventStream,
    model: Model<Api>,
    requestedThinkingLevel: SimpleStreamOptions["reasoning"],
    providerThoughtLevel: string | undefined,
  ) {
    this.stream = stream;
    this.output = {
      role: "assistant",
      content: [],
      api: model.api || API_ID,
      provider: model.provider || PROVIDER_ID,
      model: model.id,
      ...(requestedThinkingLevel ? { thinkingLevel: requestedThinkingLevel } : {}),
      ...(providerThoughtLevel ? { providerThinkingLevel: providerThoughtLevel } : {}),
      usage: zeroUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
  }

  get isFinished(): boolean {
    return this.finished;
  }

  ensureStarted(): void {
    if (this.started || this.finished) return;
    this.started = true;
    this.stream.push({ type: "start", partial: this.output });
  }

  private closeOpenBlock(): void {
    if (!this.openBlock) return;
    const { type, index } = this.openBlock;
    this.openBlock = undefined;
    if (type === "text") {
      const block = this.output.content[index] as TextContent;
      this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.output });
    } else {
      const block = this.output.content[index] as ThinkingContent;
      this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.output });
    }
  }

  pushThinking(delta: string): void {
    if (this.finished || !delta) return;
    this.ensureStarted();
    if (this.openBlock?.type !== "thinking") {
      this.closeOpenBlock();
      const index = this.output.content.length;
      this.output.content.push({ type: "thinking", thinking: "" });
      this.openBlock = { type: "thinking", index };
      this.stream.push({ type: "thinking_start", contentIndex: index, partial: this.output });
    }
    const index = this.openBlock.index;
    const block = this.output.content[index] as ThinkingContent;
    block.thinking += delta;
    this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.output });
  }

  pushText(delta: string): void {
    if (this.finished || !delta) return;
    this.ensureStarted();
    if (this.openBlock?.type !== "text") {
      this.closeOpenBlock();
      const index = this.output.content.length;
      this.output.content.push({ type: "text", text: "" });
      this.openBlock = { type: "text", index };
      this.stream.push({ type: "text_start", contentIndex: index, partial: this.output });
    }
    const index = this.openBlock.index;
    const block = this.output.content[index] as TextContent;
    block.text += delta;
    this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.output });
  }

  pushToolCall(id: string, name: string, args: JsonObject): ToolCall {
    this.ensureStarted();
    this.closeOpenBlock();
    const index = this.output.content.length;
    const toolCall: ToolCall = { type: "toolCall", id, name, arguments: args };
    this.output.content.push(toolCall);
    this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
    const serialized = JSON.stringify(args);
    if (serialized) {
      this.stream.push({ type: "toolcall_delta", contentIndex: index, delta: serialized, partial: this.output });
    }
    this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: this.output });
    return toolCall;
  }

  finish(reason: Extract<StopReason, "stop" | "length" | "toolUse">, usage?: Usage, rawStopReason?: string): void {
    if (this.finished) return;
    this.ensureStarted();
    this.closeOpenBlock();
    this.finished = true;
    this.output.stopReason = reason;
    if (usage) this.output.usage = usage;
    if (rawStopReason) this.output.rawStopReason = rawStopReason;
    if (reason === "stop") this.output.endTurn = true;
    this.stream.push({ type: "done", reason, message: this.output });
    this.stream.end(this.output);
  }

  fail(message: string, aborted = false): void {
    if (this.finished) return;
    if (this.started) this.closeOpenBlock();
    this.finished = true;
    const reason: Extract<StopReason, "aborted" | "error"> = aborted ? "aborted" : "error";
    this.output.stopReason = reason;
    this.output.errorMessage = message;
    this.stream.push({ type: "error", reason, error: this.output });
    this.stream.end(this.output);
  }
}

interface ActiveTurnBinding {
  model: Model<Api>;
  emitter: TurnEmitter;
  options: SimpleStreamOptions | undefined;
  resolveTurn: () => void;
  onToolCall: (call: SuspendedToolCall, acpToolCallId: string) => void;
  onPromptResult: (res: AcpPromptResult) => void;
  onPromptError: (err: Error) => void;
  onNotification: (notif: AcpNotification) => void;
}

class LiveAcpSession {
  readonly key: string;
  readonly acp: AcpClient;
  readonly mcpServer: LoopbackMcpServer;
  readonly tempCwd: string;
  readonly sessionId: string;
  readonly systemPromptAppend: string;
  readonly toolFingerprint: string;

  modelId: string;
  thoughtLevel: string | undefined;
  committedKeys: string[] = [];
  inFlightPrompt: Promise<AcpPromptResult> | null = null;
  pendingToolCall: { id: string; call: SuspendedToolCall } | null = null;
  bufferedToolCalls: Array<{ id: string; call: SuspendedToolCall }> = [];
  activeTurn: ActiveTurnBinding | null = null;
  lastActivityAt = Date.now();
  disposed = false;

  // Pairs `session/request_permission` ACP toolCallIds with the immediately following MCP `tools/call`.
  private approvedCallIds: Array<{ mcpName: string; toolCallId: string }> = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(params: {
    key: string;
    acp: AcpClient;
    mcpServer: LoopbackMcpServer;
    tempCwd: string;
    sessionId: string;
    systemPromptAppend: string;
    toolFingerprint: string;
    modelId: string;
    thoughtLevel: string | undefined;
  }) {
    this.key = params.key;
    this.acp = params.acp;
    this.mcpServer = params.mcpServer;
    this.tempCwd = params.tempCwd;
    this.sessionId = params.sessionId;
    this.systemPromptAppend = params.systemPromptAppend;
    this.toolFingerprint = params.toolFingerprint;
    this.modelId = params.modelId;
    this.thoughtLevel = params.thoughtLevel;

    this.acp.onNotification((notif) => this.handleNotification(notif));
    this.acp.onServerRequest((req) => this.handleServerRequest(req));
    this.acp.onExit((err) => {
      const turn = this.activeTurn;
      this.activeTurn = null;
      this.inFlightPrompt = null;
      if (this.pendingToolCall) {
        this.pendingToolCall.call.reject(err);
        this.pendingToolCall = null;
      }
      for (const buffered of this.bufferedToolCalls) {
        buffered.call.reject(err);
      }
      this.bufferedToolCalls = [];
      turn?.onPromptError(err);
      this.dispose();
    });
  }

  static async create(params: {
    key: string;
    env: Record<string, string | undefined>;
    context: TranscriptContext;
    toolChoice: SimpleStreamOptions["toolChoice"];
    modelId: string;
    thoughtLevel: string | undefined;
    signal?: AbortSignal;
  }): Promise<LiveAcpSession> {
    const tools = extractEffectiveTools(params.context, params.toolChoice);
    const toolFingerprint = fingerprintTools(tools);
    const tempCwd = createIsolatedCwd();
    let sessionRef: LiveAcpSession | undefined;
    const earlyCalls: SuspendedToolCall[] = [];

    const mcpServer = await LoopbackMcpServer.start(tools, (call) => {
      if (sessionRef) {
        sessionRef.handleIncomingMcpCall(call);
      } else {
        earlyCalls.push(call);
      }
    });

    const acp = AcpClient.spawn({ env: params.env });
    try {
      await acp.initialize(params.signal);
      const systemPromptAppend = buildSystemPromptAppend(params.context, mcpServer.toolMapping);
      const mcpServers = tools.length > 0 ? [mcpServer.toAcpServerSpec()] : [];
      const created = await acp.newSession(
        {
          cwd: tempCwd,
          mcpServers,
          systemPromptAppend,
        },
        params.signal,
      );

      await acp.setConfigOption(created.sessionId, "model", params.modelId, params.signal);
      if (params.thoughtLevel) {
        await acp.setConfigOption(created.sessionId, "thought_level", params.thoughtLevel, params.signal);
      }

      sessionRef = new LiveAcpSession({
        key: params.key,
        acp,
        mcpServer,
        tempCwd,
        sessionId: created.sessionId,
        systemPromptAppend,
        toolFingerprint,
        modelId: params.modelId,
        thoughtLevel: params.thoughtLevel,
      });

      for (const call of earlyCalls) {
        sessionRef.handleIncomingMcpCall(call);
      }
      sessionRef.touch();
      return sessionRef;
    } catch (err) {
      acp.close();
      mcpServer.close();
      removeIsolatedCwd(tempCwd);
      throw err;
    }
  }

  touch(): void {
    this.lastActivityAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.activeTurn && !this.inFlightPrompt) {
        this.dispose();
        sessionsByKey.delete(this.key);
      }
    }, SESSION_IDLE_TTL_MS);
    this.idleTimer.unref();
  }

  private handleServerRequest(req: AcpServerRequest): unknown {
    if (req.method === "session/request_permission") {
      const toolCall = (req.params?.toolCall ?? {}) as { name?: string; toolCallId?: string };
      const acpName = typeof toolCall.name === "string" ? toolCall.name : "";
      const options = (Array.isArray(req.params?.options) ? req.params.options : []) as Array<{
        optionId?: string;
        kind?: string;
      }>;
      const allowOpt = options.find((o) => o.kind?.startsWith("allow")) ?? options[0];
      const denyOpt = options.find((o) => o.kind?.startsWith("reject")) ?? options[options.length - 1];

      if (this.mcpServer.isKnownAcpToolName(acpName)) {
        const mcpName = acpName.slice(MCP_TOOL_PREFIX.length);
        const toolCallId =
          typeof toolCall.toolCallId === "string" && toolCall.toolCallId
            ? toolCall.toolCallId
            : `call_${randomUUID()}`;
        this.approvedCallIds.push({ mcpName, toolCallId });
        return { outcome: { outcome: "selected", optionId: allowOpt?.optionId ?? "allow" } };
      }

      // Strictly deny every built-in Antigravity tool or unknown MCP tool.
      return { outcome: { outcome: "selected", optionId: denyOpt?.optionId ?? "deny" } };
    }

    throw new Error(`Unsupported ACP client request: ${req.method}`);
  }

  private handleNotification(notif: AcpNotification): void {
    this.touch();
    this.activeTurn?.onNotification(notif);
  }

  private takeApprovedCallId(mcpName: string): string {
    const idx = this.approvedCallIds.findIndex((entry) => entry.mcpName === mcpName);
    if (idx !== -1) {
      const [entry] = this.approvedCallIds.splice(idx, 1);
      return entry.toolCallId;
    }
    return `call_${randomUUID()}`;
  }

  private handleIncomingMcpCall(call: SuspendedToolCall): void {
    this.touch();
    const id = this.takeApprovedCallId(call.mcpName);
    if (this.activeTurn && !this.pendingToolCall) {
      this.pendingToolCall = { id, call };
      this.activeTurn.onToolCall(call, id);
    } else {
      this.bufferedToolCalls.push({ id, call });
    }
  }

  startPrompt(blocks: AcpPromptBlock[]): void {
    this.touch();
    const promise = this.acp.prompt(this.sessionId, blocks as unknown as Array<Record<string, unknown>>);
    this.inFlightPrompt = promise;
    promise.then(
      (result) => {
        if (this.inFlightPrompt === promise) {
          this.inFlightPrompt = null;
        }
        this.touch();
        const turn = this.activeTurn;
        if (turn) {
          turn.onPromptResult(result);
        } else if (this.pendingToolCall || this.bufferedToolCalls.length > 0) {
          // Prompt ended while Pi was between turns; discard stale session cleanly.
          this.dispose();
        }
      },
      (err) => {
        if (this.inFlightPrompt === promise) {
          this.inFlightPrompt = null;
        }
        const wrapped = err instanceof Error ? err : new Error(String(err));
        const turn = this.activeTurn;
        if (turn) {
          turn.onPromptError(wrapped);
        } else {
          this.dispose();
        }
      },
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.activeTurn = null;
    this.inFlightPrompt = null;
    const err = new Error("Antigravity ACP session closed");
    if (this.pendingToolCall) {
      this.pendingToolCall.call.reject(err);
      this.pendingToolCall = null;
    }
    for (const buffered of this.bufferedToolCalls) {
      buffered.call.reject(err);
    }
    this.bufferedToolCalls = [];
    this.acp.close();
    this.mcpServer.close();
    removeIsolatedCwd(this.tempCwd);
  }
}

const sessionsByKey = new Map<string, LiveAcpSession>();

function evictOldestSessions(): void {
  while (sessionsByKey.size > MAX_RETAINED_SESSIONS) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, s] of sessionsByKey.entries()) {
      if (!s.activeTurn && s.lastActivityAt < oldestAt) {
        oldestAt = s.lastActivityAt;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    const victim = sessionsByKey.get(oldestKey);
    sessionsByKey.delete(oldestKey);
    victim?.dispose();
  }
}

export function disposeAllAntigravitySessions(): void {
  for (const session of sessionsByKey.values()) {
    session.dispose();
  }
  sessionsByKey.clear();
}

process.once("exit", () => {
  disposeAllAntigravitySessions();
});

function sessionKeyFor(options?: SimpleStreamOptions): string {
  return options?.sessionId ? `session:${options.sessionId}` : "default";
}

function findMatchingToolResult(
  messages: readonly Message[],
  committedCount: number,
  expectedToolCallId: string,
): ToolResultMessage | undefined {
  const tail = nonSystemMessages(messages).slice(committedCount);
  // Expect only the matching toolResult (and no intervening user turn).
  if (tail.length === 0) return undefined;
  if (tail.some((m) => m.role === "user")) return undefined;
  for (let i = tail.length - 1; i >= 0; i--) {
    const msg = tail[i];
    if (msg.role === "toolResult" && msg.toolCallId === expectedToolCallId) {
      return msg;
    }
  }
  return undefined;
}

function resolveStreamEnv(options?: SimpleStreamOptions): Record<string, string | undefined> {
  return { ...process.env, ...options?.env };
}

export function streamAntigravity(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const thoughtLevel = resolveAcpThoughtLevel(model, options?.reasoning);
  const emitter = new TurnEmitter(stream, model, options?.reasoning, thoughtLevel);

  void runTurn(model, context, options, thoughtLevel, emitter).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    emitter.fail(message, Boolean(options?.signal?.aborted));
  });

  return stream;
}

async function runTurn(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  thoughtLevel: string | undefined,
  emitter: TurnEmitter,
): Promise<void> {
  if (options?.signal?.aborted) {
    emitter.fail("Request aborted", true);
    return;
  }

  const key = sessionKeyFor(options);
  const env = resolveStreamEnv(options);
  const tools = extractEffectiveTools(context, options?.toolChoice);
  const toolFingerprint = fingerprintTools(tools);
  const convo = nonSystemMessages(context.messages);

  let session = sessionsByKey.get(key);
  if (session?.disposed || session?.acp.isClosed) {
    sessionsByKey.delete(key);
    session = undefined;
  }

  // Case A: Resume a suspended MCP tool call inside the live ACP turn.
  let resumingToolResult: ToolResultMessage | undefined;
  if (
    session &&
    session.inFlightPrompt &&
    session.pendingToolCall &&
    session.modelId === model.id &&
    session.thoughtLevel === thoughtLevel &&
    session.toolFingerprint === toolFingerprint &&
    isLinearPrefix(session.committedKeys, context.messages)
  ) {
    resumingToolResult = findMatchingToolResult(
      context.messages,
      session.committedKeys.length,
      session.pendingToolCall.id,
    );
  }

  // Case B: Linear multi-turn continuation on an idle warm ACP session.
  let incrementalUserBlocks: AcpPromptBlock[] | undefined;
  if (
    !resumingToolResult &&
    session &&
    !session.inFlightPrompt &&
    !session.pendingToolCall &&
    session.toolFingerprint === toolFingerprint &&
    isLinearPrefix(session.committedKeys, context.messages)
  ) {
    const tail = convo.slice(session.committedKeys.length);
    const expectedSystemPrompt = buildSystemPromptAppend(context, session.mcpServer.toolMapping);
    if (
      tail.length === 1 &&
      tail[0].role === "user" &&
      session.systemPromptAppend === expectedSystemPrompt
    ) {
      incrementalUserBlocks = buildIncrementalPrompt(tail[0]);
    }
  }

  // Case C: Cold start / branch / edit / compaction / tool-list change -> fresh ACP session.
  let replayBlocks: AcpPromptBlock[] | undefined;
  if (!resumingToolResult && !incrementalUserBlocks) {
    if (session) {
      sessionsByKey.delete(key);
      session.dispose();
      session = undefined;
    }
    session = await LiveAcpSession.create({
      key,
      env,
      context,
      toolChoice: options?.toolChoice,
      modelId: model.id,
      thoughtLevel,
      signal: options?.signal,
    });
    sessionsByKey.set(key, session);
    evictOldestSessions();
    replayBlocks = buildReplayPrompt(context.messages);
  }

  if (!session) {
    emitter.fail("Failed to initialize Antigravity ACP session");
    return;
  }

  // Update model / thought_level in-place when reusing an idle session.
  if (incrementalUserBlocks) {
    if (session.modelId !== model.id) {
      await session.acp.setConfigOption(session.sessionId, "model", model.id, options?.signal);
      session.modelId = model.id;
    }
    if (thoughtLevel && session.thoughtLevel !== thoughtLevel) {
      await session.acp.setConfigOption(session.sessionId, "thought_level", thoughtLevel, options?.signal);
      session.thoughtLevel = thoughtLevel;
    }
  }

  // Invoke Pi's `onPayload` instrumentation hook before dispatching.
  let promptToSend = incrementalUserBlocks ?? replayBlocks;
  const payload = {
    sessionId: session.sessionId,
    model: model.id,
    thoughtLevel,
    mode: resumingToolResult ? "resume_tool_call" : incrementalUserBlocks ? "continue" : "new_session",
    ...(resumingToolResult
      ? { toolCallId: resumingToolResult.toolCallId, toolName: resumingToolResult.toolName }
      : { prompt: promptToSend }),
  };
  const replaced = await options?.onPayload?.(payload, model);
  if (
    replaced &&
    typeof replaced === "object" &&
    "prompt" in replaced &&
    Array.isArray((replaced as { prompt?: unknown }).prompt)
  ) {
    promptToSend = (replaced as { prompt: AcpPromptBlock[] }).prompt;
  }

  if (options?.signal?.aborted) {
    emitter.fail("Request aborted", true);
    return;
  }

  await options?.onResponse?.({ status: 200, headers: {} }, model);
  emitter.ensureStarted();

  const activeSession = session;

  await new Promise<void>((resolveTurn) => {
    let settled = false;
    let notificationChain = Promise.resolve();

    const finishTurn = () => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener("abort", onAbort);
      if (activeSession.activeTurn?.resolveTurn === resolveTurn) {
        activeSession.activeTurn = null;
      }
      resolveTurn();
    };

    const onAbort = () => {
      if (settled) return;
      activeSession.acp.cancel(activeSession.sessionId);
      sessionsByKey.delete(activeSession.key);
      activeSession.dispose();
      emitter.fail("Request aborted", true);
      finishTurn();
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const commitAssistantAndTail = () => {
      activeSession.committedKeys = [...convo.map(messageKey), messageKey(emitter.output)];
    };

    const deliverToolCall = (call: SuspendedToolCall, acpToolCallId: string) => {
      if (settled) return;
      notificationChain = notificationChain.then(() => {
        if (settled) return;
        emitter.pushToolCall(acpToolCallId, call.piName, call.args);
        commitAssistantAndTail();
        emitter.finish("toolUse", undefined, "tool_use");
        finishTurn();
      });
    };

    const binding: ActiveTurnBinding = {
      model,
      emitter,
      options,
      resolveTurn,
      onToolCall: deliverToolCall,
      onPromptResult: (res) => {
        notificationChain = notificationChain.then(() => {
          if (settled) return;
          if (res.stopReason === "cancelled" || options?.signal?.aborted) {
            sessionsByKey.delete(activeSession.key);
            activeSession.dispose();
            emitter.fail("Request aborted", true);
            finishTurn();
            return;
          }
          const mappedReason = res.stopReason === "max_tokens" ? "length" : "stop";
          commitAssistantAndTail();
          emitter.finish(mappedReason, mapAcpUsage(res.usage), res.stopReason);
          finishTurn();
        });
      },
      onPromptError: (err) => {
        notificationChain = notificationChain.then(() => {
          if (settled) return;
          sessionsByKey.delete(activeSession.key);
          activeSession.dispose();
          emitter.fail(err.message, Boolean(options?.signal?.aborted));
          finishTurn();
        });
      },
      onNotification: (notif) => {
        notificationChain = notificationChain.then(async () => {
          if (settled) return;
          await options?.onProviderStreamEvent?.(notif, model);
          if (settled) return;
          if (notif.method !== "session/update") return;
          const update = (notif.params?.update ?? {}) as Record<string, unknown>;
          const kind = update.sessionUpdate;
          if (kind === "agent_thought_chunk") {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type === "text" && typeof content.text === "string") {
              emitter.pushThinking(content.text);
            }
          } else if (kind === "agent_message_chunk") {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type === "text" && typeof content.text === "string") {
              emitter.pushText(content.text);
            }
          }
        });
      },
    };

    activeSession.activeTurn = binding;

    if (resumingToolResult && activeSession.pendingToolCall) {
      const pending = activeSession.pendingToolCall;
      activeSession.pendingToolCall = null;
      activeSession.committedKeys = convo.map(messageKey);
      pending.call.resolve(piToolResultToMcp(resumingToolResult.content, resumingToolResult.isError));

      // If `agy` dispatched another parallel tool call already buffered, hand it to Pi immediately.
      if (activeSession.bufferedToolCalls.length > 0) {
        const next = activeSession.bufferedToolCalls.shift()!;
        activeSession.pendingToolCall = next;
        deliverToolCall(next.call, next.id);
      }
      return;
    }

    if (!promptToSend) {
      emitter.fail("Internal error: missing prompt payload for Antigravity ACP turn");
      finishTurn();
      return;
    }

    activeSession.committedKeys = convo.map(messageKey);
    activeSession.startPrompt(promptToSend);
  });
}
