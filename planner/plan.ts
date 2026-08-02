/**
 * planner plan engine — pure, dependency-free model of a plan as data:
 * a validated task DAG with per-task, pdca-shaped acceptance criteria.
 *
 * The only import is pdca's pure loop engine, so this module stays free of
 * pi and Node APIs and can be unit tested in isolation and reused by the
 * extension and the orchestrator.
 */

import {
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_SCALE_MAX,
  normalizeCriteria,
  type Criterion,
  type CriterionInput,
} from "../pdca/loop.ts";
import type { ArtifactRef } from "@pi-kit/agent-types";

export const DEFAULT_AGENT = "implementer";
export const MAX_ATTEMPT_FEEDBACK_ENTRIES = 3;
export const MAX_ATTEMPT_FEEDBACK_SUMMARY_BYTES = 2048;
export const MAX_RENDERED_ATTEMPT_FEEDBACK_BYTES = 6144;
export const MAX_TASK_CHECKS = 32;
export const MAX_FINAL_CHECKS = 32;
export const MIN_CHECK_TIMEOUT_MS = 100;
export const MAX_CHECK_TIMEOUT_MS = 30 * 60 * 1000;

export interface AttemptFeedback {
  attempt: number;
  source: "execution" | "check" | "review" | "integration";
  status: string;
  summary: string;
  createdAt: number;
}

export interface CommandCheck {
  id: string;
  command: string;
  args: string[];
  /** Repository/worktree-relative lexical path. */
  cwd?: string;
  timeoutMs?: number;
}

export type TaskStatus =
  | "pending" // dependencies not yet met
  | "ready" // dispatchable
  | "running"
  | "review" // done, awaiting critic verdict
  | "done"
  | "failed";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "ready",
  "running",
  "review",
  "done",
  "failed",
];

export interface PlanTask {
  id: string;
  title: string;
  /** Full brief handed to the sub-agent. */
  description: string;
  /** Ids of tasks that must be done before this one can run. */
  dependsOn: string[];
  /** fleet agent name; defaults to "implementer". */
  agent?: string;
  /** pdca-shaped acceptance criteria. */
  criteria: Criterion[];
  checks: CommandCheck[];
  attemptFeedback: AttemptFeedback[];
  /**
   * Names of goal-level criteria this task helps satisfy (exact names from
   * the pdca goal loop). Optional: plans persisted before this field
   * existed lack it entirely.
   */
  covers?: string[];
  status: TaskStatus;
  /** Number of times the task has been dispatched. */
  attempts: number;
  /** Artifacts produced by this task after passing review. */
  artifacts: ArtifactRef[];
}

export interface Plan {
  goal: string;
  tasks: PlanTask[];
  createdAt: number;
  updatedAt: number;
  finalChecks: CommandCheck[];
}

export interface PlanTaskInput {
  id: string;
  title: string;
  description: string;
  dependsOn?: string[];
  agent?: string;
  criteria: CriterionInput[];
  checks?: CommandCheck[];
  covers?: string[];
}

export interface CreatePlanOptions {
  passThreshold?: number;
  scaleMax?: number;
  now?: number;
  finalChecks?: CommandCheck[];
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= 0; end--) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch { /* cut through a multibyte code point */ }
  }
  return "";
}

/** Append immutable retry context while retaining the latest bounded entries. */
export function appendAttemptFeedback(
  entries: readonly AttemptFeedback[] | undefined,
  feedback: AttemptFeedback,
): AttemptFeedback[] {
  if (!Number.isInteger(feedback.attempt) || feedback.attempt < 1) {
    throw new Error("Attempt feedback attempt must be a positive integer");
  }
  if (!["execution", "check", "review", "integration"].includes(feedback.source)) {
    throw new Error(`Invalid attempt feedback source: ${feedback.source}`);
  }
  const normalized = {
    ...feedback,
    status: String(feedback.status ?? "").trim(),
    summary: truncateUtf8(String(feedback.summary ?? ""), MAX_ATTEMPT_FEEDBACK_SUMMARY_BYTES),
  };
  if (!normalized.status) throw new Error("Attempt feedback status must not be empty");
  if (!Number.isFinite(normalized.createdAt)) throw new Error("Attempt feedback createdAt must be finite");
  return [...(entries ?? []), normalized].slice(-MAX_ATTEMPT_FEEDBACK_ENTRIES);
}

