import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  addTasks,
  createPlan,
  readySet,
  resetRunningTasks,
  setTaskStatus,
  statusLine,
  summarizePlan,
  updateTask,
  type Plan,
  type PlanTaskInput,
} from "./plan.ts";

function task(
  id: string,
  overrides: Partial<PlanTaskInput> = {},
): PlanTaskInput {
  return {
    id,
    title: `Task ${id}`,
    description: `Do the work for ${id}`,
    criteria: ["works"],
    ...overrides,
  };
}

/** a ← b ← d, a ← c ← d  (diamond: d depends on b and c, both depend on a). */
function diamond(): Plan {
  return createPlan(
    "Ship the feature",
    [
      task("a"),
      task("b", { dependsOn: ["a"] }),
      task("c", { dependsOn: ["a"] }),
      task("d", { dependsOn: ["b", "c"] }),
    ],
    { now: 1000 },
  );
}

function statusOf(plan: Plan, id: string) {
  return plan.tasks.find((t) => t.id === id)!.status;
}

describe("createPlan validation", () => {
  it("creates a valid plan with trimmed fields", () => {
    const plan = createPlan(
      "  Ship it  ",
      [task(" a ", { title: "  T  ", description: "  D  " })],
      { now: 42 },
    );
    assert.strictEqual(plan.goal, "Ship it");
    assert.strictEqual(plan.tasks[0].id, "a");
    assert.strictEqual(plan.tasks[0].title, "T");
    assert.strictEqual(plan.tasks[0].description, "D");
    assert.strictEqual(plan.createdAt, 42);
    assert.strictEqual(plan.updatedAt, 42);
  });

  it("rejects an empty goal", () => {
    assert.throws(() => createPlan("  ", [task("a")]), /goal must not be empty/);
  });

  it("rejects an empty task list", () => {
    assert.throws(() => createPlan("g", []), /at least one task/);
  });

  it("rejects duplicate task ids", () => {
    assert.throws(
      () => createPlan("g", [task("a"), task("a")]),
      /Duplicate task id: a/,
    );
  });

  it("rejects non-slug ids", () => {
    assert.throws(
      () => createPlan("g", [task("a task!")]),
      /must be a slug/,
    );
  });

  it("rejects empty titles and descriptions", () => {
    assert.throws(
      () => createPlan("g", [task("a", { title: " " })]),
      /must have a title/,
    );
    assert.throws(
      () => createPlan("g", [task("a", { description: "" })]),
      /must have a description/,
    );
  });

  it("rejects a task without criteria, naming the task", () => {
    assert.throws(
      () => createPlan("g", [task("a", { criteria: [] })]),
      /Task "a": At least one success criterion/,
    );
  });

  it("rejects invalid criterion thresholds through lykkja's validation", () => {
    assert.throws(
      () =>
        createPlan("g", [
          task("a", { criteria: [{ name: "x", threshold: 99 }] }),
        ]),
      /Task "a": .*between 1 and 10/,
    );
  });

  it("rejects dangling dependencies", () => {
    assert.throws(
      () => createPlan("g", [task("a", { dependsOn: ["ghost"] })]),
      /depends on unknown task "ghost"/,
    );
  });

  it("rejects self-dependencies", () => {
    assert.throws(
      () => createPlan("g", [task("a", { dependsOn: ["a"] })]),
      /must not depend on itself/,
    );
  });

  it("rejects two-task cycles and reports the path", () => {
    assert.throws(
      () =>
        createPlan("g", [
          task("a", { dependsOn: ["b"] }),
          task("b", { dependsOn: ["a"] }),
        ]),
      /Dependency cycle: (a -> b -> a|b -> a -> b)/,
    );
  });

  it("rejects longer cycles buried in a bigger graph", () => {
    assert.throws(
      () =>
        createPlan("g", [
          task("root"),
          task("a", { dependsOn: ["root", "c"] }),
          task("b", { dependsOn: ["a"] }),
          task("c", { dependsOn: ["b"] }),
        ]),
      /Dependency cycle/,
    );
  });

  it("rejects empty dependency ids", () => {
    assert.throws(
      () => createPlan("g", [task("a", { dependsOn: [" "] })]),
      /empty dependency id/,
    );
  });

  it("dedupes repeated dependencies", () => {
    const plan = createPlan("g", [task("a"), task("b", { dependsOn: ["a", "a"] })]);
    assert.deepStrictEqual(plan.tasks[1].dependsOn, ["a"]);
  });

  it("normalizes criteria with the default threshold and per-criterion overrides", () => {
    const plan = createPlan(
      "g",
      [task("a", { criteria: ["x", { name: "y", threshold: 9 }] })],
      { defaultThreshold: 7 },
    );
    assert.deepStrictEqual(plan.tasks[0].criteria, [
      { name: "x", threshold: 7 },
      { name: "y", threshold: 9 },
    ]);
  });

  it("drops a blank agent and keeps a named one", () => {
    const plan = createPlan("g", [
      task("a", { agent: "  " }),
      task("b", { agent: "scout" }),
    ]);
    assert.strictEqual(plan.tasks[0].agent, undefined);
    assert.strictEqual(plan.tasks[1].agent, "scout");
  });
});

