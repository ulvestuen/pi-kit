import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  clampScore,
  createLoop,
  failingScores,
  normalizeCriteria,
  recordCheckpoint,
  statusLine,
  summarizeLoop,
  type LoopState,
} from "./loop.ts";

function newLoop(overrides: Partial<Parameters<typeof createLoop>[0]> = {}) {
  return createLoop({
    task: "Build a JSON parser",
    criteria: ["tests pass", "no type errors", "handles empty input"],
    now: 1000,
    ...overrides,
  });
}

function passingScores(state: LoopState) {
  return state.criteria.map((c) => ({ name: c.name, score: c.threshold }));
}

describe("normalizeCriteria", () => {
  it("accepts bare string names with the default threshold", () => {
    const criteria = normalizeCriteria(["a", "b"], 8, 10);
    assert.deepStrictEqual(criteria, [
      { name: "a", threshold: 8 },
      { name: "b", threshold: 8 },
    ]);
  });

  it("accepts per-criterion thresholds", () => {
    const criteria = normalizeCriteria(
      [{ name: "a", threshold: 9 }, "b"],
      7,
      10,
    );
    assert.deepStrictEqual(criteria, [
      { name: "a", threshold: 9 },
      { name: "b", threshold: 7 },
    ]);
  });

  it("trims names", () => {
    assert.strictEqual(normalizeCriteria(["  a  "], 8, 10)[0].name, "a");
  });

  it("rejects empty input", () => {
    assert.throws(() => normalizeCriteria([], 8, 10), /At least one/);
  });

  it("rejects blank names", () => {
    assert.throws(() => normalizeCriteria(["   "], 8, 10), /must not be empty/);
  });

  it("rejects duplicate names case-insensitively", () => {
    assert.throws(() => normalizeCriteria(["A", "a"], 8, 10), /Duplicate/);
  });

  it("rejects thresholds above the scale", () => {
    assert.throws(
      () => normalizeCriteria([{ name: "a", threshold: 11 }], 8, 10),
      /between 1 and 10/,
    );
  });

  it("rejects thresholds below 1", () => {
    assert.throws(
      () => normalizeCriteria([{ name: "a", threshold: 0 }], 8, 10),
      /between 1 and 10/,
    );
  });
});

describe("clampScore", () => {
  it("rounds to the nearest integer", () => {
    assert.strictEqual(clampScore(7.4, 10), 7);
    assert.strictEqual(clampScore(7.6, 10), 8);
  });

  it("clamps below 1 up to 1", () => {
    assert.strictEqual(clampScore(-5, 10), 1);
    assert.strictEqual(clampScore(0, 10), 1);
  });

  it("clamps above the scale down to the scale", () => {
    assert.strictEqual(clampScore(99, 10), 10);
  });

  it("rejects non-finite scores", () => {
    assert.throws(() => clampScore(NaN, 10), /finite number/);
  });
});

describe("createLoop", () => {
  it("starts active with no iterations", () => {
    const loop = newLoop();
    assert.strictEqual(loop.status, "active");
    assert.strictEqual(loop.iterations.length, 0);
    assert.strictEqual(loop.passThreshold, 8);
    assert.strictEqual(loop.scaleMax, 10);
    assert.strictEqual(loop.criteria.length, 3);
  });

  it("applies a custom pass threshold to bare criteria", () => {
    const loop = newLoop({ passThreshold: 9 });
    assert.ok(loop.criteria.every((c) => c.threshold === 9));
  });

  it("rejects an empty task", () => {
    assert.throws(() => newLoop({ task: "   " }), /task must not be empty/);
  });

  it("rejects a pass threshold above the scale", () => {
    assert.throws(
      () => newLoop({ passThreshold: 20, scaleMax: 10 }),
      /between 1 and 10/,
    );
  });

  it("rejects a scale below 2", () => {
    assert.throws(() => newLoop({ scaleMax: 1 }), /at least 2/);
  });
});

