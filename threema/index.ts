import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  buildThreemaTextPayload,
  bytesToHex,
  decryptMessage,
  hexToBytes,
  naclBox,
  parseFormBody,
  verifyMac,
} from "./lib.ts";

const DEFAULT_WEBHOOK_PORT = 7633;
const INBOUND_ENTRY_TYPE = "threema-inbound";
const THREEMA_ID_RE = /^[A-Z0-9*]{8}$/;
const HEX_RE = /^[0-9a-fA-F]+$/;
const MAX_PERSISTED_INBOUND_KEYS = 1000;

type ThreemaMode = "e2e" | "basic";

interface ThreemaConfig {
  apiId: string;
  apiSecret: string;
  privateKey?: Uint8Array;
  recipientId: string;
  webhookPort: number;
  allowedSenders: Set<string>;
  configPath?: string;
  mode: ThreemaMode;
}

interface RawThreemaConfig {
  apiId?: string;
  apiSecret?: string;
  privateKey?: string;
  recipientId?: string;
  webhookPort?: number | string;
  allowedSenders?: string[] | string;
  mode?: string;
}

interface IncomingWebhookParams {
  from: string;
  to: string;
  messageId: string;
  date: string;
  nonce: string;
  box: string;
  mac: string;
}

interface SeenInboundEntry {
  key: string;
  from: string;
  messageId: string;
  receivedAt: number;
}

function normalizeThreemaId(id: string): string {
  return id.trim().toUpperCase();
}

function assertValidThreemaId(name: string, id: string): string {
  const normalized = normalizeThreemaId(id);
  if (!THREEMA_ID_RE.test(normalized)) {
    throw new Error(`${name} must be an 8-character Threema ID (got: ${id})`);
  }
  return normalized;
}

function assertValidHex(
  name: string,
  value: string,
  expectedLength?: number,
): string {
  const normalized = value.trim();
  if (expectedLength !== undefined && normalized.length !== expectedLength) {
    throw new Error(`${name} must be ${expectedLength} hex characters long`);
  }
  if (
    normalized.length === 0 ||
    normalized.length % 2 !== 0 ||
    !HEX_RE.test(normalized)
  ) {
    throw new Error(`${name} must be a non-empty even-length hex string`);
  }
  return normalized.toLowerCase();
}

function parseAllowedSenders(
  value: string[] | string | undefined,
  fallbackRecipientId: string,
): Set<string> {
  const source = Array.isArray(value)
    ? value
    : value?.trim()
      ? value.split(",")
      : [fallbackRecipientId];

  const allowedSenders = new Set<string>();
  for (const rawId of source) {
    const normalized = assertValidThreemaId(
      "THREEMA_ALLOWED_SENDERS entry",
      rawId,
    );
    allowedSenders.add(normalized);
  }

  if (allowedSenders.size === 0) {
    throw new Error(
      "THREEMA_ALLOWED_SENDERS must contain at least one Threema ID",
    );
  }

  return allowedSenders;
}

function getDefaultPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

function getConfigPath(): string {
  return (
    process.env.THREEMA_CONFIG_PATH ||
    path.join(
      getDefaultPiAgentDir(),
      "extensions",
      "pi-threema",
      "threema.json",
    )
  );
}

function warnIfConfigFileIsNotPrivate(configPath: string) {
  try {
    const mode = statSync(configPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(
        `[threema] Warning: config file ${configPath} is readable by group/others. Consider: chmod 600 ${configPath}`,
      );
    }
  } catch {}
}

