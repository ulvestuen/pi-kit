// JSON-RPC 2.0 stdio client for the official `agy acp --stdio` server.
// Handles process spawning, request/response correlation, server-to-client
// requests (e.g. `session/request_permission`), notifications, status probes,
// and clean teardown.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiscoveredModels, type AcpSessionInitMetadata, type DiscoveredAntigravityModel } from "./catalog.ts";

export const COMMAND_ENV = "PI_ANTIGRAVITY_COMMAND";
export const LOGIN_HINT =
  'Antigravity is not logged in. Run `agy` or `agy acp --login` in a terminal to authenticate, then retry.';

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface AcpServerRequest {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: {
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    _meta?: {
      antigravity?: {
        tier?: boolean;
        systemPrompt?: { append?: boolean };
      };
    };
  };
}

export interface AcpSessionNewResult extends AcpSessionInitMetadata {
  sessionId: string;
}

export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface AcpPromptResult {
  stopReason?: string;
  usage?: AcpUsage;
}

export interface AcpMcpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AntigravityStatus {
  available: boolean;
  loggedIn: boolean;
  subscription: boolean;
  tierName?: string;
  tierId?: string;
  serverVersion?: string;
  models: DiscoveredAntigravityModel[];
  detail?: string;
}

export function resolveAgyCommand(env: Record<string, string | undefined> = process.env): string {
  const configured = env[COMMAND_ENV]?.trim();
  return configured || "agy";
}

export function createIsolatedCwd(): string {
  return mkdtempSync(join(tmpdir(), "pi-antigravity-cwd-"));
}

export function removeIsolatedCwd(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of scratch directory.
  }
}

