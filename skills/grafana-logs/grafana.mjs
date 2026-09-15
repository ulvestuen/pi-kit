#!/usr/bin/env node
// Standalone Grafana Cloud MCP client; keep both Grafana skill copies identical.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { addAbortSignal } from "node:stream";
import { pathToFileURL } from "node:url";

export const ENDPOINT = "https://mcp.grafana.com/mcp";
const ORIGIN = new URL(ENDPOINT).origin;
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const LOGIN_TIMEOUT = 5 * 60_000;
export const READ_TOOLS = new Set([
  "list_datasources", "get_datasource", "generate_deeplink",
  "list_loki_label_names", "list_loki_label_values", "query_loki_logs",
  "query_loki_stats", "query_loki_patterns",
  "list_prometheus_metric_names", "list_prometheus_metric_metadata",
  "list_prometheus_label_names", "list_prometheus_label_values",
  "query_prometheus", "query_prometheus_histogram",
]);

function trustedURL(value) {
  const url = new URL(value);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) {
    throw new Error("Refusing an OAuth or MCP endpoint outside https://mcp.grafana.com.");
  }
  return url.href;
}

export function configuration(env = process.env) {
  let stack = "";
  if (env.GRAFANA_URL) {
    const url = new URL(env.GRAFANA_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("GRAFANA_URL must be an HTTPS stack origin without credentials, path, or query.");
    }
    stack = url.origin;
  }
  const port = Number(env.GRAFANA_OAUTH_PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("GRAFANA_OAUTH_PORT must be an integer from 1024 to 65535.");
  }
  const profile = createHash("sha256").update(`${ENDPOINT}\n${stack}`).digest("hex").slice(0, 24);
  return {
    stack,
    redirectUri: `http://127.0.0.1:${port}/callback`,
    file: join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-kit", "grafana", `${profile}.json`),
  };
}

