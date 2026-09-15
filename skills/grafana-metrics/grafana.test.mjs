import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { callbackServer, configuration, ENDPOINT, GrafanaClient, readReply, saveState } from "./grafana.mjs";

const SCRIPT = fileURLToPath(new URL("./grafana.mjs", import.meta.url));
const NOW = Date.parse("2026-09-15T12:00:00Z");
const oauth = {
  authorization_endpoint: `${ENDPOINT}/oauth/authorize`,
  token_endpoint: `${ENDPOINT}/oauth/token`,
  registration_endpoint: `${ENDPOINT}/oauth/register`,
};
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
const tokens = (extra = {}) => ({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 3600, scope: "grafana:read", ...extra });

async function fixture(t, handler = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "grafana test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = configuration({ XDG_CONFIG_HOME: root, GRAFANA_URL: "https://test.grafana.net" });
  const requests = [];
  const fetchImpl = async (url, options) => {
    const entry = { url, ...options };
    requests.push(entry);
    const custom = await handler(entry);
    if (custom) return custom;
    if (url === ENDPOINT && !options.method) return new Response(null, {
      status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.grafana.com/.well-known/oauth-protected-resource/mcp"' },
    });
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) return json({ resource: ENDPOINT, authorization_servers: [ENDPOINT] });
    if (url.endsWith("/.well-known/oauth-authorization-server/mcp")) return json({ issuer: ENDPOINT, ...oauth, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url === oauth.registration_endpoint) return json({ client_id: "registered-client", token_endpoint_auth_method: "none" }, 201);
    if (url === oauth.token_endpoint) return json(tokens());
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    const message = JSON.parse(options.body);
    if (message.id === undefined || !message.method) return new Response(null, { status: 202 });
    if (message.method === "initialize") return json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }, 200, { "Mcp-Session-Id": "session-1" });
    return json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
  };
  const client = new GrafanaClient(config, { fetchImpl, now: () => NOW });
  const authenticate = () => {
    client.state = { client: { client_id: "registered-client" }, oauth, redirectUri: config.redirectUri };
    client.storeTokens(tokens());
  };
  return { root, config, client, requests, fetchImpl, authenticate };
}

test("OAuth discovers real-shaped metadata, registers a public client, and completes PKCE across client restarts", async (t) => {
  const f = await fixture(t);
  const authorization = new URL(await f.client.beginLogin());
  const pending = JSON.parse(await readFile(f.config.file, "utf8"));
  const registration = JSON.parse(f.requests.find((r) => r.url === oauth.registration_endpoint).body);
  assert.deepEqual(registration.redirect_uris, ["http://127.0.0.1:8787/callback"]);
  assert.equal(registration.token_endpoint_auth_method, "none");
  assert.equal(registration.scope, "grafana:read");
  assert.equal(authorization.searchParams.get("resource"), "https://mcp.grafana.com/mcp");
  assert.equal(authorization.searchParams.get("scope"), "grafana:read");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("code_challenge"), createHash("sha256").update(pending.pending.verifier).digest("base64url"));
  assert.match(pending.pending.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(pending.pending.state, pending.pending.verifier);
  const next = new GrafanaClient(f.config, { fetchImpl: f.fetchImpl, now: () => NOW });
  await next.load();
  await next.finishLogin(`${f.config.redirectUri}?code=code%2Bwith%26symbols&state=${pending.pending.state}`);
  const exchange = new URLSearchParams(f.requests.find((r) => r.url === oauth.token_endpoint).body);
  assert.equal(exchange.get("code"), "code+with&symbols");
  assert.equal(exchange.get("code_verifier"), pending.pending.verifier);
  assert.equal(exchange.get("redirect_uri"), "http://127.0.0.1:8787/callback");
  assert.equal(exchange.get("resource"), "https://mcp.grafana.com/mcp");
  assert.equal(exchange.get("client_id"), "registered-client");
  assert.equal(exchange.get("grant_type"), "authorization_code");
  const saved = JSON.parse(await readFile(f.config.file, "utf8"));
  assert.equal(saved.pending, undefined);
  assert.equal(saved.tokens.expiresAt, Date.parse("2026-09-15T13:00:00Z"));
  assert.equal((await stat(f.config.file)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(f.config.file))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dirname(f.config.file)), [f.config.file.split("/").at(-1)]);
  for (const r of f.requests) {
    assert.equal(r.redirect, "error");
    assert.equal(r.headers["X-Grafana-URL"], "https://test.grafana.net");
    assert.equal(r.headers.Authorization, undefined);
  }
  await next.beginLogin();
  assert.equal(f.requests.filter((r) => r.url === oauth.registration_endpoint).length, 1, "reuse registration");
  assert.notEqual(next.state.pending.state, pending.pending.state);
});

