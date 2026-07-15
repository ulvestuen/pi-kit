import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  addTasks,
  createPlan,
  getTask,
  readySet,
  setTaskStatus,
  statusLine,
  summarizePlan,
  updateTask,
  type PlanTaskInput,
} from "./plan.ts";
import type { ArtifactRef } from "@pi-kit/agent-types";

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

/** t1 -> t2 -> t4, t1 -> t3 -> t4 diamond. */
function diamond() {
  return createPlan(
    "ship the feature",
    [
      task("t1"),
      task("t2", { dependsOn: ["t1"] }),
      task("t3", { dependsOn: ["t1"] }),
      task("t4", { dependsOn: ["t2", "t3"] }),
    ],
    { now: 1000 },
  );
}

describe("createPlan", () => {
  it("creates a validated plan with pending tasks", () => {
    const plan = diamond();
    assert.strictEqual(plan.goal, "ship the feature");
    assert.strictEqual(plan.tasks.length, 4);
    assert.ok(plan.tasks.every((t) => t.status === "pending"));
    assert.ok(plan.tasks.every((t) => t.attempts === 0));
    assert.strictEqual(plan.createdAt, 1000);
  });

  it("normalizes criteria with lykkja semantics", () => {
    const plan = createPlan("g", [
      task("t1", { criteria: ["a", { name: "b", threshold: 9 }] }),
    ]);
    assert.deepStrictEqual(getTask(plan, "t1")!.criteria, [
      { name: "a", threshold: 8 },
      { name: "b", threshold: 9 },
    ]);
  });

  it("rejects an empty goal", () => {
    assert.throws(() => createPlan("  ", [task("t1")]), /goal must not be empty/);
  });

  it("rejects an empty task list", () => {
    assert.throws(() => createPlan("g", []), /at least one task/);
  });

  it("rejects duplicate ids case-insensitively", () => {
    assert.throws(
      () => createPlan("g", [task("T1"), task("t1")]),
      /Duplicate task id/,
    );
  });

  it("rejects dangling dependencies", () => {
    assert.throws(
      () => createPlan("g", [task("t1", { dependsOn: ["missing"] })]),
      /unknown task "missing"/,
    );
  });

  it("rejects self-dependencies", () => {
    assert.throws(
      () => createPlan("g", [task("t1", { dependsOn: ["t1"] })]),
      /depends on itself/,
    );
  });

  it("rejects cycles", () => {
    assert.throws(
      () =>
        createPlan("g", [
          task("t1", { dependsOn: ["t3"] }),
          task("t2", { dependsOn: ["t1"] }),
          task("t3", { dependsOn: ["t2"] }),
        ]),
      /dependency cycle: t1, t2, t3/,
    );
  });

  it("rejects tasks without criteria", () => {
    assert.throws(
      () => createPlan("g", [task("t1", { criteria: [] })]),
      /At least one/,
    );
  });

  it("rejects blank titles and descriptions", () => {
    assert.throws(() => createPlan("g", [task("t1", { title: " " })]), /title/);
    assert.throws(
      () => createPlan("g", [task("t1", { description: " " })]),
      /description/,
    );
  });
});

describe("readySet", () => {
  it("returns only tasks whose dependencies are all done", () => {
    let plan = diamond();
    assert.deepStrictEqual(readySet(plan).map((t) => t.id), ["t1"]);

    plan = setTaskStatus(plan, "t1", "done");
    assert.deepStrictEqual(readySet(plan).map((t) => t.id), ["t2", "t3"]);

    plan = setTaskStatus(plan, "t2", "done");
    assert.deepStrictEqual(readySet(plan).map((t) => t.id), ["t3"]);

    plan = setTaskStatus(plan, "t3", "done");
    assert.deepStrictEqual(readySet(plan).map((t) => t.id), ["t4"]);
  });

  it("excludes running, review, done, and failed tasks", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "t1", "running");
    assert.deepStrictEqual(readySet(plan), []);
    plan = setTaskStatus(plan, "t1", "review");
    assert.deepStrictEqual(readySet(plan), []);
    plan = setTaskStatus(plan, "t1", "failed");
    assert.deepStrictEqual(readySet(plan), []);
  });

  it("includes tasks explicitly marked ready", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "t1", "ready");
    assert.deepStrictEqual(readySet(plan).map((t) => t.id), ["t1"]);
  });
});

