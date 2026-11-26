// The @mention router. Members never poll: a post that mentions a `waiting` or `stopped` member wakes it with every
// board message it has not seen; a mention of a `working` member is remembered and delivered when its turn settles,
// never mid-tool-call. Active workers are capped; extra wakes wait in FIFO order. See a3/swarm.md.

import { EventEmitter } from "node:events";
import { Mutex, type BoardMessage, type Kind, type Member, type SwarmStore } from "./store.ts";

export const COORDINATOR = "coordinator";
export const HUMAN = "human";
export const SYSTEM = "system";
export const RESERVED = new Set([COORDINATOR, HUMAN, SYSTEM, "all"]);
const NAME = /^[a-z][a-z0-9-]{0,30}$/;

export function validName(name: string): boolean {
  return NAME.test(name) && !RESERVED.has(name) && !name.endsWith("-");
}

/** `@name` tokens outside code. Emails (`a@b`) and paths (`x/@y`) are not mentions. Lowercased, deduped, in order. */
export function parseMentions(body: string, known: Iterable<string>): string[] {
  const allowed = new Set([...known, "all", HUMAN, COORDINATOR]);
  const prose = body.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const found: string[] = [];
  for (const match of prose.matchAll(/(?<![\w.@/\\-])@([a-zA-Z][\w-]*)/g)) {
    const name = match[1].toLowerCase().replace(/-+$/, "");
    if (allowed.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/** What the router needs from a member's agent. `deliver` starts (or restarts) the agent and begins one run. */
export interface AgentHandle {
  deliver(text: string): Promise<void>;
  stop(): Promise<void>;
}

export interface RouterOptions {
  maxActive: number;
  maxWakes: number;
  maxPromptChars?: number;
}

export type SwarmEvent =
  | { type: "board"; message: BoardMessage }
  | { type: "roster"; members: Member[] }
  | { type: "transcript"; name: string; record: unknown };

export function formatUnread(name: string, messages: BoardMessage[], maxChars = 60_000): string {
  const header = (m: BoardMessage) => `--- #${m.id} ${m.ts} @${m.from}${m.mentions.length ? " → " + m.mentions.map((x) => "@" + x).join(" ") : ""} [${m.kind}]`;
  const blocks = messages.map((m) => `${header(m)}\n${m.body}`);
  // Keep the newest messages when over budget; the agent can board_read the rest.
  let total = 0;
  let start = blocks.length;
  while (start > 0 && total + blocks[start - 1].length + 2 <= maxChars) total += blocks[--start].length + 2;
  if (start === blocks.length && blocks.length) {
    start = blocks.length - 1;
    blocks[start] = blocks[start].slice(0, maxChars) + "\n…(truncated; use board_read)";
  }
  const skipped = start > 0 ? `(${start} older unread message(s) omitted; use board_read to see them)\n\n` : "";
  const range = messages.length ? `#${messages[0].id}–#${messages[messages.length - 1].id}` : "none";
  return [
    `[swarm board] @${name}, new board messages since your last turn (${range}):`,
    "",
    skipped + blocks.slice(start).join("\n\n"),
    "",
    "Act on what concerns you. Reply with board_post and @mention whoever should act next. When this turn ends you sleep until someone mentions you.",
  ].join("\n");
}

export class Router extends EventEmitter {
  private readonly lock = new Mutex();
  private readonly handles = new Map<string, AgentHandle>();
  /** Mentioned while working: wake again as soon as the current run settles. */
  private readonly pending = new Set<string>();
  /** Wakes waiting for a free slot under maxActive. */
  private readonly queue: string[] = [];
  private readonly limited = new Set<string>();

  constructor(readonly store: SwarmStore, readonly options: RouterOptions) {
    super();
  }

  attach(name: string, handle: AgentHandle) {
    this.handles.set(name, handle);
  }

  emitEvent(event: SwarmEvent) {
    this.emit("event", event);
  }

  names(): string[] {
    return this.store.getRoster().members.map((m) => m.name);
  }

  activeWorkers(): number {
    return this.store.getRoster().members.filter((m) => m.name !== COORDINATOR && m.state === "working").length;
  }

  queued(): string[] {
    return [...this.queue];
  }

  /** Append a message and route its mentions. Returns once state transitions are recorded (not when agents finish). */
  async post(from: string, body: string, kind: Kind = "message"): Promise<BoardMessage> {
    // System notices name the affected member ("@w1 stopped") but must only wake the coordinator: waking the
    // subject of a crash report would restart it in a loop.
    const parsed = parseMentions(body, this.names());
    const mentions = kind === "system" ? parsed.filter((m) => m === COORDINATOR) : parsed;
    const message = await this.store.append({ from, mentions, kind, body });
    this.emitEvent({ type: "board", message });
    await this.lock.run(async () => {
      for (const target of this.targets(message)) await this.request(target);
    });
    return message;
  }

  /** The member's run finished: it waits now, and wakes again at once if it was mentioned meanwhile. */
  async settled(name: string): Promise<void> {
    await this.lock.run(async () => {
      const member = this.store.member(name);
      if (!member || member.state === "killed" || member.state === "stopped") return;
      await this.setState(name, { state: "waiting" });
      if (this.pending.delete(name)) await this.request(name);
      await this.drain();
    });
  }

  /** The member's process went away. Mentions still wake it (by respawning). */
  async exited(name: string, reason?: string): Promise<void> {
    let report = false;
    await this.lock.run(async () => {
      const member = this.store.member(name);
      if (!member || member.state === "killed" || member.state === "stopped") return;
      report = Boolean(reason);
      this.pending.delete(name);
      this.dequeue(name);
      await this.setState(name, { state: "stopped" });
      await this.drain();
    });
    if (report) await this.post(SYSTEM, `@${COORDINATOR} worker @${name} stopped unexpectedly: ${reason}`, "system");
  }

  async kill(name: string): Promise<void> {
    const handle = this.handles.get(name);
    await this.lock.run(async () => {
      this.pending.delete(name);
      this.dequeue(name);
      await this.setState(name, { state: "killed" });
    });
    await handle?.stop().catch(() => undefined);
    this.handles.delete(name);
    await this.lock.run(() => this.drain());
  }

  /** Mark messages as seen (board_read). Keeps the next wake from repeating them. */
  async markSeen(name: string, id: number): Promise<void> {
    const member = this.store.member(name);
    if (member && id > member.lastSeenMessageId) await this.setState(name, { lastSeenMessageId: id });
  }

  /** Mark the coordinator working when the user starts a turn in the TUI. */
  async working(name: string): Promise<void> {
    await this.lock.run(async () => {
      const member = this.store.member(name);
      if (member && member.state === "waiting") await this.setState(name, { state: "working" });
    });
  }

  private targets(message: BoardMessage): string[] {
    const members = this.store.getRoster().members.filter((m) => m.state !== "killed" && m.name !== message.from);
    if (message.mentions.includes("all")) return members.map((m) => m.name);
    return members.filter((m) => message.mentions.includes(m.name)).map((m) => m.name);
  }

  // Everything below runs inside `lock`.

  private async request(name: string) {
    const member = this.store.member(name);
    if (!member || member.state === "killed") return;
    if (member.state === "working") {
      this.pending.add(name);
      return;
    }
    if (name !== COORDINATOR && this.activeWorkers() >= this.options.maxActive) {
      if (!this.queue.includes(name)) this.queue.push(name);
      return;
    }
    await this.wake(member);
  }

  private async drain() {
    while (this.queue.length && this.activeWorkers() < this.options.maxActive) {
      const member = this.store.member(this.queue.shift()!);
      if (member && (member.state === "waiting" || member.state === "stopped")) await this.wake(member);
    }
  }

  private dequeue(name: string) {
    const i = this.queue.indexOf(name);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private async wake(member: Member) {
    const unread = this.store.messages(member.lastSeenMessageId).filter((m) => m.from !== member.name);
    if (!unread.length) return;
    const handle = this.handles.get(member.name);
    if (!handle) return;
    if (member.name !== COORDINATOR && member.wakes >= this.options.maxWakes) {
      if (!this.limited.has(member.name)) {
        this.limited.add(member.name);
        // Posted after the lock is released, to the coordinator only, so it cannot loop.
        queueMicrotask(() => {
          void this.post(SYSTEM, `@${COORDINATOR} @${member.name} reached its wake limit (${this.options.maxWakes}); it stays idle. Kill it or raise --max-wakes.`, "system");
        });
      }
      return;
    }
    const text = formatUnread(member.name, unread, this.options.maxPromptChars);
    await this.setState(member.name, { state: "working", lastSeenMessageId: unread[unread.length - 1].id, wakes: member.wakes + 1 });
    // Deliver outside the lock: spawning a worker can take seconds and must not block other routing.
    handle.deliver(text).catch((error: Error) => {
      void this.exited(member.name, `could not deliver wake: ${error.message}`);
    });
  }

  private async setState(name: string, patch: Partial<Member>) {
    await this.store.upsertMember(name, patch);
    this.emitEvent({ type: "roster", members: this.store.getRoster().members });
  }
}