describe("ready-set resolution", () => {
  it("marks dependency-free tasks ready and dependent tasks pending", () => {
    const plan = diamond();
    assert.strictEqual(statusOf(plan, "a"), "ready");
    assert.strictEqual(statusOf(plan, "b"), "pending");
    assert.strictEqual(statusOf(plan, "c"), "pending");
    assert.strictEqual(statusOf(plan, "d"), "pending");
    assert.deepStrictEqual(readySet(plan).map((t) => t.id), ["a"]);
  });

  it("promotes dependents when all their dependencies are done", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "done", 2000);
    assert.deepStrictEqual(readySet(plan).map((t) => t.id), ["b", "c"]);
    assert.strictEqual(statusOf(plan, "d"), "pending");

    plan = setTaskStatus(plan, "b", "done", 3000);
    assert.strictEqual(statusOf(plan, "d"), "pending");
    plan = setTaskStatus(plan, "c", "done", 4000);
    assert.deepStrictEqual(readySet(plan).map((t) => t.id), ["d"]);
  });

  it("demotes a ready task if its dependency stops being done", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "done");
    assert.strictEqual(statusOf(plan, "b"), "ready");
    plan = setTaskStatus(plan, "a", "review");
    assert.strictEqual(statusOf(plan, "b"), "pending");
  });
});

describe("setTaskStatus", () => {
  it("rejects unknown task ids", () => {
    assert.throws(() => setTaskStatus(diamond(), "nope", "done"), /Unknown task id "nope"/);
  });

  it("rejects unknown statuses", () => {
    assert.throws(
      () => setTaskStatus(diamond(), "a", "paused" as never),
      /Invalid status "paused"/,
    );
  });

  it("refuses to run or ready a task with unmet dependencies", () => {
    const plan = diamond();
    assert.throws(
      () => setTaskStatus(plan, "d", "running"),
      /cannot be running: unmet dependencies: b, c/,
    );
    assert.throws(
      () => setTaskStatus(plan, "b", "ready"),
      /cannot be ready: unmet dependencies: a/,
    );
  });

  it("counts an attempt on each transition into running", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "running");
    assert.strictEqual(plan.tasks[0].attempts, 1);
    plan = setTaskStatus(plan, "a", "review");
    plan = setTaskStatus(plan, "a", "running"); // re-dispatch after review
    assert.strictEqual(plan.tasks[0].attempts, 2);
  });

  it("does not double-count running -> running", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "running");
    plan = setTaskStatus(plan, "a", "running");
    assert.strictEqual(plan.tasks[0].attempts, 1);
  });

  it("does not mutate the input plan", () => {
    const plan = diamond();
    setTaskStatus(plan, "a", "done");
    assert.strictEqual(statusOf(plan, "a"), "ready");
    assert.strictEqual(statusOf(plan, "b"), "pending");
  });

  it("bumps updatedAt", () => {
    const plan = setTaskStatus(diamond(), "a", "done", 9999);
    assert.strictEqual(plan.updatedAt, 9999);
    assert.strictEqual(plan.createdAt, 1000);
  });
});