/** Render retry context independently of the task's immutable description. */
export function renderAttemptFeedback(entries: readonly AttemptFeedback[] | undefined): string {
  const lines = (entries ?? []).slice(-MAX_ATTEMPT_FEEDBACK_ENTRIES).map(
    (item) => `[Attempt ${item.attempt} · ${item.source} · ${item.status}] ${item.summary}`,
  );
  return truncateUtf8(lines.join("\n"), MAX_RENDERED_ATTEMPT_FEEDBACK_BYTES);
}

function normalizeChecks(value: unknown, label: string, maxCount: number): CommandCheck[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maxCount) throw new Error(`${label} may contain at most ${maxCount} checks`);
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`${label}[${index}] must be an object`);
    const source = raw as Partial<CommandCheck>;
    const id = String(source.id ?? "").trim();
    const command = String(source.command ?? "").trim();
    if (!id) throw new Error(`${label}[${index}] needs a non-empty id`);
    if (ids.has(id.toLowerCase())) throw new Error(`Duplicate check id in ${label}: ${id}`);
    ids.add(id.toLowerCase());
    if (!command) throw new Error(`Check "${id}" needs a non-empty command`);
    if (!Array.isArray(source.args) || !source.args.every((arg) => typeof arg === "string")) {
      throw new Error(`Check "${id}" args must be a string array`);
    }
    let cwd: string | undefined;
    if (source.cwd !== undefined) {
      cwd = String(source.cwd).trim().replaceAll("\\", "/");
      if (!cwd || cwd.startsWith("/") || /^[A-Za-z]:\//.test(cwd)) {
        throw new Error(`Check "${id}" cwd must be a non-empty relative path`);
      }
      const parts = cwd.split("/");
      if (parts.some((part) => part === "..") || parts.some((part) => part === "")) {
        throw new Error(`Check "${id}" cwd must stay inside the repository or worktree`);
      }
      cwd = parts.filter((part) => part !== ".").join("/") || ".";
    }
    let timeoutMs: number | undefined;
    if (source.timeoutMs !== undefined) {
      timeoutMs = Number(source.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_CHECK_TIMEOUT_MS || timeoutMs > MAX_CHECK_TIMEOUT_MS) {
        throw new Error(`Check "${id}" timeoutMs must be an integer between ${MIN_CHECK_TIMEOUT_MS} and ${MAX_CHECK_TIMEOUT_MS}`);
      }
    }
    return { id, command, args: [...source.args], cwd, timeoutMs };
  });
}

function normalizeId(id: string): string {
  return id.trim();
}

function idKey(id: string): string {
  return normalizeId(id).toLowerCase();
}

function buildTask(
  input: PlanTaskInput,
  options: CreatePlanOptions,
): PlanTask {
  const id = normalizeId(input.id ?? "");
  if (!id) {
    throw new Error("Every task needs a non-empty id");
  }
  const title = (input.title ?? "").trim();
  if (!title) {
    throw new Error(`Task "${id}" needs a non-empty title`);
  }
  const description = (input.description ?? "").trim();
  if (!description) {
    throw new Error(`Task "${id}" needs a non-empty description`);
  }
  const criteria = normalizeCriteria(
    input.criteria ?? [],
    options.passThreshold ?? DEFAULT_PASS_THRESHOLD,
    options.scaleMax ?? DEFAULT_SCALE_MAX,
  );
  return {
    id,
    title,
    description,
    dependsOn: (input.dependsOn ?? []).map(normalizeId).filter(Boolean),
    agent: input.agent?.trim() || undefined,
    criteria,
    checks: normalizeChecks(input.checks, `Task "${id}" checks`, MAX_TASK_CHECKS),
    attemptFeedback: [],
    covers: normalizeCovers(input.covers),
    status: "pending",
    attempts: 0,
    artifacts: [],
  };
}

