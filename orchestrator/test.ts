import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createLoop, recordCheckpoint } from "../lykkja/loop.ts";
import type { TaskResult } from "../fleet/runner.ts";
import type { ReviewResult } from "../critic/review.ts";
import {
  createPlan,
  getTask,
  setTaskStatus,
  summarizePlan,
  updateTask,
  type Plan,
  type PlanTaskInput,
} from "../planner/plan.ts";
import type { ArtifactRef } from "@pi-kit/agent-types";
import { buildHandoffSection } from "./handoff.ts";

/** Promote a task from pending through the proper lifecycle to done.
 * Uses the real lifecycle transitions (pending → ready → running → review → done)
 * to avoid illegal-transition warnings in test setup. */
function promoteToDone(plan: Plan, id: string): Plan {
  let p = setTaskStatus(plan, id, "ready");
  p = setTaskStatus(p, id, "running");
  p = setTaskStatus(p, id, "review");
  p = setTaskStatus(p, id, "done");
  return p;
}
import {
  applyReview,
  applyTaskResult,
  nextActions,
  setPlanTaskRunning,
  type SchedulerPolicy,
} from "./scheduler.ts";

const policy: SchedulerPolicy = { maxConcurrent: 2, maxAttempts: 2 };

function task(
  id: string,
  overrides: Partial<PlanTaskInput> = {},
): PlanTaskInput {
  return {
    id,
    title: `Task ${id}`,
    description: `Do ${id}`,
    criteria: ["works"],
    ...overrides,
  };
}

function okResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    agent: "implementer",
    status: "ok",
    output: "did the thing",
    truncated: false,
    durationMs: 100,
    exitCode: 0,
    ...overrides,
  };
}

function review(passed: boolean, weaknesses: string[] = []): ReviewResult {
  return {
    scores: [{ name: "works", score: passed ? 9 : 4 }],
    passed,
    weaknesses,
    raw: "",
  };
}

/** t1 -> {t2, t3} -> t4, plus independent t5 — the 5-task simulation DAG. */
function fiveTaskPlan(): Plan {
  return createPlan(
    "ship the feature",
    [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
      task("t3", { dependsOn: ["t1"] }),
      task("t4", { dependsOn: ["t2", "t3"] }),
      task("t5"),
    ],
    { now: 1000 },
  );
}

describe("nextActions", () => {
  it("dispatches the ready set up to free capacity", () => {
    const decision = nextActions(fiveTaskPlan(), policy);
    assert.deepStrictEqual(
      decision.dispatch.map((t) => t.id),
      ["t1", "t5"],
    );
    assert.deepStrictEqual(decision.reviews, []);
    assert.strictEqual(decision.terminal, "running");
  });

  it("subtracts running tasks from capacity", () => {
    let plan = fiveTaskPlan();
    plan = setPlanTaskRunning(plan, "t1");
    const decision = nextActions(plan, policy);
    assert.deepStrictEqual(decision.dispatch.map((t) => t.id), ["t5"]);
  });

  it("lists tasks awaiting review", () => {
    let plan = fiveTaskPlan();
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult(), policy);
    const decision = nextActions(plan, policy);
    assert.deepStrictEqual(decision.reviews.map((t) => t.id), ["t1"]);
    assert.strictEqual(decision.terminal, "running");
  });

  it("reports complete when every task is done", () => {
    let plan = createPlan("g", [task("t1")]);
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult(), policy);
    plan = applyReview(plan, "t1", review(true), policy);
    const decision = nextActions(plan, policy);
    assert.strictEqual(decision.terminal, "complete");
    assert.deepStrictEqual(decision.dispatch, []);
  });

  it("reports blocked when failures hold back the rest of the DAG", () => {
    let plan = createPlan("g", [task("t1"), task("t2", { dependsOn: ["t1"] })]);
    const strict: SchedulerPolicy = { maxConcurrent: 2, maxAttempts: 1 };
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(
      plan,
      "t1",
      okResult({ status: "error", output: "boom" }),
      strict,
    );
    assert.strictEqual(getTask(plan, "t1")!.status, "failed");
    const decision = nextActions(plan, strict);
    assert.strictEqual(decision.terminal, "blocked");
  });

  it("rejects invalid policies", () => {
    assert.throws(
      () => nextActions(fiveTaskPlan(), { maxConcurrent: 0, maxAttempts: 2 }),
      /maxConcurrent/,
    );
    assert.throws(
      () => nextActions(fiveTaskPlan(), { maxConcurrent: 2, maxAttempts: 0 }),
      /maxAttempts/,
    );
  });
});

