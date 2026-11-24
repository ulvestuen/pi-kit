import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DONE } from "../pair/pair.mjs";
import { DEFAULTS, main, reviewTurnText, runReview } from "./pair-review.mjs";

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

/** Fake herdr-app + hc and rex: each prompt makes the "reviewer" write the report its turn file names. */
function fakeMux() {
  const calls = [];
  let n = 0;
  const answer = (prompt) => {
    const turn = /read (\S+\.turn\.md)/.exec(prompt)?.[1];
    if (!turn) return;
    const report = readFileSync(turn, "utf8").match(/write your report as Markdown to:\n\n(\S+)/)[1];
    const verdict = turn.includes("consolidate") ? "Verdict: changes requested\n" : "";
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
const tmp = () => mkdtempSync(join(tmpdir(), "pair-review-test-"));
const options = (mux, env, rounds = DEFAULTS.rounds) => ({ task: "Review PR #42", mux, cwd: "/repo", dir: tmp(), rounds, leadModel: DEFAULTS.models.lead[0], peerModel: DEFAULTS.models.peer[0], turnTimeout: "1m", env, ...fast });

describe("pair-review run", () => {
  it("in Herdr: two independent reviews, a cross-check, then the lead consolidates", async () => {
    const { exec, calls } = fakeMux();
    const env = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: fakePi };
    const result = await runReview({ ...options("herdr", env), exec });

    const splits = calls.filter((c) => c[2] === "pane.split").map((c) => JSON.parse(c[3]));
    assert.deepEqual(splits.map((s) => [s.pane, s.direction]), [["p0", "right"], ["p1", "down"]]);
    assert.ok(launcherOf(splits[0].argv), "started directly: pane.split gets no /bin/sh wrapper");
    assert.deepEqual(launcherArgs(splits[0].argv).slice(0, 2), ["--model", "claude-code/claude-opus-5-5"]);
    assert.ok(launcherRunsPi(readFileSync(launcherOf(splits[0].argv), "utf8")), "reviewers start through the worker launcher");
    assert.deepEqual(launcherArgs(splits[1].argv).slice(0, 2), ["--model", "openai/gpt-6.1-sol:xhigh"]);
    assert.deepEqual(result.panes, { lead: "t1", peer: "t2" });
    assert.deepEqual(result.reports.map((r) => `${r.role}:${r.path.match(/\d+-(?:lead|peer)-([\w-]+)\.report/)[1]}`).sort(), [
      "lead:consolidate", "lead:cross-check", "lead:review", "peer:cross-check", "peer:review",
    ]);
    assert.equal(result.verdict, "changes requested");
    assert.match(result.finalReview, /lead-consolidate/);

    // Each cross-check reads the other reviewer's independent review; the consolidation reads every report.
    const turn = (name) => readFileSync(result.reports.find((r) => r.path.includes(name)).path.replace(".report.md", ".turn.md"), "utf8");
    assert.match(turn("lead-cross-check"), /peer-review\.report\.md/);
    assert.match(turn("peer-cross-check"), /lead-review\.report\.md/);
    for (const r of result.reports.filter((r) => !r.path.includes("consolidate"))) assert.ok(turn("lead-consolidate").includes(r.path));
  });

  it("in Rex: splits beside REX_BLOCK and runs the requested number of cross-check rounds", async () => {
    const { exec, calls } = fakeMux();
    const result = await runReview({ ...options("rex", { REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi }, 2), exec });
    assert.deepEqual(calls.filter((c) => c[1] === "split").map((c) => c.slice(2, 4)), [["-s", "blk0"], ["-s", "blk0"]]);
    assert.equal(calls.filter((c) => c[1] === "send").length, 5, "two rounds × two reviewers + one consolidation");
    assert.equal(result.reports.length, 7);
  });
});

describe("pair-review turns and CLI", () => {
  it("keeps both reviewers read-only and the first reviews independent", () => {
    const review = reviewTurnText({ role: "peer", kind: "review", task: "T", report: "/r.md" });
    assert.match(review, /PEER REVIEWER/);
    assert.match(review, /Do not modify, create, or delete repository files/);
    assert.match(review, /Do not look for or read the other reviewer's report/);
    const final = reviewTurnText({ role: "lead", kind: "consolidate", task: "T", report: "/r.md", previous: ["/a.md", "/b.md"] });
    assert.match(final, /- \/a\.md\n- \/b\.md/);
    assert.match(final, /Verdict: approve/);
    assert.ok(final.includes(DONE));
  });

  it("prints models with its own role names", async () => {
    const table = ["provider  model  context", "claude-code  claude-opus-5-5  1M", "openai  gpt-6.1-sol  272K"];
    const exec = async (cmd, args) => {
      assert.equal(cmd, fakePi, "the probes use the resolved pi, not a bare PATH name");
      if (args[0] === "--list-models") return table.join("\n");
      throw Object.assign(new Error("not ready"), { stdout: '{"status":"not_ready","provider":"claude-code","reason":"credentials_not_configured"}\n', code: 1 });
    };
    let text = "";
    assert.equal(await main(["models"], { env: { PAIR_PI_BIN: fakePi, PATH: "/usr/bin" }, exec, log: (s) => (text = s) }), 1, "nothing ready is a failure code, not a crash");
    assert.match(text, /^pair-review models \(checked in a worker's environment: /);
    assert.match(text, /\blead +\(none ready\)\n +why: claude-code\/claude-opus-5-5 is not ready: credentials_not_configured/);
    assert.match(text, /\bpeer +\(none ready\)\n +why: openai\/gpt-6\.1-sol:xhigh is not ready: credentials_not_configured/);
  });

  it("validates input, rejects pair-only flags, and closes reviewer panes", async () => {
    const quiet = { log: () => {}, progress: () => {} };
    const rex = { REX_SESSION: "s", REX_BLOCK: "b", REX_BIN: "rex" };
    await assert.rejects(main(["run", "--task-file", "/nope"], { env: {}, ...quiet }), /not running inside Herdr/);
    await assert.rejects(main(["run"], { env: rex, ...quiet }), /--task-file/);
    await assert.rejects(main(["run", "--implementer-model", "x"], { env: rex, ...quiet }), /unknown option --implementer-model/);
    const file = join(tmp(), "task.md");
    writeFileSync(file, "review it");
    await assert.rejects(main(["run", "--task-file", file, "--rounds", "0"], { env: rex, ...quiet }), /--rounds/);

    const calls = [];
    const exec = async (cmd, args) => (calls.push([cmd, ...args]), "");
    assert.equal(await main(["close", "b1", "b2"], { env: rex, exec, ...quiet }), 0);
    assert.deepEqual(calls, [["rex", "block", "close", "-s", "s", "b1"], ["rex", "block", "close", "-s", "s", "b2"]]);
    await assert.rejects(main(["close", "b"], { env: rex, exec, ...quiet }), /your own pane/);
  });
});

describe("pair-review doctor", () => {
  // The shared doctor, with this workflow's roles: the lead's provider is extension-provided (so auth is
  // unverifiable but usable), the peer is authorized. --no-launch keeps it to detection, resolution and readiness.
  const table = ["provider  model  context", "claude-code  claude-opus-5-5  1M", "openai  gpt-6.1-sol  272K"].join("\n");
  const exec = async (cmd, args) => {
    assert.equal(cmd, fakePi);
    if (args[0] === "--list-models") return table;
    const value = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : args[args.indexOf("--model") + 1];
    if (args.includes("--provider")) throw Object.assign(new Error("not found"), { stdout: '{"status":"not_ready","provider":"claude-code","reason":"provider_not_found"}\n', code: 1 });
    if (value.startsWith("openai/")) return '{"status":"ready","provider":"openai","authType":"oauth"}\n';
    throw Object.assign(new Error("invalid"), { stdout: '{"status":"invalid","provider":"claude-code/claude-opus-5-5","reason":"invalid_state"}\n', code: 2 });
  };

  it("prints the shared doctor checks with the reviewers' role names", async () => {
    let text = "";
    const env = { REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    assert.equal(await main(["doctor", "--no-launch"], { env, exec, log: (s) => (text = s) }), 0);
    assert.match(text, /^pair-review doctor: \d+ pass, 0 fail, 1 skipped/);
    assert.match(text, /  pass  mux: rex/);
    assert.match(text, /  pass  lead: claude-code\/claude-opus-5-5 .*listed; auth unverifiable/);
    assert.match(text, /  pass  peer: openai\/gpt-6\.1-sol:xhigh .*ready/);
    assert.match(text, /  skip  launch: skipped \(--no-launch\)/);
    let json = "";
    await main(["doctor", "--json", "--no-launch"], { env, exec, log: (s) => (json = s) });
    assert.deepEqual(JSON.parse(json).checks.map((c) => c.name), ["mux", "pi", "node", "PATH", "lead", "peer", "launch"]);
    // Both variable families set: `--mux rex` selects the transport instead of failing as ambiguous, as a run does.
    const both = { ...env, HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc" };
    assert.equal(await main(["doctor", "--no-launch"], { env: both, exec, log: (s) => (text = s) }), 1);
    assert.match(text, /  fail  mux: none: both Herdr .* and Rex .* are set; pass --mux herdr\|rex/);
    assert.equal(await main(["doctor", "--no-launch", "--mux", "rex"], { env: both, exec, log: (s) => (text = s) }), 0);
    assert.match(text, /  pass  mux: rex \(Rex panes\)\n {8}selected with --mux rex/);
    assert.match(text, /  pass  lead: /);
    assert.match(text, /  pass  peer: /);
  });
});