test("wrong state, wrong redirect, missing code, denial, and the exact expiry boundary cannot exchange codes", async (t) => {
  const f = await fixture(t);
  await f.client.beginLogin();
  const state = f.client.state.pending.state;
  const badState = (state[0] === "A" ? "B" : "A") + state.slice(1);
  for (const callback of [
    `${f.config.redirectUri}?code=secret&state=${badState}`,
    `${f.config.redirectUri}?code=secret`,
    `https://evil.example/callback?code=secret&state=${state}`,
    `${f.config.redirectUri}/wrong?code=secret&state=${state}`,
    `${f.config.redirectUri}?state=${state}`,
  ]) await assert.rejects(f.client.finishLogin(callback), /mismatch|missing/);
  f.client.now = () => NOW + 300_000;
  await assert.rejects(f.client.finishLogin(`${f.config.redirectUri}?code=secret&state=${state}`), /expired/);
  f.client.now = () => NOW + 299_999;
  await assert.rejects(f.client.finishLogin(`${f.config.redirectUri}?error=access_denied&state=${state}`), /denied/);
  assert.equal(f.client.state.pending, undefined);
  assert.equal(f.requests.filter((r) => r.url === oauth.token_endpoint).length, 0);
});

test("untrusted discovery and cached token endpoints are rejected before credentials leave Grafana", async (t) => {
  const f = await fixture(t, (r) => r.url.endsWith("oauth-protected-resource/mcp")
    ? json({ resource: ENDPOINT, authorization_servers: ["https://evil.example/mcp"] }) : undefined);
  await assert.rejects(f.client.beginLogin(), /outside/);
  f.authenticate();
  f.client.state.oauth = { ...oauth, token_endpoint: "https://evil.example/token" };
  await assert.rejects(f.client.accessToken(true), /outside/);
  assert.ok(f.requests.every((r) => new URL(r.url).origin === "https://mcp.grafana.com"));
  assert.throws(() => configuration({ GRAFANA_URL: "https://name:secret@stack.grafana.net" }), /without credentials/);
  assert.throws(() => configuration({ GRAFANA_URL: "http://stack.grafana.net" }), /HTTPS/);
  assert.throws(() => configuration({ GRAFANA_OAUTH_PORT: "0" }), /1024/);
  assert.notEqual(configuration({ GRAFANA_URL: "https://a.grafana.net" }).file, configuration({ GRAFANA_URL: "https://b.grafana.net" }).file);
});

test("refresh respects the 60-second boundary, persists rotation, and retains an omitted refresh token", async (t) => {
  let refreshed = 0;
  const f = await fixture(t, (r) => r.url === oauth.token_endpoint
    ? json(tokens({ access_token: `access-${++refreshed}`, refresh_token: refreshed === 1 ? "rotated-refresh" : undefined })) : undefined);
  f.authenticate();
  f.client.now = () => NOW + 3_539_999;
  assert.equal(await f.client.accessToken(), "access-secret");
  assert.equal(refreshed, 0);
  f.client.now = () => NOW + 3_540_000;
  assert.equal(await f.client.accessToken(), "access-1");
  assert.equal(JSON.parse(await readFile(f.config.file, "utf8")).tokens.refresh_token, "rotated-refresh");
  assert.equal(await f.client.accessToken(true), "access-2");
  assert.equal(f.client.state.tokens.refresh_token, "rotated-refresh");
  const requests = f.requests.filter((r) => r.url === oauth.token_endpoint).map((r) => new URLSearchParams(r.body));
  assert.equal(requests[0].get("refresh_token"), "refresh-secret");
  assert.equal(requests[1].get("refresh_token"), "rotated-refresh");
  assert.equal(requests[1].get("grant_type"), "refresh_token");
  assert.equal(requests[1].get("resource"), "https://mcp.grafana.com/mcp");
});

test("revoked refresh tokens are removed without exposing OAuth error bodies; write scope is rejected", async (t) => {
  const f = await fixture(t, (r) => r.url === oauth.token_endpoint
    ? json({ error: "invalid_grant", error_description: "do-not-print-refresh-secret" }, 400) : undefined);
  f.authenticate();
  await assert.rejects(f.client.accessToken(true), (error) => {
    assert.match(error.message, /revoked.*login/);
    assert.doesNotMatch(error.message, /do-not-print/);
    return true;
  });
  assert.equal(JSON.parse(await readFile(f.config.file, "utf8")).tokens, undefined);
  assert.throws(() => f.client.storeTokens(tokens({ scope: "grafana:read grafana:write" })), /unexpected scopes/);
});