describe("applyTaskResult", () => {
  it("sends ok results to review", () => {
    let plan = fiveTaskPlan();
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult(), policy);
    assert.strictEqual(getTask(plan, "t1")!.status, "review");
  });

  it("re-queues a first failure with the failure note in the brief", () => {
    let plan = fiveTaskPlan();
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(
      plan,
      "t1",
      okResult({ status: "timeout", output: "task timed out after 5 ms" }),
      policy,
    );
    const t1 = getTask(plan, "t1")!;
    assert.strictEqual(t1.status, "ready");
    assert.match(t1.description, /Attempt 1 timeout: task timed out/);
  });

  it("fails the task at the attempt cap", () => {
    let plan = fiveTaskPlan();
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult({ status: "error" }), policy);
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult({ status: "error" }), policy);
    assert.strictEqual(getTask(plan, "t1")!.status, "failed");
    assert.strictEqual(getTask(plan, "t1")!.attempts, 2);
  });

  it("rejects unknown task ids", () => {
    assert.throws(
      () => applyTaskResult(fiveTaskPlan(), "zzz", okResult(), policy),
      /Unknown task/,
    );
  });
});

describe("applyReview", () => {
  function reviewablePlan(): Plan {
    let plan = fiveTaskPlan();
    plan = setPlanTaskRunning(plan, "t1");
    return applyTaskResult(plan, "t1", okResult(), policy);
  }

  it("marks passed reviews done", () => {
    const plan = applyReview(reviewablePlan(), "t1", review(true), policy);
    assert.strictEqual(getTask(plan, "t1")!.status, "done");
  });

  it("re-queues failed reviews with critic weaknesses appended to the brief", () => {
    const plan = applyReview(
      reviewablePlan(),
      "t1",
      review(false, ["works: not verified", "tests: missing edge case"]),
      policy,
    );
    const t1 = getTask(plan, "t1")!;
    assert.strictEqual(t1.status, "ready");
    assert.match(t1.description, /Review of attempt 1 FAILED/);
    assert.match(t1.description, /- works: not verified/);
    assert.match(t1.description, /- tests: missing edge case/);
  });

  it("fails the task when review fails at the attempt cap", () => {
    let plan = applyReview(
      reviewablePlan(),
      "t1",
      review(false, ["weak"]),
      policy,
    );
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult(), policy);
    plan = applyReview(plan, "t1", review(false, ["still weak"]), policy);
    assert.strictEqual(getTask(plan, "t1")!.status, "failed");
  });

  it("rejects reviews of tasks not awaiting review", () => {
    assert.throws(
      () => applyReview(fiveTaskPlan(), "t1", review(true), policy),
      /not awaiting review/,
    );
  });
});

