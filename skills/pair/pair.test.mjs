import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULTS, DONE, detect, main, runPair, turnText } from "./pair.mjs";

/** Fake herdr-app + hc and rex: each prompt makes the "worker" write the report its turn file names. */
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
    if (cmd === "herdr-app" && args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t0", pane: "p0" }] }] }] });
    if (cmd === "herdr-app" && args[1] === "pane.split") {
      answer(JSON.parse(args[2]).argv.at(-1));
      n++;
      return JSON.stringify({ pane: `p${n}`, terminal: `t${n}` });
    }
    if (cmd === "herdr-app") return "{}";
    if (cmd === "hc" && args[0] === "send") answer(args.at(-1));
    if (cmd === "hc" && args[0] === "get") return JSON.stringify({ state: "live" });
    if (cmd === "hc" && args[0] === "wait") return JSON.stringify({ reason: "status" });
    if (cmd === "hc") return "";
    if (args[0] === "split") {
      answer(args.at(-1));
      return JSON.stringify({ block_ids: [`blk${++n}`] });
    }
    if (args[0] === "send") answer(args.at(-1));
    return "{}";
  };
  return { exec, calls };
}

const fast = { sleep: async () => {}, now: () => 0 };
const tmp = () => mkdtempSync(join(tmpdir(), "pair-test-"));

describe("pair detect", () => {
  it("recognizes Herdr, Rex, neither, and refuses to guess when both are set", () => {
    assert.equal(detect({ HC_TERMINAL_ID: "t7" }).mux, "herdr");
    assert.equal(detect({ REX_SESSION: "s", REX_BLOCK: "b" }).mux, "rex");
    assert.equal(detect({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }).mux, null, "the old Herdr TUI is not supported");
    assert.equal(detect({}).mux, null);
    assert.match(detect({ HC_TERMINAL_ID: "t7", REX_SESSION: "s", REX_BLOCK: "b" }).reason, /--mux/);
  });
});

