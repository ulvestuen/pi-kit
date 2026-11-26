// One running swarm: store + router + RPC workers + worktrees + local server. Independent of ExtensionAPI so it can be
// driven by tests with a fake `pi` and a temporary git repository. index.ts adapts it to Pi commands and tools.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RpcWorker, type PiCommand } from "./driver.ts";
import { COORDINATOR, HUMAN, Router, validName, type AgentHandle, type SwarmEvent } from "./router.ts";
import { startServer, type SwarmServer } from "./server.ts";
import { KINDS, SwarmStore, type BoardMessage, type Kind, type Member, type Workspace } from "./store.ts";
import { addWorktree, baseRef, describeStatus, excludeDir, removeWorktree, repoRoot, worktreeStatus, type Git, git as realGit, type WorktreeStatus } from "./worktree.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKER_EXTENSION = join(HERE, "worker-ext.ts");
const UI_FILE = join(HERE, "ui.html");
/** Environment that must not leak from the coordinator into workers. */
const UNSET_ENV = ["PI_SESSION_FILE", "PI_SESSION_ID"];

export interface SwarmLimits {
  maxActive: number;
  maxWorkers: number;
  maxWakes: number;
}

export const DEFAULT_LIMITS: SwarmLimits = { maxActive: 4, maxWorkers: 8, maxWakes: 50 };

export interface SwarmOptions extends Partial<SwarmLimits> {
  goal: string;
  cwd: string;
  pi: PiCommand;
  coordinator: AgentHandle;
  coordinatorModel?: string;
  port?: number;
  id?: string;
  git?: Git;
  /** Extra args for every worker after `--mode rpc` (tests use this to stub the CLI). */
  workerArgs?: string[];
}

export interface AddOptions {
  name: string;
  brief: string;
  workspace?: "inherit" | "worktree";
  model?: string;
}

export interface StopReport {
  stopped: string[];
  kept: WorktreeStatus[];
  removed: WorktreeStatus[];
  errors: string[];
}

export type SwarmCommand =
  | { action: "start"; goal: string; limits: Partial<SwarmLimits>; port?: number }
  | { action: "ui" | "status" | "stop" | "help" };

const FLAGS: Record<string, keyof SwarmLimits | "port"> = { "--max-active": "maxActive", "--max-workers": "maxWorkers", "--max-wakes": "maxWakes", "--port": "port" };

/** `/swarm <goal> [--max-active N] [--max-workers N] [--max-wakes N] [--port N]`, or `/swarm ui|status|stop`. Env: PI_SWARM_MAX_ACTIVE, ... */
export function parseSwarmArgs(input: string, env: NodeJS.ProcessEnv = process.env): SwarmCommand {
  const text = input.trim();
  if (!text || text === "help") return { action: "help" };
  if (["ui", "status", "stop"].includes(text)) return { action: text as "ui" | "status" | "stop" };
  const values: Partial<Record<keyof SwarmLimits | "port", number>> = {};
  for (const key of Object.values(FLAGS)) {
    const fromEnv = env[`PI_SWARM_${key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`];
    if (fromEnv !== undefined && fromEnv !== "") values[key] = Number(fromEnv);
  }
  const goal = text
    .replace(/(?:^|\s)(--max-active|--max-workers|--max-wakes|--port)(?:=|\s+)(\S+)/g, (_m, flag: string, value: string) => {
      values[FLAGS[flag]] = Number(value);
      return " ";
    })
    .trim();
  for (const [key, value] of Object.entries(values)) {
    const min = key === "port" ? 0 : 1;
    if (!Number.isInteger(value) || value! < min || (key === "port" && value! > 65535)) throw new Error(`Invalid ${key}: ${value}`);
  }
  if (!goal) throw new Error("Give the swarm a goal: /swarm <goal>");
  const { port, ...limits } = values;
  return { action: "start", goal, limits, port };
}

export function newSwarmId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export function workerRules(goal: string, member: Pick<Member, "name" | "workspace" | "cwd" | "branch">, base?: string): string {
  const where =
    member.workspace === "worktree"
      ? `Your workspace is your own git worktree at ${member.cwd} on branch ${member.branch}. Edit and commit there; @coordinator merges your branch into ${base ?? "the base branch"}. Do not touch the main checkout.`
      : `Your workspace is the shared main checkout at ${member.cwd}. Other members may be working there too: stay inside your track, and prefer reading and verifying over editing files outside it.`;
  return [
    `<swarm-worker>`,
    `You are @${member.name}, a worker in a Pi swarm run by @coordinator. Swarm goal: ${goal}`,
    `- Your assignment is the board message addressed to @${member.name} with kind "brief". Do only that track.`,
    `- ${where}`,
    `- The shared board is how members talk. Use board_post and @mention whoever must act next: a peer (for example @verifier) to hand work over, or @coordinator when your track is done (kind "result") or blocked (kind "question").`,
    `- You are woken only when someone mentions you; the board messages you have not seen arrive as your next prompt. Ending your turn is how you wait. Never poll, sleep, or loop while waiting.`,
    `- Messages from @human come from the person running the swarm and take priority.`,
    `</swarm-worker>`,
  ].join("\n");
}

