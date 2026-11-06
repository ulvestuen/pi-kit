import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULTS, DONE, detect, main, runPair, shellQuote, turnText } from "./pair.mjs";

/** Fake herdr/rex: each prompt makes the "worker" write the report its turn file names. */
function fakeMux() {
  const calls = [];
  let n = 0;
  const answer = (prompt) => {
    const turn = /read (\S+\.turn\.md)/.exec(prompt)?.[1];
    if (!turn) return;
    const report = readFileSync(turn, "utf8").match(/write your report as Markdown to:\n\n(\S+)/)[1];
    const verdict = turn.includes("auditor-audit") ? "Verdict: changes requested\n" : "";
    writeFileSync(report, `report for ${turn}\n${verdict}${DONE}\n`);
  };
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git") return "## main\n";
    if (args[0] === "pane" && args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: `w1:p${++n}` } } });
    if (args[0] === "pane" && args[1] === "run") answer(args[3]);
    if (args[0] === "split") {
      answer(args.at(-1));
      return JSON.stringify({ block_ids: [`blk${++n}`] });
    }
    if ((args[0] === "pane" && args[1] === "send-text") || args[0] === "send") answer(args.at(-1));
    return "{}";
  };
  return { exec, calls };
}

const fast = { sleep: async () => {}, now: () => 0 };
const tmp = () => mkdtempSync(join(tmpdir(), "pair-test-"));

describe("pair detect", () => {
  it("recognizes Herdr, Rex, neither, and refuses to guess when both are set", () => {
    assert.equal(detect({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }).mux, "herdr");
    assert.equal(detect({ REX_SESSION: "s", REX_BLOCK: "b" }).mux, "rex");
    assert.equal(detect({ HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1" }).mux, null);
    assert.equal(detect({}).mux, null);
    assert.match(detect({ HERDR_ENV: "1", HERDR_PANE_ID: "p", REX_SESSION: "s", REX_BLOCK: "b" }).reason, /--mux/);
  });
});

describe("pair run", () => {
  const options = (mux, env) => ({ task: "Add a /health endpoint", mux, cwd: "/repo", dir: tmp(), rounds: 3, implementerModel: DEFAULTS.implementerModel, auditorModel: DEFAULTS.auditorModel, turnTimeout: "1m", env, ...fast });

  it("in Herdr: opens two panes with the subscription models and runs three audit/address rounds", async () => {
    const { exec, calls } = fakeMux();
    const result = await runPair({ ...options("herdr", { HERDR_PANE_ID: "w1:p0", PAIR_PI_BIN: "pi" }), exec });

    const splits = calls.filter((c) => c[1] === "pane" && c[2] === "split");
    assert.deepEqual(splits.map((c) => c[3]), ["w1:p0", "w1:p1"], "implementer beside caller, auditor below implementer");
    assert.ok(splits.every((c) => c.includes("--no-focus")));
    const runs = calls.filter((c) => c[1] === "pane" && c[2] === "run").map((c) => c[4]);
    assert.match(runs[0], /^pi --model claude-code\/claude-opus-5-5 /);
    assert.match(runs[1], /^pi --model openai-codex\/gpt-6\.1-sol /);

    assert.deepEqual(result.reports.map((r) => `${r.role}:${r.path.match(/-(\w+)\.report/)[1]}`), [
      "auditor:orient",
      "implementer:implement",
      "auditor:audit",
      "implementer:address",
      "auditor:audit",
      "implementer:address",
      "auditor:audit",
      "implementer:address",
    ]);
    assert.equal(result.lastAuditVerdict, "changes requested");
    assert.match(result.finalReport, /08-implementer-address/);
    assert.ok(!result.finalReport.includes(DONE));
  });

  it("in Rex: splits beside REX_BLOCK in REX_SESSION without stealing focus", async () => {
    const { exec, calls } = fakeMux();
    const result = await runPair({ ...options("rex", { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: "pi" }), exec });
    const splits = calls.filter((c) => c[0] === "rex" && c[1] === "split");
    assert.equal(splits.length, 2);
    assert.deepEqual(splits[0].slice(1, 7), ["split", "-s", "sess", "-b", "blk0", "--split=right"]);
    assert.ok(splits[1].includes("--split=below") && splits[1].includes("blk1"));
    assert.ok(splits.every((c) => c.includes("--focus=false")));
    assert.deepEqual(splits[1].slice(splits[1].indexOf("--") + 1, -1), ["pi", "--model", "openai-codex/gpt-6.1-sol"]);
    assert.equal(calls.filter((c) => c[1] === "send").length, 6);
    assert.equal(result.reports.length, 8);
  });

  it("times out instead of waiting forever for a silent worker", async () => {
    let t = 0;
    const exec = async (cmd, args) => (args[1] === "split" ? JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }) : "");
    await assert.rejects(
      runPair({ ...options("herdr", { HERDR_PANE_ID: "w1:p0" }), exec, now: () => (t += 30_000) }),
      /timed out waiting for .*auditor-orient/,
    );
  });
});

describe("pair turns and CLI", () => {
  it("keeps the auditor read-only and marks the final round", () => {
    const audit = turnText({ role: "auditor", kind: "audit", task: "T", report: "/r.md", previous: "/p.md", round: 1, rounds: 3 });
    assert.match(audit, /Do not modify repository files/);
    assert.match(audit, /\/p\.md/);
    const last = turnText({ role: "implementer", kind: "address", task: "T", report: "/r.md", previous: "/a.md", round: 3, rounds: 3 });
    assert.match(last, /final round/);
    assert.ok(last.includes(DONE));
  });

  it("quotes shell arguments for Herdr's pane run", () => {
    assert.equal(shellQuote("claude-code/claude-opus-5-5"), "claude-code/claude-opus-5-5");
    assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
  });

  it("refuses to run outside a multiplexer and validates input", async () => {
    const quiet = { log: () => {}, progress: () => {} };
    await assert.rejects(main(["run", "--task-file", "/nope"], { env: {}, ...quiet }), /not running inside Herdr/);
    await assert.rejects(main(["run"], { env: { REX_SESSION: "s", REX_BLOCK: "b" }, ...quiet }), /--task-file/);
    const file = join(tmp(), "task.md");
    writeFileSync(file, "do it");
    await assert.rejects(main(["run", "--task-file", file, "--rounds", "0"], { env: { REX_SESSION: "s", REX_BLOCK: "b" }, ...quiet }), /--rounds/);
    let out = "";
    assert.equal(await main(["detect"], { env: {}, log: (s) => (out = s) }), 1);
    assert.match(out, /^none/);
  });
});
