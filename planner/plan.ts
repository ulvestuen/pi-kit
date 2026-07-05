/**
 * planner plan engine — pure state model for a plan as *data*: a validated
 * task DAG with per-task acceptance criteria.
 *
 * This module has no pi or Node dependencies so it can be unit tested in
 * isolation and reused by the extension, commands, tools, and the
 * orchestrator's scheduler. Its only import is lykkja's pure, dependency-free
 * `loop.ts`, reused as the shared vocabulary for acceptance criteria — every
 * task's bar is, by construction, something lykkja and a critic can score.
 */

import {
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_SCALE_MAX,
  normalizeCriteria,
  type Criterion,
  type CriterionInput,
} from "../lykkja/loop.ts";

/** Fleet agent used for tasks that do not name one explicitly. */
export const DEFAULT_AGENT = "implementer";

/** Task lifecycle states, in rough execution order. */
export const TASK_STATUSES = [
  "pending", // dependencies not yet met
  "ready", // dispatchable
  "running",
  "review", // done, awaiting critic verdict
  "done",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface PlanTask {
  /** Short slug id, unique within the plan (e.g. "parser-core"). */
  id: string;
  title: string;
  /** Full brief handed to the sub-agent. */
  description: string;
  /** Ids of tasks that must be done before this one can start. */
  dependsOn: string[];
  /** Fleet agent name; omitted means the default ("implementer"). */
  agent?: string;
  /** lykkja-shaped acceptance criteria this task is scored against. */
  criteria: Criterion[];
  status: TaskStatus;
  /** Number of times the task has been dispatched (set to "running"). */
  attempts: number;
}

export interface Plan {
  goal: string;
  tasks: PlanTask[];
  createdAt: number;
  updatedAt: number;
}

/** Raw task input accepted by createPlan / addTasks. */
export interface PlanTaskInput {
  id: string;
  title: string;
  description: string;
  dependsOn?: string[];
  agent?: string;
  criteria: CriterionInput[];
}

/** Editable fields accepted by updateTask. */
export interface PlanTaskPatch {
  title?: string;
  description?: string;
  /** Empty string clears the agent back to the default. */
  agent?: string;
  dependsOn?: string[];
  criteria?: CriterionInput[];
}

export interface PlanOptions {
  /** Default minimum passing score for criteria without one. */
  defaultThreshold?: number;
  /** Top of the scoring scale. */
  scaleMax?: number;
  now?: number;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function validateId(id: string): string {
  const normalized = normalizeText(id);
  if (!normalized) {
    throw new Error("Task id must not be empty");
  }
  if (!ID_PATTERN.test(normalized)) {
    throw new Error(
      `Task id "${normalized}" must be a slug: letters, digits, ".", "_" or "-"`,
    );
  }
  return normalized;
}

function buildTask(input: PlanTaskInput, options: PlanOptions): PlanTask {
  const id = validateId(input.id);

  const title = normalizeText(input.title);
  if (!title) {
    throw new Error(`Task "${id}" must have a title`);
  }
  const description = normalizeText(input.description);
  if (!description) {
    throw new Error(`Task "${id}" must have a description (the sub-agent brief)`);
  }

  const dependsOn: string[] = [];
  for (const raw of input.dependsOn ?? []) {
    const dep = normalizeText(raw);
    if (!dep) {
      throw new Error(`Task "${id}" has an empty dependency id`);
    }
    if (dep === id) {
      throw new Error(`Task "${id}" must not depend on itself`);
    }
    if (!dependsOn.includes(dep)) {
      dependsOn.push(dep);
    }
  }

  let criteria: Criterion[];
  try {
    criteria = normalizeCriteria(
      input.criteria ?? [],
      options.defaultThreshold ?? DEFAULT_PASS_THRESHOLD,
      options.scaleMax ?? DEFAULT_SCALE_MAX,
    );
  } catch (e: any) {
    throw new Error(`Task "${id}": ${e.message}`);
  }

  const agent = normalizeText(input.agent);
  return {
    id,
    title,
    description,
    dependsOn,
    ...(agent ? { agent } : {}),
    criteria,
    status: "pending",
    attempts: 0,
  };
}

/** Throw on dangling dependencies or dependency cycles. */
function validateGraph(tasks: PlanTask[]): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) {
        throw new Error(
          `Task "${task.id}" depends on unknown task "${dep}"`,
        );
      }
    }
  }

  // Iterative depth-first search with an explicit stack: white/grey/black.
  const state = new Map<string, "visiting" | "done">();
  for (const root of tasks) {
    if (state.has(root.id)) continue;
    const stack: { id: string; next: number; path: string[] }[] = [
      { id: root.id, next: 0, path: [root.id] },
    ];
    state.set(root.id, "visiting");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = byId.get(frame.id)!.dependsOn;
      if (frame.next >= deps.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++];
      const depState = state.get(dep);
      if (depState === "visiting") {
        const cycleStart = frame.path.indexOf(dep);
        const cycle = [...frame.path.slice(cycleStart), dep];
        throw new Error(`Dependency cycle: ${cycle.join(" -> ")}`);
      }
      if (depState === undefined) {
        state.set(dep, "visiting");
        stack.push({ id: dep, next: 0, path: [...frame.path, dep] });
      }
    }
  }
}

