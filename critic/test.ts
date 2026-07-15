import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  buildAdvisePrompt,
  buildCriticPrompt,
  parseCriticOutput,
  type ReviewRequest,
} from "./review.ts";

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    subject: "the diff in src/parser.ts",
    context: "add duration parsing",
    criteria: [
      { name: "tests pass", threshold: 8 },
      { name: "handles empty input", threshold: 9 },
    ],
    scaleMax: 10,
    ...overrides,
  };
}

function reply(scores: unknown): string {
  return [
    "I inspected the files.",
    "```json",
    JSON.stringify({ scores }),
    "```",
  ].join("\n");
}

describe("buildCriticPrompt", () => {
  it("includes subject, context, rubric with thresholds, and JSON instructions", () => {
    const prompt = buildCriticPrompt(request());
    assert.match(prompt, /SUBJECT:\n(.|\n)*src\/parser\.ts/);
    assert.match(prompt, /CONTEXT:\n(.|\n)*duration parsing/);
    assert.match(prompt, /"tests pass" \(passing threshold: 8\/10\)/);
    assert.match(prompt, /"handles empty input" \(passing threshold: 9\/10\)/);
    assert.match(prompt, /exactly one fenced JSON block/);
    assert.match(prompt, /1\.\.10/);
  });

  it("omits the context section when absent", () => {
    const prompt = buildCriticPrompt(request({ context: undefined }));
    assert.doesNotMatch(prompt, /CONTEXT:/);
  });

  it("omits the artifacts section when absent", () => {
    const prompt = buildCriticPrompt(request({ artifacts: undefined }));
    assert.doesNotMatch(prompt, /PREREQUISITE ARTIFACTS/);
  });

  it("includes prerequisite artifacts in the evidence section", () => {
    const prompt = buildCriticPrompt(
      request({
        artifacts: [
          { type: "branch", id: "feat-a", description: "feature branch", location: "fleet/task-1-100" },
          { type: "summary", id: "review", description: "review summary" },
        ],
      }),
    );
    assert.match(prompt, /PREREQUISITE ARTIFACTS/);
    assert.match(prompt, /branch: feature branch at fleet\/task-1-100/);
    assert.match(prompt, /summary: review summary/);
  });

  it("omits artifacts section when array is empty", () => {
    const prompt = buildCriticPrompt(request({ artifacts: [] }));
    assert.doesNotMatch(prompt, /PREREQUISITE ARTIFACTS/);
  });

  it("rejects empty subjects and rubrics", () => {
    assert.throws(() => buildCriticPrompt(request({ subject: " " })), /subject/);
    assert.throws(
      () => buildCriticPrompt(request({ criteria: [] })),
      /at least one criterion/,
    );
  });
});

describe("buildAdvisePrompt", () => {
  it("asks for prioritized concerns, not scores", () => {
    const prompt = buildAdvisePrompt({ subject: "the plan", context: "ctx" });
    assert.match(prompt, /prioritized list of concerns/);
    assert.match(prompt, /do not produce scores/);
    assert.match(prompt, /SUBJECT:\n(.|\n)*the plan/);
  });

  it("rejects an empty subject", () => {
    assert.throws(() => buildAdvisePrompt({ subject: "" }), /subject/);
  });
});

