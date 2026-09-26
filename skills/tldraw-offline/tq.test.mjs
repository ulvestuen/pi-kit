import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { getServerJsonPath } from "./tq.mjs";

const tq = fileURLToPath(new URL("./tq.mjs", import.meta.url));

test("getServerJsonPath uses portable app-data defaults and supports an override", () => {
  assert.equal(
    getServerJsonPath({ env: {}, platform: "darwin", home: "/home/alex" }),
    path.join("/home/alex", "Library", "Application Support", "tldraw", "server.json"),
  );
  assert.equal(
    getServerJsonPath({ env: { XDG_CONFIG_HOME: "/config" }, platform: "linux", home: "/home/alex" }),
    path.join("/config", "tldraw", "server.json"),
  );
  assert.equal(
    getServerJsonPath({ env: { TLDRAW_SERVER_JSON: "$HOME/custom/server.json" }, home: "/home/alex" }),
    "/home/alex/custom/server.json",
  );
});

test("tq reads server.json and forwards an authenticated JSON request", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tq-test-"));
  const serverJsonPath = path.join(directory, "server.json");
  let received;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      };
      response.end('{"ok":true}');
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await writeFile(serverJsonPath, JSON.stringify({ port, token: "secret-token" }));

  try {
    const result = await runNode(
      [tq, "POST", "/api/search", '{"code":"return 1"}'],
      { ...process.env, TLDRAW_SERVER_JSON: serverJsonPath },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '{"ok":true}');
    assert.deepEqual(received, {
      method: "POST",
      url: "/api/search",
      authorization: "Bearer secret-token",
      contentType: "application/json",
      body: '{"code":"return 1"}',
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