/**
 * Recompute the pending↔ready boundary: a pending task whose dependencies are
 * all done becomes ready; a ready task whose dependencies are no longer all
 * done drops back to pending. Other statuses are never touched.
 */
function resolveReady(tasks: PlanTask[]): PlanTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.map((task) => {
    if (task.status !== "pending" && task.status !== "ready") return task;
    const dispatchable = task.dependsOn.every(
      (dep) => byId.get(dep)!.status === "done",
    );
    const status: TaskStatus = dispatchable ? "ready" : "pending";
    return status === task.status ? task : { ...task, status };
  });
}

/**
 * Create a validated plan. Throws on an empty goal, an empty task list,
 * duplicate task ids, dangling dependencies, cycles, or invalid criteria.
 */
export function createPlan(
  goal: string,
  tasks: PlanTaskInput[],
  options: PlanOptions = {},
): Plan {
  const normalizedGoal = normalizeText(goal);
  if (!normalizedGoal) {
    throw new Error("Plan goal must not be empty");
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("A plan needs at least one task");
  }

  const built = tasks.map((input) => buildTask(input, options));
  const seen = new Set<string>();
  for (const task of built) {
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    seen.add(task.id);
  }
  validateGraph(built);

  const now = options.now ?? Date.now();
  return {
    goal: normalizedGoal,
    tasks: resolveReady(built),
    createdAt: now,
    updatedAt: now,
  };
}

function requireTask(plan: Plan, id: string): PlanTask {
  const task = plan.tasks.find((t) => t.id === id);
  if (!task) {
    const known = plan.tasks.map((t) => t.id).join(", ");
    throw new Error(`Unknown task id "${id}" (known: ${known})`);
  }
  return task;
}

/** Tasks that are dispatchable right now. */
export function readySet(plan: Plan): PlanTask[] {
  return plan.tasks.filter((t) => t.status === "ready");
}

/**
 * Set one task's status and re-resolve the pending↔ready boundary.
 * Guards against dispatching blocked work: a task cannot be set "ready" or
 * "running" while a dependency is not done. Transitioning into "running"
 * counts one attempt. Returns a new Plan; the input is not mutated.
 */
export function setTaskStatus(
  plan: Plan,
  id: string,
  status: TaskStatus,
  now?: number,
): Plan {
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(
      `Invalid status "${status}" (expected: ${TASK_STATUSES.join(", ")})`,
    );
  }
  const task = requireTask(plan, id);

  if (status === "ready" || status === "running") {
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    const unmet = task.dependsOn.filter((dep) => byId.get(dep)!.status !== "done");
    if (unmet.length > 0) {
      throw new Error(
        `Task "${id}" cannot be ${status}: unmet dependencies: ${unmet.join(", ")}`,
      );
    }
  }

  const attempts =
    status === "running" && task.status !== "running"
      ? task.attempts + 1
      : task.attempts;

  const tasks = plan.tasks.map((t) =>
    t.id === id ? { ...t, status, attempts } : t,
  );
  return {
    ...plan,
    tasks: resolveReady(tasks),
    updatedAt: now ?? Date.now(),
  };
}

/**
 * Append follow-up tasks to an existing plan. New tasks may depend on
 * existing or new tasks; the combined graph is re-validated. Returns a new
 * Plan; the input is not mutated.
 */
export function addTasks(
  plan: Plan,
  inputs: PlanTaskInput[],
  options: PlanOptions = {},
): Plan {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("addTasks needs at least one task");
  }

  const built = inputs.map((input) => buildTask(input, options));
  const seen = new Set(plan.tasks.map((t) => t.id));
  for (const task of built) {
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    seen.add(task.id);
  }

  const tasks = [...plan.tasks, ...built];
  validateGraph(tasks);
  return {
    ...plan,
    tasks: resolveReady(tasks),
    updatedAt: options.now ?? Date.now(),
  };
}

/**
 * Edit one task's brief, agent, dependencies, or criteria. Structure changes
 * re-validate the whole graph. Status and attempts are not editable here —
 * use setTaskStatus. Returns a new Plan; the input is not mutated.
 */
