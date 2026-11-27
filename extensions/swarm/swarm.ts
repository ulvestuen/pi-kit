// One running swarm: store + router + headless workers + worktrees + local server. Independent of ExtensionAPI so it can be
// driven by tests with a fake `pi` and a temporary git repository. index.ts adapts it to Pi commands and tools.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { antigravityWorker, type ApprovalChoice } from "./antigravity.ts";
import type { PiCommand } from "./driver.ts";
import { nativeInvocation, nativeWorker } from "./native.ts";
import { pairSandbox } from "./pair-sandbox.ts";
import { COORDINATOR, HUMAN, Router, validName, type AgentHandle, type PendingApproval, type SwarmEvent } from "./router.ts";
import { startServer, type SwarmServer } from "./server.ts";
import { KINDS, Mutex, SwarmStore, type BoardMessage, type Kind, type Member, type Workspace } from "./store.ts";
import { DEFAULT_TURN_TIMEOUT_MS, HARNESSES, failed, piWorker, probe, type Harness, type TranscriptEvent, type TurnResult, type WorkerAdapter } from "./worker.ts";
import { addWorktree, baseRef, describeStatus, excludeDir, removeWorktree, repoRoot, worktreeStatus, type Git, git as realGit, type WorktreeStatus } from "./worktree.ts";
import { PairWorkflow, type Pick as WorkerPick, type WorkflowOptions } from "./workflow.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKER_EXTENSION = join(HERE, "worker-ext.ts");
const WORKFLOW_TOOLS_EXTENSION = join(HERE, "workflow-tools.ts");
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
  validatePiEffort?: (model: string, effort: string) => void;
  port?: number;
  id?: string;
  git?: Git;
  /** Extra args for every worker after `--mode rpc` (tests use this to stub the CLI). */
  workerArgs?: string[];
  nativeTurnTimeoutMs?: number;
  managedPiTurnTimeoutMs?: number;
  workflow?: WorkflowOptions;
}

