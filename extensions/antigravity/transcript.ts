// Transcript normalization and replay helpers for the Antigravity ACP provider.
// Converts Pi `TranscriptContext` into ACP `systemPrompt.append` instructions,
// prompt blocks (text + images), tool-set fingerprints, and linear-continuation checks.

import {
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type TextContent,
  type Tool,
  type ToolResultMessage,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { MCP_TOOL_PREFIX, type ToolMapping } from "./mcp-server.ts";

export interface AcpTextBlock {
  type: "text";
  text: string;
}

export interface AcpImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export type AcpPromptBlock = AcpTextBlock | AcpImageBlock;

export function nonSystemMessages(messages: readonly Message[]): Message[] {
  return messages.filter((msg) => msg.role !== "system");
}

export function fingerprintTools(tools: readonly Tool[]): string {
  return JSON.stringify(tools.map((tool) => toToolDeclaration(tool)));
}

export function extractEffectiveTools(context: TranscriptContext, toolChoice?: "auto" | "none"): Tool[] {
  if (toolChoice === "none") return [];
  return getCurrentTools(context.messages);
}

/**
 * Build the `_meta.antigravity.systemPrompt.append` instruction block.
 * Carries Pi's resolved system prompt and strictly instructs the model to use
 * only the bridged `mcp_pi_*` tools (never Antigravity's built-in tools).
 */
export function buildSystemPromptAppend(
  context: TranscriptContext,
  mapping: ToolMapping,
): string {
  const hostPrompt = getCurrentSystemPrompt(context.messages).trim();
  const lines: string[] = [
    "=== PI HOST HARNESS INSTRUCTIONS ===",
    "You are running inside the Pi coding agent harness. Pi owns the workspace, approvals, conversation history, and every tool.",
  ];

  if (mapping.mcpTools.length === 0) {
    lines.push(
      "CRITICAL TOOL RULE: No tools are available for this session. NEVER call any built-in Antigravity tools (read_file, edit_file, write_file, run_command, grep_search, find_by_name, list_dir, search_web, read_url, invoke_subagent, etc.). Respond with text only.",
    );
  } else {
    lines.push(
      `CRITICAL TOOL RULE: NEVER call any built-in Antigravity tools (read_file, edit_file, write_file, run_command, grep_search, find_by_name, list_dir, search_web, read_url, invoke_subagent, manage_task, schedule, etc.). You MUST ONLY use the Pi host tools provided on the \`pi\` MCP server (prefixed with \`${MCP_TOOL_PREFIX}\`).`,
      "When the host instructions below refer to a tool by its Pi name (for example `read`, `edit`, `bash`, `codemode`), invoke its corresponding MCP tool:",
    );
    for (const [piName, mcpName] of mapping.piToMcp.entries()) {
      lines.push(`- Pi tool \`${piName}\` -> call \`${MCP_TOOL_PREFIX}${mcpName}\``);
    }
  }

  if (hostPrompt) {
    lines.push("", "=== PI SYSTEM PROMPT ===", hostPrompt);
  }

  return lines.join("\n");
}

function userMessageToBlocks(msg: UserMessage): AcpPromptBlock[] {
  if (typeof msg.content === "string") {
    return [{ type: "text", text: msg.content }];
  }
  const blocks: AcpPromptBlock[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function renderContentText(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text") {
      parts.push(item.text);
    } else if (item.type === "image") {
      parts.push(`[image: ${item.mimeType}]`);
    }
  }
  return parts.join("\n");
}

function renderAssistantTurn(msg: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "toolCall") {
      parts.push(`[Tool call ${block.name} (id=${block.id}): ${JSON.stringify(block.arguments)}]`);
    }
  }
  return parts.join("\n") || "(empty response)";
}

function renderToolResultTurn(msg: ToolResultMessage): string {
  const status = msg.isError ? "ERROR" : "OK";
  const body = renderContentText(msg.content);
  return `[Tool result for ${msg.toolName} (id=${msg.toolCallId}, status=${status})]\n${body}`;
}

/**
 * Convert a single new `UserMessage` into ACP prompt blocks (used on linear
 * multi-turn continuations of a warm ACP session).
 */
export function buildIncrementalPrompt(msg: UserMessage): AcpPromptBlock[] {
  return userMessageToBlocks(msg);
}

/**
 * Build ACP prompt blocks for a fresh ACP session from Pi's message list.
 * - Single initial `UserMessage`: sent verbatim (including images).
 * - Multi-turn / replayed history (branch, edit, compaction, provider handoff,
 *   or interrupted tool turn): serializes prior turns into a clear transcript
 *   block followed by the latest user prompt or tool results.
 */
export function buildReplayPrompt(messages: readonly Message[]): AcpPromptBlock[] {
  const convo = nonSystemMessages(messages);
  if (convo.length === 0) {
    return [{ type: "text", text: "" }];
  }

  if (convo.length === 1 && convo[0].role === "user") {
    return userMessageToBlocks(convo[0]);
  }

  const last = convo[convo.length - 1];
  const trailingUser = last.role === "user" ? last : undefined;
  const history = trailingUser ? convo.slice(0, -1) : convo;

  const lines: string[] = [
    "Prior conversation history from the Pi session (for full context; continue seamlessly from the end):",
  ];
  const replayImages: AcpImageBlock[] = [];

  for (const msg of history) {
    if (msg.role === "user") {
      lines.push(`\n<user>\n${renderContentText(msg.content)}\n</user>`);
    } else if (msg.role === "assistant") {
      lines.push(`\n<assistant>\n${renderAssistantTurn(msg)}\n</assistant>`);
    } else if (msg.role === "toolResult") {
      lines.push(`\n<tool_result>\n${renderToolResultTurn(msg)}\n</tool_result>`);
      for (const item of msg.content) {
        if (item.type === "image") {
          replayImages.push({ type: "image", data: item.data, mimeType: item.mimeType });
        }
      }
    }
  }

  const blocks: AcpPromptBlock[] = [];
  if (trailingUser) {
    lines.push("\nContinue by responding to the following latest user message:");
    blocks.push({ type: "text", text: lines.join("\n") });
    blocks.push(...userMessageToBlocks(trailingUser));
  } else {
    lines.push(
      "\nThe tool result(s) above have now been executed by Pi. Continue the response from here without re-running completed tool calls unless needed.",
    );
    blocks.push({ type: "text", text: lines.join("\n") });
    blocks.push(...replayImages);
  }

  return blocks;
}

/** Stable structural fingerprint of a Pi message for prefix-continuation checks. */
export function messageKey(msg: Message): string {
  if (msg.role === "user") {
    return JSON.stringify(["u", msg.content]);
  }
  if (msg.role === "assistant") {
    // Compare semantic output (text + tool calls); thinking blocks/timestamps/usage may be stripped or adjusted.
    const compact = msg.content
      .filter((block) => block.type !== "thinking")
      .map((block) =>
        block.type === "toolCall"
          ? ["tc", block.id, block.name, block.arguments]
          : ["t", block.text],
      );
    return JSON.stringify(["a", compact]);
  }
  if (msg.role === "toolResult") {
    return JSON.stringify(["tr", msg.toolCallId, msg.toolName, msg.isError, msg.content]);
  }
  return JSON.stringify(["s", msg.role]);
}

export function isLinearPrefix(committedKeys: readonly string[], currentMessages: readonly Message[]): boolean {
  const convo = nonSystemMessages(currentMessages);
  if (convo.length < committedKeys.length) return false;
  for (let i = 0; i < committedKeys.length; i++) {
    if (messageKey(convo[i]) !== committedKeys[i]) return false;
  }
  return true;
}