function loadRawConfigFromJson(
  configPath: string,
): RawThreemaConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  warnIfConfigFileIsNotPrivate(configPath);
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Threema config ${configPath} must contain a JSON object`);
  }
  return raw as RawThreemaConfig;
}

function parseMode(value: string | undefined): ThreemaMode {
  if (value === undefined) return "e2e";
  const normalized = value.trim().toLowerCase();
  if (normalized === "e2e" || normalized === "basic") return normalized;
  throw new Error(`mode must be "e2e" or "basic" (got: ${value})`);
}

function loadConfig(): ThreemaConfig {
  const configPath = getConfigPath();
  const fileConfig = loadRawConfigFromJson(configPath);
  const config: RawThreemaConfig = fileConfig ?? {
    apiId: process.env.THREEMA_API_ID,
    apiSecret: process.env.THREEMA_API_SECRET,
    privateKey: process.env.THREEMA_PRIVATE_KEY,
    recipientId: process.env.THREEMA_RECIPIENT_ID,
    webhookPort: process.env.THREEMA_WEBHOOK_PORT,
    allowedSenders: process.env.THREEMA_ALLOWED_SENDERS,
    mode: process.env.THREEMA_MODE,
  };

  const { apiId, apiSecret, privateKey: privateKeyHex, recipientId } = config;
  const webhookPortRaw = config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const mode = parseMode(config.mode);

  const baseRequired = !apiId || !apiSecret || !recipientId;
  const e2eMissingKey = mode === "e2e" && !privateKeyHex;
  if (baseRequired || e2eMissingKey) {
    const requiredFields =
      mode === "e2e"
        ? "apiId, apiSecret, privateKey, recipientId"
        : "apiId, apiSecret, recipientId";
    throw new Error(
      fileConfig
        ? `Missing required fields in ${configPath}. Set: ${requiredFields}`
        : `Missing Threema config. Create ${configPath} with ${requiredFields} (or set THREEMA_CONFIG_PATH).`,
    );
  }

  const normalizedApiId = assertValidThreemaId("apiId", apiId);
  const normalizedRecipientId = assertValidThreemaId(
    "recipientId",
    recipientId,
  );

  let privateKey: Uint8Array | undefined;
  if (mode === "e2e") {
    const normalizedPrivateKeyHex = assertValidHex(
      "privateKey",
      privateKeyHex!,
      64,
    );
    privateKey = hexToBytes(normalizedPrivateKeyHex);
    if (privateKey.length !== 32) {
      throw new Error("privateKey must decode to exactly 32 bytes");
    }
  }

  const webhookPort =
    typeof webhookPortRaw === "number"
      ? webhookPortRaw
      : Number.parseInt(String(webhookPortRaw), 10);
  if (!Number.isFinite(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
    throw new Error(
      `webhookPort must be a valid TCP port (got: ${webhookPortRaw})`,
    );
  }

  return {
    apiId: normalizedApiId,
    apiSecret,
    privateKey,
    recipientId: normalizedRecipientId,
    webhookPort,
    allowedSenders: parseAllowedSenders(
      config.allowedSenders,
      normalizedRecipientId,
    ),
    configPath: fileConfig ? configPath : undefined,
    mode,
  };
}

function parseIncomingWebhookParams(body: string): IncomingWebhookParams {
  const params = parseFormBody(body);
  const from = params.from;
  const to = params.to;
  const messageId = params.messageId;
  const date = params.date;
  const nonce = params.nonce;
  const box = params.box;
  const mac = params.mac;

  if (!from || !to || !messageId || !date || !nonce || !box || !mac) {
    throw new Error("Webhook payload is missing one or more required fields");
  }

  if (!/^\d+$/.test(date)) {
    throw new Error("Webhook field 'date' must be a unix timestamp");
  }

  const normalizedMessageId = messageId.trim();
  if (!normalizedMessageId) {
    throw new Error("Webhook field 'messageId' must not be empty");
  }

  return {
    from: assertValidThreemaId("Webhook field 'from'", from),
    to: assertValidThreemaId("Webhook field 'to'", to),
    messageId: normalizedMessageId,
    date,
    nonce: assertValidHex("Webhook field 'nonce'", nonce, 48),
    box: assertValidHex("Webhook field 'box'", box),
    mac: assertValidHex("Webhook field 'mac'", mac, 64),
  };
}

function inboundMessageKey(
  params: Pick<IncomingWebhookParams, "from" | "messageId">,
): string {
  return `${params.from}:${params.messageId}`;
}

function buildSystemPrompt(config: ThreemaConfig): string {
  const lines = [
    "You have a Threema messaging integration.",
    `Use the threema_send tool to send short text messages to the default recipient ${config.recipientId} or to a specified Threema ID.`,
  ];
  if (config.mode === "e2e") {
    lines.push(
      `Incoming Threema messages are accepted only from these sender IDs: ${[...config.allowedSenders].join(", ")}.`,
      "If a Threema message arrives while you are already working, it is queued as a follow-up user message.",
    );
  } else {
    lines.push(
      "This Gateway ID is in basic mode — outbound messages only; inbound messages are not received.",
    );
  }
  lines.push(
    "Use Threema to notify the user of completed tasks, ask concise clarifying questions, or send short status updates when remote messaging is appropriate.",
  );
  return lines.join("\n");
}

// Cache for looked-up public keys
const publicKeyCache = new Map<string, Uint8Array>();

async function lookupPublicKey(
  threemaId: string,
  config: ThreemaConfig,
): Promise<Uint8Array> {
  const normalizedId = assertValidThreemaId("Public key lookup ID", threemaId);
  const cached = publicKeyCache.get(normalizedId);
  if (cached) return cached;

  const url = `https://msgapi.threema.ch/pubkeys/${normalizedId}?from=${encodeURIComponent(config.apiId)}&secret=${encodeURIComponent(config.apiSecret)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Failed to look up public key for ${normalizedId}: ${resp.status} ${resp.statusText}`,
    );
  }
  const hexKey = (await resp.text()).trim();
  const key = hexToBytes(hexKey);
  if (key.length !== 32) {
    throw new Error(
      `Unexpected public key length for ${normalizedId}: ${key.length} bytes`,
    );
  }
  publicKeyCache.set(normalizedId, key);
  return key;
}