function normalizeCovers(covers: string[] | undefined): string[] | undefined {
  const normalized = (covers ?? []).map((name) => name.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

/** Validate the task list as a DAG: unique ids, no dangling deps, no cycles. */
function validateDag(tasks: PlanTask[]): void {
  const byId = new Map<string, PlanTask>();
  for (const task of tasks) {
    const key = idKey(task.id);
    if (byId.has(key)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    byId.set(key, task);
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (idKey(dep) === idKey(task.id)) {
        throw new Error(`Task "${task.id}" depends on itself`);
      }
      if (!byId.has(idKey(dep))) {
        throw new Error(
          `Task "${task.id}" depends on unknown task "${dep}"`,
        );
      }
    }
  }

  // Kahn's algorithm: if not every task can be ordered, there is a cycle.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(idKey(task.id), task.dependsOn.length);
    for (const dep of task.dependsOn) {
      const key = idKey(dep);
      dependents.set(key, [...(dependents.get(key) ?? []), idKey(task.id)]);
    }
  }
  const queue = tasks
    .map((t) => idKey(t.id))
    .filter((key) => indegree.get(key) === 0);
  let ordered = 0;
  while (queue.length > 0) {
    const key = queue.shift()!;
    ordered++;
    for (const dependent of dependents.get(key) ?? []) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  if (ordered !== tasks.length) {
    const cyclic = tasks
      .filter((t) => (indegree.get(idKey(t.id)) ?? 0) > 0)
      .map((t) => t.id);
    throw new Error(`Plan contains a dependency cycle: ${cyclic.join(", ")}`);
  }
}

/** Create a validated plan. Throws on cycles, dangling deps, or bad input. */
export function createPlan(
  goal: string,
  tasks: PlanTaskInput[],
  options: CreatePlanOptions = {},
): Plan {
  const normalizedGoal = goal?.trim();
  if (!normalizedGoal) {
    throw new Error("Plan goal must not be empty");
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("A plan needs at least one task");
  }
  const built = tasks.map((t) => buildTask(t, options));
  validateDag(built);
  const now = options.now ?? Date.now();
  return {
    goal: normalizedGoal,
    tasks: built,
    createdAt: now,
    updatedAt: now,
    finalChecks: normalizeChecks(options.finalChecks, "Plan finalChecks", MAX_FINAL_CHECKS),
  };
}

/** Validate and migrate persisted plans. Missing checks/feedback become empty arrays. */
export function normalizePlan(value: unknown): Plan {
  if (!value || typeof value !== "object") throw new Error("Persisted plan must be an object");
  const raw = value as Partial<Plan> & { tasks?: unknown[] };
  if (!Array.isArray(raw.tasks)) throw new Error("Persisted plan tasks must be an array");
  const created = createPlan(
    String(raw.goal ?? ""),
    raw.tasks.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Persisted plan task must be an object");
      const task = item as any;
      return { ...task, checks: task.checks ?? [] } as PlanTaskInput;
    }),
    { now: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(), finalChecks: raw.finalChecks ?? [] },
  );
  created.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt! : created.createdAt;
  created.tasks = created.tasks.map((task, index) => {
    const source = raw.tasks![index] as any;
    const status = source.status ?? "pending";
    if (!TASK_STATUSES.includes(status)) throw new Error(`Invalid task status: ${status}`);
    const attempts = source.attempts ?? 0;
    if (!Number.isInteger(attempts) || attempts < 0) throw new Error(`Task "${task.id}" attempts must be a non-negative integer`);
    let feedback: AttemptFeedback[] = [];
    for (const item of source.attemptFeedback ?? []) feedback = appendAttemptFeedback(feedback, item);
    return { ...task, status, attempts, artifacts: Array.isArray(source.artifacts) ? source.artifacts : [], attemptFeedback: feedback } as PlanTask;
  });
  validateDag(created.tasks);
  return created;
}

export function getTask(plan: Plan, id: string): PlanTask | undefined {
  return plan.tasks.find((t) => idKey(t.id) === idKey(id));
}

function requireTask(plan: Plan, id: string): PlanTask {
  const task = getTask(plan, id);
  if (!task) {
    throw new Error(`Unknown task id: ${id}`);
  }
  return task;
}

/** Tasks dispatchable now: not yet started, with every dependency done. */
export function readySet(plan: Plan): PlanTask[] {
  return plan.tasks.filter(
    (task) =>
      (task.status === "pending" || task.status === "ready") &&
      task.dependsOn.every((dep) => getTask(plan, dep)?.status === "done"),
  );
}

/** Legal status transitions. Maps from current status to the set of
 * allowed next statuses. Code-enforced with a console.warn on violation;
 * does not throw so manual overrides remain possible. */
const LEGAL_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["ready"],
  ready: ["running"],
  running: ["review", "ready", "failed"],
  review: ["done", "ready", "failed"],
  done: [],
  failed: [],
};

