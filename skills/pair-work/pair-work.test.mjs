import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DONE } from "../pair/pair.mjs";
import { DEFAULTS, main, runWork, workTurnText } from "./pair-work.mjs";

/** Fake herdr-app + hc and rex: each prompt makes the "worker" write the report its turn file names. */
function fakeMux({ acceptOnRound = Infinity } = {}) {
  const calls = [];
  let n = 0;
  let verifications = 0;
  const answer = (prompt) => {
    const turn = /read (\S+\.turn\.md)/.exec(prompt)?.[1];
    if (!turn) return;
    const report = readFileSync(turn, "utf8").match(/write your report as Markdown to:\n\n(\S+)/)[1];
    let verdict = "";
    if (turn.includes("verifier-verify")) verdict = ++verifications >= acceptOnRound ? "Verdict: accept\n" : "Verdict: changes requested\n";
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
const tmp = () => mkdtempSync(join(tmpdir(), "pair-work-test-"));
const options = (mux, env, rounds = DEFAULTS.rounds) => ({ task: "Write a vendor comparison memo", mux, cwd: "/repo", dir: tmp(), rounds, doerModel: DEFAULTS.doerModel, verifierModel: DEFAULTS.verifierModel, turnTimeout: "1m", env, ...fast });
const kinds = (result) => result.reports.map((r) => r.path.match(/\d+-(\w+-\w+)\.report/)[1]);

describe("pair-work run", () => {
  it("in Herdr: the verifier plans while the doer works, then verify/address rounds run to the limit", async () => {
    const { exec, calls } = fakeMux();
    const env = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: "pi" };
    const result = await runWork({ ...options("herdr", env), exec });

    const splits = calls.filter((c) => c[2] === "pane.split").map((c) => JSON.parse(c[3]));
    assert.deepEqual(splits.map((s) => [s.pane, s.direction]), [["p0", "right"], ["p1", "down"]]);
    assert.deepEqual(splits[0].argv.slice(5, 8), ["pi", "--model", "claude-code/claude-opus-5-5"]);
    assert.deepEqual(splits[1].argv.slice(5, 8), ["pi", "--model", "openai/gpt-6.1-sol:xhigh"]);
    assert.deepEqual(result.panes, { doer: "t1", verifier: "t2" });
    assert.deepEqual(kinds(result), [
      "verifier-plan", "doer-do",
      "verifier-verify", "doer-address",
      "verifier-verify", "doer-address",
      "verifier-verify", "doer-address",
    ]);
    assert.equal(result.rounds, 3);
    assert.equal(result.accepted, false);
    assert.equal(result.lastVerdict, "changes requested");
    assert.ok(existsSync(result.workDir));
    assert.match(result.finalReport, /doer-address/);

    // Each verification reads the doer's latest report and the verifier's own plan.
    const turns = result.reports.filter((r) => r.path.includes("verifier-verify")).map((r) => readFileSync(r.path.replace(".report.md", ".turn.md"), "utf8"));
    assert.match(turns[0], /doer-do\.report\.md/);
    assert.match(turns[1], /doer-address\.report\.md/);
    for (const t of turns) assert.match(t, /verifier-plan\.report\.md/);
  });

  it("in Rex: stops early once the verifier accepts", async () => {
    const { exec, calls } = fakeMux({ acceptOnRound: 2 });
    const result = await runWork({ ...options("rex", { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: "pi" }), exec });
    assert.equal(calls.filter((c) => c[1] === "split").length, 2);
    assert.deepEqual(kinds(result), ["verifier-plan", "doer-do", "verifier-verify", "doer-address", "verifier-verify"]);
    assert.equal(result.rounds, 2);
    assert.equal(result.accepted, true);
    assert.equal(result.lastVerdict, "accept");
    assert.match(result.finalReport, /doer-address/, "the final report is the doer's last turn");
  });
});

describe("pair-work turns and CLI", () => {
  it("keeps the verifier hands-off and planning before it sees the work", () => {
    const plan = workTurnText({ role: "verifier", kind: "plan", task: "T", report: "/r.md", workDir: "/w" });
    assert.match(plan, /VERIFIER/);
    assert.match(plan, /Do not modify the doer's deliverables/);
    assert.match(plan, /Before you see any work/);
    assert.match(plan, /Verdict: accept/);
    const doer = workTurnText({ role: "doer", kind: "address", task: "T", report: "/r.md", previous: "/v.md", round: 2, rounds: 2, workDir: "/w" });
    assert.match(doer, /DOER/);
    assert.match(doer, /no commits, pushes, deploys, purchases, publishing, or sending messages/);
    assert.match(doer, /## Work folder\n\n\/w/);
    assert.match(doer, /final round/);
    assert.ok(doer.includes(DONE));
  });

  it("validates input, rejects other pair flags, and closes worker panes", async () => {
    const quiet = { log: () => {}, progress: () => {} };
    const rex = { REX_SESSION: "s", REX_BLOCK: "b", REX_BIN: "rex" };
    await assert.rejects(main(["run", "--task-file", "/nope"], { env: {}, ...quiet }), /not running inside Herdr/);
    await assert.rejects(main(["run"], { env: rex, ...quiet }), /--task-file/);
    await assert.rejects(main(["run", "--implementer-model", "x"], { env: rex, ...quiet }), /unknown option --implementer-model/);
    const file = join(tmp(), "task.md");
    writeFileSync(file, "do it");
    await assert.rejects(main(["run", "--task-file", file, "--rounds", "0"], { env: rex, ...quiet }), /--rounds/);

    const calls = [];
    const exec = async (cmd, args) => (calls.push([cmd, ...args]), "");
    assert.equal(await main(["close", "b1", "b2"], { env: rex, exec, ...quiet }), 0);
    assert.deepEqual(calls, [["rex", "block", "close", "-s", "s", "b1"], ["rex", "block", "close", "-s", "s", "b2"]]);
    await assert.rejects(main(["close", "b"], { env: rex, exec, ...quiet }), /your own pane/);
  });
});