async function postSendRequest(
  endpoint: "send_simple" | "send_e2e",
  body: URLSearchParams,
): Promise<string> {
  const resp = await fetch(`https://msgapi.threema.ch/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    const suffix = errText.trim() ? `: ${errText}` : "";
    throw new Error(
      `Threema API error ${resp.status} ${resp.statusText}${suffix}`,
    );
  }

  return (await resp.text()).trim();
}

async function sendThreemaMessage(
  text: string,
  recipientId: string,
  config: ThreemaConfig,
): Promise<string> {
  const message = text.trim();
  if (!message) {
    throw new Error("Threema message must not be empty");
  }

  const to = assertValidThreemaId("recipient", recipientId);

  if (config.mode === "basic") {
    const body = new URLSearchParams({
      from: config.apiId,
      secret: config.apiSecret,
      to,
      text: message,
    });
    return postSendRequest("send_simple", body);
  }

  if (!config.privateKey) {
    throw new Error("E2E mode requires a privateKey");
  }
  const recipientPublicKey = await lookupPublicKey(to, config);
  const nonce = new Uint8Array(crypto.randomBytes(24));
  const payload = buildThreemaTextPayload(message);
  const box = naclBox(payload, nonce, recipientPublicKey, config.privateKey);

  const body = new URLSearchParams({
    from: config.apiId,
    secret: config.apiSecret,
    to,
    nonce: bytesToHex(nonce),
    box: bytesToHex(box),
  });

  return postSendRequest("send_e2e", body);
}

const threemaSendTool = defineTool({
  name: "threema_send",
  label: "Threema Send",
  description:
    "Send a text message to a Threema user. Use this to communicate results, ask questions, or notify the user via Threema.",
  promptSnippet:
    "threema_send: send a short text message to the configured Threema recipient or to an explicitly provided Threema ID.",
  promptGuidelines: [
    "Use threema_send for brief remote notifications, concise clarifying questions, or short completion updates.",
  ],
  parameters: Type.Object({
    message: Type.String({ description: "The text message to send" }),
    recipient: Type.Optional(
      Type.String({
        description:
          "Recipient Threema ID (8 chars). Defaults to the preconfigured THREEMA_RECIPIENT_ID.",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const config = loadConfig();
    const recipient = params.recipient
      ? assertValidThreemaId("recipient", params.recipient)
      : config.recipientId;
    const messageId = await sendThreemaMessage(
      params.message,
      recipient,
      config,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Message sent to ${recipient}. Threema message ID: ${messageId}`,
        },
      ],
      details: { messageId, recipient },
    };
  },
});

