// Local viewer and steering API, bound to 127.0.0.1 only. Every request needs a token (the UI token in `?t=` or the
// `x-swarm-token` header; worker tokens for the worker endpoints). The Host header must name the bound address, which
// blocks DNS rebinding, and a POST from a foreign Origin is refused, which blocks cross-site form posts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BoardMessage, Kind } from "./store.ts";

export interface ServerApi {
  html(): string;
  state(): unknown;
  workflowAction?(input: unknown): Promise<unknown>;
  transcript(name: string): unknown[] | null;
  humanPost(body: string): Promise<BoardMessage>;
  workerName(token: string): string | null;
  workerPost(name: string, body: string, kind: Kind): Promise<BoardMessage>;
  workerRead(name: string, query: URLSearchParams): Promise<unknown>;
  subscribe(listener: (type: string, data: unknown) => void): () => void;
}

export interface SwarmServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY = 256 * 1024;
const HEARTBEAT_MS = 15_000;

const BOARD_TOOLS = [
  { name: "board_read", description: "Read the swarm board and current roster.", inputSchema: { type: "object", properties: {} } },
  { name: "board_post", description: "Post as yourself. Use @name to wake the member who should act next.", inputSchema: {
    type: "object", required: ["body"], properties: { body: { type: "string" }, kind: { type: "string", enum: ["message", "result", "question"] } },
  } },
];

/** Stateless Streamable HTTP MCP, sharing the same per-worker identity and board as Pi. */
async function boardMcp(api: ServerApi, name: string, rpc: any, res: ServerResponse) {
  if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") return send(res, 400, { error: "invalid JSON-RPC request" });
  if (rpc.id === undefined) { res.writeHead(202).end(); return; }
  const respond = (result: unknown) => send(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
  switch (rpc.method) {
    case "initialize": {
      const requested = rpc.params?.protocolVersion;
      const protocolVersion = ["2025-03-26", "2025-06-18", "2025-11-25"].includes(requested) ? requested : "2025-11-25";
      return respond({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "swarm-board", version: "1.0.0" } });
    }
    case "ping": return respond({});
    case "tools/list": return respond({ tools: BOARD_TOOLS });
    case "tools/call": {
      const tool = rpc.params?.name;
      const args = rpc.params?.arguments;
      const text = (value: unknown, isError = false) => respond({ isError, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
      if (tool === "board_read") return text(await api.workerRead(name, new URLSearchParams()));
      if (tool === "board_post" && typeof args?.body === "string" && args.body.trim()) return text(await api.workerPost(name, args.body, args.kind ?? "message"));
      return text("Unknown board tool or missing body.", true);
    }
    default: return send(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
  }
}

function send(res: ServerResponse, status: number, data: unknown, type = "application/json; charset=utf-8") {
  const body = typeof data === "string" && !type.startsWith("application/json") ? data : JSON.stringify(data);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export function startServer(api: ServerApi, options: { token: string; port?: number; host?: string }): Promise<SwarmServer> {
  const host = options.host ?? "127.0.0.1";
  const sockets = new Set<import("node:net").Socket>();
  const streams = new Set<ServerResponse>();
  let port = 0;

  const allowedHosts = () => new Set([`${host}:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([`http://${host}:${port}`, `http://localhost:${port}`]);

  const server: Server = createServer(async (req, res) => {
    try {
      if (!allowedHosts().has(String(req.headers.host ?? ""))) return send(res, 421, { error: "unexpected Host header" });
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const origin = req.headers.origin;
      if (req.method !== "GET" && origin && !allowedOrigins().has(origin)) return send(res, 403, { error: "cross-origin request refused" });
      const token = String(req.headers["x-swarm-token"] ?? url.searchParams.get("t") ?? "");
      const path = url.pathname;

      // Worker endpoints: authenticated by a per-worker token, so a worker can only post as itself.
      if (path.startsWith("/api/worker/")) {
        const workerToken = String(req.headers["x-swarm-token"] ?? "");
        const name = api.workerName(workerToken);
        if (!name) return send(res, 401, { error: "unknown worker token" });
        if (path === "/api/worker/mcp") {
          if (req.method !== "POST") return send(res, 405, { error: "MCP accepts POST only" });
          const rpc = await readBody(req);
          if (!api.workerName(workerToken)) return send(res, 401, { error: "worker token revoked" });
          return await boardMcp(api, name, rpc, res);
        }
        if (req.method === "POST" && path === "/api/worker/board") {
          const body = await readBody(req);
          if (!api.workerName(workerToken)) return send(res, 401, { error: "worker token revoked" });
          if (typeof body?.body !== "string" || !body.body.trim()) return send(res, 400, { error: "body is required" });
          return send(res, 200, await api.workerPost(name, body.body, body.kind ?? "message"));
        }
        if (req.method === "GET" && path === "/api/worker/board") return send(res, 200, await api.workerRead(name, url.searchParams));
        return send(res, 404, { error: "not found" });
      }

      if (token !== options.token) return send(res, 401, { error: "missing or wrong token; open the URL printed by /swarm" });

      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.setHeader("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        return send(res, 200, api.html(), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && path === "/api/state") return send(res, 200, api.state());
      if (req.method === "POST" && path === "/api/workflow" && api.workflowAction) {
        const body = await readBody(req);
        try { return send(res, 200, await api.workflowAction(body)); }
        catch (error) { return send(res, 400, { error: (error as Error).message }); }
      }
      const transcript = path.match(/^\/api\/workers\/([a-z][a-z0-9-]*)\/transcript$/);
      if (req.method === "GET" && transcript) {
        const records = api.transcript(transcript[1]);
        return records ? send(res, 200, { name: transcript[1], records }) : send(res, 404, { error: "no such member" });
      }
      if (req.method === "POST" && path === "/api/board") {
        const body = await readBody(req);
        if (typeof body.body !== "string" || !body.body.trim()) return send(res, 400, { error: "body is required" });
        return send(res, 200, await api.humanPost(body.body));
      }
      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        let seq = 0;
        const write = (type: string, data: unknown) => res.write(`id: ${++seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        write("snapshot", api.state());
        const unsubscribe = api.subscribe(write);
        const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
        streams.add(res);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
          streams.delete(res);
        });
        return;
      }
      return send(res, 404, { error: "not found" });
    } catch (error: any) {
      if (!res.headersSent) send(res, error?.status ?? 500, { error: error?.message ?? String(error) });
      else res.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      port = (server.address() as AddressInfo).port;
      resolve({
        port,
        url: `http://${host}:${port}/?t=${options.token}`,
        close: () =>
          new Promise<void>((done) => {
            for (const res of streams) res.end();
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
          }),
      });
    });
  });
}
