// In-process loopback HTTP bridge paired with `mcp-bridge.mjs`.
// Maps Pi tool definitions into MCP tools for `agy acp`, strips Antigravity's
// synthetic `toolSummary` argument when undeclared, and suspends `tools/call`
// requests until Pi executes the tool and supplies the result.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent, JsonObject, TextContent, Tool } from "@earendil-works/pi-ai";
import type { AcpMcpServerSpec } from "./acp-client.ts";

export const MCP_SERVER_NAME = "pi";
export const MCP_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`;

const BRIDGE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "mcp-bridge.mjs");

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContentItem {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolCallResult {
  content: McpContentItem[];
  isError?: boolean;
}

export interface SuspendedToolCall {
  piName: string;
  mcpName: string;
  args: JsonObject;
  resolve: (result: McpToolCallResult) => void;
  reject: (err: Error) => void;
}

export interface ToolMapping {
  mcpTools: McpToolDefinition[];
  mcpToPi: Map<string, string>;
  piToMcp: Map<string, string>;
  declaredKeysByMcpName: Map<string, Set<string>>;
}

function toSafeMcpName(piName: string, used: Set<string>): string {
  let base = piName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "");
  if (!base) base = "tool";
  if (/^[0-9]/.test(base)) base = `t_${base}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix++}`;
  }
  used.add(candidate);
  return candidate;
}

function normalizeSchema(raw: unknown): Record<string, unknown> {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(raw ?? {}));
  } catch {
    cloned = {};
  }
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    return { type: "object", properties: {} };
  }
  const obj = cloned as Record<string, unknown>;
  if (!obj.type) obj.type = "object";
  if (obj.type === "object" && !obj.properties) obj.properties = {};
  return obj;
}

export function buildToolMapping(tools: readonly Tool[]): ToolMapping {
  const used = new Set<string>();
  const mcpTools: McpToolDefinition[] = [];
  const mcpToPi = new Map<string, string>();
  const piToMcp = new Map<string, string>();
  const declaredKeysByMcpName = new Map<string, Set<string>>();

  for (const tool of tools) {
    const mcpName = toSafeMcpName(tool.name, used);
    const inputSchema = normalizeSchema(tool.parameters);
    const props =
      inputSchema.properties && typeof inputSchema.properties === "object" && !Array.isArray(inputSchema.properties)
        ? Object.keys(inputSchema.properties as Record<string, unknown>)
        : [];
    mcpTools.push({
      name: mcpName,
      description: tool.description || `Pi tool ${tool.name}`,
      inputSchema,
    });
    mcpToPi.set(mcpName, tool.name);
    piToMcp.set(tool.name, mcpName);
    declaredKeysByMcpName.set(mcpName, new Set(props));
  }

  return { mcpTools, mcpToPi, piToMcp, declaredKeysByMcpName };
}

/**
 * Clean arguments received from `agy` before returning them to Pi:
 * Antigravity automatically appends a `toolSummary` field to MCP tool calls;
 * strip it unless the Pi tool explicitly declared `toolSummary` in its schema.
 */
export function sanitizeToolArguments(
  rawArgs: unknown,
  declaredKeys: ReadonlySet<string> | undefined,
): JsonObject {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return {};
  }
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
    if (key === "toolSummary" && !(declaredKeys?.has("toolSummary"))) continue;
    if (value !== undefined) {
      result[key] = value as JsonObject[string];
    }
  }
  return result;
}

/** Convert Pi `ToolResultMessage` content blocks into an MCP `CallToolResult`. */
export function piToolResultToMcp(
  content: readonly (TextContent | ImageContent)[],
  isError: boolean,
): McpToolCallResult {
  const items: McpContentItem[] = [];
  for (const block of content) {
    if (block.type === "text") {
      items.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      items.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  if (items.length === 0) {
    items.push({ type: "text", text: isError ? "Tool failed with no output." : "" });
  }
  return { content: items, ...(isError ? { isError: true } : {}) };
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export class LoopbackMcpServer {
  private readonly server: Server;
  private readonly token: string;
  private readonly mapping: ToolMapping;
  private readonly onCall: (call: SuspendedToolCall) => void;
  private readonly activeRejectors = new Set<(err: Error) => void>();
  private port = 0;
  private socketDir: string | undefined;
  private socketPath: string | undefined;
  private closed = false;

  private constructor(mapping: ToolMapping, onCall: (call: SuspendedToolCall) => void) {
    this.mapping = mapping;
    this.onCall = onCall;
    this.token = randomBytes(24).toString("hex");
    this.server = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(err instanceof Error ? err.message : String(err));
        }
      });
    });
    // Never time out suspended tool calls waiting on Pi user approvals or slow scripts.
    this.server.timeout = 0;
    this.server.keepAliveTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.requestTimeout = 0;
  }

  static async start(tools: readonly Tool[], onCall: (call: SuspendedToolCall) => void): Promise<LoopbackMcpServer> {
    const mapping = buildToolMapping(tools);
    const instance = new LoopbackMcpServer(mapping, onCall);
    await new Promise<void>((resolve, reject) => {
      instance.server.once("error", reject);
      if (process.platform !== "win32") {
        // Prefer /tmp on POSIX to stay well under macOS's 104-byte sun_path limit.
        const baseTmp = existsSync("/tmp") ? "/tmp" : tmpdir();
        instance.socketDir = mkdtempSync(join(baseTmp, "pi-agy-"));
        instance.socketPath = join(instance.socketDir, "m.sock");
        instance.server.listen(instance.socketPath, () => {
          instance.server.off("error", reject);
          resolve();
        });
      } else {
        instance.server.listen(0, "127.0.0.1", () => {
          instance.server.off("error", reject);
          const addr = instance.server.address();
          if (!addr || typeof addr === "string") {
            reject(new Error("Failed to bind loopback MCP server"));
            return;
          }
          instance.port = addr.port;
          resolve();
        });
      }
    });
    return instance;
  }

  get toolMapping(): ToolMapping {
    return this.mapping;
  }

  /** ACP `mcpServers` entry that spawns `mcp-bridge.mjs` pointing at this loopback server. */
  toAcpServerSpec(): AcpMcpServerSpec {
    const endpointEnv = this.socketPath
      ? { name: "PI_AGY_MCP_SOCKET", value: this.socketPath }
      : { name: "PI_AGY_MCP_URL", value: `http://127.0.0.1:${this.port}` };
    return {
      name: MCP_SERVER_NAME,
      command: process.execPath,
      args: [BRIDGE_SCRIPT],
      env: [
        endpointEnv,
        { name: "PI_AGY_MCP_TOKEN", value: this.token },
      ],
    };
  }

  isKnownAcpToolName(acpName: string): boolean {
    if (!acpName.startsWith(MCP_TOOL_PREFIX)) return false;
    const mcpName = acpName.slice(MCP_TOOL_PREFIX.length);
    return this.mapping.mcpToPi.has(mcpName);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    if (req.method === "GET" && req.url === "/tools") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools: this.mapping.mcpTools }));
      return;
    }

    if (req.method === "POST" && req.url === "/call") {
      const body = await readJsonBody(req);
      const mcpName = typeof body.name === "string" ? body.name : "";
      const piName = this.mapping.mcpToPi.get(mcpName);
      if (!piName) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: `Unknown Pi tool: ${mcpName}` }],
            isError: true,
          }),
        );
        return;
      }

      const args = sanitizeToolArguments(body.arguments, this.mapping.declaredKeysByMcpName.get(mcpName));

      let settled = false;
      const result = await new Promise<McpToolCallResult>((resolve, reject) => {
        const doneResolve = (value: McpToolCallResult) => {
          if (settled) return;
          settled = true;
          this.activeRejectors.delete(doneReject);
          resolve(value);
        };
        const doneReject = (err: Error) => {
          if (settled) return;
          settled = true;
          this.activeRejectors.delete(doneReject);
          reject(err);
        };
        this.activeRejectors.add(doneReject);
        req.on("close", () => {
          if (!settled) {
            doneReject(new Error("MCP bridge connection closed before tool completed"));
          }
        });
        this.onCall({
          piName,
          mcpName,
          args,
          resolve: doneResolve,
          reject: doneReject,
        });
      });

      if (!res.writableEnded) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("Loopback MCP server closed");
    for (const reject of this.activeRejectors) {
      reject(err);
    }
    this.activeRejectors.clear();
    try {
      this.server.close();
    } catch {
      // Ignore.
    }
    if (this.socketDir) {
      try {
        rmSync(this.socketDir, { recursive: true, force: true });
      } catch {
        // Ignore.
      }
      this.socketDir = undefined;
      this.socketPath = undefined;
    }
  }
}