export class AcpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string }
  >();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private closed = false;
  private closeError: Error | undefined;
  private notificationHandler: ((notif: AcpNotification) => void) | undefined;
  private requestHandler: ((req: AcpServerRequest) => Promise<unknown> | unknown) | undefined;
  private exitListeners = new Set<(err: Error) => void>();

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });

    proc.on("error", (err) => {
      const wrapped =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`Antigravity CLI (\`${proc.spawnfile}\`) was not found on PATH.`)
          : err;
      this.handleExit(wrapped);
    });

    proc.on("close", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderrTail.trim().split("\n").slice(-3).join(" ").trim();
      const why = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.handleExit(new Error(`agy acp exited unexpectedly (${why})${detail ? `: ${detail}` : ""}`));
    });
  }

  static spawn(options?: {
    env?: Record<string, string | undefined>;
    extraArgs?: string[];
  }): AcpClient {
    const mergedEnv = options?.env ? { ...process.env, ...options.env } : process.env;
    const command = resolveAgyCommand(mergedEnv);
    const args = ["acp", "--stdio", "--include-default-customizations=false", ...(options?.extraArgs ?? [])];
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(mergedEnv)) {
      if (v !== undefined) childEnv[k] = v;
    }
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    return new AcpClient(proc);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onNotification(handler: ((notif: AcpNotification) => void) | undefined): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: ((req: AcpServerRequest) => Promise<unknown> | unknown) | undefined): void {
    this.requestHandler = handler;
  }

  onExit(listener: (err: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  private handleExit(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
    for (const listener of this.exitListeners) {
      try {
        listener(err);
      } catch {
        // Ignore listener errors during teardown.
      }
    }
    this.exitListeners.clear();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.dispatchMessage(msg);
    }
  }

  private dispatchMessage(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === "string";

    if (hasId && hasMethod) {
      const req: AcpServerRequest = {
        id: msg.id as string | number,
        method: msg.method as string,
        params: (msg.params ?? undefined) as Record<string, unknown> | undefined,
      };
      this.handleIncomingRequest(req);
      return;
    }

    if (hasId) {
      const id = Number(msg.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (msg.error && typeof msg.error === "object") {
        const rpcErr = msg.error as JsonRpcErrorObject;
        entry.reject(new Error(rpcErr.message || `ACP error ${rpcErr.code} in ${entry.method}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (hasMethod) {
      this.notificationHandler?.({
        method: msg.method as string,
        params: (msg.params ?? undefined) as Record<string, unknown> | undefined,
      });
    }
  }

  private handleIncomingRequest(req: AcpServerRequest): void {
    const handler = this.requestHandler;
    if (!handler) {
      this.sendRaw({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not implemented: ${req.method}` },
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(req))
      .then((result) => {
        if (!this.closed) {
          this.sendRaw({ jsonrpc: "2.0", id: req.id, result });
        }
      })
      .catch((err) => {
        if (!this.closed) {
          this.sendRaw({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
      });
  }

  private sendRaw(payload: unknown): void {
    if (this.closed || this.proc.stdin.destroyed) return;
    try {
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Process exiting; close handler will reject pending requests.
    }
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("ACP client is closed"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Request aborted"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new Error("Request aborted"));
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, {
        method,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      this.sendRaw({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.sendRaw({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  initialize(signal?: AbortSignal): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "pi-antigravity", version: "1.0.0" },
      },
      signal,
    );
  }

  newSession(
    params: {
      cwd: string;
      mcpServers?: AcpMcpServerSpec[];
      systemPromptAppend?: string;
    },
    signal?: AbortSignal,
  ): Promise<AcpSessionNewResult> {
    const rpcParams: Record<string, unknown> = {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    };
    if (params.systemPromptAppend) {
      rpcParams._meta = {
        antigravity: {
          systemPrompt: { append: params.systemPromptAppend },
        },
      };
    }
    return this.request<AcpSessionNewResult>("session/new", rpcParams, signal);
  }

  setConfigOption(sessionId: string, configId: string, value: string, signal?: AbortSignal): Promise<unknown> {
    return this.request("session/set_config_option", { sessionId, configId, value }, signal);
  }

  prompt(
    sessionId: string,
    prompt: Array<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<AcpPromptResult> {
    return this.request<AcpPromptResult>("session/prompt", { sessionId, prompt }, signal);
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = new Error("ACP client closed");
    for (const entry of this.pending.values()) {
      entry.reject(this.closeError);
    }
    this.pending.clear();
    this.exitListeners.clear();
    try {
      this.proc.stdin.end();
    } catch {
      // Ignore.
    }
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // Ignore.
    }
    const timer = setTimeout(() => {
      try {
        if (!this.proc.killed) this.proc.kill("SIGKILL");
      } catch {
        // Ignore.
      }
    }, 1500);
    timer.unref();
  }
}

const STATUS_CACHE_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 20_000;
let cachedStatus: { command: string; at: number; value: AntigravityStatus } | undefined;

export function clearStatusCache(): void {
  cachedStatus = undefined;
}

/**
 * Probe `agy acp --stdio` with `initialize` + `session/new` (no prompt sent) to
 * verify binary availability, login state, subscription tier, and base model catalog.
 */
export async function probeAntigravity(
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  options?: { bypassCache?: boolean },
): Promise<AntigravityStatus> {
  const command = resolveAgyCommand(env);
  if (
    !options?.bypassCache &&
    cachedStatus &&
    cachedStatus.command === command &&
    Date.now() - cachedStatus.at < STATUS_CACHE_TTL_MS
  ) {
    return cachedStatus.value;
  }

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  timer.unref();

  let client: AcpClient | undefined;
  let tempCwd: string | undefined;
  try {
    tempCwd = createIsolatedCwd();
    client = AcpClient.spawn({ env });
    const init = await client.initialize(controller.signal);
    const imageInput = init.agentCapabilities?.promptCapabilities?.image !== false;
    const session = await client.newSession({ cwd: tempCwd, mcpServers: [] }, controller.signal);
    const models = parseDiscoveredModels(session, imageInput);
    const tier = session._meta?.antigravity?.tier;
    const status: AntigravityStatus = {
      available: true,
      loggedIn: models.length > 0,
      subscription: Boolean(tier?.id || tier?.name),
      tierName: tier?.name,
      tierId: tier?.id,
      serverVersion: init.agentInfo?.version,
      models,
      detail: models.length > 0 ? undefined : LOGIN_HINT,
    };
    cachedStatus = { command, at: Date.now(), value: status };
    return status;
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const notFound = /was not found on PATH|ENOENT/i.test(message);
    const unauth = /auth|login|unauthenticated|credential|sign in/i.test(message);
    const status: AntigravityStatus = {
      available: !notFound,
      loggedIn: false,
      subscription: false,
      models: [],
      detail: notFound ? message : unauth ? LOGIN_HINT : message,
    };
    if (!controller.signal.aborted) {
      cachedStatus = { command, at: Date.now(), value: status };
    }
    return status;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
    client?.close();
    removeIsolatedCwd(tempCwd);
  }
}