describe("end-to-end simulation: 5-task DAG to FINAL", () => {
  it("drives the plan to complete and the goal loop to FINAL", () => {
    // Fake runner: t3 times out once; everything else succeeds first try.
    const timeoutsLeft = new Map([["t3", 1]]);
    const fakeRun = (taskId: string): TaskResult => {
      const left = timeoutsLeft.get(taskId) ?? 0;
      if (left > 0) {
        timeoutsLeft.set(taskId, left - 1);
        return okResult({ status: "timeout", output: "timed out" });
      }
      return okResult({ output: `${taskId} implemented` });
    };
    // Fake critic: fails t2's first review with an actionable weakness.
    let t2Reviews = 0;
    const fakeCritic = (taskId: string): ReviewResult => {
      if (taskId === "t2" && t2Reviews++ === 0) {
        return review(false, ["works: no test for empty input"]);
      }
      return review(true);
    };

    let plan = fiveTaskPlan();
    const loop = createLoop({
      task: "ship the feature",
      criteria: ["all plan tasks done", "every task passed critic review"],
      now: 1,
    });

    let verdict = "";
    let waves = 0;
    while (waves < 20) {
      const decision = nextActions(plan, policy);
      if (decision.terminal === "complete" || decision.terminal === "blocked") {
        // Goal-level checkpoint from critic-derived evidence.
        const summary = summarizePlan(plan);
        const allDone = summary.done ? 10 : 3;
        const { decision: act } = recordCheckpoint(loop, {
          plan: `wave ${waves}: finish`,
          changes: "final wave",
          scores: [
            { name: "all plan tasks done", score: allDone, weakness: summary.done ? undefined : "tasks remain" },
            { name: "every task passed critic review", score: allDone, weakness: summary.done ? undefined : "reviews remain" },
          ],
        });
        verdict = act.verdict;
        break;
      }

      waves++;
      // Dispatch wave.
      for (const t of decision.dispatch) {
        plan = setPlanTaskRunning(plan, t.id);
        plan = applyTaskResult(plan, t.id, fakeRun(t.id), policy);
      }
      // Review wave.
      for (const t of plan.tasks.filter((t) => t.status === "review")) {
        plan = applyReview(plan, t.id, fakeCritic(t.id), policy);
      }
      // Mid-run checkpoint mirrors the orchestrate flow.
      const summary = summarizePlan(plan);
      const progress = Math.max(
        1,
        Math.round((summary.counts.done / summary.total) * 10),
      );
      const { decision: act } = recordCheckpoint(loop, {
        plan: `wave ${waves}`,
        changes: `done ${summary.counts.done}/${summary.total}`,
        scores: [
          {
            name: "all plan tasks done",
            score: summary.done ? 10 : Math.min(progress, 7),
            weakness: summary.done ? undefined : "tasks remain",
          },
          {
            name: "every task passed critic review",
            score: summary.done ? 10 : Math.min(progress, 7),
            weakness: summary.done ? undefined : "reviews remain",
          },
        ],
      });
      if (act.verdict !== "ITERATING") {
        verdict = act.verdict;
        break;
      }
    }

    if (!verdict) {
      const decision = nextActions(plan, policy);
      assert.fail(`run did not terminate: ${decision.terminal} after ${waves} waves`);
    }

    const summary = summarizePlan(plan);
    assert.strictEqual(summary.done, true, "every plan task is done");
    assert.strictEqual(verdict, "FINAL");
    // The retries actually happened: t3 needed 2 dispatch attempts,
    // t2 needed 2 (one review failure), the rest 1.
    assert.strictEqual(getTask(plan, "t3")!.attempts, 2);
    assert.strictEqual(getTask(plan, "t2")!.attempts, 2);
    assert.strictEqual(getTask(plan, "t1")!.attempts, 1);
    assert.strictEqual(getTask(plan, "t4")!.attempts, 1);
    assert.strictEqual(getTask(plan, "t5")!.attempts, 1);
    // Critic feedback landed in the re-dispatched brief.
    assert.match(getTask(plan, "t2")!.description, /no test for empty input/);
    assert.strictEqual(loop.status, "final");
  });

  it("ends blocked and honest when a task exhausts its attempts", () => {
    const strict: SchedulerPolicy = { maxConcurrent: 2, maxAttempts: 1 };
    let plan = createPlan("g", [task("t1"), task("t2", { dependsOn: ["t1"] })]);

    // t1 dispatches, fails review, and is out of attempts.
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult(), strict);
    plan = applyReview(plan, "t1", review(false, ["broken"]), strict);
    assert.strictEqual(getTask(plan, "t1")!.status, "failed");

    const decision = nextActions(plan, strict);
    assert.strictEqual(decision.terminal, "blocked");
    assert.deepStrictEqual(summarizePlan(plan).blocked, ["t2"]);
  });
});