describe("setTaskStatus", () => {
  it("returns a new plan without mutating the old one", () => {
    const plan = diamond();
    const next = setTaskStatus(plan, "t1", "running", 2000);
    assert.strictEqual(plan.tasks[0].status, "pending");
    assert.strictEqual(next.tasks[0].status, "running");
    assert.strictEqual(next.updatedAt, 2000);
  });

  it("counts dispatches as attempts", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "t1", "running");
    assert.strictEqual(getTask(plan, "t1")!.attempts, 1);
    plan = setTaskStatus(plan, "t1", "ready");
    plan = setTaskStatus(plan, "t1", "running");
    assert.strictEqual(getTask(plan, "t1")!.attempts, 2);
  });

  it("does not double-count staying in running", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "t1", "running");
    plan = setTaskStatus(plan, "t1", "running");
    assert.strictEqual(getTask(plan, "t1")!.attempts, 1);
  });

  it("rejects unknown task ids", () => {
    assert.throws(() => setTaskStatus(diamond(), "zzz", "done"), /Unknown task/);
  });

  it("rejects invalid statuses", () => {
    assert.throws(
      () => setTaskStatus(diamond(), "t1", "paused" as any),
      /Invalid task status/,
    );
  });
});

describe("updateTask", () => {
  it("edits briefs, agents, and criteria", () => {
    let plan = diamond();
    plan = updateTask(plan, "t1", {
      description: "new brief",
      agent: "scout",
      criteria: [{ name: "strict", threshold: 9 }],
    });
    const t1 = getTask(plan, "t1")!;
    assert.strictEqual(t1.description, "new brief");
    assert.strictEqual(t1.agent, "scout");
    assert.deepStrictEqual(t1.criteria, [{ name: "strict", threshold: 9 }]);
  });

  it("rejects blanking required fields", () => {
    assert.throws(
      () => updateTask(diamond(), "t1", { description: "  " }),
      /description/,
    );
  });
});

describe("addTasks", () => {
  it("appends follow-up tasks and re-validates the DAG", () => {
    const plan = addTasks(diamond(), [task("t5", { dependsOn: ["t4"] })]);
    assert.strictEqual(plan.tasks.length, 5);
    assert.deepStrictEqual(getTask(plan, "t5")!.dependsOn, ["t4"]);
  });

  it("rejects follow-ups that collide or dangle", () => {
    assert.throws(() => addTasks(diamond(), [task("t1")]), /Duplicate/);
    assert.throws(
      () => addTasks(diamond(), [task("t9", { dependsOn: ["nope"] })]),
      /unknown task/,
    );
  });
});

describe("summarizePlan", () => {
  it("counts statuses and computes the ready set", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "t1", "done");
    plan = setTaskStatus(plan, "t2", "running");
    const s = summarizePlan(plan);
    assert.strictEqual(s.total, 4);
    assert.strictEqual(s.counts.done, 1);
    assert.strictEqual(s.counts.running, 1);
    assert.strictEqual(s.counts.pending, 2);
    assert.deepStrictEqual(s.ready, ["t3"]);
    assert.deepStrictEqual(s.blocked, []);
    assert.strictEqual(s.done, false);
  });

  it("reports transitive blockage behind failed tasks", () => {
    let plan = diamond();
    plan = setTaskStatus(plan, "t1", "done");
    plan = setTaskStatus(plan, "t2", "failed");
    const s = summarizePlan(plan);
    assert.deepStrictEqual(s.blocked, ["t4"]);
  });

  it("computes the critical path over unfinished tasks", () => {
    let plan = diamond();
    assert.strictEqual(summarizePlan(plan).criticalPathLength, 3);
    plan = setTaskStatus(plan, "t1", "done");
    assert.strictEqual(summarizePlan(plan).criticalPathLength, 2);
    for (const id of ["t2", "t3", "t4"]) plan = setTaskStatus(plan, id, "done");
    const s = summarizePlan(plan);
    assert.strictEqual(s.criticalPathLength, 0);
    assert.strictEqual(s.done, true);
  });
});

describe("statusLine", () => {
  it("summarizes progress for the footer", () => {
    let plan = diamond();
    assert.strictEqual(statusLine(plan), "plan: 0/4 done");
    plan = setTaskStatus(plan, "t1", "done");
    plan = setTaskStatus(plan, "t2", "running");
    plan = setTaskStatus(plan, "t3", "failed");
    assert.strictEqual(
      statusLine(plan),
      "plan: 1/4 done, 1 running, 1 failed",
    );
  });

  it("reports completion", () => {
    let plan = createPlan("g", [task("t1")]);
    plan = setTaskStatus(plan, "t1", "done");
    assert.strictEqual(statusLine(plan), "plan: complete (1/1 done)");
  });
});

