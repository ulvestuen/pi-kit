/**
 * planner plan engine — pure, dependency-free model of a plan as data:
 * a validated task DAG with per-task, lykkja-shaped acceptance criteria.
 *
 * The only import is lykkja's pure loop engine, so this module stays free of
 * pi and Node APIs and can be unit tested in isolation and reused by the
 * extension and the orchestrator.
 */

import {
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_SCALE_MAX,
  normalizeCriteria,
  type Criterion,
  type CriterionInput,
} from "../lykkja/loop.ts";
import type { ArtifactRef } from "@pi-kit/agent-types";

export const DEFAULT_AGENT = "implementer";

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
  /** lykkja-shaped acceptance criteria. */
  criteria: Criterion[];
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
}

export interface PlanTaskInput {
  id: string;
  title: string;
  description: string;
  dependsOn?: string[];
  agent?: string;
  criteria: CriterionInput[];
}

export interface CreatePlanOptions {
  passThreshold?: number;
  scaleMax?: number;
  now?: number;
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
    status: "pending",
    attempts: 0,
    artifacts: [],
  };
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
  return { goal: normalizedGoal, tasks: built, createdAt: now, updatedAt: now };
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
  if (patch.artifacts !== undefined) {
    updated.artifacts = patch.artifacts;
  }
  return {
    ...plan,
    updatedAt: options.now ?? Date.now(),
    tasks: plan.tasks.map((task) => (task === target ? updated : task)),
  };
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
