#!/usr/bin/env node
// tq — tldraw agent API helper. Usage:
//   node tq.mjs GET  /api/doc/DOC/script-status
//   node tq.mjs POST /api/search '{"code":"return await api.getDocs()"}'
//   node tq.mjs POST /api/doc/DOC/exec 'return editor.getCurrentPageShapes().length'
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function getServerJsonPath({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  if (env.TLDRAW_SERVER_JSON) {
    return expandLeadingVariable(env.TLDRAW_SERVER_JSON, env, home);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "tldraw", "server.json");
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "tldraw", "server.json");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "tldraw", "server.json");
}

function expandLeadingVariable(filePath, env, home) {
  if (filePath === "~" || filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return home + filePath.slice(1);
  }
  const match = filePath.match(/^\$([A-Za-z_][A-Za-z0-9_]*)(?=[/\\]|$)/);
  if (!match) return filePath;
  const value = env[match[1]] ?? (match[1] === "HOME" ? home : undefined);
  return value ? value + filePath.slice(match[0].length) : filePath;
}

export function readServerJson(serverJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(serverJsonPath, "utf8"));
  } catch {
    return null;
  }
}

export function sendRequest({ method, requestPath, body, server, stdout = process.stdout, stderr = process.stderr }) {
  return new Promise((resolve) => {
    const headers = { authorization: `Bearer ${server.token}` };
    if (body) headers["content-type"] = body.startsWith("{") ? "application/json" : "text/plain";

    const req = http.request(
      { host: "127.0.0.1", port: server.port, path: requestPath, method, headers },
      (res) => {
        res.pipe(stdout, { end: false });
        res.on("end", () => resolve(0));
      },
    );
    req.on("error", (error) => {
      stderr.write(`tq: ${error.message}\n`);
      resolve(1);
    });
    req.end(body || undefined);
  });
}

export async function main(args = process.argv.slice(2)) {
  const [method, requestPath, body] = args;
  if (!method || !requestPath) {
    console.error("Usage: tq.mjs <METHOD> <path> [body]");
    return 2;
  }

  const serverJsonPath = getServerJsonPath();
  const server = readServerJson(serverJsonPath);
  if (!server?.port || !server?.token) {
    console.error(`tq: cannot read ${serverJsonPath} — the tldraw desktop app is not running`);
    return 1;
  }

  return sendRequest({ method, requestPath, body, server });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
