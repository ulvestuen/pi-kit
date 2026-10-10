import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

type TraceEntry = { id: number } & (
  | { kind: "thinking" | "text" | "event"; text: string }
  | { kind: "tool"; toolCallId: string; name: string; args: string; output: string;
      status: "preparing" | "running" | "completed" | "failed" }
);
export interface Transcript {
  entries: TraceEntry[];
  truncated: boolean;
  // Retained text blocks of the last successfully ended assistant message.
  // Renderers can replace these with the full answer without matching text.
  finalTextIds?: number[];
}

// Bound both session details and every streamed snapshot. Never retain image
// payloads, provider thinking signatures, or arbitrary tool result metadata.
const MAX_ENTRIES = 40;
const MAX_TEXT = 8192;
const OMITTED = "[Earlier content omitted]\n";
const tail = (text: string) => text.length <= MAX_TEXT ? text : OMITTED + text.slice(-(MAX_TEXT - OMITTED.length));

export function terminalText(text: string): string {
  return stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function toolOutput(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return tail(content.map((part) => part.type === "text" ? part.text ?? "" : `[${part.type} omitted]`).join("\n"));
}

export class ChildTrace {
  private entries: TraceEntry[] = [];
  private truncated = false;
  private nextId = 0;
  private discardedThrough = 0;
  private messageEntries = new Map<number, number>();
  private finalMessage = false;

  snapshot(): Transcript {
    // Entries are replaced, never mutated, so earlier snapshots stay immutable.
    const messageIds = new Set(this.messageEntries.values());
    return { entries: [...this.entries], truncated: this.truncated,
      ...(this.finalMessage ? { finalTextIds: this.entries
        .filter((entry) => entry.kind === "text" && messageIds.has(entry.id)).map((entry) => entry.id) } : {}),
    };
  }

  private put(entry: TraceEntry) {
    if (entry.id <= this.discardedThrough) return;
    const index = this.entries.findIndex((item) => item.id === entry.id);
    if (index < 0) this.entries.push(entry);
    else this.entries[index] = entry;
    if (this.entries.length > MAX_ENTRIES) {
      this.discardedThrough = this.entries.shift()!.id;
      this.truncated = true;
    }
  }

  private assistant(message: AssistantMessage) {
    message.content.forEach((part, index) => {
      let id = this.messageEntries.get(index);
      if (id === undefined) {
        id = ++this.nextId;
        this.messageEntries.set(index, id);
      }
      if (part.type === "thinking" || part.type === "text") {
        this.put({ id, kind: part.type, text: tail(part.type === "thinking" ? part.thinking : part.text) });
      } else if (part.type === "toolCall") {
        const existing = this.entries.find((entry) => entry.kind === "tool" && entry.toolCallId === part.id);
        if (!existing || existing.kind !== "tool" || existing.status === "preparing") {
          this.put({ id, kind: "tool", toolCallId: part.id, name: tail(part.name),
            args: tail(JSON.stringify(part.arguments, null, 2) ?? ""), output: "", status: "preparing" });
        }
      }
    });
  }

  accept(event: AgentSessionEvent) {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.messageEntries.clear();
      this.finalMessage = false;
      this.assistant(event.message);
    } else if ((event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant") {
      // The SDK supplies the response-so-far; final messages also cover providers
      // that do not emit deltas (including redacted thinking).
      this.assistant(event.message);
      this.finalMessage = event.type === "message_end" && event.message.stopReason === "stop";
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const existing = this.entries.find((entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId);
      const tool = existing?.kind === "tool" ? existing : undefined;
      this.put({
        id: tool?.id ?? ++this.nextId, kind: "tool", toolCallId: event.toolCallId, name: tail(event.toolName),
        args: event.type === "tool_execution_end" ? tool?.args ?? "" : tail(JSON.stringify(event.args, null, 2) ?? ""),
        // Tool updates are cumulative snapshots, not chunks to concatenate.
        output: event.type === "tool_execution_start" ? "" : toolOutput(event.type === "tool_execution_update" ? event.partialResult : event.result),
        status: event.type === "tool_execution_end" ? event.isError ? "failed" : "completed" : "running",
      });
    } else if (event.type === "auto_retry_start" || event.type === "compaction_start") {
      this.put({ id: ++this.nextId, kind: "event", text: event.type === "auto_retry_start"
        ? tail(`Retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage}`)
        : "Compacting child context" });
    }
  }
}

export function transcriptText(transcript?: Transcript): string {
  if (!transcript?.entries.length) return "No streamed activity captured yet.";
  return terminalText([
    ...(transcript.truncated ? ["[Earlier transcript entries omitted]"] : []),
    ...transcript.entries.map((entry) => entry.kind === "tool"
      ? `Tool: ${entry.name} · ${entry.status}\n${entry.args}${entry.output ? `\nOutput:\n${entry.output}` : ""}`
      : `${entry.kind === "thinking" ? "Thinking" : entry.kind === "text" ? "Assistant" : "Event"}:\n${entry.text}`),
  ].join("\n\n"));
}