export interface AddOptions {
  name: string;
  brief: string;
  workspace?: "inherit" | "worktree";
  harness?: Harness;
  model?: string;
  effort?: string;
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

export function workerRules(goal: string, member: Pick<Member, "name" | "workspace" | "cwd" | "branch" | "harness">, base?: string): string {
  const where =
    member.workspace === "worktree"
      ? `Your workspace is your own git worktree at ${member.cwd} on branch ${member.branch}. Do not touch the main checkout.${member.harness === "claude" ? " Your tools cannot run git commands; hand off the worktree path and identify any uncommitted changes." : ` Edit and commit there; @coordinator merges your branch into ${base ?? "the base branch"}.`}`
      : `Your workspace is the shared main checkout at ${member.cwd}. Other members may be working there too: stay inside your track, and prefer reading and verifying over editing files outside it.`;
  return [
    `<swarm-worker>`,
    `You are @${member.name}, a worker in a Pi swarm run by @coordinator. Swarm goal: ${goal}`,
    `- Your assignment is the board message addressed to @${member.name} with kind "brief". Do only that track.`,
    `- ${where}`,
    `- The shared board is how members talk. Use board_post${member.harness && member.harness !== "pi" ? " (on the swarm_board MCP server)" : ""} and @mention whoever must act next: a peer (for example @verifier) to hand work over, or @coordinator when your track is done (kind "result") or blocked (kind "question").`,
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
  readonly workflow?: PairWorkflow;
  server: SwarmServer | null = null;
  private readonly workerChanges = new Mutex();
  private readonly workers = new Map<string, WorkerAdapter>();
  private readonly tokens = new Map<string, string>();
  private readonly approvals = new Map<string, { request: PendingApproval; token: string; decide(choice: ApprovalChoice): void }>();
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
    if (options.workflow) this.workflow = new PairWorkflow(this, options.workflow);
  }

  static async start(options: SwarmOptions): Promise<Swarm> {
    const run = options.git ?? realGit;
    const top = options.workflow ? null : await repoRoot(options.cwd, run);
    const root = options.workflow ? mkdtempSync(join(tmpdir(), "pi-swarm-pair-")) : top ?? resolve(options.cwd);
    if (top) await excludeDir(top, ".swarm/", run);
    const swarm = new Swarm(options, root, Boolean(top), top ? await baseRef(top, run) : undefined);
    if (!swarm.workflow) {
      await swarm.store.upsertMember(COORDINATOR, { state: "working", workspace: "coordinator", cwd: root, harness: "pi", model: options.coordinatorModel });
      swarm.router.attach(COORDINATOR, options.coordinator);
    }
    try {
      swarm.server = await startServer(swarm.serverApi(), { token: swarm.uiToken, port: options.port });
    } catch (error) {
      await swarm.store.close();
      throw error;
    }
    if (!swarm.workflow) await swarm.router.post("system", `Swarm ${swarm.id} started.\n\n**Goal:** ${swarm.goal}`, "system");
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
    return this.workerChanges.run(() => this.addWorker(input));
  }

  private async addWorker(input: AddOptions): Promise<{ member: Member; brief: BoardMessage }> {
    if (this.stopping) throw new Error("The swarm is stopping.");
    if (this.workflow) throw new Error("Workflow workers are configured in browser setup.");
    const name = input.name.trim().toLowerCase();
    if (!validName(name)) throw new Error(`Invalid worker name "${input.name}": use 1-31 lowercase letters, digits, or dashes, starting with a letter (reserved: coordinator, human, system, all).`);
    const existing = this.store.member(name);
    if (existing && existing.state !== "killed") throw new Error(`@${name} already exists (${existing.state}).`);
    if (existing) throw new Error(`@${name} was killed in this swarm; choose a new name.`);
    if (this.liveMembers().length >= this.limits.maxWorkers) throw new Error(`Worker limit reached (${this.limits.maxWorkers}). Kill a finished worker first.`);
    if (!input.brief.trim()) throw new Error("brief is required");
    const harness = input.harness ?? "pi";
    if (!HARNESSES.includes(harness)) throw new Error(`Unsupported harness ${harness}. Choose ${HARNESSES.join(", ")}.`);
    const requestedModel = input.model?.trim() || undefined;
    const effort = input.effort?.trim() || undefined;
    let model = requestedModel ?? (harness === "pi" ? this.options.coordinatorModel : undefined);
    if (harness === "pi" && effort) {
      if (requestedModel?.includes(":")) throw new Error("Choose Pi effort separately or use the legacy model:effort syntax, not both.");
      model = model?.replace(/:[a-z]+$/, "");
      if (!model || !this.options.validatePiEffort) throw new Error("Explicit Pi effort requires a model in the coordinator's model registry.");
      this.options.validatePiEffort(model, effort);
    }
    const workspace: Workspace = input.workspace ?? "inherit";
    let cwd = this.root;
    let branch: string | undefined;
    const base = this.store.getRoster().base;
    if (workspace === "worktree") {
      if (!this.isRepo) throw new Error(`workspace "worktree" needs a git repository; ${this.root} is not one.`);
      cwd = join(this.store.dir, "worktrees", name);
      branch = `swarm/${this.id}/${name}`;
    }
    const selection = { name, workspace, cwd, branch, harness, model, effort };
    const token = randomBytes(18).toString("base64url");
    const worker = this.createWorker(selection, token, base);
    await worker.preflight();
    if (this.stopping) throw new Error("The swarm is stopping.");
    if (branch) await addWorktree(this.root, cwd, branch, base ?? "HEAD", this.git);
    await this.store.upsertMember(name, { ...selection, state: "waiting", lastSeenMessageId: 0, wakes: 0 });
    if (!this.stopping) this.tokens.set(token, name);
    this.attachWorker(name, harness, token, worker);
    this.router.emitEvent({ type: "roster", members: this.store.getRoster().members });
    // The brief is an ordinary @mention: it wakes the worker through the same router as every other message.
    const brief = await this.router.post(COORDINATOR, `@${name} ${input.brief.trim()}`, "brief");
    return { member: this.store.member(name)!, brief };
  }

  /** Build and check both roles before adding either to the roster. Workflow roles are never attached to mention routing. */
  async prepareWorkflowWorkers(roles: (WorkerPick & { name: string; policy: "read" | "write" })[], cwd: string, preflightCwd: string) {
    const workers = await Promise.all(roles.map(async ({ policy, ...pick }) => {
      const member = { ...pick, cwd, workspace: "inherit" as const };
      const token = randomBytes(18).toString("base64url");
      const worker = this.createWorker(member, token, undefined, policy, preflightCwd);
      try { await worker.preflight(); } catch (error) { throw new Error(`@${member.name}: ${(error as Error).message}`); }
      return { member, token, worker };
    }));
    return () => this.workerChanges.run(async () => {
      if (this.stopping || this.workflow?.snapshot().status !== "checking") return;
      for (const { member, token, worker } of workers) {
        this.workers.set(member.name, worker);
        this.tokens.set(token, member.name);
        await this.store.upsertMember(member.name, { ...member, state: "waiting" });
      }
      this.router.emitEvent({ type: "roster", members: this.store.getRoster().members });
    });
  }

  async workflowTurn(name: string, prompt: string): Promise<TurnResult> {
    const worker = this.workers.get(name);
    if (!worker || this.stopping) return { type: "cancelled" };
    const wakes = this.store.member(name)!.wakes;
    await this.store.upsertMember(name, { state: "working", wakes: wakes + 1 });
    this.router.emitEvent({ type: "roster", members: this.store.getRoster().members });
    // Private prompts and raw reports are never published to the board or written to transcripts.
    const result = await worker.deliver(prompt).catch(() => failed("exit", "Could not deliver the workflow turn."));
    if (result.type === "failed") {
      await this.record(name, { type: "turn_failed", failure: result.failure, reason: result.reason });
      await this.router.exited(name, undefined, result.failure);
      await this.store.upsertMember(name, { problem: result.reason });
      this.router.emitEvent({ type: "roster", members: this.store.getRoster().members });
    } else if (result.type === "completed") {
      await this.record(name, { type: "agent_settled" });
      await this.router.settled(name);
      return { ...result, text: this.redact(result.text) };
    } else {
      await this.record(name, { type: "turn_cancelled" });
    }
    return result;
  }

  async stopWorkflowWorkers() {
    if (!this.workflow) return;
    await this.workerChanges.run(async () => {
      this.tokens.clear();
      await Promise.all([...this.workers].map(async ([name, worker]) => {
        await worker.stop();
        const member = this.store.member(name);
        if (member?.state === "working" || member?.state === "waiting") await this.store.upsertMember(name, { state: "stopped" });
      }));
      this.workers.clear();
      this.router.emitEvent({ type: "roster", members: this.store.getRoster().members });
    });
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
      for (const [token, owner] of this.tokens) if (owner === name) this.tokens.delete(token);
      await this.router.kill(name);
      this.workers.delete(name);
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
    await this.workflow?.cancel();
    this.tokens.clear();
    await this.workerChanges.run(() => undefined);
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
    if (!this.workflow) await this.store.upsertMember(COORDINATOR, { state: "stopped" });
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

  private createWorker(member: Pick<Member, "name" | "cwd" | "workspace" | "branch" | "harness" | "model" | "effort">, token: string, base: string | undefined, policy?: "read" | "write", preflightCwd = this.root): WorkerAdapter {
    const { name, cwd, harness, model, effort } = member;
    const rules = policy ? `Follow the assigned workflow phase. Use only this checkout for the task. ${policy === "read" ? "Do not edit files." : "Only edit task files; do not commit, merge or push."} Return your final report as instructed.` : workerRules(this.goal, member, base);
    const env = { PI_SWARM_ROLE: "worker", PI_SWARM_ID: this.id, PI_SWARM_NAME: name, PI_SWARM_URL: this.apiBase, PI_SWARM_TOKEN: token };
    const onRecord = (record: TranscriptEvent, live?: boolean) => {
      if (this.stopping || !this.tokens.has(token)) return;
      if (policy && record.type !== "agent_start") return;
      if (live) this.router.emitEvent({ type: "transcript", name, record: { ...this.safeRecord(record), ts: Date.now() } });
      else void this.record(name, record);
    };
    if (harness && harness !== "pi") {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
      for (const key of UNSET_ENV) delete childEnv[key];
      const cli = nativeInvocation(harness, preflightCwd);
      const sandbox = policy ? pairSandbox({ cli, cwd, harness, policy, stateDir: this.store.dir, env: childEnv }) : undefined;
      const options = { cli, cwd, preflightCwd, env: childEnv, model, effort, sandbox,
        rules, boardUrl: `${this.apiBase}/api/worker/mcp`, timeoutMs: this.options.nativeTurnTimeoutMs, onRecord,
        revokeBoard: () => this.tokens.delete(token) };
      if (harness !== "agy") return nativeWorker({ ...options, harness, policy });
      delete childEnv.PI_SWARM_TOKEN;
      return antigravityWorker({ ...options, boardToken: token,
        approve: (details, decide) => {
          const id = randomBytes(18).toString("base64url");
          const request = { ...details, id, name, title: this.redact(details.title), details: this.redact(details.details) };
          this.approvals.set(id, { request, token, decide });
          this.emitApprovals();
          return () => { if (this.approvals.delete(id)) this.emitApprovals(); };
        },
      });
    }
    const args = [
      ...(this.options.workerArgs ?? []),
      ...(policy
        ? ["--no-session", "--no-approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
          "--tools", policy === "write" ? "task_read,task_ls,task_edit,task_write" : "task_read,task_ls",
          "-e", WORKFLOW_TOOLS_EXTENSION]
        : ["--session-dir", join(this.store.dir, "sessions", name), "-e", WORKER_EXTENSION]),
      "--name", `swarm ${this.id} @${name}`,
      "--append-system-prompt", rules,
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--thinking", effort] : []),
    ];
    const worker = piWorker({
      name, cwd, pi: this.options.pi, args, unset: UNSET_ENV,
      env: policy ? { ...env, PI_SWARM_WORKFLOW_WRITE: policy === "write" ? "1" : "0" } : env, onRecord,
      managedTimeoutMs: policy ? this.options.managedPiTurnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS : undefined,
      onIdleExit: (reason) => {
        if (this.stopping || !this.tokens.has(token)) return;
        reason = this.redact(reason);
        void this.record(name, { type: "turn_failed", failure: "exit", reason });
        void this.router.exited(name, reason);
      },
    });
    if (policy) worker.preflight = async () => {
      const result = await probe(this.options.pi, ["--version"], preflightCwd);
      if (!result.ok) throw new Error("The Pi CLI version check failed.");
      const auth = await probe(this.options.pi, ["auth", "check", "--model", model!, "--json", "--no-refresh"], preflightCwd);
      if (!auth.ok) throw new Error(`Pi could not verify ${model} without extensions. Check credentials or choose another model or harness.`);
    };
    return worker;
  }

  private attachWorker(name: string, harness: Harness, token: string, worker: WorkerAdapter) {
    this.workers.set(name, worker);
    this.router.attach(name, {
      deliver: async (text) => {
        if (this.stopping || !this.tokens.has(token)) return;
        await this.record(name, { type: "wake", text });
        if (this.stopping || !this.tokens.has(token)) return;
        const result = await worker.deliver(text);
        if (result.type === "cancelled" || this.stopping || this.store.member(name)?.state === "killed") {
          await this.record(name, { type: "turn_cancelled" });
          if (!this.stopping && this.tokens.has(token)) await this.router.settled(name);
        } else if (result.type === "failed") {
          const reason = this.redact(result.reason);
          await this.record(name, { type: "turn_failed", failure: result.failure, reason });
          if (harness !== "pi") this.tokens.delete(token);
          if (!this.stopping) await this.router.exited(name, reason, harness === "pi" ? undefined : result.failure);
        } else {
          await this.record(name, { type: "agent_settled" });
          if (!this.stopping) await this.router.settled(name);
        }
      },
      stop: () => worker.stop(),
    });
  }

  private redact(text: string): string {
    for (const token of [this.uiToken, ...this.tokens.keys()]) text = text.replaceAll(token, "[redacted]");
    return text;
  }

  private safeRecord(record: TranscriptEvent): TranscriptEvent {
    return JSON.parse(this.redact(JSON.stringify(record)));
  }

  private async record(name: string, event: TranscriptEvent) {
    const record = { ts: Date.now(), ...this.safeRecord(event) };
    await this.store.appendTranscript(name, record);
    this.router.emitEvent({ type: "transcript", name, record });
  }

  private pendingApprovals() {
    return [...this.approvals.values()].map(({ request }) => request);
  }

  private emitApprovals() {
    this.router.emitEvent({ type: "approvals", approvals: this.pendingApprovals() });
  }

  private serverApi() {
    const html = existsSync(UI_FILE) ? readFileSync(UI_FILE, "utf8") : "<!doctype html><p>ui.html missing</p>";
    return {
      html: () => html,
      state: () => ({ id: this.id, goal: this.goal, dir: this.workflow ? this.store.dir : relative(this.root, this.store.dir) || this.store.dir, limits: this.limits, roster: this.store.getRoster(), board: this.store.messages(), queued: this.router.queued(), approvals: this.pendingApprovals(), workflow: this.workflow?.snapshot() }),
      workflowAction: this.workflow ? (input: unknown) => this.workflow!.action(input) : undefined,
      approve: (id: string, choice: ApprovalChoice) => {
        const pending = this.approvals.get(id);
        if (this.stopping || !pending || !this.tokens.has(pending.token) || (choice === "allow" && !pending.request.canAllow)) return false;
        this.approvals.delete(id);
        pending.decide(choice);
        this.emitApprovals();
        return true;
      },
      transcript: (name: string) => (this.store.member(name) ? this.store.transcript(name) : null),
      humanPost: (body: string) => this.post(HUMAN, body, "message"),
      workerName: (token: string) => this.tokens.get(token) ?? null,
      workerPost: (name: string, body: string, kind: Kind) => {
        if (this.workflow) throw Object.assign(new Error("Workflow reports do not go on the board."), { status: 403 });
        return this.post(name, this.redact(body), kind === "brief" || kind === "system" ? "message" : kind);
      },
      workerRead: async (name: string, q: URLSearchParams) =>
        this.workflow ? { messages: [], members: [], lastId: 0 } : this.read(name, { since: q.has("since") ? Number(q.get("since")) : undefined, from: q.get("from") ?? undefined, limit: q.has("limit") ? Number(q.get("limit")) : undefined }),
      subscribe: (listener: (type: string, data: unknown) => void) =>
        this.onEvent((event) => {
          if (event.type === "board") listener("board", event.message);
          else if (event.type === "roster") listener("roster", { members: event.members, queued: this.router.queued() });
          else if (event.type === "workflow") listener("workflow", event.workflow);
          else if (event.type === "approvals") listener("approvals", event.approvals);
          else listener("transcript", { name: event.name, record: event.record });
        }),
    };
  }
}
