// Loaded only into swarm worker processes (`pi --mode rpc -e worker-ext.ts`). Workers never write .swarm/ directly:
// board_post and board_read call the coordinator's local API with this worker's token, so the coordinator stays the
// single writer and a worker can only post under its own name.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const KINDS = ["message", "result", "question"] as const;

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const base = process.env.PI_SWARM_URL;
  const token = process.env.PI_SWARM_TOKEN;
  if (!base || !token) throw new Error("not running as a swarm worker (PI_SWARM_URL/PI_SWARM_TOKEN missing)");
  const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json", "x-swarm-token": token, ...(init.headers ?? {}) } });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

export function formatMessages(messages: any[]): string {
  if (!messages.length) return "(no messages)";
  return messages.map((m) => `--- #${m.id} ${m.ts} @${m.from} [${m.kind}]\n${m.body}`).join("\n\n");
}

export default function swarmWorker(pi: ExtensionAPI) {
  if (process.env.PI_SWARM_ROLE !== "worker") return;
  const me = process.env.PI_SWARM_NAME ?? "worker";

  pi.registerTool({
    name: "board_post",
    label: "Board post",
    description: `Post a message to the swarm's shared message board as @${me}. Mention members with @name (or @all) to wake them; mentioned members receive every board message they have not seen yet.`,
    promptSnippet: "Post to the shared swarm board; @mention the member who should act next",
    promptGuidelines: [
      "Use board_post to report results, hand work to a peer, or ask a question; @mention exactly the members who must act (usually @coordinator or a named peer).",
      "Do not call board_post just to say you are waiting; ending your turn is how you wait.",
    ],
    parameters: Type.Object({
      body: Type.String({ description: "Markdown message. Include @name mentions for whoever should act on it." }),
      kind: Type.Optional(StringEnum(KINDS, { description: "result = finished work, question = needs an answer, message = anything else" })),
    }),
    async execute(_id, params) {
      const message = await call("/api/worker/board", { method: "POST", body: JSON.stringify({ body: params.body, kind: params.kind ?? "message" }) });
      const who = message.mentions?.length ? ` mentioning ${message.mentions.map((m: string) => "@" + m).join(", ")}` : " (no mentions: nobody is woken)";
      return { content: [{ type: "text", text: `Posted #${message.id}${who}.` }], details: message };
    },
  });

  pi.registerTool({
    name: "board_read",
    label: "Board read",
    description: "Read messages from the swarm board and the current roster. Unread messages are delivered automatically when you are woken; use board_read for older history.",
    promptSnippet: "Read swarm board history and the roster",
    parameters: Type.Object({
      since: Type.Optional(Type.Integer({ minimum: 0, description: "Only messages with id greater than this" })),
      from: Type.Optional(Type.String({ description: "Only messages from this member" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Newest N messages (default 50)" })),
    }),
    async execute(_id, params) {
      const q = new URLSearchParams();
      if (params.since !== undefined) q.set("since", String(params.since));
      if (params.from) q.set("from", params.from);
      if (params.limit) q.set("limit", String(params.limit));
      const data = await call(`/api/worker/board?${q}`);
      const roster = data.members.map((m: any) => `@${m.name} ${m.state}${m.branch ? ` (${m.branch})` : ""}`).join(", ");
      return { content: [{ type: "text", text: `Roster: ${roster}\n\n${formatMessages(data.messages)}` }], details: data };
    },
  });
}