describe("parseCriticOutput", () => {
  it("parses a well-formed fenced verdict", () => {
    const review = parseCriticOutput(
      reply([
        { name: "tests pass", score: 9 },
        { name: "handles empty input", score: 10 },
      ]),
      request(),
    );
    assert.strictEqual(review.passed, true);
    assert.deepStrictEqual(review.weaknesses, []);
    assert.deepStrictEqual(review.scores, [
      { name: "tests pass", score: 9, weakness: undefined },
      { name: "handles empty input", score: 10, weakness: undefined },
    ]);
  });

  it("fails when a criterion is below threshold, with prioritized weaknesses", () => {
    const review = parseCriticOutput(
      reply([
        { name: "tests pass", score: 7, weakness: "two tests fail" },
        { name: "handles empty input", score: 5, weakness: "throws on ''" },
      ]),
      request(),
    );
    assert.strictEqual(review.passed, false);
    // "handles empty input" misses by 4, "tests pass" by 1 — worst first.
    assert.deepStrictEqual(review.weaknesses, [
      "handles empty input: throws on ''",
      "tests pass: two tests fail",
    ]);
  });

  it("uses the last fenced JSON block (the verdict comes last)", () => {
    const text = [
      "```json",
      JSON.stringify({ scores: [{ name: "tests pass", score: 1 }] }),
      "```",
      "wait, correcting after a second look:",
      reply([
        { name: "tests pass", score: 9 },
        { name: "handles empty input", score: 9 },
      ]),
    ].join("\n");
    const review = parseCriticOutput(text, request());
    assert.strictEqual(review.passed, true);
  });

  it("accepts a bare unfenced JSON object", () => {
    const review = parseCriticOutput(
      JSON.stringify({
        scores: [
          { name: "tests pass", score: 8 },
          { name: "handles empty input", score: 9 },
        ],
      }),
      request(),
    );
    assert.strictEqual(review.passed, true);
  });

  it("matches criterion names case-insensitively and returns canonical names", () => {
    const review = parseCriticOutput(
      reply([
        { name: "TESTS PASS", score: 8 },
        { name: " Handles Empty Input ", score: 9 },
      ]),
      request(),
    );
    assert.strictEqual(review.passed, true);
    assert.strictEqual(review.scores[0].name, "tests pass");
  });

  it("clamps out-of-range scores", () => {
    const review = parseCriticOutput(
      reply([
        { name: "tests pass", score: 99 },
        { name: "handles empty input", score: -3, weakness: "w" },
      ]),
      request(),
    );
    assert.strictEqual(review.scores[0].score, 10);
    assert.strictEqual(review.scores[1].score, 1);
    assert.strictEqual(review.passed, false);
  });

  it("fails loudly when no JSON block is found", () => {
    const review = parseCriticOutput("looks great, ship it!", request());
    assert.strictEqual(review.passed, false);
    assert.deepStrictEqual(review.scores, []);
    assert.match(review.weaknesses[0], /unscorable output/);
    assert.strictEqual(review.raw, "looks great, ship it!");
  });

  it("fails loudly on malformed JSON", () => {
    const review = parseCriticOutput("```json\n{scores: oops}\n```", request());
    assert.strictEqual(review.passed, false);
    assert.match(review.weaknesses[0], /unscorable output/);
  });

  it("fails loudly when a criterion is not scored", () => {
    const review = parseCriticOutput(
      reply([{ name: "tests pass", score: 9 }]),
      request(),
    );
    assert.strictEqual(review.passed, false);
    assert.match(review.weaknesses[0], /criteria not scored: handles empty input/);
  });

  it("ignores unknown extra criteria as long as the rubric is covered", () => {
    const review = parseCriticOutput(
      reply([
        { name: "tests pass", score: 9 },
        { name: "handles empty input", score: 9 },
        { name: "invented extra", score: 1 },
      ]),
      request(),
    );
    assert.strictEqual(review.passed, true);
    assert.strictEqual(review.scores.length, 2);
  });

  it("fails entries with non-numeric scores as unscored criteria", () => {
    const review = parseCriticOutput(
      reply([
        { name: "tests pass", score: "high" },
        { name: "handles empty input", score: 9 },
      ]),
      request(),
    );
    assert.strictEqual(review.passed, false);
    assert.match(review.weaknesses[0], /criteria not scored: tests pass/);
  });

  it("synthesizes a weakness note when the critic omits one below threshold", () => {
    const review = parseCriticOutput(
      reply([
        { name: "tests pass", score: 5 },
        { name: "handles empty input", score: 9 },
      ]),
      request(),
    );
    assert.match(review.weaknesses[0], /tests pass: scored 5\/8/);
  });
});