// ---------------------------------------------------------------------------
// Artifacts on PlanTask
// ---------------------------------------------------------------------------

describe("PlanTask.artifacts", () => {
  it("tasks are created with an empty artifacts array", () => {
    const plan = createPlan("g", [task("t1")]);
    const t1 = getTask(plan, "t1")!;
    assert.deepStrictEqual(t1.artifacts, []);
  });

  it("artifacts survive createPlan → getTask round-trip", () => {
    const plan = createPlan("g", [task("t1")]);
    const arts: ArtifactRef[] = [
      { type: "branch", id: "feat-a", description: "feature branch", location: "fleet/task-1-100" },
      { type: "summary", id: "review", description: "review summary" },
    ];
    const updated = updateTask(plan, "t1", { artifacts: arts });
    const t1 = getTask(updated, "t1")!;
    assert.strictEqual(t1.artifacts.length, 2);
    assert.strictEqual(t1.artifacts[0].type, "branch");
    assert.strictEqual(t1.artifacts[0].location, "fleet/task-1-100");
  });

  it("artifacts survive JSON round-trip", () => {
    const plan = createPlan("g", [task("t1")]);
    const arts: ArtifactRef[] = [
      { type: "path", id: "file", description: "output file", location: "/tmp/out" },
    ];
    const updated = updateTask(plan, "t1", { artifacts: arts });
    const json = JSON.stringify(updated);
    const restored = JSON.parse(json);
    const t1 = getTask(restored, "t1")!;
    assert.deepStrictEqual(t1.artifacts, arts);
  });

  it("status transitions preserve artifacts", () => {
    let plan = createPlan("g", [task("t1")]);
    const arts: ArtifactRef[] = [
      { type: "commit", id: "abc", description: "commit" },
    ];
    plan = updateTask(plan, "t1", { artifacts: arts });
    plan = setTaskStatus(plan, "t1", "ready");
    plan = setTaskStatus(plan, "t1", "running");
    plan = setTaskStatus(plan, "t1", "done");
    assert.deepStrictEqual(getTask(plan, "t1")!.artifacts, arts);
  });
});

// ---------------------------------------------------------------------------
// Transition soft-check: warns on illegal transitions
// ---------------------------------------------------------------------------

describe("setTaskStatus transition soft-check", () => {
  it("does not warn on legal transitions", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(" "));
    try {
      let plan = createPlan("g", [task("t1")]);
      plan = setTaskStatus(plan, "t1", "ready");
      plan = setTaskStatus(plan, "t1", "running");
      plan = setTaskStatus(plan, "t1", "review");
      plan = setTaskStatus(plan, "t1", "done");
      assert.strictEqual(warnings.length, 0);
    } finally {
      console.warn = origWarn;
    }
  });

  it("warns on illegal transition running → done", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(" "));
    try {
      let plan = createPlan("g", [task("t1")]);
      plan = setTaskStatus(plan, "t1", "ready");
      plan = setTaskStatus(plan, "t1", "running");
      // running → done is illegal
      plan = setTaskStatus(plan, "t1", "done");
      assert.ok(warnings.length >= 1);
      assert.match(warnings[0], /running.*done/);
      assert.match(warnings[0], /t1/);
      // The transition still succeeds (manual override)
      assert.strictEqual(getTask(plan, "t1")!.status, "done");
    } finally {
      console.warn = origWarn;
    }
  });

  it("warns on illegal transition done → ready", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(" "));
    try {
      let plan = createPlan("g", [task("t1")]);
      plan = setTaskStatus(plan, "t1", "ready");
      plan = setTaskStatus(plan, "t1", "done");
      // done → ready is illegal
      plan = setTaskStatus(plan, "t1", "ready");
      assert.ok(warnings.length >= 1);
      assert.match(warnings[0], /done.*ready/);
    } finally {
      console.warn = origWarn;
    }
  });

  it("warns on illegal transition failed → ready", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(" "));
    try {
      let plan = createPlan("g", [task("t1")]);
      plan = setTaskStatus(plan, "t1", "ready");
      plan = setTaskStatus(plan, "t1", "failed");
      // failed → ready is illegal
      plan = setTaskStatus(plan, "t1", "ready");
      assert.ok(warnings.length >= 1);
      assert.match(warnings[0], /failed.*ready/);
    } finally {
      console.warn = origWarn;
    }
  });
});
