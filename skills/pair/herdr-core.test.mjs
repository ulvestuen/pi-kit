// Herdr over SSH: hc works on the agent's machine, the desktop app CLI is missing or cannot see the caller.
// Exercises the shared transport through all three entry points (pair, pair-review, pair-work) with mocked commands.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import * as pairReview from "../pair-review/pair-review.mjs";
import * as pairWork from "../pair-work/pair-work.mjs";
import { fakeHerdrCore, reportWriter } from "./fake-herdr.mjs";
import * as pair from "./pair.mjs";

const { DONE } = pair;
const fast = { sleep: async () => {}, now: () => 0 };
const tmp = () => mkdtempSync(join(tmpdir(), "pair-core-test-"));
// No SSH variables and no herdr-app override: only what a remote hc terminal provides.
const remoteEnv = { HC_TERMINAL_ID: "t0", HC_BIN: "hc", HERDR_APP_BIN: "herdr-app", PAIR_PI_BIN: "/usr/bin/pi" };
const quiet = { log: () => {}, progress: () => {} };

const verdicts = (turn) => (/auditor-audit|consolidate/.test(turn) ? "Verdict: changes requested\n" : turn.includes("verifier-verify") ? "Verdict: changes requested\n" : "");
const fake = (opts = {}) => fakeHerdrCore({ answer: reportWriter(readFileSync, writeFileSync, DONE, verdicts), ...opts });
const runs = (calls) => calls.filter((c) => c[0] === "hc" && c[1] === "run");
const flag = (call, name) => call[call.indexOf(name) + 1];
const labels = (call) => call.flatMap((x, i) => (call[i - 1] === "--label" ? [x] : []));

/** Common assertions for a core-only launch: two hc workers, launch task in argv, unique run labels, no app or SSH needed. */
function assertCoreLaunch(calls, { workflow, roles, models, cwd }) {
  const launched = runs(calls);
  assert.equal(launched.length, 2, "exactly two workers");
  assert.ok(!calls.some((c) => c[0] === "herdr-app" && c[1] === "do"), "no pane commands without app controls");
  const runId = labels(launched[0]).find((l) => l.startsWith("pair.run="))?.split("=")[1];
  assert.match(runId ?? "", /^[0-9a-f]{8}$/);
  launched.forEach((call, i) => {
    assert.ok(call.includes("--bg") && call.includes("--no-notify"), "background launch that does not type notes into the caller");
    assert.equal(flag(call, "--cwd"), cwd);
    assert.equal(flag(call, "--name"), `${workflow}-${roles[i]}-${runId}`);
    assert.deepEqual(labels(call).sort(), [`pair.role=${roles[i]}`, `pair.run=${runId}`, `pair.workflow=${workflow}`]);
    const argv = call.slice(call.indexOf("--") + 1);
    assert.deepEqual(argv.slice(0, 3), ["/usr/bin/pi", "--model", models[i]], "an interactive pi, not print mode");
    assert.ok(!argv.includes("-p") && !argv.includes("--print"));
    assert.match(argv.at(-1), /read \S+\.turn\.md and follow it exactly/, "the first task goes in at launch");
  });
  return runId;
}

