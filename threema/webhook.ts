import * as http from "node:http";
import * as path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  assertValidHex,
  assertValidThreemaId,
  getDefaultPiAgentDir,
  type ThreemaConfig,
} from "./config.ts";
import { decryptMessage, parseFormBody, verifyMac } from "./lib.ts";
import { lookupPublicKey } from "./pubkeys.ts";

const INBOUND_ENTRY_TYPE = "threema-inbound";
const MAX_PERSISTED_INBOUND_KEYS = 1000;

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

export interface WebhookServer {
  start(): void;
  stop(): void;
  isListening(): boolean;
  restoreSeen(ctx: ExtensionContext): Promise<void>;
  flushSeen(): Promise<void>;
  seenCount(): number;
}

export interface WebhookOptions {
  pi: ExtensionAPI;
  config: ThreemaConfig;
  isAgentBusy(): boolean;
}

function parseIncomingWebhookParams(body: string): IncomingWebhookParams {
  const params = parseFormBody(body);
  const { from, to, messageId, date, nonce, box, mac } = params;

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

function getSeenInboundStorePath(): string {
  return path.join(getDefaultPiAgentDir(), "threema-seen-message-ids.json");
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

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function createWebhookServer({
  pi,
  config,
  isAgentBusy,
}: WebhookOptions): WebhookServer {
  let server: http.Server | null = null;
  let listening = false;
  let persistChain: Promise<void> = Promise.resolve();
  const seenKeys = new Set<string>();

  const queuePersist = () => {
    persistChain = persistChain
      .catch(() => undefined)
      .then(() => persistSeenInboundMessages(seenKeys))
      .catch((err: any) => {
        console.error(
          `[threema] Failed to persist message cache: ${err.message}`,
        );
      });
  };

  const handleWebhook = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    try {
      const body = await readRequestBody(req);
      const params = parseIncomingWebhookParams(body);

      if (!verifyMac(params, config.apiSecret)) {
        console.error("[threema] MAC verification failed — rejecting message");
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
      if (seenKeys.has(messageKey)) {
        console.log(`[threema] Duplicate webhook ignored for ${messageKey}`);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("duplicate");
        return;
      }

      if (!config.privateKey) {
        throw new Error("Inbound webhook requires E2E mode with a privateKey");
      }
      const senderPublicKey = await lookupPublicKey(params.from, config);
      const text = decryptMessage(
        params.box,
        params.nonce,
        senderPublicKey,
        config.privateKey,
      );

      seenKeys.add(messageKey);
      pi.appendEntry(INBOUND_ENTRY_TYPE, {
        key: messageKey,
        from: params.from,
        messageId: params.messageId,
        receivedAt: Date.now(),
      } satisfies SeenInboundEntry);
      queuePersist();

      const inboundText = `[Threema message from ${params.from}]: ${text}`;
      const busy = isAgentBusy();
      if (busy) {
        pi.sendUserMessage(inboundText, { deliverAs: "followUp" });
      } else {
        pi.sendUserMessage(inboundText);
      }

      console.log(
        `[threema] Accepted inbound message ${params.messageId} from ${params.from}${busy ? " (queued as follow-up)" : ""}`,
      );

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(busy ? "queued" : "ok");
    } catch (err: any) {
      console.error(`[threema] Error processing webhook: ${err.message}`);
      res.writeHead(500);
      res.end("Internal error");
    }
  };

  return {
    start() {
      if (server) return;

      server = http.createServer(async (req, res) => {
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

        await handleWebhook(req, res);
      });

      server.on("listening", () => {
        listening = true;
        console.log(
          `[threema] Webhook server listening on port ${config.webhookPort} — configure Threema Gateway callback URL to http://<your-host>:${config.webhookPort}/webhook`,
        );
      });

      server.on("close", () => {
        listening = false;
      });

      server.on("error", (err: any) => {
        listening = false;
        console.error(`[threema] Webhook server error: ${err.message}`);
      });

      server.listen(config.webhookPort);
    },

    stop() {
      if (!server) return;
      server.close();
      server = null;
      console.log("[threema] Webhook server stopped");
    },

    isListening() {
      return listening;
    },

    async restoreSeen(ctx: ExtensionContext) {
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
    },

    async flushSeen() {
      await persistChain.catch(() => undefined);
      await persistSeenInboundMessages(seenKeys);
    },

    seenCount() {
      return seenKeys.size;
    },
  };
}