export function updateTask(
  plan: Plan,
  id: string,
  patch: PlanTaskPatch,
  options: PlanOptions = {},
): Plan {
  const task = requireTask(plan, id);

  const merged: PlanTaskInput = {
    id: task.id,
    title: patch.title !== undefined ? patch.title : task.title,
    description:
      patch.description !== undefined ? patch.description : task.description,
    dependsOn: patch.dependsOn !== undefined ? patch.dependsOn : task.dependsOn,
    agent: patch.agent !== undefined ? patch.agent : task.agent,
    criteria: patch.criteria !== undefined ? patch.criteria : task.criteria,
  };
  const rebuilt = buildTask(merged, options);
  const updated: PlanTask = {
    ...rebuilt,
    status: task.status,
    attempts: task.attempts,
  };

  const tasks = plan.tasks.map((t) => (t.id === id ? updated : t));
  validateGraph(tasks);
  return {
    ...plan,
    tasks: resolveReady(tasks),
    updatedAt: options.now ?? Date.now(),
  };
}

/**
 * Reset every "running" task back to "ready". Used on session restart:
 * sub-agent children do not survive the parent process, so in-flight work is
 * re-dispatched idempotently. Returns the reset task ids alongside the plan.
 */
export function resetRunningTasks(
  plan: Plan,
  now?: number,
): { plan: Plan; reset: string[] } {
  const reset = plan.tasks.filter((t) => t.status === "running").map((t) => t.id);
  if (reset.length === 0) return { plan, reset };
  const tasks = plan.tasks.map((t) =>
    t.status === "running" ? { ...t, status: "ready" as TaskStatus } : t,
  );
  return {
    plan: { ...plan, tasks: resolveReady(tasks), updatedAt: now ?? Date.now() },
    reset,
  };
}

export interface PlanSummary {
  goal: string;
  total: number;
  counts: Record<TaskStatus, number>;
  /** Ids dispatchable right now. */
  ready: string[];
  /** Pending ids that can never become ready because a (transitive) dependency failed. */
  blocked: string[];
  /** Failed ids — each one blocks plan completion. */
  blockers: string[];
  /** Longest dependency chain in the DAG, in execution order. */
  criticalPath: string[];
  /** Every task is done. */
  complete: boolean;
  /** Not complete, and nothing is ready, running, or in review — the DAG cannot advance without plan repair. */
  stalled: boolean;
}

function longestChain(plan: Plan): string[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const memo = new Map<string, string[]>();

  const chainTo = (task: PlanTask): string[] => {
    const cached = memo.get(task.id);
    if (cached) return cached;
    let best: string[] = [];
    for (const dep of task.dependsOn) {
      const chain = chainTo(byId.get(dep)!);
      if (chain.length > best.length) best = chain;
    }
    const result = [...best, task.id];
    memo.set(task.id, result);
    return result;
  };

  let best: string[] = [];
  for (const task of plan.tasks) {
    const chain = chainTo(task);
    if (chain.length > best.length) best = chain;
  }
  return best;
}

export function summarizePlan(plan: Plan): PlanSummary {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));

  const counts: Record<TaskStatus, number> = {
    pending: 0,
    ready: 0,
    running: 0,
    review: 0,
    done: 0,
    failed: 0,
  };
  for (const task of plan.tasks) counts[task.status]++;

  const failedDep = new Map<string, boolean>();
  const hasFailedDep = (task: PlanTask): boolean => {
    const cached = failedDep.get(task.id);
    if (cached !== undefined) return cached;
    failedDep.set(task.id, false); // acyclic, but stay safe on revisits
    const result = task.dependsOn.some((dep) => {
      const depTask = byId.get(dep)!;
      return depTask.status === "failed" || hasFailedDep(depTask);
    });
    failedDep.set(task.id, result);
    return result;
  };

  const complete = counts.done === plan.tasks.length;
  return {
    goal: plan.goal,
    total: plan.tasks.length,
    counts,
    ready: plan.tasks.filter((t) => t.status === "ready").map((t) => t.id),
    blocked: plan.tasks
      .filter((t) => t.status === "pending" && hasFailedDep(t))
      .map((t) => t.id),
    blockers: plan.tasks.filter((t) => t.status === "failed").map((t) => t.id),
    criticalPath: longestChain(plan),
    complete,
    stalled:
      !complete &&
      counts.ready === 0 &&
      counts.running === 0 &&
      counts.review === 0,
  };
}

/** One-line status suitable for a footer/status bar. */
export function statusLine(plan: Plan): string {
  const s = summarizePlan(plan);
  if (s.complete) {
    return `planner: complete — ${s.counts.done}/${s.total} tasks done`;
  }
  if (s.stalled) {
    return `planner: stalled — ${s.blockers.length} failed (${s.counts.done}/${s.total} done)`;
  }
  const parts = [`${s.counts.done}/${s.total} done`];
  if (s.counts.running > 0) parts.push(`${s.counts.running} running`);
  if (s.counts.review > 0) parts.push(`${s.counts.review} in review`);
  if (s.counts.ready > 0) parts.push(`${s.counts.ready} ready`);
  if (s.blockers.length > 0) parts.push(`${s.blockers.length} failed`);
  return `planner: ${parts.join(", ")}`;
}