describe("Herdr core-only transport (hc without desktop pane controls)", () => {
  it("detect reports core-only Herdr when herdr-app is missing, and none only when hc cannot reach the caller", async () => {
    for (const app of ["missing", "no-window", "hidden"]) {
      const { exec } = fake({ app });
      let out = "";
      assert.equal(await pair.main(["detect"], { env: remoteEnv, exec, log: (s) => (out = s) }), 0);
      assert.match(out, /^herdr \(core-only: hc terminals, no automatic panes;/, app);
      assert.doesNotMatch(out, /install/i);
      let json = "";
      await pair.main(["detect", "--json"], { env: remoteEnv, exec, log: (s) => (json = s) });
      assert.deepEqual([JSON.parse(json).mux, JSON.parse(json).layout], ["herdr", "terminals"]);
    }
    const broken = async (cmd) => Promise.reject(new Error(`${cmd}: spawn ${cmd} ENOENT`));
    let out = "";
    assert.equal(await pair.main(["detect"], { env: remoteEnv, exec: broken, log: (s) => (out = s) }), 1);
    assert.match(out, /^none: .*hc get t0/);
  });

  it("/pair: launches implementer and auditor with hc and runs every audit/address round without herdr-app", async () => {
    const { exec, calls, sendsAfterIdleCheck } = fake();
    const result = await pair.runPair({ task: "Add /health", mux: "herdr", cwd: "/srv/repo", dir: tmp(), rounds: 3, implementerModel: pair.DEFAULTS.implementerModel, auditorModel: pair.DEFAULTS.auditorModel, turnTimeout: "1m", env: remoteEnv, exec, ...fast });
    const runId = assertCoreLaunch(calls, { workflow: "pair", roles: ["implementer", "auditor"], models: [pair.DEFAULTS.implementerModel, pair.DEFAULTS.auditorModel], cwd: "/srv/repo" });
    assert.deepEqual([result.layout, result.runId, result.caller], ["terminals", runId, "t0"]);
    assert.deepEqual(result.panes, { implementer: "t1", auditor: "t2" });
    assert.deepEqual(result.reports.map((r) => r.path.match(/\d+-(\w+-\w+)\.report/)[1]), [
      "auditor-orient", "implementer-implement",
      "auditor-audit", "implementer-address", "auditor-audit", "implementer-address", "auditor-audit", "implementer-address",
    ]);
    const sends = calls.filter((c) => c[0] === "hc" && c[1] === "send");
    assert.deepEqual(sends.map((c) => c[2]), ["t2", "t1", "t2", "t1", "t2", "t1"], "auditor and implementer alternate");
    assert.ok(sendsAfterIdleCheck(), "every send follows a status check");
    assert.equal(result.lastAuditVerdict, "changes requested");
    // Report files stay on the agent's machine; the turn keeps the auditor read-only.
    const audit = readFileSync(result.reports[2].path.replace(".report.md", ".turn.md"), "utf8");
    assert.match(audit, /Do not modify repository files/);
    const text = pair.formatResult(result);
    assert.match(text, /not placed in desktop panes/);
    assert.match(text, /hc attach t1/);
    assert.match(text, new RegExp(`close t1 t2 --mux herdr --run ${runId}`));
    assert.doesNotMatch(text, /panes still open/);
  });

  it("/pair-review: two read-only reviewers, a cross-check, and a consolidation over hc", async () => {
    const { exec, calls, sendsAfterIdleCheck } = fake({ app: "no-window" });
    const d = pairReview.DEFAULTS;
    const result = await pairReview.runReview({ task: "Review main..HEAD", mux: "herdr", cwd: "/srv/repo", dir: tmp(), rounds: 1, leadModel: d.leadModel, peerModel: d.peerModel, turnTimeout: "1m", env: remoteEnv, exec, ...fast });
    const runId = assertCoreLaunch(calls, { workflow: "pair-review", roles: ["lead", "peer"], models: [d.leadModel, d.peerModel], cwd: "/srv/repo" });
    assert.deepEqual(result.panes, { lead: "t1", peer: "t2" });
    assert.equal(result.layout, "terminals");
    assert.deepEqual(result.reports.map((r) => r.path.match(/\d+-(\w+-[\w-]+)\.report/)[1]).sort(), ["lead-consolidate", "lead-cross-check", "lead-review", "peer-cross-check", "peer-review"]);
    assert.deepEqual(calls.filter((c) => c[1] === "send").map((c) => c[2]), ["t1", "t2", "t1"]);
    assert.ok(sendsAfterIdleCheck());
    for (const r of result.reports) {
      const turn = readFileSync(r.path.replace(".report.md", ".turn.md"), "utf8");
      assert.match(turn, /Do not modify, create, or delete repository files/);
      assert.doesNotMatch(turn, /IMPLEMENTER|Address the/, "no fix-up phase");
    }
    assert.equal(result.verdict, "changes requested");
    assert.match(pairReview.formatResult(result), new RegExp(`close t1 t2 --mux herdr --run ${runId}`));
  });

  it("/pair-work: verifier plans first, runs outside a Git repository, and stops on accept", async () => {
    let verifications = 0;
    const answer = reportWriter(readFileSync, writeFileSync, DONE, (turn) => (turn.includes("verifier-verify") ? (++verifications >= 2 ? "Verdict: accept\n" : "Verdict: changes requested\n") : ""));
    const { exec, calls, sendsAfterIdleCheck } = fakeHerdrCore({ answer, app: "hidden", git: false });
    const d = pairWork.DEFAULTS;
    const result = await pairWork.runWork({ task: "Write a vendor memo", mux: "herdr", cwd: "/home/me/notes", dir: tmp(), rounds: 3, doerModel: d.doerModel, verifierModel: d.verifierModel, turnTimeout: "1m", env: remoteEnv, exec, ...fast });
    const runId = assertCoreLaunch(calls, { workflow: "pair-work", roles: ["doer", "verifier"], models: [d.doerModel, d.verifierModel], cwd: "/home/me/notes" });
    assert.match(runs(calls)[1].at(-1), /verifier, plan/, "the verifier's first turn is its plan");
    assert.deepEqual(result.reports.map((r) => r.path.match(/\d+-(\w+-\w+)\.report/)[1]), ["verifier-plan", "doer-do", "verifier-verify", "doer-address", "verifier-verify"]);
    assert.deepEqual([result.accepted, result.rounds, result.layout], [true, 2, "terminals"]);
    assert.ok(sendsAfterIdleCheck());
    const plan = readFileSync(result.reports[0].path.replace(".report.md", ".turn.md"), "utf8");
    assert.match(plan, /Before you see any work/);
    assert.doesNotMatch(plan, /Repository state/, "no Git baseline outside a repository");
    assert.match(pairWork.formatResult(result), new RegExp(`close t1 t2 --mux herdr --run ${runId}`));
  });

  it("waits with hc wait while a worker is still working before sending the next turn", async () => {
    const { exec, calls } = fake({ busy: 2 });
    await pair.runPair({ task: "T", mux: "herdr", cwd: "/srv/repo", dir: tmp(), rounds: 1, implementerModel: "a", auditorModel: "b", turnTimeout: "1m", env: remoteEnv, exec, ...fast });
    // After the auditor's audit is sent, the implementer (t1) still reports `working` twice: two hc waits, then its send.
    const sends = calls.flatMap((c, i) => (c[0] === "hc" && c[1] === "send" ? [i] : []));
    assert.deepEqual(sends.map((i) => calls[i][2]), ["t2", "t1"]);
    const between = calls.slice(sends[0] + 1, sends[1]).filter((c) => c[0] === "hc" && c[2] === "t1").map((c) => c[1]);
    assert.deepEqual(between, ["get", "wait", "get", "wait", "get"], "waits with hc wait, never a blind send");
    assert.ok(calls.filter((c) => c[1] === "wait").every((c) => c.includes("--json") && c.includes("--timeout")));
  });

  it("does not send to a worker blocked on a person; gives up at the turn timeout without restarting", async () => {
    const { exec, terminals, calls } = fake();
    const blocking = async (cmd, args) => {
      const out = await exec(cmd, args);
      if (cmd === "hc" && args[0] === "run") terminals.get(JSON.parse(out).address).status = { state: "blocked" };
      return out;
    };
    const notes = [];
    let t = 0;
    await assert.rejects(
      pair.runPair({ task: "T", mux: "herdr", cwd: "/r", dir: tmp(), rounds: 1, implementerModel: "a", auditorModel: "b", turnTimeout: "1m", env: remoteEnv, exec: blocking, sleep: async () => {}, now: () => (t += 10_000), progress: (s) => notes.push(s) }),
      /t2 is still blocked .*hc read t2/,
    );
    assert.ok(notes.some((s) => /t2 is blocked and needs a person: hc attach t2/.test(s)));
    assert.ok(!calls.some((c) => c[1] === "send"), "nothing typed into a blocked worker");
    assert.equal(runs(calls).length, 2, "no duplicate workers");
  });

  it("a worker that exits after its report is not sent another turn; the run stops with a clear error", async () => {
    const { exec, terminals, calls } = fake();
    const exiting = async (cmd, args) => {
      const out = await exec(cmd, args);
      // The implementer's process ends as soon as it has written its first report.
      if (cmd === "hc" && args[0] === "run" && JSON.parse(out).address === "t1") terminals.get("t1").state = "finished";
      return out;
    };
    await assert.rejects(
      pair.runPair({ task: "T", mux: "herdr", cwd: "/r", dir: tmp(), rounds: 1, implementerModel: "a", auditorModel: "b", turnTimeout: "1m", env: remoteEnv, exec: exiting, ...fast }),
      /terminal t1 is finished/,
      "its report is accepted, but the next turn is not sent to a finished terminal",
    );
    assert.ok(!calls.some((c) => c[1] === "send" && c[2] === "t1"), "nothing typed into the finished worker");
  });

  it("rejects --run on run so a stray id is never silently ignored", async () => {
    const file = join(tmp(), "task.md");
    writeFileSync(file, "task");
    for (const script of [pair, pairReview, pairWork]) {
      await assert.rejects(script.main(["run", "--task-file", file, "--run", "abcd1234"], { env: remoteEnv, exec: fake().exec, ...quiet }), /--run belongs to close/);
    }
  });

  it("cleanup: kills and removes only this run's workers, never the caller or unrelated terminals", async () => {
    for (const [script, workflow, roles] of [[pair, "pair", ["implementer", "auditor"]], [pairReview, "pair-review", ["lead", "peer"]], [pairWork, "pair-work", ["doer", "verifier"]]]) {
      const { exec, calls, terminals } = fake();
      const env = remoteEnv;
      // A previous run's workers and an unrelated user terminal share the core.
      terminals.set("t7", { state: "live", labels: { "pair.run": "aaaaaaaa", "pair.workflow": workflow } });
      terminals.set("t8", { state: "live", labels: { "pair.run": "aaaaaaaa", "pair.workflow": workflow } });
      terminals.set("t9", { state: "live", labels: {} });
      await assert.rejects(script.main(["close", "t0"], { env, exec, ...quiet }), /your own/);
      await assert.rejects(script.main(["close", "t7", "t9"], { env, exec, ...quiet }), /t9 was not started by a pair run/);
      await assert.rejects(script.main(["close", "t7", "t8", "--run", "bbbbbbbb"], { env, exec, ...quiet }), /t7 belongs to pair run aaaaaaaa, not bbbbbbbb/);
      assert.ok(!calls.some((c) => c[1] === "kill" || c[1] === "rm"), `${workflow}: nothing closed after a refusal`);
      assert.equal(await script.main(["close", "t7", "t8", "--mux", "herdr", "--run", "aaaaaaaa"], { env, exec, ...quiet }), 0);
      assert.deepEqual(calls.filter((c) => c[1] === "kill" || c[1] === "rm").map((c) => `${c[1]} ${c[2]}`), ["kill t7", "rm t7", "kill t8", "rm t8"], roles.join("/"));
      assert.deepEqual([...terminals.keys()].sort(), ["t0", "t9"]);
    }
  });
});

describe("Herdr app pane controls", () => {
  it("are preferred when herdr-app shows the caller's pane", async () => {
    const calls = [];
    let n = 0;
    const answer = reportWriter(readFileSync, writeFileSync, DONE);
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git") return "";
      if (cmd === "herdr-app" && args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t0", pane: "p0" }] }] }] });
      if (cmd === "herdr-app" && args[1] === "pane.split") {
        answer(JSON.parse(args[2]).argv.at(-1));
        return JSON.stringify({ pane: `p${++n}`, terminal: `t${n}` });
      }
      if (cmd === "hc" && args[0] === "send") answer(args.at(-1));
      if (cmd === "hc" && args[0] === "get") return JSON.stringify({ state: "live", status: { state: "done" } });
      if (cmd === "hc" && args[0] === "wait") return JSON.stringify({ reason: "status" });
      return "{}";
    };
    const result = await pairWork.runWork({ task: "T", mux: "herdr", cwd: "/r", dir: tmp(), rounds: 1, doerModel: "a", verifierModel: "b", turnTimeout: "1m", env: remoteEnv, exec, ...fast });
    assert.equal(result.layout, "panes");
    assert.equal(calls.filter((c) => c[2] === "pane.split").length, 2);
    assert.equal(calls.filter((c) => c[0] === "hc" && c[1] === "run").length, 0);
    const label = calls.find((c) => c[0] === "hc" && c[1] === "label");
    assert.equal(label[2], "t1");
    assert.deepEqual(label.slice(3).sort(), ["pair.role=doer", `pair.run=${result.runId}`, "pair.workflow=pair-work"]);
    assert.match(pairWork.formatResult(result), /Worker panes still open: doer t1, verifier t2/);
  });
});