test("MCP negotiates sessions, paginates filtered schemas, and preserves complete tool results and arguments", async (t) => {
  const schema = { name: "query_loki_logs", inputSchema: { type: "object", required: ["datasourceUid"] } };
  const result = { content: [{ type: "text", text: "æ log" }], structuredContent: { samples: [3, 7] }, isError: false };
  const f = await fixture(t, (r) => {
    if (r.url !== ENDPOINT || r.method !== "POST") return;
    const m = JSON.parse(r.body);
    if (m.method === "tools/list") return json({ jsonrpc: "2.0", id: m.id, result: m.params.cursor
      ? { tools: [schema] } : { tools: [{ name: "update_dashboard" }, { name: "query_clickhouse" }], nextCursor: "page-two" } });
    if (m.method === "tools/call") return json({ jsonrpc: "2.0", id: m.id, result });
  });
  f.authenticate();
  assert.deepEqual(await f.client.tools(), { tools: [schema] });
  const args = { datasourceUid: "loki-B", logql: '{service_name="checkout"} |= "error"', limit: 73, startRfc3339: "2026-09-15T11:47:00Z" };
  assert.deepEqual(await f.client.call("query_loki_logs", args), result);
  await f.client.close();
  const posts = f.requests.filter((r) => r.method === "POST");
  assert.deepEqual(posts.map((r) => JSON.parse(r.body).method), ["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call"]);
  assert.equal(posts[0].headers["Mcp-Session-Id"], undefined);
  for (const r of posts.slice(1)) {
    assert.equal(r.headers["Mcp-Session-Id"], "session-1");
    assert.equal(r.headers["MCP-Protocol-Version"], "2025-06-18");
    assert.equal(r.headers.Authorization, "Bearer access-secret");
    assert.match(r.headers.Accept, /application\/json, text\/event-stream/);
  }
  assert.deepEqual(JSON.parse(posts.at(-1).body).params, { name: "query_loki_logs", arguments: args });
  assert.equal(f.requests.at(-1).method, "DELETE");
  assert.equal(f.requests.at(-1).headers["Mcp-Session-Id"], "session-1");
  assert.throws(() => f.client.call("update_dashboard", {}), /read-only/);
  assert.throws(() => f.client.call("query_clickhouse", {}), /read-only/);
  assert.throws(() => f.client.call("query_loki_logs", []), /JSON object/);
});