function getSeenInboundStorePath(): string {
  const baseDir = getDefaultPiAgentDir();
  return path.join(baseDir, "threema-seen-message-ids.json");
}

async function loadPersistedSeenInboundMessages(): Promise<string[]> {
  try {
    const raw = await readFile(getSeenInboundStorePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    console.error(
      `[threema] Failed to load persisted message cache: ${err.message}`,
    );
    return [];
  }
}

async function persistSeenInboundMessages(seenKeys: Set<string>) {
  const storePath = getSeenInboundStorePath();
  const recentKeys = [...seenKeys].slice(-MAX_PERSISTED_INBOUND_KEYS);
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(recentKeys, null, 2), "utf8");
}

async function restoreSeenInboundMessages(
  ctx: ExtensionContext,
  seenKeys: Set<string>,
) {
  seenKeys.clear();

  for (const key of await loadPersistedSeenInboundMessages()) {
    seenKeys.add(key);
  }

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === INBOUND_ENTRY_TYPE) {
      const data = entry.data as SeenInboundEntry | undefined;
      if (typeof data?.key === "string") {
        seenKeys.add(data.key);
      }
    }
  }
}

export default function (pi: ExtensionAPI) {
  let config: ThreemaConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[threema] ${e.message}`);
    console.error(
      `[threema] Extension disabled. Create ${getConfigPath()} (chmod 600) or set THREEMA_CONFIG_PATH, then /reload.`,
    );
    return;
  }

  let webhookServer: http.Server | null = null;
  let webhookServerListening = false;
  let agentBusy = false;
  let persistSeenInboundKeysPromise = Promise.resolve();
  const seenInboundKeys = new Set<string>();

  const startWebhookServer = () => {
    if (webhookServer) return;

    webhookServer = http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }

      if (req.method !== "POST" || !req.url?.startsWith("/webhook")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.setEncoding("utf8");
          req.on("data", (chunk: string) => {
            data += chunk;
          });
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });

        const params = parseIncomingWebhookParams(body);

        if (!verifyMac(params, config.apiSecret)) {
          console.error(
            "[threema] MAC verification failed — rejecting message",
          );
          res.writeHead(400);
          res.end("MAC verification failed");
          return;
        }

        if (params.to !== config.apiId) {
          console.error(
            `[threema] Webhook target mismatch — expected ${config.apiId}, got ${params.to}`,
          );
          res.writeHead(400);
          res.end("Webhook target mismatch");
          return;
        }

        if (!config.allowedSenders.has(params.from)) {
          console.error(
            `[threema] Unauthorized sender ${params.from} — rejecting message`,
          );
          res.writeHead(403);
          res.end("Sender not allowed");
          return;
        }

        const messageKey = inboundMessageKey(params);
        if (seenInboundKeys.has(messageKey)) {
          console.log(`[threema] Duplicate webhook ignored for ${messageKey}`);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("duplicate");
          return;
        }

        if (!config.privateKey) {
          throw new Error(
            "Inbound webhook requires E2E mode with a privateKey",
          );
        }
        const senderPublicKey = await lookupPublicKey(params.from, config);
        const text = decryptMessage(
          params.box,
          params.nonce,
          senderPublicKey,
          config.privateKey,
        );

        seenInboundKeys.add(messageKey);
        pi.appendEntry(INBOUND_ENTRY_TYPE, {
          key: messageKey,
          from: params.from,
          messageId: params.messageId,
          receivedAt: Date.now(),
        } satisfies SeenInboundEntry);
        persistSeenInboundKeysPromise = persistSeenInboundKeysPromise
          .catch(() => undefined)
          .then(() => persistSeenInboundMessages(seenInboundKeys))
          .catch((persistErr: any) => {
            console.error(
              `[threema] Failed to persist message cache: ${persistErr.message}`,
            );
          });

        const inboundText = `[Threema message from ${params.from}]: ${text}`;
        if (agentBusy) {
          pi.sendUserMessage(inboundText, { deliverAs: "followUp" });
        } else {
          pi.sendUserMessage(inboundText);
        }

        console.log(
          `[threema] Accepted inbound message ${params.messageId} from ${params.from}${agentBusy ? " (queued as follow-up)" : ""}`,
        );

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(agentBusy ? "queued" : "ok");
      } catch (err: any) {
        console.error(`[threema] Error processing webhook: ${err.message}`);
        res.writeHead(500);
        res.end("Internal error");
      }
    });

    webhookServer.on("listening", () => {
      webhookServerListening = true;
      console.log(
        `[threema] Webhook server listening on port ${config.webhookPort} — configure Threema Gateway callback URL to http://<your-host>:${config.webhookPort}/webhook`,
      );
    });

    webhookServer.on("close", () => {
      webhookServerListening = false;
    });

    webhookServer.on("error", (err: any) => {
      webhookServerListening = false;
      console.error(`[threema] Webhook server error: ${err.message}`);
    });

    webhookServer.listen(config.webhookPort);
  };

  pi.registerTool(threemaSendTool);

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config)}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (config.mode !== "e2e") return;
    await restoreSeenInboundMessages(ctx, seenInboundKeys);
    try {
      await persistSeenInboundMessages(seenInboundKeys);
    } catch (persistErr: any) {
      console.error(
        `[threema] Failed to persist message cache: ${persistErr.message}`,
      );
    }
    startWebhookServer();
  });

  pi.on("agent_start", async () => {
    agentBusy = true;
  });

  pi.on("agent_end", async () => {
    agentBusy = false;
  });

  pi.registerCommand("threema", {
    description: "Threema messaging status and controls",
    handler: async (_args, ctx) => {
      const creditsUrl = `https://msgapi.threema.ch/credits?from=${encodeURIComponent(config.apiId)}&secret=${encodeURIComponent(config.apiSecret)}`;
      let credits = "unknown";
      try {
        const resp = await fetch(creditsUrl);
        if (resp.ok) credits = (await resp.text()).trim();
      } catch {}

      const lines = [
        `Threema Extension Status`,
        `  Mode:            ${config.mode}`,
        `  API ID:          ${config.apiId}`,
        `  Recipient:       ${config.recipientId}`,
        `  Config file:     ${config.configPath ?? "environment variables"}`,
        `  Credits:         ${credits}`,
        `  Agent busy:      ${agentBusy ? "yes" : "no"}`,
      ];
      if (config.mode === "e2e") {
        lines.push(
          `  Allowed senders: ${[...config.allowedSenders].join(", ")}`,
          `  Webhook port:    ${config.webhookPort}`,
          `  Webhook URL:     http://<host>:${config.webhookPort}/webhook`,
          `  Server:          ${webhookServerListening ? "running" : "stopped"}`,
          `  Seen inbound IDs: ${seenInboundKeys.size}`,
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_shutdown", async () => {
    agentBusy = false;

    try {
      await persistSeenInboundKeysPromise.catch(() => undefined);
      await persistSeenInboundMessages(seenInboundKeys);
    } catch (persistErr: any) {
      console.error(
        `[threema] Failed to persist message cache: ${persistErr.message}`,
      );
    }

    if (webhookServer) {
      webhookServer.close();
      webhookServer = null;
      console.log("[threema] Webhook server stopped");
    }
  });
}