function warnIllegalTransition(
  from: TaskStatus,
  to: TaskStatus,
  taskId: string,
): void {
  console.warn(
    `[planner] Warning: illegal status transition ${from} -> ${to} on task "${taskId}". ` +
    `Legal transitions from ${from}: [${LEGAL_TRANSITIONS[from].join(", ")}]. ` +
    `Proceeding anyway (manual override).`,
  );
}

/**
 * Return a new plan with one task's status changed. Dispatching a task
 * (transition to "running") counts as an attempt.
 *
 * Logs a warning on illegal transitions but does not throw — manual
 * overrides remain possible.
 */
export function setTaskStatus(
  plan: Plan,
  id: string,
  status: TaskStatus,
  now?: number,
): Plan {
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`Invalid task status: ${status}`);
  }
  const target = requireTask(plan, id);
  if (target.status !== status && !LEGAL_TRANSITIONS[target.status]?.includes(status)) {
    warnIllegalTransition(target.status, status, id);
  }
  return {
    ...plan,
    updatedAt: now ?? Date.now(),
    tasks: plan.tasks.map((task) =>
      task === target
        ? {
            ...task,
            status,
            attempts:
              status === "running" && task.status !== "running"
                ? task.attempts + 1
                : task.attempts,
          }
        : task,
    ),
  };
}

/** Fields of a task that may be edited after creation. */
export interface PlanTaskPatch {
  title?: string;
  description?: string;
  agent?: string;
  criteria?: CriterionInput[];
  checks?: CommandCheck[];
  /** Goal-level criterion names this task helps satisfy. */
  covers?: string[];
  /** Artifacts produced by the task (set on passing review). */
  artifacts?: ArtifactRef[];
}

/** Return a new plan with one task edited. */
export function updateTask(
  plan: Plan,
  id: string,
  patch: PlanTaskPatch,
  options: CreatePlanOptions = {},
): Plan {
  const target = requireTask(plan, id);
  const updated: PlanTask = { ...target };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error(`Task "${id}" needs a non-empty title`);
    updated.title = title;
  }
  if (patch.description !== undefined) {
    if (target.attempts > 0 && patch.description !== target.description) {
      throw new Error(`Task "${id}" description is immutable after its first attempt; add a follow-up task for scope changes`);
    }
    const description = patch.description.trim();
    if (!description) {
      throw new Error(`Task "${id}" needs a non-empty description`);
    }
    updated.description = description;
  }
  if (patch.agent !== undefined) {
    updated.agent = patch.agent.trim() || undefined;
  }
  if (patch.criteria !== undefined) {
    updated.criteria = normalizeCriteria(
      patch.criteria,
      options.passThreshold ?? DEFAULT_PASS_THRESHOLD,
      options.scaleMax ?? DEFAULT_SCALE_MAX,
    );
  }
  if (patch.checks !== undefined) {
    if (target.attempts > 0) throw new Error(`Task "${id}" checks are immutable after its first attempt`);
    updated.checks = normalizeChecks(patch.checks, `Task "${id}" checks`, MAX_TASK_CHECKS);
  }
  if (patch.covers !== undefined) {
    updated.covers = normalizeCovers(patch.covers);
  }
  if (patch.artifacts !== undefined) {
    updated.artifacts = patch.artifacts;
  }
  return {
    ...plan,
    updatedAt: options.now ?? Date.now(),
    tasks: plan.tasks.map((task) => (task === target ? updated : task)),
  };
}

export function updateFinalChecks(plan: Plan, checks: CommandCheck[], now?: number): Plan {
  if (plan.tasks.some((task) => task.attempts > 0)) {
    throw new Error("Plan finalChecks are immutable after execution starts");
  }
  return { ...plan, finalChecks: normalizeChecks(checks, "Plan finalChecks", MAX_FINAL_CHECKS), updatedAt: now ?? Date.now() };
}

/** Return a new plan with follow-up tasks appended (full DAG re-validation). */
export function addTasks(
  plan: Plan,
  tasks: PlanTaskInput[],
  options: CreatePlanOptions = {},
): Plan {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("addTasks needs at least one task");
  }
  const built = tasks.map((t) => buildTask(t, options));
  const all = [...plan.tasks, ...built];
  validateDag(all);
  return { ...plan, updatedAt: options.now ?? Date.now(), tasks: all };
}