test("streamed replies handle split UTF-8, CRLF, progress, server ping, and a stream left open after the reply", async (t) => {
  let cancelled = false;
  const result = { content: [{ type: "text", text: "blåbær" }], isError: true };
  const f = await fixture(t, (r) => {
    if (r.url !== ENDPOINT || r.method !== "POST") return;
    const m = JSON.parse(r.body);
    if (m.method !== "tools/call") return;
    const bytes = new TextEncoder().encode([
      ": keepalive\r\n\r\n",
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n',
      'data: {"jsonrpc":"2.0","id":"ping-1","method":"ping"}\r\n\r\n',
      'data: {"jsonrpc":"2.0","id":999,"result":{"wrong":true}}\r\n\r\n',
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\r\n\r\n`,
    ].join(""));
    let index = 0;
    return new Response(new ReadableStream({
      pull(controller) { if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index)); },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  });
  f.authenticate();
  assert.deepEqual(await f.client.call("query_prometheus", { expr: "up" }), result);
  assert.equal(cancelled, true);
  const pong = f.requests.map((r) => r.body && JSON.parse(r.body)).find((m) => m?.id === "ping-1");
  assert.deepEqual(pong, { jsonrpc: "2.0", id: "ping-1", result: {} });
  await assert.rejects(readReply(json({ jsonrpc: "2.0", id: 99, result: {} }), 3), /without a matching/);
});

test("a read call recovers with the rotated token after 401 and a new session after 404", async (t) => {
  for (const status of [401, 404]) {
    let initializations = 0, calls = 0;
    const result = { content: [{ type: "text", text: "recovered" }], structuredContent: { value: 73 } };
    const f = await fixture(t, (r) => {
      if (r.url === oauth.token_endpoint) return json(tokens({ access_token: "new-access", refresh_token: "new-refresh" }));
      if (r.url !== ENDPOINT || r.method !== "POST") return;
      const m = JSON.parse(r.body);
      if (m.method === "initialize") return json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18" } }, 200, { "Mcp-Session-Id": `session-${++initializations}` });
      if (m.method === "tools/call") return ++calls === 1 ? new Response(null, { status })
        : json({ jsonrpc: "2.0", id: m.id, result });
    });
    f.authenticate();
    assert.deepEqual(await f.client.call("query_prometheus", { expr: "up", time: "2026-09-15T11:47:00Z" }), result);
    const requests = f.requests.filter((r) => r.url === ENDPOINT && r.method === "POST");
    const attempts = requests.filter((r) => JSON.parse(r.body).method === "tools/call");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].headers.Authorization, "Bearer access-secret");
    assert.equal(attempts[1].headers.Authorization, status === 401 ? "Bearer new-access" : "Bearer access-secret");
    assert.equal(attempts[0].headers["Mcp-Session-Id"], "session-1");
    assert.equal(attempts[1].headers["Mcp-Session-Id"], status === 404 ? "session-2" : "session-1");
    assert.deepEqual(JSON.parse(attempts[1].body), JSON.parse(attempts[0].body));
    for (const r of requests.filter((r) => JSON.parse(r.body).method === "initialize")) {
      assert.equal(r.headers["Mcp-Session-Id"], undefined);
    }
  }
});

test("401 refresh and expired-session recovery are bounded; permission, network, and server failures are not retried", async (t) => {
  for (const status of [401, 403, 404, 429, 503, "network"]) {
    let count = 0;
    const f = await fixture(t, (r) => {
      if (r.url !== ENDPOINT || r.method !== "POST" || JSON.parse(r.body).method !== "tools/list") return;
      count++;
      if (status === "network") throw new Error("secret transport detail");
      return new Response(null, { status });
    });
    f.authenticate();
    await assert.rejects(f.client.tools(), status === "network" ? /network/ : new RegExp(`HTTP ${status}`));
    assert.equal(count, [401, 404].includes(status) ? 2 : 1, String(status));
    assert.equal(f.requests.filter((r) => r.url === oauth.token_endpoint).length, status === 401 ? 1 : 0);
    assert.equal(f.requests.filter((r) => r.method === "POST" && r.url === ENDPOINT && JSON.parse(r.body).method === "initialize").length, status === 404 ? 2 : 1);
  }
});

test("loopback listener rejects foreign Host/path and bad state, then accepts the legitimate callback", async (t) => {
  const listener = await callbackServer("http://127.0.0.1:0/callback", async (url) => {
    if (new URL(url).searchParams.get("state") !== "correct") {
      throw Object.assign(new Error("bad state"), { code: "INVALID_CALLBACK" });
    }
  });
  t.after(() => listener.close());
  // fetch may replace the Host header; use HTTP directly to exercise rebinding protection.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    get(listener.redirectUri, { headers: { Host: "evil.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(foreignHostStatus, 404);
  assert.equal((await fetch(listener.redirectUri + "/wrong")).status, 404);
  assert.equal((await fetch(listener.redirectUri + "?state=wrong")).status, 400);
  const success = await fetch(listener.redirectUri + "?state=correct");
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("cache-control"), "no-store");
  assert.match(await success.text(), /login complete/);
  await listener.done;
  const expired = await callbackServer("http://127.0.0.1:0/callback", async () => {}, { timeout: 10 });
  t.after(() => expired.close());
  await assert.rejects(expired.done, /timed out/);
});

function runNode(args, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("CLI status/logout and failure paths never reveal secrets and enforce the cross-process lock", async (t) => {
  const f = await fixture(t);
  const env = { XDG_CONFIG_HOME: f.root, GRAFANA_URL: f.config.stack };
  f.authenticate();
  await saveState(f.config.file, f.client.state);
  const status = await runNode([SCRIPT, "status"], env);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).refreshable, true);
  assert.doesNotMatch(status.stdout + status.stderr, /access-secret|refresh-secret|registered-client/);
  await mkdir(`${f.config.file}.lock`);
  const locked = await runNode([SCRIPT, "status"], env);
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /Another Grafana command/);
  await rm(`${f.config.file}.lock`, { recursive: true });
  const blocked = await runNode([SCRIPT, "call", "update_dashboard", "{}"], env);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /read-only/);
  const invalid = await runNode([SCRIPT, "call", "query_loki_logs", "--file", "-"], env, "{not-json-secret");
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /valid JSON/);
  assert.doesNotMatch(invalid.stderr, /not-json-secret/);
  const logout = await runNode([SCRIPT, "logout"], env);
  assert.equal(logout.code, 0, logout.stderr);
  assert.deepEqual(JSON.parse(logout.stdout), { localCredentialsRemoved: true, remoteAccessRevoked: false });
  await assert.rejects(stat(f.config.file), { code: "ENOENT" });
});

test("CLI preserves MCP tool errors on stdout with a nonzero exit and reads query JSON from stdin", async (t) => {
  const f = await fixture(t);
  f.authenticate();
  f.client.state.tokens.expiresAt = Date.now() + 3600_000;
  await f.client.save();
  const program = `
    import { main } from ${JSON.stringify(new URL("./grafana.mjs", import.meta.url).href)};
    globalThis.fetch = async (url, options) => {
      const message = JSON.parse(options.body);
      if (!message.id) return new Response(null, {status: 202});
      const result = message.method === 'initialize' ? {protocolVersion: '2025-06-18'}
        : {isError: true, content: [{type: 'text', text: 'invalid datasource'}], structuredContent: message.params.arguments};
      return Response.json({jsonrpc: '2.0', id: message.id, result});
    };
    await main(['call', 'query_loki_logs', '--file', '-']);
  `;
  const result = await runNode(["--input-type=module", "-e", program], { XDG_CONFIG_HOME: f.root, GRAFANA_URL: f.config.stack }, '{"datasourceUid":"missing-B","limit":73}');
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    isError: true, content: [{ type: "text", text: "invalid datasource" }], structuredContent: { datasourceUid: "missing-B", limit: 73 },
  });
});

test("callback shutdown waits for an exchange and credential save that outlive the login deadline", async (t) => {
  const f = await fixture(t);
  f.authenticate();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const listener = await callbackServer("http://127.0.0.1:0/callback", async () => {
    started.resolve();
    await release.promise;
    await f.client.save();
  }, { timeout: 100 });
  t.after(async () => {
    release.resolve();
    await listener.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const response = fetch(listener.redirectUri).catch(() => null);
  await started.promise;
  await assert.rejects(listener.done, /timed out/);
  let closed = false;
  const closing = Promise.resolve(listener.close()).then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false, "closing must wait while credentials could still be saved");
  release.resolve();
  await closing;
  assert.equal(JSON.parse(await readFile(f.config.file, "utf8")).tokens.refresh_token, "refresh-secret");
  await response;
});

function interactiveNode(t, env, program) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    env, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
  const messages = [], waiting = [];
  child.on("message", (message) => waiting.length ? waiting.shift()(message) : messages.push(message));
  const result = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return {
    child, result,
    message: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiting.push(resolve)),
  };
}

test("SIGINT and SIGTERM clean up waiting logins and retain the lock until active OAuth exchanges settle", { timeout: 15_000 }, async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    for (const exchanging of [false, true]) {
      const f = await fixture(t);
      const reservation = await callbackServer("http://127.0.0.1:0/callback", async () => {});
      const port = new URL(reservation.redirectUri).port;
      await reservation.close();
      const env = { XDG_CONFIG_HOME: f.root, GRAFANA_URL: f.config.stack, GRAFANA_OAUTH_PORT: port };
      const program = `
        import { main, GrafanaClient } from ${JSON.stringify(new URL("./grafana.mjs", import.meta.url).href)};
        process.on(${JSON.stringify(signal)}, () => process.send('signal-seen'));
        GrafanaClient.prototype.beginLogin = async function () {
          this.state = {
            client: {client_id: 'test-client'}, oauth: ${JSON.stringify(oauth)},
            redirectUri: this.config.redirectUri,
            pending: {state: 'expected-state', verifier: 'test-verifier', expiresAt: Date.now() + 300000}
          };
          await this.save();
          process.send({ready: this.config.redirectUri});
          return 'https://mcp.grafana.com/test-authorization';
        };
        globalThis.fetch = async () => {
          const released = new Promise(resolve => process.once('message', resolve));
          process.send('exchange-started');
          await released;
          return Response.json(${JSON.stringify(tokens())});
        };
        try { await main(['login']); }
        catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
        finally { process.disconnect(); }
      `;
      const run = interactiveNode(t, env, program);
      const { ready } = await run.message();
      let response;
      if (exchanging) {
        response = fetch(`${ready}?code=test-code&state=expected-state`).catch(() => null);
        assert.equal(await run.message(), "exchange-started");
      }
      run.child.kill(signal);
      assert.equal(await run.message(), "signal-seen");
      if (exchanging) {
        const locked = await runNode([SCRIPT, "logout"], env);
        assert.equal(locked.code, 1);
        assert.match(locked.stderr, /Another Grafana command/);
        run.child.send("release-exchange");
      }
      const result = await run.result;
      assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.stderr);
      assert.equal(result.stdout, "", "cancellation must not print successful authentication");
      await assert.rejects(stat(`${f.config.file}.lock`), { code: "ENOENT" });
      if (exchanging) {
        assert.equal(JSON.parse(await readFile(f.config.file, "utf8")).tokens.refresh_token, "refresh-secret");
        await response;
      }
      const logout = await runNode([SCRIPT, "logout"], env);
      assert.equal(logout.code, 0, logout.stderr);
      await assert.rejects(stat(f.config.file), { code: "ENOENT" });
    }
  }
});

test("cancellation during refresh saves the rotated token without starting the MCP request", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.authenticate();
  f.client.state.tokens.expiresAt = 0;
  await f.client.save();
  const env = { XDG_CONFIG_HOME: f.root, GRAFANA_URL: f.config.stack };
  const program = `
    import { main } from ${JSON.stringify(new URL("./grafana.mjs", import.meta.url).href)};
    process.on('SIGINT', () => process.send('signal-seen'));
    let requests = 0;
    globalThis.fetch = async (url) => {
      requests++;
      if (url !== ${JSON.stringify(oauth.token_endpoint)}) throw new Error('Unexpected request after cancellation');
      const released = new Promise(resolve => process.once('message', resolve));
      process.send('refresh-started');
      await released;
      return Response.json(${JSON.stringify(tokens({ access_token: "rotated-access", refresh_token: "rotated-refresh" }))});
    };
    try { await main(['tools']); }
    catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
    finally { process.send({requests}); process.disconnect(); }
  `;
  const run = interactiveNode(t, env, program);
  assert.equal(await run.message(), "refresh-started");
  run.child.kill("SIGINT");
  assert.equal(await run.message(), "signal-seen");
  const locked = await runNode([SCRIPT, "logout"], env);
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /Another Grafana command/);
  run.child.send("release-refresh");
  assert.deepEqual(await run.message(), { requests: 1 });
  const result = await run.result;
  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(await readFile(f.config.file, "utf8")).tokens.refresh_token, "rotated-refresh");
  await assert.rejects(stat(`${f.config.file}.lock`), { code: "ENOENT" });
});

test("stdin preserves UTF-8 split across chunks and cancellation releases its lock", { timeout: 10_000 }, async (t) => {
  for (const cancel of [false, true]) {
    const f = await fixture(t);
    f.authenticate();
    f.client.state.tokens.expiresAt = Date.now() + 3600_000;
    await f.client.save();
    const env = { XDG_CONFIG_HOME: f.root, GRAFANA_URL: f.config.stack };
    const program = `
      import { main, GrafanaClient } from ${JSON.stringify(new URL("./grafana.mjs", import.meta.url).href)};
      const iterate = process.stdin[Symbol.asyncIterator].bind(process.stdin);
      process.stdin[Symbol.asyncIterator] = async function* () {
        process.send('reading');
        for await (const chunk of iterate()) { yield chunk; process.send('consumed'); }
      };
      GrafanaClient.prototype.call = async (name, args) => ({structuredContent: args});
      try { await main(['call', 'query_loki_logs', '--file', '-']); }
      catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
      finally { process.disconnect(); }
    `;
    const run = interactiveNode(t, env, program);
    assert.equal(await run.message(), "reading");
    const query = { logql: '{service_name="checkout"} |= "blåbær 🫐"', limit: 73 };
    const bytes = Buffer.from(JSON.stringify(query));
    const split = bytes.indexOf(Buffer.from("å")) + 1;
    run.child.stdin.write(bytes.subarray(0, split));
    assert.equal(await run.message(), "consumed");
    if (cancel) run.child.kill("SIGINT");
    else run.child.stdin.end(bytes.subarray(split));
    const result = await run.result;
    assert.equal(result.code, cancel ? 130 : 0, result.stderr);
    if (!cancel) assert.deepEqual(JSON.parse(result.stdout), { structuredContent: query });
    await assert.rejects(stat(`${f.config.file}.lock`), { code: "ENOENT" });
  }
});
