/**
 * orchestrator handoff — pure helper functions for artifact propagation,
 * prerequisite branch extraction, and worktree commit coordination.
 *
 * Only depends on planner/plan.ts types and @pi-kit/agent-types, so it
 * can be unit-tested in isolation without the pi extension host.
 */

import type { ArtifactRef } from "@pi-kit/agent-types";
import type { TaskResult } from "../fleet/runner.ts";
import {
  getTask,
  updateTask,
  type Plan,
  type PlanTask,
} from "../planner/plan.ts";

/**
 * Build a brief section listing prerequisite artifacts from done dependencies.
 * Injected into the downstream task's brief so structured artifact handoff
 * happens through the brief text — no shared conversation context needed.
 */
export function buildHandoffSection(plan: Plan, task: PlanTask): string {
  const deps = task.dependsOn
    .map((id) => getTask(plan, id))
    .filter((t): t is PlanTask =>
      t !== undefined && t.status === "done" && t.artifacts.length > 0,
    );
  if (deps.length === 0) return "";
  const lines = ["", "Prerequisite artifacts:"];
  for (const dep of deps) {
    lines.push(`  [${dep.id}] ${dep.title}:`);
    for (const art of dep.artifacts)
      lines.push(
        `    - ${art.type}: ${art.description} at ${art.location ?? "(in-tree)"}`,
      );
  }
  return lines.join("\n");
}

/**
 * Extract the parent branch from prerequisite task branch artifacts.
 * Used by the orchestrator to create worktrees forked from the prerequisite
 * branch instead of HEAD — enabling prerequisite branch handoff.
 */
export function findParentBranch(
  plan: Plan,
  task: PlanTask,
): string | undefined {
  for (const depId of task.dependsOn) {
    const dep = getTask(plan, depId);
    if (dep && dep.status === "done") {
      const branchArt = dep.artifacts.find((a) => a.type === "branch");
      if (branchArt) return branchArt.location ?? branchArt.id;
    }
  }
  return undefined;
}

/**
 * When a task passes review, record its output artifacts in the plan.
 * In worktree mode, commit the implementer's changes first via the
 * optional worktreeCommit callback (best-effort; errors are swallowed).
 */
export async function recordPassingArtifacts(
  plan: Plan,
  task: PlanTask,
  result?: TaskResult,
  worktreeCommit?: (branch: string) => Promise<void>,
): Promise<Plan> {
  const artifacts: ArtifactRef[] = [];
  if (result?.branch) {
    artifacts.push({
      type: "branch",
      id: result.branch,
      description: `Branch ${result.branch} with completed changes`,
      location: result.branch,
    });
  }
  if (result?.worktreePath) {
    artifacts.push({
      type: "path",
      id: `${task.id}-worktree`,
      description: `Worktree path for task ${task.id}`,
      location: result.worktreePath,
    });
  }
  if (result?.outputArtifacts) {
    artifacts.push(...result.outputArtifacts);
  }
  if (result?.fullOutputPath) {
    artifacts.push({
      type: "path",
      id: `${task.id}-transcript`,
      description: `Full transcript for task ${task.id}`,
      location: result.fullOutputPath,
    });
  }
  // Always add a summary artifact
  artifacts.push({
    type: "summary",
    id: `${task.id}-summary`,
    description: `Summary of task ${task.id}: ${task.title}`,
  });

  let updated = updateTask(plan, task.id, { artifacts });
  if (worktreeCommit && result?.branch) {
    // Commit is best-effort — artifact recording is the important part.
    try {
      await worktreeCommit(result.branch);
    } catch {
      // Swallow: commit failure does not block plan progression.
    }
  }
  return updated;
}
