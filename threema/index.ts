import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import {
  assertValidThreemaId,
  getConfigPath,
  loadConfig,
  type ThreemaConfig,
} from "./config.ts";
import { sendThreemaMessage } from "./send.ts";
import { createWebhookServer } from "./webhook.ts";

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

function buildSendTool(config: ThreemaConfig) {
  return defineTool({
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

  let agentBusy = false;
  const webhook =
    config.mode === "e2e"
      ? createWebhookServer({ pi, config, isAgentBusy: () => agentBusy })
      : null;

  pi.registerTool(buildSendTool(config));

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config)}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!webhook) return;
    await webhook.restoreSeen(ctx);
    try {
      await webhook.flushSeen();
    } catch (err: any) {
      console.error(
        `[threema] Failed to persist message cache: ${err.message}`,
      );
    }
    webhook.start();
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
      if (webhook) {
        lines.push(
          `  Allowed senders: ${[...config.allowedSenders].join(", ")}`,
          `  Webhook port:    ${config.webhookPort}`,
          `  Webhook URL:     http://<host>:${config.webhookPort}/webhook`,
          `  Server:          ${webhook.isListening() ? "running" : "stopped"}`,
          `  Seen inbound IDs: ${webhook.seenCount()}`,
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_shutdown", async () => {
    agentBusy = false;

    if (webhook) {
      try {
        await webhook.flushSeen();
      } catch (err: any) {
        console.error(
          `[threema] Failed to persist message cache: ${err.message}`,
        );
      }
      webhook.stop();
    }
  });
}