describe("addTasks", () => {
  it("appends follow-up tasks that may depend on existing tasks", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "done");
    plan = addTasks(plan, [task("e", { dependsOn: ["a"] })], { now: 5000 });
    assert.strictEqual(plan.tasks.length, 5);
    assert.strictEqual(statusOf(plan, "e"), "ready"); // dep already done
    assert.strictEqual(plan.updatedAt, 5000);
  });

  it("lets new tasks depend on each other", () => {
    const plan = addTasks(diamond(), [
      task("e"),
      task("f", { dependsOn: ["e"] }),
    ]);
    assert.strictEqual(statusOf(plan, "e"), "ready");
    assert.strictEqual(statusOf(plan, "f"), "pending");
  });

  it("rejects an empty input list", () => {
    assert.throws(() => addTasks(diamond(), []), /at least one task/);
  });

  it("rejects id collisions with existing tasks", () => {
    assert.throws(() => addTasks(diamond(), [task("a")]), /Duplicate task id: a/);
  });

  it("rejects cycles introduced across the combined graph", () => {
    assert.throws(
      () =>
        addTasks(diamond(), [
          task("e", { dependsOn: ["f"] }),
          task("f", { dependsOn: ["e"] }),
        ]),
      /Dependency cycle/,
    );
  });

  it("rejects dangling dependencies in new tasks", () => {
    assert.throws(
      () => addTasks(diamond(), [task("e", { dependsOn: ["ghost"] })]),
      /unknown task "ghost"/,
    );
  });

  it("does not mutate the input plan", () => {
    const plan = diamond();
    addTasks(plan, [task("e")]);
    assert.strictEqual(plan.tasks.length, 4);
  });
});

describe("updateTask", () => {
  it("edits the brief without touching status or attempts", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "running");
    plan = updateTask(plan, "a", { description: "New brief with feedback" });
    const a = plan.tasks.find((t) => t.id === "a")!;
    assert.strictEqual(a.description, "New brief with feedback");
    assert.strictEqual(a.status, "running");
    assert.strictEqual(a.attempts, 1);
  });

  it("re-resolves readiness when dependencies change", () => {
    let plan = diamond();
    plan = updateTask(plan, "b", { dependsOn: [] });
    assert.strictEqual(statusOf(plan, "b"), "ready");
  });

  it("rejects dependency edits that create a cycle", () => {
    assert.throws(
      () => updateTask(diamond(), "a", { dependsOn: ["d"] }),
      /Dependency cycle/,
    );
  });

  it("rejects dependency edits that dangle", () => {
    assert.throws(
      () => updateTask(diamond(), "a", { dependsOn: ["ghost"] }),
      /unknown task "ghost"/,
    );
  });

  it("renormalizes criteria edits", () => {
    const plan = updateTask(
      diamond(),
      "a",
      { criteria: [{ name: "strict", threshold: 10 }] },
      { defaultThreshold: 8 },
    );
    assert.deepStrictEqual(plan.tasks[0].criteria, [
      { name: "strict", threshold: 10 },
    ]);
  });

  it("clears the agent with an empty string", () => {
    let plan = createPlan("g", [task("a", { agent: "scout" })]);
    plan = updateTask(plan, "a", { agent: "" });
    assert.strictEqual(plan.tasks[0].agent, undefined);
  });

  it("rejects unknown task ids", () => {
    assert.throws(() => updateTask(diamond(), "nope", { title: "x" }), /Unknown task id/);
  });

  it("rejects blanking required fields", () => {
    assert.throws(() => updateTask(diamond(), "a", { title: " " }), /must have a title/);
  });
});