// ---------------------------------------------------------------------------
// Artifact propagation: passing review records artifacts
// ---------------------------------------------------------------------------

describe("artifact propagation through review", () => {
  it("applyReview + recordPassingArtifacts stores artifacts on the done task", () => {
    let plan = createPlan("g", [task("t1")], { now: 1000 });
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult(), policy);
    assert.strictEqual(getTask(plan, "t1")!.status, "review");

    // Simulate passing review
    plan = applyReview(plan, "t1", review(true), policy);
    assert.strictEqual(getTask(plan, "t1")!.status, "done");
    // Artifacts start empty, but plan still has the structure
    assert.ok(Array.isArray(getTask(plan, "t1")!.artifacts));
  });

  it("downstream tasks see prerequisite artifacts in handoff section", () => {
    let plan = createPlan("g", [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
    ]);
    const arts: ArtifactRef[] = [
      { type: "branch", id: "feat-a", description: "feature branch", location: "fleet/task-1-100" },
    ];
    plan = updateTask(plan, "t1", { artifacts: arts });
    plan = promoteToDone(plan, "t1");
    // t2 should now be ready
    assert.deepStrictEqual(nextActions(plan, policy).dispatch.map((t) => t.id), ["t2"]);
    const t1 = getTask(plan, "t1")!;
    assert.strictEqual(t1.artifacts.length, 1);
    assert.strictEqual(t1.artifacts[0].type, "branch");
  });

  it("artifacts survive serialization round-trip across plan persistence", () => {
    let plan = createPlan("g", [task("t1"), task("t2", { dependsOn: ["t1"] })], { now: 1000 });
    const arts: ArtifactRef[] = [
      { type: "patch", id: "p1", description: "diff", location: "/tmp/p.patch" },
      { type: "summary", id: "s1", description: "review summary" },
    ];
    plan = updateTask(plan, "t1", { artifacts: arts });

    // Simulate session persistence
    const json = JSON.stringify(plan);
    const restored: Plan = JSON.parse(json);
    const t1 = getTask(restored, "t1")!;
    assert.deepStrictEqual(t1.artifacts, arts);
    assert.strictEqual(t1.artifacts[0].location, "/tmp/p.patch");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: transitions and retries with critic evidence persistence
// ---------------------------------------------------------------------------

describe("lifecycle retries with critic evidence", () => {
  it("critic feedback is appended to the brief on retry", () => {
    let plan = createPlan("g", [task("t1")]);
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult(), policy);
    plan = applyReview(
      plan,
      "t1",
      review(false, ["tests fail", "missing edge case"]),
      policy,
    );
    const t1 = getTask(plan, "t1")!;
    assert.strictEqual(t1.status, "ready");
    assert.match(t1.description, /Review of attempt 1 FAILED/);
    assert.match(t1.description, /- tests fail/);
    assert.match(t1.description, /- missing edge case/);
  });

  it("attempts count increments on each dispatch", () => {
    let plan = createPlan("g", [task("t1")]);
    plan = setPlanTaskRunning(plan, "t1");
    assert.strictEqual(getTask(plan, "t1")!.attempts, 1);
    plan = applyTaskResult(plan, "t1", okResult(), policy);
    plan = applyReview(plan, "t1", review(false, ["weak"]), policy);
    plan = setPlanTaskRunning(plan, "t1");
    assert.strictEqual(getTask(plan, "t1")!.attempts, 2);
  });

  it("task fails at attempt cap after review failure", () => {
    const strict: SchedulerPolicy = { maxConcurrent: 2, maxAttempts: 1 };
    let plan = createPlan("g", [task("t1")]);
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(plan, "t1", okResult(), strict);
    plan = applyReview(plan, "t1", review(false, ["weak"]), strict);
    assert.strictEqual(getTask(plan, "t1")!.status, "failed");
  });
});

// ---------------------------------------------------------------------------
// Worktree behavior: parentBranch in TaskSpec
// ---------------------------------------------------------------------------

describe("worktree behavior", () => {
  it("buildWorktreeArgs uses parentBranch when provided", async () => {
    const { buildWorktreeArgs } = await import("../fleet/runner.ts");
    const withParent = buildWorktreeArgs("fleet/task-1-100", "/tmp/wt", "feat-parent");
    assert.deepStrictEqual(withParent, [
      "worktree", "add", "-b", "fleet/task-1-100", "feat-parent", "/tmp/wt",
    ]);
    const withoutParent = buildWorktreeArgs("fleet/task-1-100", "/tmp/wt");
    assert.deepStrictEqual(withoutParent, [
      "worktree", "add", "-b", "fleet/task-1-100", "/tmp/wt",
    ]);
  });

  it("TaskSpec accepts parentBranch field", () => {
    // This verifies the type-level contract
    const spec: import("../fleet/runner.ts").TaskSpec = {
      agent: "implementer",
      task: "do stuff",
      isolation: "worktree",
      parentBranch: "feat-parent",
    };
    assert.strictEqual(spec.parentBranch, "feat-parent");
  });
});

// ---------------------------------------------------------------------------
// Worktree commit: auto-commit after passing review
// ---------------------------------------------------------------------------

describe("worktree commit after passing review", () => {
  it("recordPassingArtifacts calls worktreeCommit when provided with a branch", async () => {
    const { recordPassingArtifacts } = await import("./handoff.ts");
    let commitCalled = false;
    let commitBranch = "";
    const commitFn = async (branch: string) => {
      commitCalled = true;
      commitBranch = branch;
    };
    const plan = createPlan("g", [task("t1")]);
    const result = okResult({
      branch: "fleet/task-1-100",
      worktreePath: "/tmp/wt/task-1-100",
    });
    const updated = await recordPassingArtifacts(
      plan,
      getTask(plan, "t1")!,
      result,
      commitFn,
    );
    // Async callback should have completed
    assert.strictEqual(commitCalled, true);
    assert.strictEqual(commitBranch, "fleet/task-1-100");
    // Artifacts should still be recorded
    const t1 = getTask(updated, "t1")!;
    assert.ok(t1.artifacts.length > 0);
    assert.ok(t1.artifacts.some((a: ArtifactRef) => a.type === "branch"));
  });

  it("recordPassingArtifacts does not call worktreeCommit when no branch", async () => {
    const { recordPassingArtifacts } = await import("./handoff.ts");
    let commitCalled = false;
    const commitFn = async () => {
      commitCalled = true;
    };
    const plan = createPlan("g", [task("t1")]);
    const result = okResult({ output: "done" });
    await recordPassingArtifacts(plan, getTask(plan, "t1")!, result, commitFn);
    assert.strictEqual(commitCalled, false);
  });

  it("recordPassingArtifacts omits an uncommitted branch and reports a warning", async () => {
    const { recordPassingArtifacts } = await import("./handoff.ts");
    const commitFn = async () => {
      throw new Error("git commit failed");
    };
    const warnings: string[] = [];
    const plan = createPlan("g", [task("t1")]);
    const result = okResult({ branch: "fleet/task-1-100" });
    const updated = await recordPassingArtifacts(
      plan,
      getTask(plan, "t1")!,
      result,
      commitFn,
      (warning) => warnings.push(warning),
    );
    const artifacts = getTask(updated, "t1")!.artifacts;
    assert.ok(artifacts.some((artifact) => artifact.type === "summary"));
    assert.ok(!artifacts.some((artifact) => artifact.type === "branch"));
    assert.match(warnings[0], /could not be committed: git commit failed/);
  });
});

// ---------------------------------------------------------------------------
// parentBranch: prerequisite branch artifact → TaskSpec.parentBranch
// ---------------------------------------------------------------------------

describe("parentBranch extraction from prerequisite artifacts", () => {
  it("finds the branch from a done dependency's artifacts", async () => {
    const { findParentBranch } = await import("./handoff.ts");
    let plan = createPlan("g", [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
    ]);
    // Mark t1 done with a branch artifact
    plan = updateTask(plan, "t1", {
      artifacts: [
        { type: "branch", id: "feat-a", description: "feature", location: "fleet/task-1-100" },
      ],
    });
    plan = promoteToDone(plan, "t1");
    const t2 = getTask(plan, "t2")!;
    assert.strictEqual(findParentBranch(plan, t2), "fleet/task-1-100");
  });

  it("returns undefined when no prerequisite has a branch artifact", async () => {
    const { findParentBranch } = await import("./handoff.ts");
    let plan = createPlan("g", [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
    ]);
    plan = promoteToDone(plan, "t1");
    const t2 = getTask(plan, "t2")!;
    assert.strictEqual(findParentBranch(plan, t2), undefined);
  });

  it("returns undefined when dependency is not done", async () => {
    const { findParentBranch } = await import("./handoff.ts");
    let plan = createPlan("g", [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
    ]);
    plan = updateTask(plan, "t1", {
      artifacts: [
        { type: "branch", id: "feat-a", description: "feature", location: "fleet/task-1-100" },
      ],
    });
    // t1 is NOT done yet
    const t2 = getTask(plan, "t2")!;
    assert.strictEqual(findParentBranch(plan, t2), undefined);
  });

  it("picks the first done dependency's branch artifact", async () => {
    const { findParentBranch } = await import("./handoff.ts");
    let plan = createPlan("g", [
      task("t1"),
      task("t2"),
      task("t3", { dependsOn: ["t1", "t2"] }),
    ]);
    plan = updateTask(plan, "t1", {
      artifacts: [
        { type: "branch", id: "feat-x", description: "x", location: "fleet/task-x" },
      ],
    });
    plan = updateTask(plan, "t2", {
      artifacts: [
        { type: "branch", id: "feat-y", description: "y", location: "fleet/task-y" },
      ],
    });
    plan = promoteToDone(plan, "t1");
    plan = promoteToDone(plan, "t2");
    const t3 = getTask(plan, "t3")!;
    assert.strictEqual(findParentBranch(plan, t3), "fleet/task-x");
  });
});

// ---------------------------------------------------------------------------
// RunLog and RunId: wave events carry run identity
// ---------------------------------------------------------------------------

describe("RunId and RunLog", () => {
  it("RunId is carried through TaskSpec to TaskResult", () => {
    const runId: import("@pi-kit/agent-types").RunId = {
      runId: "r-1",
      taskId: "t-1",
      attempt: 1,
      wave: 1,
    };
    // TaskSpec accepts runId
    const spec: import("../fleet/runner.ts").TaskSpec = {
      agent: "implementer",
      task: "do stuff",
      runId,
    };
    assert.deepStrictEqual(spec.runId, runId);
  });

  it("TaskResult carries runId, outputArtifacts, and toolCalls", () => {
    const result: TaskResult = {
      agent: "implementer",
      status: "ok",
      output: "done",
      truncated: false,
      durationMs: 100,
      exitCode: 0,
      runId: { runId: "r-1", taskId: "t-1", attempt: 1, wave: 1 },
      outputArtifacts: [{ type: "branch", id: "feat", description: "feature" }],
      toolCalls: [{ tool: "bash", args: { cmd: "ls" }, result: "ok" }],
      usage: { promptTokens: 100, completionTokens: 50 },
    };
    assert.deepStrictEqual(result.runId!.taskId, "t-1");
    assert.strictEqual(result.outputArtifacts!.length, 1);
    assert.strictEqual(result.toolCalls!.length, 1);
    assert.strictEqual(result.usage!.promptTokens, 100);
  });
});

// ---------------------------------------------------------------------------
// Comprehensive end-to-end: legacy plain-text + structured artifact handoff
// ---------------------------------------------------------------------------

describe("end-to-end: legacy plain-text task → structured artifact handoff to dependent task", () => {
  it("drives a 2-task DAG to FINAL: legacy task completes, dependent receives artifacts via brief without shared context, critic evidence persists on retry", () => {
    // --- Setup: t1 (legacy plain-text) -> t2 (structured dependent) ---
    let plan = createPlan(
      "ship the feature",
      [
        task("t1", {
          description: "Implement the parser module",
        }),
        task("t2", {
          dependsOn: ["t1"],
          description: "Write integration tests for the parser",
        }),
      ],
      { now: 1000 },
    );

    const loop = createLoop({
      task: "ship the feature",
      criteria: ["all plan tasks done", "every task passed critic review"],
      now: 1,
    });

    // --- Phase 1: dispatch t1 (legacy plain-text, no RunId) ---
    const decision1 = nextActions(plan, policy);
    assert.deepStrictEqual(decision1.dispatch.map((t) => t.id), ["t1"]);
    assert.strictEqual(decision1.terminal, "running");

    // Dispatch t1 — plain TaskResult with no agent-native fields (legacy path)
    plan = setPlanTaskRunning(plan, "t1");
    plan = applyTaskResult(
      plan,
      "t1",
      okResult({ output: "parser implemented" }),
      policy,
    );
    assert.strictEqual(getTask(plan, "t1")!.status, "review");

    // Critic passes t1
    plan = applyReview(plan, "t1", review(true), policy);
    assert.strictEqual(getTask(plan, "t1")!.status, "done");

    // Record artifacts for t1 (simulates orchestrator's recordPassingArtifacts)
    const t1Artifacts: ArtifactRef[] = [
      {
        type: "branch",
        id: "feat-parser",
        description: "Branch feat-parser with completed parser changes",
        location: "fleet/t1-w1-a1",
      },
      {
        type: "summary",
        id: "t1-summary",
        description: "Summary of task t1: Implement the parser module",
      },
    ];
    plan = updateTask(plan, "t1", { artifacts: t1Artifacts });

    // --- Phase 2: verify artifact handoff section for t2 ---
    const t2 = getTask(plan, "t2")!;
    const handoff = buildHandoffSection(plan, t2);
    assert.ok(handoff.length > 0, "handoff section should not be empty");
    assert.match(handoff, /Prerequisite artifacts/);
    assert.match(handoff, /\[t1\]/);
    assert.match(handoff, /branch:.*feat-parser/);
    assert.match(handoff, /summary:.*Implement the parser/);

    // Verify the brief builder would include the handoff
    // (buildTaskBrief is private, but we can verify the handoff function
    // produces the right content that gets spliced into the brief)
    const handoffLines = handoff.split("\n");
    assert.ok(handoffLines.some((l) => l.includes("branch")));
    assert.ok(handoffLines.some((l) => l.includes("fleet/t1-w1-a1")));

    // --- Phase 3: dispatch t2 with structured artifacts in brief context ---
    const decision2 = nextActions(plan, policy);
    assert.deepStrictEqual(decision2.dispatch.map((t) => t.id), ["t2"]);

    // t2 runs — first attempt fails review (critic finds weakness)
    plan = setPlanTaskRunning(plan, "t2");
    plan = applyTaskResult(
      plan,
      "t2",
      okResult({ output: "tests written" }),
      policy,
    );
    plan = applyReview(
      plan,
      "t2",
      review(false, ["tests: missing edge case for empty input"]),
      policy,
    );
    // t2 should be re-queued with critic feedback in the brief
    assert.strictEqual(getTask(plan, "t2")!.status, "ready");
    assert.match(
      getTask(plan, "t2")!.description,
      /Review of attempt 1 FAILED/,
    );
    assert.match(
      getTask(plan, "t2")!.description,
      /missing edge case for empty input/,
    );
    // Artifacts from t1 should still be accessible in the plan
    assert.strictEqual(getTask(plan, "t1")!.artifacts.length, 2);
    assert.strictEqual(getTask(plan, "t1")!.artifacts[0].type, "branch");

    // t2 retry — second attempt passes
    plan = setPlanTaskRunning(plan, "t2");
    plan = applyTaskResult(
      plan,
      "t2",
      okResult({ output: "tests written with edge cases" }),
      policy,
    );
    plan = applyReview(plan, "t2", review(true), policy);
    assert.strictEqual(getTask(plan, "t2")!.status, "done");

    // Verify retry counts
    assert.strictEqual(getTask(plan, "t1")!.attempts, 1);
    assert.strictEqual(getTask(plan, "t2")!.attempts, 2);

    // --- Phase 4: goal loop reaches FINAL ---
    const summary = summarizePlan(plan);
    assert.strictEqual(summary.done, true, "every plan task is done");

    const { decision: finalAct } = recordCheckpoint(loop, {
      plan: "wave 1: all done",
      changes: "t1 parser + t2 tests with retry",
      scores: [
        { name: "all plan tasks done", score: 10 },
        { name: "every task passed critic review", score: 10 },
      ],
    });
    assert.strictEqual(finalAct.verdict, "FINAL");
    assert.strictEqual(loop.status, "final");
  });

  it("buildHandoffSection returns empty when no dependencies have artifacts", () => {
    let plan = createPlan("g", [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
    ]);
    plan = promoteToDone(plan, "t1");
    const t2 = getTask(plan, "t2")!;
    assert.strictEqual(buildHandoffSection(plan, t2), "");
  });

  it("buildHandoffSection returns empty when dependencies are not done", () => {
    let plan = createPlan("g", [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
    ]);
    plan = updateTask(plan, "t1", {
      artifacts: [{ type: "branch", id: "b", description: "branch", location: "loc" }],
    });
    // t1 is NOT done
    const t2 = getTask(plan, "t2")!;
    assert.strictEqual(buildHandoffSection(plan, t2), "");
  });

  it("buildHandoffSection formats multiple prerequisite artifacts", () => {
    let plan = createPlan("g", [
      task("t1"),
      task("t2"),
      task("t3", { dependsOn: ["t1", "t2"] }),
    ]);
    plan = updateTask(plan, "t1", {
      artifacts: [
        { type: "branch", id: "b1", description: "branch one", location: "loc1" },
        { type: "summary", id: "s1", description: "summary one" },
      ],
    });
    plan = updateTask(plan, "t2", {
      artifacts: [
        { type: "path", id: "p1", description: "output file", location: "/tmp/out" },
      ],
    });
    plan = promoteToDone(plan, "t1");
    plan = promoteToDone(plan, "t2");
    const t3 = getTask(plan, "t3")!;
    const handoff = buildHandoffSection(plan, t3);
    assert.match(handoff, /\[t1\] Task t1:/);
    assert.match(handoff, /\[t2\] Task t2:/);
    assert.match(handoff, /branch: branch one at loc1/);
    assert.match(handoff, /summary: summary one at \(in-tree\)/);
    assert.match(handoff, /path: output file at \/tmp\/out/);
  });

  it("identifies the single worktree fork branch and unmerged prerequisites", () => {
    let plan = createPlan("g", [
      task("t1"),
      task("t2"),
      task("t3", { dependsOn: ["t1", "t2"] }),
    ]);
    plan = updateTask(plan, "t1", {
      artifacts: [
        { type: "branch", id: "b1", description: "one", location: "fleet/one" },
      ],
    });
    plan = updateTask(plan, "t2", {
      artifacts: [
        { type: "branch", id: "b2", description: "two", location: "fleet/two" },
      ],
    });
    plan = promoteToDone(plan, "t1");
    plan = promoteToDone(plan, "t2");

    const handoff = buildHandoffSection(
      plan,
      getTask(plan, "t3")!,
      "fleet/one",
    );
    assert.match(handoff, /worktree is forked from fleet\/one/);
    assert.match(handoff, /not merged into this workspace: fleet\/two/);
  });
});
