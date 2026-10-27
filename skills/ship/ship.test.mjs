import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractErrors, main, matcher, parseDuration, verifyUrl, watchRuns } from "./ship.mjs";

const SHA = "a".repeat(40);
const run = (id, status, conclusion = "", workflowName = "test") => ({
  databaseId: id,
  workflowName,
  status,
  conclusion,
  url: `https://github.com/o/r/actions/runs/${id}`,
  event: "push",
  attempt: 1,
});

/** Fake gh: each `run list` call returns the next snapshot; the last one repeats. */
function fakeGh(snapshots, { jobs = [], log = "" } = {}) {
  const calls = [];
  let i = 0;
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === "run" && args[1] === "list") return JSON.stringify(snapshots[Math.min(i++, snapshots.length - 1)]);
    if (args.includes("--log-failed")) return log;
    if (args[1] === "view") return JSON.stringify({ jobs });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

const FAILED_LOG = [
  "quality\tUNKNOWN STEP\t\uFEFF2026-10-25T22:21:14.9490072Z Current runner version: '2.338.0'",
  "quality\tUNKNOWN STEP\t2026-10-25T22:21:20.1Z ##[group]Run npm audit --omit=dev",
  "quality\tUNKNOWN STEP\t2026-10-25T22:21:20.2Z ^[[36;1mnpm audit --omit=dev^[[0m",
  "quality\tUNKNOWN STEP\t2026-10-25T22:21:21.0Z next  16.0.0 - 16.4.0",
  "quality\tUNKNOWN STEP\t2026-10-25T22:21:21.1Z Severity: critical",
  "quality\tUNKNOWN STEP\t2026-10-25T22:21:21.2Z ##[error]Process completed with exit code 1.",
  "quality\tUNKNOWN STEP\t2026-10-25T22:21:22.0Z Cleaning up orphan processes",
].join("\n");

describe("ship ci", () => {
  it("waits for runs to appear and complete, then confirms the set is stable", async () => {
    const { gh, calls } = fakeGh([[], [run(1, "in_progress")], [run(1, "completed", "success")]]);
    const outcome = await watchRuns({ sha: SHA, gh, ...clock(), interval: 1000 });
    assert.equal(outcome.state, "success");
    assert.equal(calls.length, 4, "one extra poll after completion to catch late workflows");
    assert.deepEqual(calls[0].slice(0, 4), ["run", "list", "--commit", SHA]);
  });

  it("includes a workflow that starts after the first one finished", async () => {
    const late = [run(1, "completed", "success"), run(2, "queued", "", "deploy")];
    const { gh } = fakeGh([[run(1, "completed", "success")], late, [run(1, "completed", "success"), run(2, "completed", "failure", "deploy")]]);
    const outcome = await watchRuns({ sha: SHA, gh, ...clock() });
    assert.equal(outcome.state, "failure");
    assert.equal(outcome.runs.length, 2);
  });

  it("reports missing runs and timeouts instead of waiting forever", async () => {
    assert.equal((await watchRuns({ sha: SHA, gh: fakeGh([[]]).gh, ...clock(), appearTimeout: 60_000 })).state, "missing");
    assert.equal((await watchRuns({ sha: SHA, gh: fakeGh([[run(1, "in_progress")]]).gh, ...clock(), timeout: 60_000 })).state, "timeout");
  });

  it("extracts the lines before ##[error] without timestamps, BOM, or ANSI codes", () => {
    const [job] = extractErrors(FAILED_LOG, { context: 4 });
    assert.equal(job.job, "quality");
    assert.deepEqual(job.errors, ["Process completed with exit code 1."]);
    assert.deepEqual(job.excerpt, [
      "npm audit --omit=dev",
      "next  16.0.0 - 16.4.0",
      "Severity: critical",
      "##[error]Process completed with exit code 1.",
    ]);
  });

  it("prints failed jobs, steps, and log excerpts and exits 1", async () => {
    const jobs = [
      { name: "quality", conclusion: "failure", url: "https://job/1", steps: [{ name: "Checkout", conclusion: "success" }, { name: "Audit", conclusion: "failure" }] },
      { name: "deploy", conclusion: "skipped", steps: [] },
    ];
    const { gh } = fakeGh([[run(7, "completed", "failure")]], { jobs, log: FAILED_LOG });
    const out = [];
    const code = await main(["ci", "--interval", "1s"], { gh, git: async () => `${SHA}\n`, log: (l) => out.push(l), progress: () => {}, ...clock() });
    assert.equal(code, 1);
    const text = out.join("\n");
    assert.match(text, /^CI failure for a{12}/);
    assert.match(text, /job "quality" failure; failed step: Audit https:\/\/job\/1/);
    assert.doesNotMatch(text, /job "deploy"/);
    assert.match(text, /Severity: critical\n##\[error\]Process completed/);
  });

  it("exits 3 when no workflow runs appear for the commit", async () => {
    const out = [];
    const code = await main(["ci", "--interval", "30s"], { gh: fakeGh([[]]).gh, git: async () => SHA, log: (l) => out.push(l), progress: () => {}, ...clock() });
    assert.equal(code, 3);
    assert.match(out.join("\n"), /No workflow runs found/);
  });
});

describe("ship verify", () => {
  const page = (body, init = {}) => async () => new Response(body, { status: 200, headers: { "x-cache": "Hit from cloudfront" }, ...init });

  it("checks status, expected and rejected content, and reports cache headers", async () => {
    const v = await verifyUrl("https://app.test/", { expect: ["New heading", "/build-\\d+/"], reject: ["/error/i"], fetchImpl: page("<h1>New heading</h1> build-42") });
    assert.equal(v.ok, true);
    assert.equal(v.headers["x-cache"], "Hit from cloudfront");
    assert.equal(v.checks.length, 4);
  });

  it("fails on a wrong status, missing text, or rejected text", async () => {
    const v = await verifyUrl("https://app.test/", { expect: ["New heading"], reject: ["Error"], fetchImpl: page("Old heading. Error", { status: 503 }) });
    assert.equal(v.ok, false);
    assert.deepEqual(v.checks.map((c) => c.ok), [false, false, false]);
    assert.equal(v.checks[0].actual, "503");
  });

  it("reports network errors and validates input", async () => {
    const out = [];
    const failing = async () => {
      throw new Error("getaddrinfo ENOTFOUND app.test");
    };
    assert.equal(await main(["verify", "https://app.test/"], { fetchImpl: failing, log: (l) => out.push(l) }), 1);
    assert.match(out[0], /ENOTFOUND/);
    await assert.rejects(main(["verify", "app.test"], { log: () => {} }), /http\(s\) URL/);
    await assert.rejects(main(["verify", "https://a.test", "--expect"], { log: () => {} }), /needs a value/);
  });

  it("parses durations and regex matchers", () => {
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("30m"), 1_800_000);
    assert.throws(() => parseDuration("soon"), /invalid duration/);
    assert.equal(matcher("/v\\d+/i")("Version V2"), true);
    assert.equal(matcher("a.b")("axb"), false);
  });
});