describe("pair run", () => {
  const options = (mux, env) => ({ task: "Add a /health endpoint", mux, cwd: "/repo", dir: tmp(), rounds: 3, implementerModel: DEFAULTS.implementerModel, auditorModel: DEFAULTS.auditorModel, turnTimeout: "1m", env, ...fast });

  it("in Herdr: splits panes with herdr-app, talks through hc, and runs three audit/address rounds", async () => {
    const { exec, calls } = fakeMux();
    const env = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: "pi" };
    const result = await runPair({ ...options("herdr", env), exec });

    const splits = calls.filter((c) => c[0] === "herdr-app" && c[2] === "pane.split").map((c) => JSON.parse(c[3]));
    assert.deepEqual(splits.map((s) => [s.pane, s.direction]), [["p0", "right"], ["p1", "down"]], "implementer beside caller, auditor below implementer");
    assert.deepEqual(splits[0].argv.slice(0, 5), ["/bin/sh", "-c", 'cd -- "$1" && shift && exec "$@"', "pair", "/repo"]);
    assert.deepEqual(splits[0].argv.slice(5, 8), ["pi", "--model", "claude-code/claude-opus-5-5"]);
    assert.deepEqual(splits[1].argv.slice(5, 8), ["pi", "--model", "openai/gpt-6.1-sol:xhigh"]);
    const focus = calls.filter((c) => c[2] === "pane.focus").map((c) => JSON.parse(c[3]).pane);
    assert.deepEqual(focus, ["p0", "p0"], "focus returns to the caller's pane after each split");
    const sends = calls.filter((c) => c[0] === "hc" && c[1] === "send");
    assert.equal(sends.length, 6);
    assert.deepEqual(new Set(sends.map((c) => c[2])), new Set(["t1", "t2"]));
    assert.equal(result.panes.implementer, "t1");
    assert.equal(result.panes.auditor, "t2");

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
    assert.deepEqual(splits[1].slice(splits[1].indexOf("--") + 1, -1), ["pi", "--model", "openai/gpt-6.1-sol:xhigh"]);
    assert.equal(calls.filter((c) => c[1] === "send").length, 6);
    assert.equal(result.reports.length, 8);
  });

  it("times out instead of waiting forever for a silent worker", async () => {
    let t = 0;
    const exec = async (cmd, args) => {
      if (args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t0", pane: "p0" }] }] }] });
      if (args[1] === "pane.split") return JSON.stringify({ pane: "p9", terminal: "t9" });
      if (args[0] === "get") return JSON.stringify({ state: "live" });
      return cmd.endsWith("herdr-app") ? "{}" : "";
    };
    await assert.rejects(
      runPair({ ...options("herdr", { HC_TERMINAL_ID: "t0" }), exec, now: () => (t += 30_000) }),
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

  it("in Herdr: reports a finished worker terminal and refuses to run from a terminal without a pane", async () => {
    const opts = { task: "T", mux: "herdr", cwd: "/repo", dir: tmp(), rounds: 1, implementerModel: "a", auditorModel: "b", turnTimeout: "1h", env: { HC_TERMINAL_ID: "t0" }, ...fast };
    const ls = (terminals) => JSON.stringify({ spaces: [{ tabs: [{ terminals }] }] });
    const gone = async (cmd, args) => {
      if (args[0] === "ls") return ls([{ terminal: "t0", pane: "p0" }]);
      if (args[1] === "pane.split") return JSON.stringify({ pane: "p9", terminal: "t9" });
      if (args[0] === "get") return JSON.stringify({ state: "finished", exit_code: 1 });
      return cmd.endsWith("herdr-app") ? "{}" : "";
    };
    await assert.rejects(runPair({ ...opts, exec: gone }), /auditor pane t9 is gone \(terminal t9 is finished \(exit 1\)\)/);
    const hidden = async (cmd, args) => (args[0] === "ls" ? ls([{ terminal: "t5", pane: "p5" }]) : "{}");
    await assert.rejects(runPair({ ...opts, exec: hidden }), /terminal t0 is not shown in a Herdr app pane/);
    const failing = async (cmd, args) => (args[0] === "ls" ? ls([{ terminal: "t0", pane: "p0" }]) : Promise.reject(Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ error: 'no pane "p0"' }) })));
    await assert.rejects(runPair({ ...opts, exec: failing }), /herdr-app pane\.split: no pane "p0"/);
  });

  it("closes finished worker panes in Herdr and Rex, never the caller's own", async () => {
    const quiet = { progress: () => {} };
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t0", pane: "p0" }, { terminal: "t1", pane: "p1" }, { terminal: "t2", pane: "p2" }] }] }] });
      return cmd === "herdr-app" ? "{}" : "";
    };
    const herdr = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc" };
    const logs = [];
    assert.equal(await main(["close", "t1", "t2"], { env: herdr, exec, log: (s) => logs.push(s), ...quiet }), 0);
    assert.deepEqual(calls.filter((c) => c[2] === "pane.close").map((c) => JSON.parse(c[3]).pane), ["p1", "p2"]);
    assert.deepEqual(calls.filter((c) => c[0] === "hc" && c[1] === "rm").map((c) => c[2]), ["t1", "t2"]);
    assert.deepEqual(logs, ["closed t1", "closed t2"]);
    await assert.rejects(main(["close", "t0"], { env: herdr, exec, log: () => {}, ...quiet }), /your own pane/);
    await assert.rejects(main(["close"], { env: herdr, exec, log: () => {}, ...quiet }), /close needs the worker ids/);

    calls.length = 0;
    const rex = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex" };
    assert.equal(await main(["close", "blk1", "blk2", "--mux", "rex"], { env: rex, exec, log: () => {}, ...quiet }), 0);
    assert.deepEqual(calls, [["rex", "block", "close", "-s", "sess", "blk1"], ["rex", "block", "close", "-s", "sess", "blk2"]]);
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
