#!/usr/bin/env node
// Minimal stdio MCP server spawned by `agy acp` per session.
// Forwards `tools/list` and `tools/call` to the in-process loopback bridge owned
// by the Pi Antigravity provider so Pi executes every tool and returns results.

import http from "node:http";
import readline from "node:readline";

const socketPath = process.env.PI_AGY_MCP_SOCKET;
const baseUrl = process.env.PI_AGY_MCP_URL;
const token = process.env.PI_AGY_MCP_TOKEN;

if ((!socketPath && !baseUrl) || !token) {
  process.stderr.write("pi-antigravity mcp-bridge: missing PI_AGY_MCP_SOCKET/PI_AGY_MCP_URL or PI_AGY_MCP_TOKEN\n");
  process.exit(1);
}

const parsedBase = baseUrl ? new URL(baseUrl) : null;

const send = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

function bridgeJson(path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const target = socketPath
      ? { socketPath }
      : { hostname: parsedBase.hostname, port: parsedBase.port };
    const req = http.request(
      {
        ...target,
        path,
        method: payload === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(payload === undefined ? {} : { "Content-Length": Buffer.byteLength(payload) }),
        },
        // Paused tool calls wait for Pi's user approvals or long codemode scripts.
        timeout: 0,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(text || `MCP bridge HTTP ${res.statusCode ?? "unknown"}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.setTimeout(0);
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pi-antigravity-mcp", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  }

  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    const data = await bridgeJson("/tools");
    send({
      jsonrpc: "2.0",
      id,
      result: { tools: Array.isArray(data.tools) ? data.tools : [] },
    });
    return;
  }

  if (method === "tools/call") {
    const result = await bridgeJson("/call", {
      name: params?.name,
      arguments: params?.arguments ?? {},
    });
    send({ jsonrpc: "2.0", id, result });
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handleMessage(msg).catch((err) => {
    if (msg.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      });
    }
  });
});

rl.on("close", () => {
  process.exit(0);
});