describe("resetRunningTasks", () => {
  it("resets running tasks to ready and reports them", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "running");
    const { plan: reconciled, reset } = resetRunningTasks(plan, 7777);
    assert.deepStrictEqual(reset, ["a"]);
    assert.strictEqual(statusOf(reconciled, "a"), "ready");
    assert.strictEqual(reconciled.updatedAt, 7777);
    // Attempts are preserved — the re-dispatch will count the next one.
    assert.strictEqual(reconciled.tasks[0].attempts, 1);
  });

  it("is a no-op when nothing is running", () => {
    const plan = diamond();
    const { plan: same, reset } = resetRunningTasks(plan);
    assert.strictEqual(same, plan);
    assert.deepStrictEqual(reset, []);
  });
});

describe("summarizePlan", () => {
  it("counts statuses and lists the ready set", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "done");
    const s = summarizePlan(plan);
    assert.strictEqual(s.total, 4);
    assert.strictEqual(s.counts.done, 1);
    assert.strictEqual(s.counts.ready, 2);
    assert.strictEqual(s.counts.pending, 1);
    assert.deepStrictEqual(s.ready, ["b", "c"]);
    assert.strictEqual(s.complete, false);
    assert.strictEqual(s.stalled, false);
  });

  it("computes the critical path as the longest dependency chain", () => {
    const s = summarizePlan(diamond());
    assert.strictEqual(s.criticalPath.length, 3);
    assert.strictEqual(s.criticalPath[0], "a");
    assert.strictEqual(s.criticalPath[2], "d");
    assert.match(s.criticalPath[1], /^(b|c)$/);
  });

  it("reports failed blockers and transitively blocked tasks", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "done");
    plan = setTaskStatus(plan, "b", "failed");
    const s = summarizePlan(plan);
    assert.deepStrictEqual(s.blockers, ["b"]);
    assert.deepStrictEqual(s.blocked, ["d"]);
    assert.strictEqual(s.stalled, false); // c is still ready
  });

  it("reports stalled when nothing can advance", () => {
    let plan = createPlan("g", [task("a"), task("b", { dependsOn: ["a"] })]);
    plan = setTaskStatus(plan, "a", "failed");
    const s = summarizePlan(plan);
    assert.strictEqual(s.stalled, true);
    assert.deepStrictEqual(s.blocked, ["b"]);
  });

  it("reports complete when every task is done", () => {
    let plan = createPlan("g", [task("a")]);
    plan = setTaskStatus(plan, "a", "done");
    const s = summarizePlan(plan);
    assert.strictEqual(s.complete, true);
    assert.strictEqual(s.stalled, false);
  });
});

describe("statusLine", () => {
  it("summarizes a fresh plan", () => {
    assert.strictEqual(statusLine(diamond()), "planner: 0/4 done, 1 ready");
  });

  it("mentions running, review, and failures", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "a", "done");
    plan = setTaskStatus(plan, "b", "running");
    plan = setTaskStatus(plan, "c", "failed");
    assert.strictEqual(
      statusLine(plan),
      "planner: 1/4 done, 1 running, 1 failed",
    );
    plan = setTaskStatus(plan, "b", "review");
    assert.strictEqual(
      statusLine(plan),
      "planner: 1/4 done, 1 in review, 1 failed",
    );
  });

  it("reports completion", () => {
    let plan = createPlan("g", [task("a")]);
    plan = setTaskStatus(plan, "a", "done");
    assert.strictEqual(statusLine(plan), "planner: complete — 1/1 tasks done");
  });

  it("reports a stalled plan", () => {
    let plan = createPlan("g", [task("a"), task("b", { dependsOn: ["a"] })]);
    plan = setTaskStatus(plan, "a", "failed");
    assert.strictEqual(statusLine(plan), "planner: stalled — 1 failed (0/2 done)");
  });
});
