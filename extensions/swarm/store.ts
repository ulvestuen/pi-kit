// Swarm state on disk: .swarm/<id>/{board.jsonl, roster.json, workers/<name>.jsonl}. The coordinator process is the
// only writer; every write goes through one promise-queue mutex so concurrent tool calls and HTTP posts never
// interleave lines or race on roster.json. See a3/swarm.md.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemberState = "working" | "waiting" | "stopped" | "killed";
export type Workspace = "inherit" | "worktree" | "coordinator";
export const KINDS = ["message", "brief", "result", "question", "system"] as const;
export type Kind = (typeof KINDS)[number];

export interface BoardMessage {
  id: number;
  ts: string;
  from: string;
  mentions: string[];
  kind: Kind;
  body: string;
}

export interface Member {
  name: string;
  state: MemberState;
  workspace: Workspace;
  cwd: string;
  branch?: string;
  model?: string;
  lastSeenMessageId: number;
  wakes: number;
  createdAt: string;
}

export interface Roster {
  swarmId: string;
  goal: string;
  base?: string;
  createdAt: string;
  members: Member[];
}

/** Serializes async critical sections: each run starts after the previous one settles, success or failure. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Parse JSONL leniently: a torn last line (crash mid-write) is skipped rather than failing the whole file. */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export class SwarmStore {
  readonly dir: string;
  readonly boardFile: string;
  readonly rosterFile: string;
  readonly workersDir: string;
  private readonly lockFile: string;
  private readonly mutex = new Mutex();
  private board: BoardMessage[];
  private roster: Roster;
  private locked = false;

  constructor(root: string, swarmId: string, goal: string, base?: string) {
    this.dir = join(root, swarmId);
    this.boardFile = join(this.dir, "board.jsonl");
    this.rosterFile = join(this.dir, "roster.json");
    this.workersDir = join(this.dir, "workers");
    this.lockFile = join(this.dir, ".lock");
    mkdirSync(this.workersDir, { recursive: true });
    // O_EXCL lock: a second coordinator on the same swarm directory fails instead of interleaving writes.
    try {
      closeSync(openSync(this.lockFile, "wx"));
      this.locked = true;
    } catch {
      throw new Error(`Swarm ${swarmId} is already open by another process (remove ${this.lockFile} if it is stale)`);
    }
    this.board = readJsonl<BoardMessage>(this.boardFile);
    this.roster = existsSync(this.rosterFile)
      ? JSON.parse(readFileSync(this.rosterFile, "utf8"))
      : { swarmId, goal, base, createdAt: new Date().toISOString(), members: [] };
    this.writeRosterNow();
  }

  get lastId(): number {
    return this.board.length ? this.board[this.board.length - 1].id : 0;
  }

  messages(sinceId = 0): BoardMessage[] {
    return this.board.filter((m) => m.id > sinceId);
  }

  getRoster(): Roster {
    return structuredClone(this.roster);
  }

  member(name: string): Member | undefined {
    return this.roster.members.find((m) => m.name === name);
  }

  /** Append one message; ids are assigned inside the lock so they are dense and ordered. */
  append(entry: Omit<BoardMessage, "id" | "ts">): Promise<BoardMessage> {
    return this.mutex.run(() => {
      const message: BoardMessage = { id: this.lastId + 1, ts: new Date().toISOString(), ...entry };
      appendFileSync(this.boardFile, JSON.stringify(message) + "\n");
      this.board.push(message);
      return message;
    });
  }

  /** Add or patch a member and persist roster.json atomically (temp file + rename). */
  upsertMember(name: string, patch: Partial<Member>): Promise<Member> {
    return this.mutex.run(() => {
      let member = this.roster.members.find((m) => m.name === name);
      if (!member) {
        member = { name, state: "waiting", workspace: "inherit", cwd: "", lastSeenMessageId: 0, wakes: 0, createdAt: new Date().toISOString(), ...patch };
        this.roster.members.push(member);
      } else {
        Object.assign(member, patch);
      }
      this.writeRosterNow();
      return structuredClone(member);
    });
  }

  appendTranscript(name: string, record: unknown): Promise<void> {
    return this.mutex.run(() => {
      appendFileSync(this.transcriptFile(name), JSON.stringify(record) + "\n");
    });
  }

  transcript(name: string): unknown[] {
    return readJsonl(this.transcriptFile(name));
  }

  transcriptFile(name: string): string {
    return join(this.workersDir, `${name}.jsonl`);
  }

  /** Wait for queued writes, then release the lock. */
  async close(): Promise<void> {
    await this.mutex.run(() => undefined);
    if (this.locked) rmSync(this.lockFile, { force: true });
    this.locked = false;
  }

  private writeRosterNow() {
    const tmp = `${this.rosterFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.roster, null, 2) + "\n");
    renameSync(tmp, this.rosterFile);
  }
}
