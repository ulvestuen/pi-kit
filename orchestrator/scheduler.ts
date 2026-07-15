/**
 * orchestrator scheduler — pure, deterministic state machine over the
 * planner's plan model (the "loop.ts" of this extension).
 *
 * Hard control flow (waves, retries, stops) lives here in code; judgment
 * (decomposition, scoring, plan repair) stays with the models. Imports only
 * pure cores: planner/plan.ts types and functions, fleet/runner.ts and
 * critic/review.ts result shapes.
 */

import type { TaskResult } from "../fleet/runner.ts";
import type { ReviewResult } from "../critic/review.ts";
import {
  getTask,
  readySet,
  setTaskStatus,
  updateTask,
  type Plan,
  type PlanTask,
} from "../planner/plan.ts";

export const DEFAULT_MAX_ATTEMPTS = 2;

export interface SchedulerPolicy {
  /** Dispatch-wave width, forwarded to the fleet runner. */
  maxConcurrent: number;
  /** Per-task dispatch cap; a task failing review at the cap goes "failed". */
  maxAttempts: number;
}

export interface DispatchDecision {
  /** Ready tasks to send to fleet now (bounded by free capacity). */
  dispatch: PlanTask[];
  /** Completed tasks awaiting the critic's verdict. */
  reviews: PlanTask[];
  /** blocked = a failed task blocks the rest of the DAG. */
  terminal: "running" | "complete" | "blocked";
}

function validatePolicy(policy: SchedulerPolicy): void {
  if (!Number.isFinite(policy.maxConcurrent) || policy.maxConcurrent < 1) {
    throw new Error(
      `maxConcurrent must be at least 1 (got: ${policy.maxConcurrent})`,
    );
  }
  if (!Number.isFinite(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error(
      `maxAttempts must be at least 1 (got: ${policy.maxAttempts})`,
    );
  }
}

/** Compute what to do next: which tasks to dispatch, review, or whether the
 * run is complete/blocked. Pure — does not modify the plan. */
export function nextActions(
  plan: Plan,
  policy: SchedulerPolicy,
): DispatchDecision {
  validatePolicy(policy);

  const reviews = plan.tasks.filter((t) => t.status === "review");
  const running = plan.tasks.filter((t) => t.status === "running").length;
  const capacity = Math.max(0, policy.maxConcurrent - running);
  const dispatch = readySet(plan).slice(0, capacity);

  const doneCount = plan.tasks.filter((t) => t.status === "done").length;
  let terminal: DispatchDecision["terminal"];
  if (doneCount === plan.tasks.length) {
    terminal = "complete";
  } else if (dispatch.length === 0 && reviews.length === 0 && running === 0) {
    // Nothing can move: every remaining task is failed or waiting on one.
    terminal = "blocked";
  } else {
    terminal = "running";
  }

  return { dispatch, reviews, terminal };
}

/** Mark a task dispatched: status "running", which counts the attempt.
 * Promotes pending → ready first so the lifecycle matches the ADR's
 * transition table (pending → ready → running) without triggering a warning. */
export function setPlanTaskRunning(plan: Plan, id: string): Plan {
  const task = getTask(plan, id);
  if (!task) throw new Error(`Unknown task id: ${id}`);
  let p = plan;
  if (task.status === "pending") {
    p = setTaskStatus(p, id, "ready");
  }
  return setTaskStatus(p, id, "running");
}

/**
 * Fold one fleet TaskResult into the plan.
 * ok → "review" (awaiting the critic); anything else is a failed attempt —
 * retried while attempts < maxAttempts, otherwise "failed".
 */
export function applyTaskResult(
  plan: Plan,
  id: string,
  result: TaskResult,
  policy: SchedulerPolicy,
): Plan {
  validatePolicy(policy);
  const task = getTask(plan, id);
  if (!task) {
    throw new Error(`Unknown task id: ${id}`);
  }

  if (result.status === "ok") {
    return setTaskStatus(plan, id, "review");
  }

  const failureNote =
    `Attempt ${task.attempts} ${result.status}: ` +
    `${result.output.trim() || "(no output)"}`;
  const withNote = updateTask(plan, id, {
    description: `${task.description}\n\n[${failureNote}]`,
  });
  return setTaskStatus(
    withNote,
    id,
    task.attempts < policy.maxAttempts ? "ready" : "failed",
  );
}

/**
 * Fold one critic ReviewResult into the plan.
 * pass → done; fail with attempts < maxAttempts → ready again with the
 * critic's weaknesses appended to the brief; otherwise failed.
 */
export function applyReview(
  plan: Plan,
  id: string,
  review: ReviewResult,
  policy: SchedulerPolicy,
): Plan {
  validatePolicy(policy);
  const task = getTask(plan, id);
  if (!task) {
    throw new Error(`Unknown task id: ${id}`);
  }
  if (task.status !== "review") {
    throw new Error(
      `Task "${id}" is ${task.status}, not awaiting review`,
    );
  }

  if (review.passed) {
    return setTaskStatus(plan, id, "done");
  }

  const weaknesses =
    review.weaknesses.length > 0
      ? review.weaknesses.map((w) => `- ${w}`).join("\n")
      : "- (no weaknesses stated)";
  const feedback =
    `Review of attempt ${task.attempts} FAILED. ` +
    `Fix these weaknesses, worst first:\n${weaknesses}`;
  const withFeedback = updateTask(plan, id, {
    description: `${task.description}\n\n[${feedback}]`,
  });
  return setTaskStatus(
    withFeedback,
    id,
    task.attempts < policy.maxAttempts ? "ready" : "failed",
  );
}