export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export class GrafanaClient {
  constructor(config, { fetchImpl = fetch, now = Date.now, signal } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.signal = signal;
    this.state = {};
    this.id = 0;
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.config.file, "utf8"));
      await chmod(this.config.file, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Cannot read Grafana credential cache; repair or remove it and log in again.");
    }
  }

  save() { return saveState(this.config.file, this.state); }

  async request(url, options = {}) {
    // Stop new requests, but let an in-flight token exchange finish and persist.
    this.signal?.throwIfAborted();
    const target = trustedURL(url);
    try {
      return await this.fetch(target, {
        ...options,
        headers: { ...(this.config.stack ? { "X-Grafana-URL": this.config.stack } : {}), ...options.headers },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Grafana request failed (network, redirect, or 30-second timeout). No automatic network retry was made.");
    }
  }

  async json(url, options) {
    const response = await this.request(url, options);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Grafana metadata/registration returned HTTP ${response.status}.`);
    }
    return response.json();
  }

  async discover() {
    const response = await this.request(ENDPOINT);
    const challenge = response.headers.get("www-authenticate") || "";
    await response.body?.cancel();
    const metadataURL = challenge.match(/\bresource_metadata="([^"]+)"/i)?.[1]
      || `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;
    const resource = await this.json(metadataURL);
    if (resource.resource !== ENDPOINT || !resource.authorization_servers?.length) {
      throw new Error("Unexpected Grafana OAuth resource metadata.");
    }
    const issuer = new URL(trustedURL(resource.authorization_servers[0]));
    const metadata = await this.json(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`);
    if (metadata.issuer !== issuer.href || !metadata.code_challenge_methods_supported?.includes("S256")
        || !metadata.token_endpoint_auth_methods_supported?.includes("none")) {
      throw new Error("Grafana OAuth metadata does not support the expected public-client PKCE flow.");
    }
    return Object.fromEntries(["authorization_endpoint", "token_endpoint", "registration_endpoint"]
      .map((key) => [key, trustedURL(metadata[key])]));
  }

  async beginLogin() {
    const oauth = await this.discover();
    const redirectUri = this.config.redirectUri;
    if (!this.state.client || this.state.redirectUri !== redirectUri) {
      const client = await this.json(oauth.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "pi-kit Grafana logs and metrics",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "grafana:read",
        }),
      });
      if (!client.client_id || client.client_secret || (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== "none")) {
        throw new Error("Grafana did not register a public OAuth client.");
      }
      this.state.client = { client_id: client.client_id };
    }
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    this.state = {
      client: this.state.client, oauth, redirectUri,
      pending: { verifier, state, expiresAt: this.now() + LOGIN_TIMEOUT },
    };
    await this.save();
    const url = new URL(oauth.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code", client_id: this.state.client.client_id,
      redirect_uri: redirectUri, scope: "grafana:read", state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", resource: ENDPOINT,
    }).toString();
    return url.href;
  }

  async finishLogin(callback) {
    const pending = this.state.pending;
    if (!pending || pending.expiresAt <= this.now()) throw new Error("Login is missing or expired; run login again.");
    let url;
    try { url = new URL(callback.trim()); } catch {
      throw Object.assign(new Error("Expected the complete OAuth callback URL on stdin."), { code: "INVALID_CALLBACK" });
    }
    const expected = new URL(this.state.redirectUri);
    const state = Buffer.from(url.searchParams.get("state") || "");
    const validState = state.length === Buffer.byteLength(pending.state)
      && timingSafeEqual(state, Buffer.from(pending.state));
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash || !validState) {
      throw Object.assign(new Error("OAuth callback URL or state mismatch; login was not completed."), { code: "INVALID_CALLBACK" });
    }
    if (url.searchParams.has("error")) {
      delete this.state.pending;
      await this.save();
      throw new Error("Grafana authorization was denied; run login to try again.");
    }
    const code = url.searchParams.get("code");
    if (!code) throw Object.assign(new Error("OAuth callback is missing its authorization code."), { code: "INVALID_CALLBACK" });
    const tokens = await this.tokenRequest({
      grant_type: "authorization_code", code,
      redirect_uri: this.state.redirectUri, code_verifier: pending.verifier,
    });
    this.storeTokens(tokens);
    delete this.state.pending;
    await this.save();
  }

  async tokenRequest(fields) {
    const response = await this.request(this.state.oauth.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...fields, client_id: this.state.client.client_id, resource: ENDPOINT }).toString(),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      if (["invalid_grant", "invalid_client"].includes(payload.error)) {
        delete this.state.tokens;
        delete this.state.pending;
        if (payload.error === "invalid_client") delete this.state.client;
        await this.save();
        throw new Error("Grafana authorization expired or was revoked; run login again.");
      }
      // Never echo OAuth response bodies: they can contain credentials or codes.
      throw new Error(`Grafana OAuth token request failed (HTTP ${response.status}); run login if the problem persists.`);
    }
    return payload;
  }

  storeTokens(tokens, previous = {}) {
    const expires = Number(tokens.expires_in);
    if (!tokens.access_token || tokens.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(expires) || expires <= 0
        || (tokens.scope && tokens.scope.split(/\s+/).some((scope) => scope !== "grafana:read"))) {
      throw new Error("Grafana returned invalid tokens or unexpected scopes; only grafana:read is supported.");
    }
    this.state.tokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || previous.refresh_token,
      expiresAt: this.now() + expires * 1000,
    };
  }

  async accessToken(force = false) {
    const tokens = this.state.tokens;
    if (!tokens) throw new Error("Not authenticated with Grafana; run login first.");
    if (!force && tokens.expiresAt > this.now() + 60_000) return tokens.access_token;
    if (!tokens.refresh_token) throw new Error("Grafana token expired and has no refresh token; run login again.");
    const refreshed = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    this.storeTokens(refreshed, tokens);
    await this.save();
    return this.state.tokens.access_token;
  }

  async send(message, retryAuth = true) {
    const token = await this.accessToken();
    const response = await this.request(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.version ? { "MCP-Protocol-Version": this.version } : {}),
        ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      },
      body: JSON.stringify(message),
    });
    if (response.status === 401 && retryAuth) {
      await response.body?.cancel();
      await this.accessToken(true);
      return this.send(message, false);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 403 ? " Check Assistant terms, the Cloud MCP User role, and read consent."
        : response.status === 401 ? " Run login again." : "";
      throw Object.assign(new Error(`Grafana MCP returned HTTP ${response.status}.${hint}`), { status: response.status });
    }
    if (message.method === "initialize") this.session = response.headers.get("mcp-session-id") || undefined;
    if (message.id === undefined || !message.method) {
      await response.body?.cancel();
      return;
    }
    const reply = await readReply(response, message.id, async (request) => {
      await this.send({ jsonrpc: "2.0", id: request.id, ...(request.method === "ping"
        ? { result: {} } : { error: { code: -32601, message: "Client capability not supported" } }) });
    });
    if (reply.error) throw new Error(`Grafana MCP JSON-RPC error ${reply.error.code}; inspect the tool schema and arguments.`);
    return reply.result;
  }

  async initialize() {
    this.session = undefined;
    this.version = undefined;
    const result = await this.send({
      jsonrpc: "2.0", id: ++this.id, method: "initialize",
      params: { protocolVersion: VERSIONS[0], capabilities: {}, clientInfo: { name: "pi-kit-grafana", version: "1.0.0" } },
    });
    if (!VERSIONS.includes(result?.protocolVersion)) throw new Error("Grafana negotiated an unsupported MCP protocol version.");
    this.version = result.protocolVersion;
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async rpc(method, params) {
    if (!this.version) await this.initialize();
    const message = { jsonrpc: "2.0", id: ++this.id, method, params };
    try {
      return await this.send(message);
    } catch (error) {
      if (error.status !== 404 || !this.session) throw error;
      await this.initialize();
      return this.send(message);
    }
  }

  async tools(name) {
    if (name) assertReadTool(name);
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await this.rpc("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new Error("Invalid Grafana tool list.");
      tools.push(...page.tools.filter((tool) => READ_TOOLS.has(tool.name) && (!name || tool.name === name)));
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Grafana repeated a tool-list cursor.");
      cursors.add(cursor);
    } while (cursor);
    if (name && !tools.length) throw new Error("This read tool is not available for the current Grafana connection.");
    return { tools };
  }

  call(name, args) {
    assertReadTool(name);
    if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("Tool arguments must be a JSON object.");
    return this.rpc("tools/call", { name, arguments: args });
  }

  async close() {
    if (!this.session || !this.state.tokens) return;
    try {
      const response = await this.request(ENDPOINT, {
        method: "DELETE", headers: {
          Authorization: `Bearer ${this.state.tokens.access_token}`,
          "Mcp-Session-Id": this.session, "MCP-Protocol-Version": this.version,
        },
      });
      await response.body?.cancel();
    } catch { /* Session cleanup must not hide the query's result or failure. */ }
  }
}

function assertReadTool(name) {
  if (!READ_TOOLS.has(name)) throw new Error("Only the documented read-only datasource, Loki, and Prometheus tools are allowed. Run tools to list them.");
}

export async function readReply(response, id, onRequest = async () => {}) {
  const accept = async (message) => {
    if (message.jsonrpc !== "2.0") throw new Error("Invalid MCP JSON-RPC response.");
    if (message.method) {
      if (message.id !== undefined) await onRequest(message);
      return;
    }
    if (message.id === id && (Object.hasOwn(message, "result") || message.error)) return message;
  };
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const result = await accept(await response.json());
    if (result) return result;
  } else if (type.includes("text/event-stream")) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let match;
        while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          const event = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = event.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue;
          const result = await accept(JSON.parse(data));
          if (result) return result;
        }
        if (buffer.length > 16 * 1024 * 1024) throw new Error("MCP event exceeds 16 MiB; narrow the query.");
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  throw new Error("Grafana response ended without a matching MCP reply.");
}

export async function callbackServer(redirectUri, finish, { timeout = LOGIN_TIMEOUT, signal } = {}) {
  const url = new URL(redirectUri);
  let resolveDone, rejectDone, active, timer, stopped = false;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // A timeout can occur while registration is still pending.
  done.catch(() => {});
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method !== "GET" || req.headers.host !== url.host || req.url.split("?")[0] !== url.pathname) {
      res.writeHead(404).end("Not found");
      return;
    }
    if (stopped) { res.writeHead(503).end("Login has stopped."); return; }
    if (active) { res.writeHead(409).end("Login is already being completed."); return; }
    active = (async () => {
      try {
        await finish(`${url.origin}${req.url}`);
        res.end("Grafana login complete. You can close this window.");
        resolveDone();
      } catch (error) {
        // Bad state/callbacks must not consume the legitimate pending login.
        res.writeHead(400).end("Login was not completed. Check the CLI; restart login if denied or expired.");
        if (error.code !== "INVALID_CALLBACK") rejectDone(error);
      }
    })();
    await active;
    active = undefined;
  });
  const stop = (error) => {
    stopped = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    if (error) rejectDone(error);
  };
  const onAbort = () => stop(signal.reason);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(url.port), "127.0.0.1", resolve);
  });
  url.port = String(server.address().port);
  timer = setTimeout(() => stop(new Error("Grafana login timed out; run login again.")), timeout);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    done, redirectUri: url.href,
    async close() {
      stop();
      signal?.removeEventListener("abort", onAbort);
      // Closing a socket does not cancel finish(): keep the credential lock until
      // the exchange and any atomic save have settled, even after a timeout.
      await active;
    },
  };
}

const HELP = `Usage: node grafana.mjs <command>
  login                  Print a browser URL and wait for a loopback callback
  login --manual         Print a browser URL; save a pending login for 5 minutes
  login --callback       Read the complete redirect URL from stdin (manual login)
  status                 Show credential status, never token values
  logout                 Delete local credentials (revoke in Grafana separately)
  tools [NAME]           List allowed tools and their current input schemas
  call NAME JSON         Call a read-only tool; prints the complete MCP result
  call NAME --file PATH  Read arguments from a JSON file (PATH - means stdin)
Environment: GRAFANA_URL (optional stack origin), GRAFANA_OAUTH_PORT (8787),
             XDG_CONFIG_HOME (default ~/.config). Requires Node.js 22+.
Only grafana:read is requested. Raw SQL and write tools are blocked.`;

async function stdin(signal) {
  signal.throwIfAborted();
  process.stdin.setEncoding("utf8");
  addAbortSignal(signal, process.stdin);
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || ["help", "--help", "-h"].includes(command)) { console.log(HELP); return; }
  if (!(["status", "logout"].includes(command) && !args.length)
      && !(command === "login" && (!args.length || (args.length === 1 && ["--manual", "--callback"].includes(args[0]))))
      && !(command === "tools" && args.length <= 1)
      && !(command === "call" && (args.length === 2 || (args.length === 3 && args[1] === "--file")))) {
    throw new Error(HELP);
  }
  if (command === "call" || (command === "tools" && args[0])) assertReadTool(args[0]);
  const config = configuration();
  const lock = `${config.file}.lock`;
  let locked = false;
  const shutdown = new AbortController();
  const { signal } = shutdown;
  const handlers = ["SIGINT", "SIGTERM"].map((name) => {
    const handler = () => shutdown.abort(Object.assign(new Error(`Grafana command cancelled (${name}).`), {
      exitCode: name === "SIGINT" ? 130 : 143,
    }));
    process.on(name, handler);
    return [name, handler];
  });
  const client = new GrafanaClient(config, { signal });
  try {
    await mkdir(dirname(config.file), { recursive: true, mode: 0o700 });
    try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error("Another Grafana command is active. Run commands sequentially. If a process crashed, remove its .json.lock directory in the Grafana cache only after confirming it stopped.");
    }
    locked = true;
    signal.throwIfAborted();
    await client.load();
    let result;
    if (command === "login") {
      if (args[0] === "--callback") {
        await client.finishLogin(await stdin(signal));
      } else if (args[0] === "--manual") {
        const url = await client.beginLogin();
        signal.throwIfAborted();
        console.error(`Open this URL in your browser:\n${url}\nAfter consent, supply the full callback URL to login --callback via stdin within 5 minutes. Do not paste it into chat.`);
        return;
      } else {
        const listener = await callbackServer(config.redirectUri, (url) => client.finishLogin(url), { signal });
        try {
          const url = await client.beginLogin();
          signal.throwIfAborted();
          console.error(`Open this URL in a browser on this computer:\n${url}\nWaiting up to 5 minutes. For a remote shell, use login --manual instead.`);
          await listener.done;
        } finally { await listener.close(); }
      }
      result = { authenticated: true };
    } else if (command === "status") {
      result = {
        stack: config.stack || "Selected during browser consent",
        authenticated: Boolean(client.state.tokens?.expiresAt > Date.now()),
        refreshable: Boolean(client.state.tokens?.refresh_token),
        expiresAt: client.state.tokens ? new Date(client.state.tokens.expiresAt).toISOString() : null,
        loginPending: Boolean(client.state.pending?.expiresAt > Date.now()),
      };
    } else if (command === "logout") {
      await rm(config.file, { force: true });
      result = { localCredentialsRemoved: true, remoteAccessRevoked: false };
    } else if (command === "tools") {
      result = await client.tools(args[0]);
    } else {
      const input = args[1] === "--file" ? (args[2] === "-" ? await stdin(signal) : await readFile(args[2], "utf8")) : args[1];
      let parsed;
      try { parsed = JSON.parse(input); } catch { throw new Error("Tool arguments must be valid JSON."); }
      result = await client.call(args[0], parsed);
      if (result?.isError) process.exitCode = 1;
    }
    signal.throwIfAborted();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    try {
      await client.close();
      if (locked) await rm(lock, { recursive: true, force: true });
    } finally {
      for (const [name, handler] of handlers) process.removeListener(name, handler);
    }
    signal.throwIfAborted();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    // JSON parser/network errors may echo response bodies containing secrets.
    console.error(error instanceof SyntaxError ? "Grafana returned invalid JSON or configuration contains an invalid URL." : error.message);
    process.exitCode = error.exitCode || 1;
  });
}