export class Swarm {
  readonly id: string;
  readonly goal: string;
  readonly root: string;
  readonly isRepo: boolean;
  readonly limits: SwarmLimits;
  readonly store: SwarmStore;
  readonly router: Router;
  readonly uiToken = randomBytes(18).toString("base64url");
  server: SwarmServer | null = null;
  private readonly workers = new Map<string, RpcWorker>();
  private readonly tokens = new Map<string, string>();
  private readonly started = new Set<string>();
  private readonly git: Git;
  private stopping = false;

  private constructor(private readonly options: SwarmOptions, root: string, isRepo: boolean, base: string | undefined) {
    this.id = options.id ?? newSwarmId();
    this.goal = options.goal;
    this.root = root;
    this.isRepo = isRepo;
    this.git = options.git ?? realGit;
    this.limits = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries({ maxActive: options.maxActive, maxWorkers: options.maxWorkers, maxWakes: options.maxWakes }).filter(([, v]) => v !== undefined)) };
    this.store = new SwarmStore(join(root, ".swarm"), this.id, this.goal, base);
    this.router = new Router(this.store, { maxActive: this.limits.maxActive, maxWakes: this.limits.maxWakes });
  }

  static async start(options: SwarmOptions): Promise<Swarm> {
    const run = options.git ?? realGit;
    const top = await repoRoot(options.cwd, run);
    const root = top ?? resolve(options.cwd);
    if (top) await excludeDir(top, ".swarm/", run);
    const swarm = new Swarm(options, root, Boolean(top), top ? await baseRef(top, run) : undefined);
    await swarm.store.upsertMember(COORDINATOR, { state: "working", workspace: "coordinator", cwd: root, model: options.coordinatorModel });
    swarm.router.attach(COORDINATOR, options.coordinator);
    try {
      swarm.server = await startServer(swarm.serverApi(), { token: swarm.uiToken, port: options.port });
    } catch (error) {
      await swarm.store.close();
      throw error;
    }
    await swarm.router.post("system", `Swarm ${swarm.id} started.\n\n**Goal:** ${swarm.goal}`, "system");
    return swarm;
  }

  get url(): string {
    return this.server?.url ?? "";
  }

  get apiBase(): string {
    return this.server ? `http://127.0.0.1:${this.server.port}` : "";
  }

  onEvent(listener: (event: SwarmEvent) => void): () => void {
    this.router.on("event", listener);
    return () => this.router.off("event", listener);
  }

  liveMembers(): Member[] {
    return this.store.getRoster().members.filter((m) => m.name !== COORDINATOR && m.state !== "killed");
  }

  async add(input: AddOptions): Promise<{ member: Member; brief: BoardMessage }> {
    const name = input.name.trim().toLowerCase();
    if (!validName(name)) throw new Error(`Invalid worker name "${input.name}": use 1-31 lowercase letters, digits, or dashes, starting with a letter (reserved: coordinator, human, system, all).`);
    const existing = this.store.member(name);
    if (existing && existing.state !== "killed") throw new Error(`@${name} already exists (${existing.state}).`);
    if (existing) throw new Error(`@${name} was killed in this swarm; choose a new name.`);
    if (this.liveMembers().length >= this.limits.maxWorkers) throw new Error(`Worker limit reached (${this.limits.maxWorkers}). Kill a finished worker first.`);
    if (!input.brief.trim()) throw new Error("brief is required");
    const workspace: Workspace = input.workspace ?? "inherit";
    let cwd = this.root;
    let branch: string | undefined;
    const base = this.store.getRoster().base;
    if (workspace === "worktree") {
      if (!this.isRepo) throw new Error(`workspace "worktree" needs a git repository; ${this.root} is not one.`);
      cwd = join(this.store.dir, "worktrees", name);
      branch = `swarm/${this.id}/${name}`;
      await addWorktree(this.root, cwd, branch, base ?? "HEAD", this.git);
    }
    const model = input.model ?? this.options.coordinatorModel;
    const member = await this.store.upsertMember(name, { state: "waiting", workspace, cwd, branch, model, lastSeenMessageId: 0, wakes: 0 });
    this.router.emitEvent({ type: "roster", members: this.store.getRoster().members });
    this.createWorker(member, base);
    // The brief is an ordinary @mention: it wakes the worker through the same router as every other message.
    const brief = await this.router.post(COORDINATOR, `@${name} ${input.brief.trim()}`, "brief");
    return { member: this.store.member(name)!, brief };
  }

  async post(from: string, body: string, kind: Kind = "message"): Promise<BoardMessage> {
    if (!KINDS.includes(kind)) kind = "message";
    return this.router.post(from, body, kind);
  }

  read(name: string, query: { since?: number; from?: string; limit?: number }) {
    let messages = this.store.messages(query.since ?? 0);
    if (query.from) messages = messages.filter((m) => m.from === query.from);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    messages = messages.slice(-limit);
    if (!query.from && messages.length) void this.router.markSeen(name, messages[messages.length - 1].id);
    return { messages, members: this.store.getRoster().members, lastId: this.store.lastId };
  }

  async status() {
    const roster = this.store.getRoster();
    const worktrees: WorktreeStatus[] = [];
    for (const m of roster.members) {
      if (m.workspace === "worktree" && m.branch) worktrees.push(await worktreeStatus(this.root, m.cwd, m.branch, roster.base ?? "HEAD", this.git).catch(() => ({ path: m.cwd, branch: m.branch!, exists: false, dirty: [], unmergedCommits: 0, clean: true })));
    }
    return { id: this.id, goal: this.goal, url: this.url, dir: this.store.dir, limits: this.limits, members: roster.members, queued: this.router.queued(), worktrees, lastMessageId: this.store.lastId };
  }

  /** Stop a worker for good. Its worktree is removed only when merged and clean, unless force. */
  async kill(name: string, force = false): Promise<{ member: Member; worktree?: WorktreeStatus; removed: boolean }> {
    const member = this.store.member(name);
    if (!member || name === COORDINATOR) throw new Error(`No worker named @${name}.`);
    if (member.state !== "killed") {
      await this.router.kill(name);
      this.workers.delete(name);
      for (const [token, owner] of this.tokens) if (owner === name) this.tokens.delete(token);
      await this.router.post("system", `@${name} was killed.`, "system");
    }
    if (member.workspace !== "worktree" || !member.branch) return { member: this.store.member(name)!, removed: false };
    const result = await removeWorktree(this.root, member.cwd, member.branch, this.store.getRoster().base ?? "HEAD", force, this.git);
    return { member: this.store.member(name)!, worktree: result.status, removed: result.removed };
  }

  /** Stop all workers and the server. With cleanup, remove only merged and clean worktrees; report the others. */
  async stop(cleanup = true): Promise<StopReport> {
    const report: StopReport = { stopped: [], kept: [], removed: [], errors: [] };
    if (this.stopping) return report;
    this.stopping = true;
    for (const [name, worker] of this.workers) {
      try {
        await worker.stop();
        report.stopped.push(name);
      } catch (error: any) {
        report.errors.push(`${name}: ${error.message}`);
      }
      const m = this.store.member(name);
      if (m && m.state !== "killed") await this.store.upsertMember(name, { state: "stopped" });
    }
    await this.store.upsertMember(COORDINATOR, { state: "stopped" });
    const roster = this.store.getRoster();
    for (const m of roster.members) {
      if (m.workspace !== "worktree" || !m.branch) continue;
      try {
        const status = await worktreeStatus(this.root, m.cwd, m.branch, roster.base ?? "HEAD", this.git);
        if (!status.exists && status.unmergedCommits === 0) continue;
        if (!status.clean || !cleanup) report.kept.push(status);
        else {
          await removeWorktree(this.root, m.cwd, m.branch, roster.base ?? "HEAD", false, this.git);
          report.removed.push(status);
        }
      } catch (error: any) {
        report.errors.push(`${m.name}: ${error.message}`);
      }
    }
    await this.server?.close();
    this.server = null;
    await this.store.close();
    return report;
  }

  static describeStop(report: StopReport, dir: string): string {
    const lines = [`Swarm stopped. State kept in ${dir}.`];
    if (report.stopped.length) lines.push(`Stopped workers: ${report.stopped.map((n) => "@" + n).join(", ")}.`);
    if (report.kept.length) lines.push("Worktrees kept (unmerged or uncommitted work — merge or remove them yourself):", ...report.kept.map((s) => `  - ${describeStatus(s)}`));
    if (report.removed.length) lines.push(`Removed merged worktrees: ${report.removed.map((s) => s.branch).join(", ")}.`);
    if (report.errors.length) lines.push("Errors:", ...report.errors.map((e) => `  - ${e}`));
    return lines.join("\n");
  }

  // ----- internals -----

  private createWorker(member: Member, base: string | undefined) {
    const token = randomBytes(18).toString("base64url");
    this.tokens.set(token, member.name);
    const sessionDir = join(this.store.dir, "sessions", member.name);
    const args = [
      ...(this.options.workerArgs ?? []),
      "--session-dir", sessionDir,
      "--name", `swarm ${this.id} @${member.name}`,
      "-e", WORKER_EXTENSION,
      "--append-system-prompt", workerRules(this.goal, member, base),
      ...(member.model ? ["--model", member.model] : []),
    ];
    const name = member.name;
    const worker = new RpcWorker({
      name,
      cwd: member.cwd,
      pi: this.options.pi,
      args,
      unset: UNSET_ENV,
      env: { PI_SWARM_ROLE: "worker", PI_SWARM_ID: this.id, PI_SWARM_NAME: name, PI_SWARM_URL: this.apiBase, PI_SWARM_TOKEN: token },
      onEvent: (event) => this.onWorkerEvent(name, event),
      onExit: ({ code, signal, expected, stderr }) => {
        if (expected || this.stopping) return;
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        void this.record(name, { type: "exit", code, signal, stderr: tail });
        void this.router.exited(name, `exit ${signal ?? code}${tail ? `: ${tail}` : ""}`);
      },
    });
    this.workers.set(name, worker);
    this.router.attach(name, {
      deliver: async (text) => {
        if (this.stopping) return;
        if (!worker.running) {
          // A stopped worker resumes its own session; a new one starts fresh.
          worker.start(this.started.has(name) ? ["--continue"] : []);
          this.started.add(name);
        }
        await this.record(name, { type: "wake", text });
        // "handled" means no run started, so no agent_settled will follow: settle here or the member stays working.
        if ((await worker.prompt(text)) === "handled") await this.router.settled(name);
      },
      stop: () => worker.stop(),
    });
  }

  private onWorkerEvent(name: string, event: any) {
    switch (event?.type) {
      case "agent_settled":
        void this.record(name, event).then(() => this.router.settled(name));
        return;
      case "message_end":
      case "tool_execution_start":
      case "tool_execution_end":
      case "agent_start":
      case "auto_retry_start":
      case "auto_retry_end":
      case "compaction_end":
      case "extension_error":
        void this.record(name, event);
        return;
      case "message_update": {
        // Live-only (not persisted): stream text so the drawer shows progress while the model writes.
        const e = event.assistantMessageEvent;
        if (e?.type === "text_delta" || e?.type === "thinking_delta") this.router.emitEvent({ type: "transcript", name, record: { type: "delta", kind: e.type, delta: e.delta, ts: Date.now() } });
        return;
      }
    }
  }

  private async record(name: string, event: any) {
    const record = { ts: Date.now(), ...event };
    await this.store.appendTranscript(name, record);
    this.router.emitEvent({ type: "transcript", name, record });
  }

  private serverApi() {
    const html = existsSync(UI_FILE) ? readFileSync(UI_FILE, "utf8") : "<!doctype html><p>ui.html missing</p>";
    return {
      html: () => html,
      state: () => ({ id: this.id, goal: this.goal, dir: relative(this.root, this.store.dir) || this.store.dir, limits: this.limits, roster: this.store.getRoster(), board: this.store.messages(), queued: this.router.queued() }),
      transcript: (name: string) => (this.store.member(name) ? this.store.transcript(name) : null),
      humanPost: (body: string) => this.post(HUMAN, body, "message"),
      workerName: (token: string) => this.tokens.get(token) ?? null,
      workerPost: (name: string, body: string, kind: Kind) => this.post(name, body, kind === "brief" || kind === "system" ? "message" : kind),
      workerRead: async (name: string, q: URLSearchParams) =>
        this.read(name, { since: q.has("since") ? Number(q.get("since")) : undefined, from: q.get("from") ?? undefined, limit: q.has("limit") ? Number(q.get("limit")) : undefined }),
      subscribe: (listener: (type: string, data: unknown) => void) =>
        this.onEvent((event) => {
          if (event.type === "board") listener("board", event.message);
          else if (event.type === "roster") listener("roster", { members: event.members, queued: this.router.queued() });
          else listener("transcript", { name: event.name, record: event.record });
        }),
    };
  }
}