describe("recordCheckpoint", () => {
  it("returns FINAL when every criterion meets its threshold", () => {
    const loop = newLoop();
    const { decision } = recordCheckpoint(loop, {
      plan: "implement parser",
      changes: "added parse() and tests",
      scores: passingScores(loop),
      now: 2000,
    });
    assert.strictEqual(decision.verdict, "FINAL");
    assert.strictEqual(decision.passed, true);
    assert.strictEqual(decision.weakest, null);
    assert.strictEqual(loop.status, "final");
    assert.strictEqual(loop.iterations.length, 1);
  });

  it("returns ITERATING and names the weakest failing criterion", () => {
    const loop = newLoop();
    const { decision } = recordCheckpoint(loop, {
      plan: "first cut",
      changes: "rough parser",
      scores: [
        { name: "tests pass", score: 9 },
        { name: "no type errors", score: 5, weakness: "two any casts" },
        { name: "handles empty input", score: 7, weakness: "throws on ''" },
      ],
      now: 2000,
    });
    assert.strictEqual(decision.verdict, "ITERATING");
    assert.strictEqual(decision.passed, false);
    // "no type errors" has the largest negative margin (5-8 = -3).
    assert.strictEqual(decision.weakest, "no type errors");
    assert.strictEqual(decision.failing.length, 2);
    assert.strictEqual(loop.status, "active");
  });

  it("orders failing criteria by smallest margin first", () => {
    const loop = newLoop();
    const { decision } = recordCheckpoint(loop, {
      plan: "p",
      changes: "c",
      scores: [
        { name: "tests pass", score: 7, weakness: "x" },
        { name: "no type errors", score: 2, weakness: "y" },
        { name: "handles empty input", score: 6, weakness: "z" },
      ],
    });
    assert.deepStrictEqual(
      decision.failing.map((f) => f.name),
      ["no type errors", "handles empty input", "tests pass"],
    );
  });

  it("matches score names to criteria case-insensitively", () => {
    const loop = newLoop();
    const { decision } = recordCheckpoint(loop, {
      plan: "p",
      changes: "c",
      scores: [
        { name: "TESTS PASS", score: 8 },
        { name: "No Type Errors", score: 8 },
        { name: "handles empty input", score: 8 },
      ],
    });
    assert.strictEqual(decision.verdict, "FINAL");
  });

  it("clamps out-of-range scores", () => {
    const loop = newLoop();
    const { decision } = recordCheckpoint(loop, {
      plan: "p",
      changes: "c",
      scores: [
        { name: "tests pass", score: 100 },
        { name: "no type errors", score: 100 },
        { name: "handles empty input", score: 100 },
      ],
    });
    assert.strictEqual(decision.verdict, "FINAL");
    assert.ok(loop.iterations[0].scores.every((s) => s.score === 10));
  });

  it("rejects missing scores", () => {
    const loop = newLoop();
    assert.throws(
      () =>
        recordCheckpoint(loop, {
          plan: "p",
          changes: "c",
          scores: [{ name: "tests pass", score: 8 }],
        }),
      /Missing scores for/,
    );
  });

  it("rejects unknown criteria", () => {
    const loop = newLoop();
    assert.throws(
      () =>
        recordCheckpoint(loop, {
          plan: "p",
          changes: "c",
          scores: [
            ...passingScores(loop),
            { name: "made up", score: 8 },
          ],
        }),
      /Unknown criteria/,
    );
  });

  it("rejects duplicate scores for the same criterion", () => {
    const loop = newLoop();
    assert.throws(
      () =>
        recordCheckpoint(loop, {
          plan: "p",
          changes: "c",
          scores: [
            { name: "tests pass", score: 8 },
            { name: "tests pass", score: 9 },
            { name: "no type errors", score: 8 },
            { name: "handles empty input", score: 8 },
          ],
        }),
      /Duplicate score/,
    );
  });

  it("rejects an empty plan", () => {
    const loop = newLoop();
    assert.throws(
      () =>
        recordCheckpoint(loop, {
          plan: "  ",
          changes: "c",
          scores: passingScores(loop),
        }),
      /plan .* must not be empty/,
    );
  });

  it("rejects an empty changes summary", () => {
    const loop = newLoop();
    assert.throws(
      () =>
        recordCheckpoint(loop, {
          plan: "p",
          changes: "",
          scores: passingScores(loop),
        }),
      /changes .* must not be empty/,
    );
  });

  it("refuses to continue a finished loop", () => {
    const loop = newLoop();
    recordCheckpoint(loop, {
      plan: "p",
      changes: "c",
      scores: passingScores(loop),
    });
    assert.throws(
      () =>
        recordCheckpoint(loop, {
          plan: "p",
          changes: "c",
          scores: passingScores(loop),
        }),
      /Loop is final/,
    );
  });

  it("stops at the iteration safety limit", () => {
    const loop = newLoop({ maxIterations: 2 });
    const failing = () => ({
      plan: "p",
      changes: "c",
      scores: [
        { name: "tests pass", score: 3, weakness: "w" },
        { name: "no type errors", score: 3, weakness: "w" },
        { name: "handles empty input", score: 3, weakness: "w" },
      ],
    });
    const first = recordCheckpoint(loop, failing());
    assert.strictEqual(first.decision.verdict, "ITERATING");
    const second = recordCheckpoint(loop, failing());
    assert.strictEqual(second.decision.verdict, "STOPPED");
    assert.strictEqual(loop.status, "stopped");
  });

  it("accumulates iteration history across passes", () => {
    const loop = newLoop();
    recordCheckpoint(loop, {
      plan: "pass 1",
      changes: "c1",
      scores: [
        { name: "tests pass", score: 5, weakness: "w" },
        { name: "no type errors", score: 9 },
        { name: "handles empty input", score: 9 },
      ],
    });
    recordCheckpoint(loop, {
      plan: "pass 2",
      changes: "c2",
      scores: passingScores(loop),
    });
    assert.strictEqual(loop.iterations.length, 2);
    assert.strictEqual(loop.iterations[0].index, 1);
    assert.strictEqual(loop.iterations[1].index, 2);
    assert.strictEqual(loop.status, "final");
  });
});

describe("failingScores", () => {
  it("returns only criteria below threshold", () => {
    const loop = newLoop();
    const failing = failingScores(loop, [
      { name: "tests pass", score: 8 },
      { name: "no type errors", score: 4 },
      { name: "handles empty input", score: 8 },
    ]);
    assert.deepStrictEqual(
      failing.map((f) => f.name),
      ["no type errors"],
    );
  });
});

describe("summarizeLoop / statusLine", () => {
  it("summarizes a fresh loop", () => {
    const loop = newLoop();
    const s = summarizeLoop(loop);
    assert.strictEqual(s.iterationCount, 0);
    assert.strictEqual(s.latest, undefined);
    assert.match(statusLine(loop), /pass 1/);
  });

  it("reports the weakest criterion in the status line while iterating", () => {
    const loop = newLoop();
    recordCheckpoint(loop, {
      plan: "p",
      changes: "c",
      scores: [
        { name: "tests pass", score: 4, weakness: "w" },
        { name: "no type errors", score: 9 },
        { name: "handles empty input", score: 9 },
      ],
    });
    assert.match(statusLine(loop), /fix "tests pass"/);
  });

  it("reports FINAL in the status line when done", () => {
    const loop = newLoop();
    recordCheckpoint(loop, {
      plan: "p",
      changes: "c",
      scores: passingScores(loop),
    });
    assert.match(statusLine(loop), /FINAL/);
  });
});
