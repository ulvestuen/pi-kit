import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createLoop, recordCheckpoint } from "../lykkja/loop.ts";
import type { TaskResult } from "../fleet/runner.ts";
import type { ReviewResult } from "../critic/review.ts";
import {
  createPlan,
  getTask,
  summarizePlan,
  type Plan,
  type PlanTaskInput,
} from "../planner/plan.ts";
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
