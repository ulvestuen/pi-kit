import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { defineTool } from "@mariozechner/pi-coding-agent";
import * as http from "node:http";
import * as crypto from "node:crypto";
import {
  hexToBytes,
  bytesToHex,
  parseFormBody,
  verifyMac,
  naclBoxOpen,
  removePkcs7Padding,
  decryptMessage,
  x25519PublicKey,
} from "./lib.js";

// ── Configuration ──────────────────────────────────────────────────────────────
// Set these environment variables before starting pi:
//
//   THREEMA_API_ID        Your Threema Gateway API identity (8 chars, e.g. *MYAPID)
//   THREEMA_API_SECRET    Your Threema Gateway API secret
//   THREEMA_PRIVATE_KEY   Your NaCl private key (hex, 64 chars) for decrypting incoming messages
//   THREEMA_RECIPIENT_ID  Default recipient Threema ID (8 chars)
//   THREEMA_WEBHOOK_PORT  Port for the incoming-message webhook server (default: 7633)

interface ThreemaConfig {
  apiId: string;
  apiSecret: string;
  privateKey: Uint8Array;
  recipientId: string;
  webhookPort: number;
}

function loadConfig(): ThreemaConfig {
  const apiId = process.env.THREEMA_API_ID;
  const apiSecret = process.env.THREEMA_API_SECRET;
  const privateKeyHex = process.env.THREEMA_PRIVATE_KEY;
  const recipientId = process.env.THREEMA_RECIPIENT_ID;
  const webhookPort = parseInt(process.env.THREEMA_WEBHOOK_PORT || "7633", 10);

  if (!apiId || !apiSecret || !privateKeyHex || !recipientId) {
    throw new Error(
      "Missing required environment variables. Set: THREEMA_API_ID, THREEMA_API_SECRET, THREEMA_PRIVATE_KEY, THREEMA_RECIPIENT_ID"
    );
  }

  return {
    apiId,
    apiSecret,
    privateKey: hexToBytes(privateKeyHex),
    recipientId,
    webhookPort,
  };
}

// Cache for looked-up public keys
const publicKeyCache = new Map<string, Uint8Array>();

async function lookupPublicKey(
  threemaId: string,
  config: ThreemaConfig
): Promise<Uint8Array> {
  const cached = publicKeyCache.get(threemaId);
  if (cached) return cached;

  const url = `https://msgapi.threema.ch/pubkeys/${threemaId}?from=${encodeURIComponent(config.apiId)}&secret=${encodeURIComponent(config.apiSecret)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Failed to look up public key for ${threemaId}: ${resp.status} ${resp.statusText}`
    );
  }
  const hexKey = (await resp.text()).trim();
  const key = hexToBytes(hexKey);
  publicKeyCache.set(threemaId, key);
  return key;
}

// ── Send message via Simple mode ───────────────────────────────────────────────

async function sendThreemaMessage(
  text: string,
  recipientId: string,
  config: ThreemaConfig
): Promise<string> {
  const body = new URLSearchParams({
    from: config.apiId,
    secret: config.apiSecret,
    to: recipientId,
    text,
  });

  const resp = await fetch("https://msgapi.threema.ch/send_simple", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Threema API error ${resp.status}: ${errText}`);
  }

  return (await resp.text()).trim();
}

// ── Tool definition ────────────────────────────────────────────────────────────

const threemaSendTool = defineTool({
  name: "threema_send",
  label: "Threema Send",
  description:
    "Send a text message to a Threema user. Use this to communicate results, ask questions, or notify the user via Threema.",
  parameters: Type.Object({
    message: Type.String({ description: "The text message to send" }),
    recipient: Type.Optional(
      Type.String({
        description:
          "Recipient Threema ID (8 chars). Defaults to the preconfigured THREEMA_RECIPIENT_ID.",
      })
    ),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const config = loadConfig();
    const recipient = params.recipient || config.recipientId;
    const messageId = await sendThreemaMessage(params.message, recipient, config);

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

// ── Extension entry point ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config: ThreemaConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[threema] ${e.message}`);
    console.error(
      "[threema] Extension disabled. Set the required environment variables and /reload."
    );
    return;
  }

  // Register the send tool
  pi.registerTool(threemaSendTool);

  // Add system context so the agent knows about Threema capability
  pi.on("context", () => {
    return {
      parts: [
        {
          title: "Threema Messaging",
          content: [
            `You have a Threema messaging integration. You can send messages to the preconfigured Threema user (ID: ${config.recipientId}) using the threema_send tool.`,
            `Incoming Threema messages from the user will appear as user messages in this conversation.`,
            `Use Threema to notify the user of completed tasks, ask clarifying questions, or share results when they are away from the terminal.`,
          ].join("\n"),
        },
      ],
    };
  });

  // ── Webhook server for incoming messages ───────────────────────────────────

  let webhookServer: http.Server | null = null;

  const startWebhookServer = () => {
    webhookServer = http.createServer(async (req, res) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }

      // Only accept POST to /webhook
      if (req.method !== "POST" || !req.url?.startsWith("/webhook")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk: Buffer) => (data += chunk.toString()));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });

        const params = parseFormBody(body);

        // Verify MAC
        if (!verifyMac(params, config.apiSecret)) {
          console.error("[threema] MAC verification failed — rejecting message");
          res.writeHead(400);
          res.end("MAC verification failed");
          return;
        }

        // Look up sender's public key
        const senderPublicKey = await lookupPublicKey(params.from, config);

        // Decrypt
        const text = decryptMessage(
          params.box,
          params.nonce,
          senderPublicKey,
          config.privateKey
        );

        console.log(`[threema] Received message from ${params.from}: ${text.substring(0, 100)}...`);

        // Inject as user message into the pi conversation
        pi.sendUserMessage(`[Threema message from ${params.from}]: ${text}`);

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      } catch (err: any) {
        console.error(`[threema] Error processing webhook: ${err.message}`);
        res.writeHead(500);
        res.end("Internal error");
      }
    });

    webhookServer.listen(config.webhookPort, () => {
      console.log(
        `[threema] Webhook server listening on port ${config.webhookPort} — configure Threema Gateway callback URL to http://<your-host>:${config.webhookPort}/webhook`
      );
    });
  };

  startWebhookServer();

  // ── Slash command for status/control ─────────────────────────────────────────

  pi.registerCommand("threema", {
    description: "Threema messaging status and controls",
    handler: async (_args, ctx) => {
      const creditsUrl = `https://msgapi.threema.ch/credits?from=${encodeURIComponent(config.apiId)}&secret=${encodeURIComponent(config.apiSecret)}`;
      let credits = "unknown";
      try {
        const resp = await fetch(creditsUrl);
        if (resp.ok) credits = (await resp.text()).trim();
      } catch {}

      ctx.ui.notify(
        [
          `Threema Extension Status`,
          `  API ID:       ${config.apiId}`,
          `  Recipient:    ${config.recipientId}`,
          `  Webhook port: ${config.webhookPort}`,
          `  Webhook URL:  http://<host>:${config.webhookPort}/webhook`,
          `  Credits:      ${credits}`,
          `  Server:       ${webhookServer ? "running" : "stopped"}`,
        ].join("\n"),
        "info"
      );
    },
  });

  // Clean up on shutdown
  pi.on("session_shutdown", () => {
    if (webhookServer) {
      webhookServer.close();
      webhookServer = null;
      console.log("[threema] Webhook server stopped");
    }
  });
}
