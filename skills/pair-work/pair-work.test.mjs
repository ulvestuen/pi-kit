import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DONE } from "../pair/pair.mjs";
import { DEFAULTS, main, runWork, workTurnText } from "./pair-work.mjs";

// A stand-in for the pi executable: the launch resolves an absolute path, so it must exist.
const fakePi = join(mkdtempSync(join(tmpdir(), "pair-pi-")), "pi");
writeFileSync(fakePi, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
// Windows gets PowerShell (there is no /bin/sh); both launchers run the resolved pi directly, with no shell wrapper.
const launcherName = process.platform === "win32" ? "launch.ps1" : "launch.sh";
const launcherRunsPi = (text) => (process.platform === "win32" ? text.includes(`& "${fakePi}" @args`) : text.includes(`'${fakePi}' "$@"`));
/** The launcher path in an argv: on Windows the PowerShell runner and its flags come first, so never read argv[0]. */
const launcherOf = (argv) => argv.find((arg) => String(arg).endsWith(launcherName));
/** The arguments the launcher itself runs pi with, without a host runner's prefix. */
const launcherArgs = (argv) => argv.slice(argv.indexOf(launcherOf(argv)) + 1);

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
const options = (mux, env, rounds = DEFAULTS.rounds) => ({ task: "Write a vendor comparison memo", mux, cwd: "/repo", dir: tmp(), rounds, doerModel: DEFAULTS.models.doer[0], verifierModel: DEFAULTS.models.verifier[0], turnTimeout: "1m", env, ...fast });
const kinds = (result) => result.reports.map((r) => r.path.match(/\d+-(\w+-\w+)\.report/)[1]);

describe("pair-work run", () => {
  it("in Herdr: the verifier plans while the doer works, then verify/address rounds run to the limit", async () => {
    const { exec, calls } = fakeMux();
    const env = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: fakePi };
    const result = await runWork({ ...options("herdr", env), exec });

    const splits = calls.filter((c) => c[2] === "pane.split").map((c) => JSON.parse(c[3]));
    assert.deepEqual(splits.map((s) => [s.pane, s.direction]), [["p0", "right"], ["p1", "down"]]);
    assert.ok(launcherOf(splits[0].argv), "started directly: pane.split gets no /bin/sh wrapper");
    assert.deepEqual(launcherArgs(splits[0].argv).slice(0, 2), ["--model", "claude-code/claude-opus-5-5"]);
    assert.ok(launcherRunsPi(readFileSync(launcherOf(splits[0].argv), "utf8")), "workers start through the worker launcher");
    assert.deepEqual(launcherArgs(splits[1].argv).slice(0, 2), ["--model", "openai/gpt-6.1-sol:xhigh"]);
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
    const result = await runWork({ ...options("rex", { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi }), exec });
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

  it("prints models with doer and verifier role names", async () => {
    const table = ["provider  model  context", "claude-code  claude-opus-5-5  1M", "openai  gpt-6.1-sol  272K"];
    const exec = async (cmd, args) => {
      assert.equal(cmd, fakePi, "the probes use the resolved pi, not a bare PATH name");
      if (args[0] === "--list-models") return table.join("\n");
      if (args[args.indexOf("--model") + 1] === "openai/gpt-6.1-sol") return '{"status":"ready","provider":"openai","authType":"oauth"}\n';
      throw Object.assign(new Error("not ready"), { stdout: '{"status":"not_ready","provider":"claude-code","reason":"credentials_not_configured"}\n', code: 1 });
    };
    let text = "";
    assert.equal(await main(["models"], { env: { PAIR_PI_BIN: fakePi, PATH: "/usr/bin" }, exec, log: (s) => (text = s) }), 1);
    assert.match(text, /^pair-work models \(checked in a worker's environment: /);
    assert.match(text, /\bdoer +\(none ready\)\n +why: claude-code\/claude-opus-5-5 is not ready: credentials_not_configured; .*\n +ready alternatives: openai\/gpt-6\.1-sol:xhigh/);
    assert.match(text, /\bverifier +openai\/gpt-6\.1-sol:xhigh/);
    assert.match(text, new RegExp(`why: preference 1 of ${DEFAULTS.models.verifier.length}`));
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

describe("pair-work doctor", () => {
  // The shared doctor, with the doer/verifier role names: --no-launch keeps it to detection, resolution and readiness.
  const table = ["provider  model  context", "claude-code  claude-opus-5-5  1M", "openai  gpt-6.1-sol  272K"].join("\n");
  const exec = async (cmd, args) => {
    assert.equal(cmd, fakePi);
    if (args[0] === "--list-models") return table;
    const value = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : args[args.indexOf("--model") + 1];
    if (args.includes("--provider")) throw Object.assign(new Error("not found"), { stdout: '{"status":"not_ready","provider":"claude-code","reason":"provider_not_found"}\n', code: 1 });
    if (value.startsWith("openai/")) return '{"status":"ready","provider":"openai","authType":"oauth"}\n';
    throw Object.assign(new Error("invalid"), { stdout: '{"status":"invalid","provider":"claude-code/claude-opus-5-5","reason":"invalid_state"}\n', code: 2 });
  };

  it("prints the shared doctor checks with the doer and verifier role names", async () => {
    let text = "";
    const env = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    assert.equal(await main(["doctor", "--no-launch"], { env, exec, log: (s) => (text = s) }), 0);
    assert.match(text, /^pair-work doctor: \d+ pass, 0 fail, 1 skipped/);
    assert.match(text, /  pass  doer: claude-code\/claude-opus-5-5 .*listed; auth unverifiable/);
    assert.match(text, /  pass  verifier: openai\/gpt-6\.1-sol:xhigh .*ready/);
    // An unready role fails the whole check, naming a fix with the ready alternatives.
    const blocked = async (cmd, args) => {
      if (args[0] === "--list-models") return table;
      throw Object.assign(new Error("not ready"), { stdout: '{"status":"not_ready","provider":"openai","reason":"credentials_not_configured"}\n', code: 1 });
    };
    let failed = "";
    assert.equal(await main(["doctor", "--no-launch"], { env, exec: blocked, log: (s) => (failed = s) }), 1);
    assert.match(failed, /  fail  verifier: openai\/gpt-6\.1-sol:xhigh not ready \(credentials_not_configured\)/);
    assert.match(failed, / {8}fix: log in with `pi auth login <provider>`, or pass --verifier-model/);
    // Both variable families set: `--mux herdr` selects one instead of failing as ambiguous, as a run does.
    const both = { ...env, HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc" };
    const herdr = async (cmd, args) => {
      if (cmd === fakePi) return exec(cmd, args);
      if (cmd === "herdr-app" && args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t0", pane: "p0" }] }] }] });
      if (cmd === "hc" && args[0] === "get") return JSON.stringify({ state: "live", status: { state: "idle" } });
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    };
    let selected = "";
    assert.equal(await main(["doctor", "--no-launch", "--mux", "herdr"], { env: both, exec: herdr, log: (s) => (selected = s) }), 0);
    assert.match(selected, /  pass  mux: herdr: panes via herdr-app \(HERDR_APP_BIN\)\n {8}selected with --mux herdr/);
    assert.match(selected, /  pass  doer: /);
    assert.match(selected, /  pass  verifier: /);
  });
});