/** Coverage of one goal-level criterion by the tasks that declare it. */
export interface CriterionCoverage {
  /** Goal-level criterion name, as first declared by a task's `covers`. */
  criterion: string;
  /** Ids of every task covering this criterion, in plan order. */
  tasks: string[];
  /** Subset of `tasks` that are done. */
  done: string[];
  /** Subset of `tasks` that are failed. */
  failed: string[];
}

/**
 * Group tasks by the goal-level criterion names they declare via `covers`,
 * so goal-criterion progress can be read mechanically off the plan
 * (System Requirements ↔ System Testing traceability). Criterion names are
 * matched case-insensitively; the first-seen spelling is reported.
 */
export function coverageByCriterion(plan: Plan): CriterionCoverage[] {
  const byKey = new Map<string, CriterionCoverage>();
  for (const task of plan.tasks) {
    for (const name of task.covers ?? []) {
      const key = nameKeyOf(name);
      let entry = byKey.get(key);
      if (!entry) {
        entry = { criterion: name, tasks: [], done: [], failed: [] };
        byKey.set(key, entry);
      }
      entry.tasks.push(task.id);
      if (task.status === "done") entry.done.push(task.id);
      if (task.status === "failed") entry.failed.push(task.id);
    }
  }
  return [...byKey.values()];
}

function nameKeyOf(name: string): string {
  return name.trim().toLowerCase();
}

export interface PlanSummary {
  goal: string;
  total: number;
  counts: Record<TaskStatus, number>;
  /** Ids dispatchable now. */
  ready: string[];
  /** Ids that can never run because a (transitive) dependency failed. */
  blocked: string[];
  /** Longest dependency chain of not-yet-done tasks. */
  criticalPathLength: number;
  /** True when every task is done. */
  done: boolean;
}

/** Ids of tasks transitively blocked by a failed dependency. */
function blockedIds(plan: Plan): string[] {
  const failed = new Set(
    plan.tasks.filter((t) => t.status === "failed").map((t) => idKey(t.id)),
  );
  if (failed.size === 0) return [];
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of plan.tasks) {
      const key = idKey(task.id);
      if (failed.has(key) || blocked.has(key) || task.status === "done") {
        continue;
      }
      if (
        task.dependsOn.some(
          (dep) => failed.has(idKey(dep)) || blocked.has(idKey(dep)),
        )
      ) {
        blocked.add(key);
        changed = true;
      }
    }
  }
  return plan.tasks
    .filter((t) => blocked.has(idKey(t.id)))
    .map((t) => t.id);
}

export function summarizePlan(plan: Plan): PlanSummary {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    ready: 0,
    running: 0,
    review: 0,
    done: 0,
    failed: 0,
  };
  for (const task of plan.tasks) counts[task.status]++;

  // Longest chain of unfinished tasks (memoized depth over the DAG).
  const depth = new Map<string, number>();
  const taskDepth = (task: PlanTask): number => {
    const key = idKey(task.id);
    const memo = depth.get(key);
    if (memo !== undefined) return memo;
    const own = task.status === "done" ? 0 : 1;
    const deps = task.dependsOn
      .map((dep) => getTask(plan, dep))
      .filter((t): t is PlanTask => t !== undefined);
    const result =
      own + (deps.length > 0 ? Math.max(...deps.map(taskDepth)) : 0);
    depth.set(key, result);
    return result;
  };
  const criticalPathLength =
    plan.tasks.length > 0 ? Math.max(...plan.tasks.map(taskDepth)) : 0;

  return {
    goal: plan.goal,
    total: plan.tasks.length,
    counts,
    ready: readySet(plan).map((t) => t.id),
    blocked: blockedIds(plan),
    criticalPathLength,
    done: counts.done === plan.tasks.length,
  };
}

/** One-line status suitable for a footer/status bar. */
export function statusLine(plan: Plan): string {
  const s = summarizePlan(plan);
  if (s.done) return `plan: complete (${s.total}/${s.total} done)`;
  const parts = [`${s.counts.done}/${s.total} done`];
  if (s.counts.running > 0) parts.push(`${s.counts.running} running`);
  if (s.counts.review > 0) parts.push(`${s.counts.review} in review`);
  if (s.counts.failed > 0) parts.push(`${s.counts.failed} failed`);
  return `plan: ${parts.join(", ")}`;
}
