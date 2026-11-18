import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";

import { reportWriter } from "./fake-herdr.mjs";
import { adapter, awaitStartup, callerModel, DEFAULTS, DONE, dryLaunch, LAUNCH_EXIT, LAUNCH_ID, detect, findRun, launcherExit, launcherScript, main, modelChecker, modelParts, newRunId, notReadyMessage, parseModelList, prepareLaunch, probeHerdr, readStatus, requireModels, resolveLaunch, resolveModels, resolvePi, run, runPair, tracked, turnText, updateStatus, usageLimit, waitCommand, waitForRun, workerEnv, writeLauncher } from "./pair.mjs";

// A stand-in for the pi executable: A3 requires an absolute, existing path, so the tests resolve this one.
const fakePi = join(mkdtempSync(join(tmpdir(), "pair-pi-")), "pi");
writeFileSync(fakePi, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

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

// The host's own launcher: Windows gets PowerShell (there is no /bin/sh), POSIX gets the shell script. Tests that
// assert a launcher's shape branch on `launcherName` instead of assuming the host; the POSIX script's internals and
// its 0700 mode are covered by the tests that are explicitly POSIX-only.
const launcherName = process.platform === "win32" ? "launch.ps1" : "launch.sh";
/** These tests run the generated POSIX launcher and shell-script fixtures; the PowerShell path is covered elsewhere. */
const POSIX_ONLY = process.platform === "win32" && "runs the POSIX launcher and shell fixtures; windows.test.mjs covers the PowerShell launcher and runs it natively";
/** Whether the generated launcher text starts the fake POSIX `pi` (the fixture is a shell script, not a .exe). */
const launcherRuns = (text) => (process.platform === "win32" ? text.includes(`& "${fakePi}" @args`) : text.includes(`'${fakePi}' "$@"`));
/** The launcher path in an argv: on Windows the PowerShell runner and its flags come first, so never read argv[0]. */
const launcherOf = (argv) => argv.find((arg) => String(arg).endsWith(launcherName));
/** The arguments the launcher itself runs pi with, without a host runner's prefix. */
const launcherArgs = (argv) => argv.slice(argv.indexOf(launcherOf(argv)) + 1);
/** An absolute path in a launch record, on either platform (`C:\\...` or `/...`). */
const ABSOLUTE = String.raw`(?:[A-Za-z]:[\\/]|\/)`;

/** Run a generated launcher with exactly this environment, and report how it ended and what it printed. */
const runLauncher = (file, env) =>
  new Promise((resolvePromise) => {
    execFile(file, [], { env }, (error, stdout, stderr) => resolvePromise({ code: error ? error.code : 0, stdout, stderr }));
  });
const options = (mux, env, dir = tmp()) => ({ task: "Add a /health endpoint", mux, cwd: "/repo", dir, rounds: 3, implementerModel: DEFAULTS.models.implementer[0], auditorModel: DEFAULTS.models.auditor[0], turnTimeout: "1m", env, ...fast });
const appPaneLs = (terminals) => JSON.stringify({ spaces: [{ tabs: [{ terminals }] }] });
const herdrEnv = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };

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
  it("in Herdr: splits panes with herdr-app, talks through hc, and runs three audit/address rounds", async () => {
    const { exec, calls } = fakeMux();
    const env = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    const dir = tmp();
    const result = await runPair({ ...options("herdr", env, dir), exec });

    const splits = calls.filter((c) => c[0] === "herdr-app" && c[2] === "pane.split").map((c) => JSON.parse(c[3]));
    assert.deepEqual(splits.map((s) => [s.pane, s.direction]), [["p0", "right"], ["p1", "down"]], "implementer beside caller, auditor below implementer");
    // No /bin/sh wrapper: the launcher changes folder itself, so a Windows box works too (E1).
    assert.deepEqual(launcherArgs(splits[0].argv).slice(0, 2), ["--model", "claude-code/claude-opus-5-5"]);
    assert.deepEqual(launcherArgs(splits[1].argv).slice(0, 2), ["--model", "openai/gpt-6.1-sol:xhigh"]);
    // Workers start through a launcher in the run folder, which sets the caller's environment before Pi runs.
    const launcher = launcherOf(splits[0].argv);
    assert.equal(launcher, join(dir, launcherName));
    assert.ok(launcherRuns(readFileSync(launcher, "utf8")), "the launcher runs the resolved pi itself, with no shell wrapper in between");
    if (process.platform === "win32") assert.ok(readFileSync(launcher, "utf8").includes('Set-Location -LiteralPath "/repo"'), "the worker folder comes from the launcher, not a shell wrapper");
    else assert.ok(readFileSync(launcher, "utf8").includes(`cd -- '/repo'`), "the worker folder comes from the launcher, not a shell wrapper");
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
    const env = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    const dir = tmp();
    const result = await runPair({ ...options("rex", env, dir), exec });
    const splits = calls.filter((c) => c[0] === "rex" && c[1] === "split");
    assert.equal(splits.length, 2);
    assert.deepEqual(splits[0].slice(1, 7), ["split", "-s", "sess", "-b", "blk0", "--split=right"]);
    assert.ok(splits[1].includes("--split=below") && splits[1].includes("blk1"));
    assert.ok(splits.every((c) => c.includes("--focus=false")));
    const argv = splits[1].slice(splits[1].indexOf("--") + 1, -1);
    assert.deepEqual(argv.slice(-3), [join(dir, launcherName), "--model", "openai/gpt-6.1-sol:xhigh"], "the same launcher carries the environment in Rex, after the host runner if it has one");
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
      runPair({ ...options("herdr", { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", PAIR_PI_BIN: fakePi }), exec, now: () => (t += 30_000) }),
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
    const opts = { task: "T", mux: "herdr", cwd: "/repo", dir: tmp(), rounds: 1, implementerModel: "a", auditorModel: "b", turnTimeout: "1h", env: { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", PAIR_PI_BIN: fakePi }, ...fast };
    const ls = (terminals) => JSON.stringify({ spaces: [{ tabs: [{ terminals }] }] });
    // Both workers start live (two status checks each); the shared fake terminal then finishes, which the turn loop
    // must report as a gone worker rather than waiting out the turn timeout.
    let getCount = 0;
    const gone = async (cmd, args) => {
      if (args[0] === "ls") return ls([{ terminal: "t0", pane: "p0" }]);
      if (args[1] === "pane.split") return JSON.stringify({ pane: "p9", terminal: "t9" });
      if (args[0] === "get") {
        getCount++;
        return JSON.stringify(getCount <= 4 ? { state: "live", status: { state: "working" } } : { state: "finished", exit_code: 1 });
      }
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
      // Close checks ownership first: both workers carry the labels their run gave them.
      if (cmd === "hc" && args[0] === "get") return JSON.stringify({ state: "live", labels: { "pair.run": "abcd1234", "pair.role": "implementer" } });
      return cmd === "herdr-app" ? "{}" : "";
    };
    const herdr = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc" };
    const logs = [];
    assert.equal(await main(["close", "t1", "t2"], { env: herdr, exec, log: (s) => logs.push(s), ...quiet }), 0);
    assert.deepEqual(calls.filter((c) => c[2] === "pane.close").map((c) => JSON.parse(c[3]).pane), ["p1", "p2"]);
    assert.deepEqual(calls.filter((c) => c[0] === "hc" && c[1] === "rm").map((c) => c[2]), ["t1", "t2"]);
    assert.deepEqual(logs, ["closed t1", "closed t2"]);
    await assert.rejects(main(["close", "t0"], { env: herdr, exec, log: () => {}, ...quiet }), /your own terminal/);
    await assert.rejects(main(["close"], { env: herdr, exec, log: () => {}, ...quiet }), /close needs the worker ids/);

    calls.length = 0;
    const rex = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex" };
    assert.equal(await main(["close", "blk1", "blk2", "--mux", "rex"], { env: rex, exec, log: () => {}, ...quiet }), 0);
    assert.deepEqual(calls, [["rex", "block", "close", "-s", "sess", "blk1"], ["rex", "block", "close", "-s", "sess", "blk2"]]);
  });

  it("refuses to run outside a multiplexer and validates input", async () => {
    const quiet = { log: () => {}, progress: () => {} };
    // A Rex *fixture*: `REX_BIN` is taken as given, so these validation calls do not need Rex installed on the host
    // (a clean CI runner has none). The no-CLI case has its own injected-filesystem test in windows.test.mjs.
    const rex = { REX_SESSION: "s", REX_BLOCK: "b", REX_BIN: "rex" };
    await assert.rejects(main(["run", "--task-file", "/nope"], { env: {}, ...quiet }), /not running inside Herdr/);
    await assert.rejects(main(["run"], { env: rex, ...quiet }), /--task-file/);
    const file = join(tmp(), "task.md");
    writeFileSync(file, "do it");
    await assert.rejects(main(["run", "--task-file", file, "--rounds", "0"], { env: rex, ...quiet }), /--rounds/);
    let out = "";
    assert.equal(await main(["detect"], { env: {}, log: (s) => (out = s) }), 1);
    assert.match(out, /^none/);
  });
});

describe("pair wait and provider limits", () => {
  const quiet = { progress: () => {} };

  it("tracks a run in status.json: running with workers, then done with the summary", async () => {
    const { exec } = fakeMux();
    const dir = tmp();
    const runId = newRunId();
    const env = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    let seen;
    await tracked({ dir, runId, workflow: "pair", script: "pair.mjs", ...quiet }, (note) => {
      seen = readStatus(dir);
      return runPair({ task: "T", mux: "herdr", cwd: "/repo", dir, rounds: 1, implementerModel: "a", auditorModel: "b", turnTimeout: "1m", env, exec, progress: note, runId, ...fast });
    }, (r) => `summary ${r.lastAuditVerdict}`);
    assert.equal(seen.state, "running");
    const done = readStatus(dir);
    assert.equal(done.state, "done");
    assert.equal(done.summary, "summary changes requested");
    assert.deepEqual(done.workers, { implementer: "t1", auditor: "t2" });
    assert.equal(done.result.runId, runId);
    assert.equal(findRun(runId, { roots: [join(dir, "..")] }), dir);
  });

  it("marks a provider limit as stopped and any other error as failed", async () => {
    const stopped = tmp();
    const err = Object.assign(new Error("limit"), { stopReason: "usage-limit" });
    await assert.rejects(tracked({ dir: stopped, runId: "r1", workflow: "pair", script: "s", ...quiet }, async () => { throw err; }, String), /limit/);
    assert.equal(readStatus(stopped).state, "stopped");
    const failed = tmp();
    await assert.rejects(tracked({ dir: failed, runId: "r2", workflow: "pair", script: "s", ...quiet }, async () => { throw new Error("boom"); }, String), /boom/);
    assert.equal(readStatus(failed).state, "failed");
  });

  it("wait returns running after its timeout, the summary once done, and exit 1 when stopped", async () => {
    const dir = tmp();
    updateStatus(dir, { state: "running", runId: "r3", dir, pid: process.pid, last: "waiting for auditor" });
    let t = 0;
    const clock = { sleep: async () => {}, now: () => (t += 60_000) };
    let out = "";
    assert.equal(await waitCommand(dir, { timeout: "5m" }, { log: (s) => (out = s), ...clock }), 0);
    assert.match(out, /^running: .*last: waiting for auditor.*do not end your turn/);

    let polls = 0;
    const finishing = { sleep: async () => { if (++polls === 2) updateStatus(dir, { state: "done", summary: "Pair session complete" }); }, now: () => 0 };
    assert.equal(await waitCommand(dir, {}, { log: (s) => (out = s), ...finishing }), 0);
    assert.equal(out, "Pair session complete");

    updateStatus(dir, { state: "stopped", reason: "auditor t2 stopped on a provider limit" });
    assert.equal(await waitCommand(dir, {}, { log: (s) => (out = s), ...fast }), 1);
    assert.match(out, /^stopped: .*\n.*\nAsk the user/s);
  });

  it("wait marks a run failed when its process died, and rejects unknown runs", async () => {
    const dir = tmp();
    updateStatus(dir, { state: "running", runId: "r4", dir, pid: 999999 });
    const status = await waitForRun(dir, { ...fast, alive: () => false });
    assert.equal(status.state, "failed");
    assert.match(status.reason, /exited without a result/);
    assert.throws(() => findRun("nope", { roots: [tmp()] }), /no pair run nope/);
    await assert.rejects(waitCommand(undefined, {}, { log: () => {} }), /wait needs the run id/);
  });

  it("recognizes provider limit errors on a worker's screen, not ordinary output", () => {
    assert.match(usageLimit("...\nError: Codex error: The usage limit has been reached\n> "), /usage limit has been reached/);
    assert.ok(usageLimit("Claude Code billing: this request was charged to Claude usage credits instead of your plan limits"));
    assert.ok(usageLimit('429 {"type":"error","error":{"type":"GoUsageLimitError"}}'));
    assert.equal(usageLimit("I added a check for when the usage limit has been reached"), null);
    assert.equal(usageLimit(""), null);
  });

  it("stops the run before the turn loop when a worker's screen shows a provider limit instead of waiting out the timeout", async () => {
    const exec = async (cmd, args) => {
      if (args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t0", pane: "p0" }] }] }] });
      if (args[1] === "pane.split") return JSON.stringify({ pane: "p9", terminal: "t9" });
      if (args[0] === "get") return JSON.stringify({ state: "live", status: { state: "idle" } });
      if (args[0] === "read") return "Error: Codex error: The usage limit has been reached\n";
      return cmd.endsWith("herdr-app") ? "{}" : "";
    };
    const opts = { task: "T", mux: "herdr", cwd: "/repo", dir: tmp(), rounds: 1, implementerModel: "a", auditorModel: "b", turnTimeout: "1h", env: { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", PAIR_PI_BIN: fakePi }, exec, ...fast };
    await assert.rejects(runPair(opts), (error) => error.stopReason === "usage-limit" && /implementer t9 stopped on a provider limit/.test(error.message));
  });
  it("stops a Rex worker on a provider limit without turning it into a timeout", async () => {
    // Rex has no agent status, so the turn-freshness gate cannot say the turn started. A limit notice still means the
    // report is never coming, so it must stop the run as `stopped` instead of waiting out the turn timeout. The clock
    // advances past the timeout on every poll: a timeout here would mean the limit check was skipped.
    for (const screen of [
      "Error: Codex error: The usage limit has been reached\n",
      "Claude Code billing: this request was charged to Claude usage credits instead of your plan limits\n",
    ]) {
      const dir = tmp();
      let blocks = 0;
      const exec = async (cmd, args) => {
        if (cmd === "git") return "## main\n";
        if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
        if (args[0] === "split") return JSON.stringify({ block_ids: [`blk${++blocks}`] });
        if (args[0] === "capture") return screen;
        return "{}";
      };
      const env = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
      let clock = 0;
      await assert.rejects(
        tracked({ dir, runId: "rex-limit", workflow: "pair", script: "pair.mjs", progress: () => {} }, () =>
          runPair({ ...options("rex", env, dir), exec, sleep: async () => {}, now: () => (clock += 30_000) }), String),
        (error) => error.stopReason === "usage-limit" && /stopped on a provider limit/.test(error.message),
      );
      assert.equal(readStatus(dir).state, "stopped", "a provider limit is a stop, not a timeout or a failure");
    }
  });
});

describe("pair worker environment", () => {
  it("keeps provider, proxy, locale and config variables and drops session and terminal identity", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/me",
      USERPROFILE: "C:\\Users\\me",
      XDG_CONFIG_HOME: "/x",
      CLAUDE_CONFIG_DIR: "/c",
      ANTHROPIC_API_KEY: "k",
      OPENAI_API_KEY: "k2",
      HTTPS_PROXY: "http://proxy:3128",
      NO_PROXY: "localhost",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PI_OFFLINE: "1",
      PI_SESSION_ID: "s",
      PI_SESSION_FILE: "/s.jsonl",
      PI_CODING_AGENT: "true",
      HC_TERMINAL_ID: "t0",
      HC_SOCKET: "/sock",
      REX_SESSION: "r",
      REX_BLOCK: "b",
      PWD: "/p",
      OLDPWD: "/o",
      SHLVL: "3",
      _: "/bin/node",
      // Shell state a caller can have exported. It is readonly or per-process in the shell that runs the launcher,
      // so replaying it would abort the launch; none of it configures a worker.
      SHELLOPTS: "braceexpand:hashall:interactive-comments",
      BASHOPTS: "checkwinsize",
      UID: "501",
      EUID: "501",
      PPID: "42",
      RANDOM: "17",
      SECONDS: "9",
      LINENO: "1",
      OPTIND: "1",
      PS4: "+ ",
      UNSET: undefined,
    };
    assert.deepEqual(Object.keys(workerEnv(env)).sort(), [
      "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "NO_PROXY", "OPENAI_API_KEY",
      "PATH", "PI_OFFLINE", "USERPROFILE", "XDG_CONFIG_HOME",
    ]);
  });

  it("starts workers through a 0700 launcher that finds node and the caller's tools", { skip: process.platform === "win32" && "the 0700 mode and the POSIX script are not what Windows writes; windows.test.mjs checks the .ps1 and runs it natively" }, async () => {
    const bin = mkdtempSync(join(tmpdir(), "pair-bin-"));
    const home = mkdtempSync(join(tmpdir(), "pair-home-"));
    for (const name of ["node", "claude"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    writeFileSync(join(bin, "pi"), "#!/usr/bin/env node\n", { mode: 0o700 });
    const env = {
      PATH: bin,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      ANTHROPIC_API_KEY: "test-key",
      HTTPS_PROXY: "http://proxy:3128",
      LANG: "en_GB.UTF-8",
      HC_TERMINAL_ID: "t0",
      HC_SOCKET: "/tmp/hc.sock",
      PI_SESSION_ID: "sess-1",
      PI_CODING_AGENT: "true",
      HERDR_APP_BIN: "herdr-app",
      HC_BIN: "hc",
      PAIR_PI_BIN: join(bin, "pi"),
    };
    const { exec, calls } = fakeMux();
    const dir = tmp();
    await runPair({ ...options("herdr", env, dir), exec });

    const split = JSON.parse(calls.find((c) => c[2] === "pane.split")[3]);
    const launcher = launcherOf(split.argv);
    assert.equal(launcher, join(dir, launcherName));
    assert.equal(statSync(launcher).mode & 0o777, 0o700, "the launcher holds the caller's environment");
    const script = readFileSync(launcher, "utf8");
    assert.ok(script.startsWith("#!/bin/sh\n"), "a POSIX launcher on this machine");
    assert.ok(script.includes(`export PATH='${bin}'`), "node's folder comes first, the caller's PATH still finds claude");
    assert.ok(script.includes(`export HOME='${home}'`));
    assert.ok(script.includes(`export CLAUDE_CONFIG_DIR='${join(home, "claude")}'`));
    assert.ok(script.includes("export HTTPS_PROXY='http://proxy:3128'"));
    assert.ok(script.includes("export LANG='en_GB.UTF-8'"));
    assert.ok(script.includes("export ANTHROPIC_API_KEY='test-key'"));
    assert.ok(/^export [A-Za-z_][A-Za-z0-9_]*=/m.test(script), "the caller's environment is exported");
    assert.doesNotMatch(script, /^export (?:PI_SESSION_ID|PI_CODING_AGENT|HC_TERMINAL_ID|HC_SOCKET)=/m, "no session or caller-terminal identity leaks in");
    assert.ok(script.includes("for _pair_item in $(export -p); do"), "inherited variables come from the shell's own builtin, not from `env` on the core's PATH");
    assert.doesNotMatch(script, /\$\(env\)/, "a core PATH without `env` must not defeat the clearing");
    assert.match(script, /^\s+HC_\*\|REX_\*\|HERDR_\*\) ;;/m, "while clearing inherited variables, the worker's own mux identity is kept");
    assert.ok(script.includes("exit 78"), "an environment that cannot be enumerated stops the launch instead of running pi unsanitised");
    assert.ok(script.includes(`'${join(bin, "pi")}' "$@"`), "the absolute pi, so a bare PATH cannot pick another");
    assert.ok(script.includes(`>> '${join(dir, LAUNCH_EXIT)}'`), "the launcher records exit codes for fail-fast startup");
    // The identity is recorded as soon as the shell starts, so a lost creation answer can still be closed later.
    assert.ok(script.includes(`printf '%s\\n' "$_pair_self" > '${join(dir, LAUNCH_ID)}'`), "the launcher records its own terminal for recovery");
    assert.ok(script.indexOf("_pair_self=") < script.indexOf("for _pair_item in"), "before the worker starts or anything can fail");
    assert.ok(script.includes('printf \'%s %s\\n\' "${HC_TERMINAL_ID:-?}"'), "a Herdr worker's exit is recorded under its Herdr identity");
    assert.match(script, /^set \+e \+u \+v \+x$/m, "inherited shell options are neutralised as the first command");
    assert.ok(script.indexOf("set +e +u +v +x") < script.indexOf("\nexport "), "tracing is off before any value is exported");
    assert.ok(script.indexOf("trap _pair_exit EXIT") < script.indexOf("for _pair_item in"), "the exit record covers every later failure");
    assert.doesNotMatch(script, /^export (?:SHELLOPTS|BASHOPTS|UID)=/m, "shell state is never replayed as an assignment");
    assert.deepEqual(launcherArgs(split.argv).slice(0, 2), ["--model", DEFAULTS.models.implementer[0]]);

    assert.deepEqual(readStatus(dir).launch, {
      pi: join(bin, "pi"),
      node: join(bin, "node"),
      entry: null,
      PATH: bin,
      launcher,
      shebang: "#!/usr/bin/env node",
    });
  });

  it("lets the worker find node and its provider tools even from a bare PATH", { skip: POSIX_ONLY }, async () => {
    const bin = mkdtempSync(join(tmpdir(), "pair-bin-"));
    const home = mkdtempSync(join(tmpdir(), "pair-home-"));
    for (const name of ["node", "claude"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    // A pi that reports what it sees: the caller's tools, config, and whether stale core variables leaked in.
    writeFileSync(
      join(bin, "pi"),
      "#!/bin/sh\ncommand -v node\ncommand -v claude\nprintf '%s\\n' \"$CLAUDE_CONFIG_DIR\" \"${PI_SESSION_ID-unset}\" \"${OPENAI_API_KEY-unset}\" \"$HC_TERMINAL_ID\"\n",
      { mode: 0o700 },
    );
    const launch = prepareLaunch({ dir: tmp(), mux: "herdr", env: { PATH: bin, HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), HC_TERMINAL_ID: "caller-terminal", PAIR_PI_BIN: join(bin, "pi") } });
    // The core starts workers with its own login environment: a PATH so bare that it cannot even find `env` (the
    // clearing must not depend on it), its own stale session state, and a provider key the caller does not have
    // (which would override file-based auth). None of that may reach pi.
    const coreEnv = { PATH: "/fixture-no-env-binary", PI_SESSION_ID: "stale-session", OPENAI_API_KEY: "stale-key", HC_TERMINAL_ID: "t9", HC_SOCKET: "/tmp/hc.sock" };
    const output = await new Promise((resolvePromise, reject) => {
      execFile(launch.launcher, [], { env: coreEnv }, (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolvePromise(stdout)));
    });
    assert.deepEqual(output.trim().split("\n"), [join(bin, "node"), join(bin, "claude"), join(home, "claude"), "unset", "unset", "t9"], "the caller's tools and config are there; stale session and keys are not; the worker keeps its own terminal id");
    assert.equal(readFileSync(join(launch.exitFile.split(LAUNCH_EXIT)[0], LAUNCH_EXIT), "utf8").trim(), "t9 0", "the launcher records how the worker ended");
  });

  it("records the exit under the selected mux's identity, not the other mux's stale one", { skip: POSIX_ONLY }, async () => {
    const bin = mkdtempSync(join(tmpdir(), "pair-bin-"));
    writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    const launch = prepareLaunch({ dir: tmp(), mux: "rex", env: { PATH: process.env.PATH, PAIR_PI_BIN: join(bin, "pi") } });
    // The core can carry both identities (the CLI then demands --mux). A Rex worker recorded under the inherited
    // Herdr address would never match its own exit record, and the no-status death signal would be lost.
    const code = await new Promise((resolvePromise) => {
      execFile(launch.launcher, [], { env: { PATH: "/usr/bin", HC_TERMINAL_ID: "stale-t0", REX_BLOCK: "blk3" } }, (error) => resolvePromise(error ? error.code : 0));
    });
    assert.equal(code, 7, "the launcher exits with the worker's own code");
    assert.equal(launcherExit(launch.exitFile, "blk3"), 7, "a Rex worker's exit is filed under REX_BLOCK");
    assert.equal(launcherExit(launch.exitFile, "stale-t0"), null, "the inherited Herdr address is not the worker's identity");
  });

  it("refuses to start pi when it cannot read the inherited environment to clear it", { skip: POSIX_ONLY }, async () => {
    // A shell whose `export -p` yields nothing must not leave the core's environment in place: the launcher stops with
    // its own code instead. (Simulated by emptying the word list, so the guard itself is exercised.)
    const dir = tmp();
    const pi = join(dir, "pi");
    writeFileSync(pi, `#!/bin/sh\ntouch ${join(dir, "ran")}\n`, { mode: 0o700 });
    const launch = prepareLaunch({ dir, mux: "rex", env: { PATH: process.env.PATH, PAIR_PI_BIN: pi } });
    writeFileSync(launch.launcher, readFileSync(launch.launcher, "utf8").replace("for _pair_item in $(export -p); do", "for _pair_item in; do"), { mode: 0o700 });
    const { code, stderr } = await runLauncher(launch.launcher, { PATH: "/usr/bin", REX_BLOCK: "blk3" });
    assert.equal(code, 78, "the launcher refuses instead of continuing unsanitised");
    assert.match(stderr, /could not read the inherited environment/);
    assert.ok(!existsSync(join(dir, "ran")), "pi never ran in the core's environment");
    assert.equal(launcherExit(launch.exitFile, "blk3"), 78, "a bootstrap failure is recorded, not silent");
    // Integrated: a transport without agent status must reject this worker, not accept it after the window and then
    // report an ordinary turn timeout.
    const panes = { layout: "panes", read: async () => "pair launcher: could not read the inherited environment (export -p) to clear it\n" };
    let ticks = 0;
    await assert.rejects(
      awaitStartup("blk3", { panes, role: "doer", launch: launch.record, dir, exitFile: launch.exitFile, sleep: async () => {}, now: () => (ticks += 1000) }),
      /worker doer blk3 did not start: it exited \(code 78\) before taking its first turn/,
    );
  });

  it("records a failure before pi runs, for a bootstrap path the guard does not cover", { skip: POSIX_ONLY }, async () => {
    // An assignment the shell refuses (a readonly variable the drop list cannot know about) ends the launch before pi.
    // The record must still say how it ended, or the worker looks like one that is slowly starting.
    const dir = tmp();
    const pi = join(dir, "pi");
    writeFileSync(pi, `#!/bin/sh\ntouch ${join(dir, "ran")}\n`, { mode: 0o700 });
    const launch = prepareLaunch({ dir, mux: "rex", env: { PATH: process.env.PATH, PAIR_PI_BIN: pi } });
    writeFileSync(
      launch.launcher,
      readFileSync(launch.launcher, "utf8").replace(`'${pi}' "$@"`, `readonly _pair_probe=one\n_pair_probe=two\n'${pi}' "$@"`),
      { mode: 0o700 },
    );
    const { code } = await runLauncher(launch.launcher, { PATH: "/usr/bin", REX_BLOCK: "blk3" });
    assert.notEqual(code, 0, "the shell aborts the launch");
    assert.ok(!existsSync(join(dir, "ran")), "pi never ran");
    assert.equal(launcherExit(launch.exitFile, "blk3"), code, "the recorded status is the launcher's own, not a guess");
  });

  it("never prints the caller's provider values when the core's shell options enable tracing", { skip: POSIX_ONLY }, async () => {
    const key = "fixture-provider-key-not-real";
    const bin = mkdtempSync(join(tmpdir(), "pair-bin-"));
    // The worker reports whether the key arrived, without printing its value.
    writeFileSync(join(bin, "pi"), '#!/bin/sh\n[ -n "$ANTHROPIC_API_KEY" ] && echo key-present\necho worker-started\n', { mode: 0o700 });
    const launch = prepareLaunch({ dir: tmp(), mux: "rex", env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: key, PAIR_PI_BIN: join(bin, "pi") } });
    // A core that exported SHELLOPTS=xtrace (macOS /bin/sh honors it) would trace every `export` the launcher makes;
    // verbose would echo the launcher source. Either would put the caller's secrets on the worker's terminal.
    for (const options of ["braceexpand:hashall:interactive-comments:xtrace", "braceexpand:hashall:interactive-comments:verbose"]) {
      writeFileSync(launch.exitFile, "");
      const { code, stdout, stderr } = await runLauncher(launch.launcher, { PATH: "/usr/bin", REX_BLOCK: "blk3", SHELLOPTS: options });
      assert.equal(code, 0, `${options}: the worker still starts`);
      assert.match(stdout, /worker-started/);
      assert.match(stdout, /key-present/, "the caller's provider key still reaches the worker");
      assert.ok(!stdout.includes(key) && !stderr.includes(key), `${options}: the value is never printed`);
      assert.equal(launcherExit(launch.exitFile, "blk3"), 0);
    }
  });

  it("launches a worker whose caller exported readonly shell variables", { skip: POSIX_ONLY }, async () => {
    const bin = mkdtempSync(join(tmpdir(), "pair-bin-"));
    writeFileSync(join(bin, "pi"), '#!/bin/sh\n[ -n "$ANTHROPIC_API_KEY" ] && echo key-present\necho worker-started\n', { mode: 0o700 });
    // Replaying SHELLOPTS or UID as `export NAME=value` aborts the launch in the shell that runs the launcher
    // (`SHELLOPTS: readonly variable`), even though the caller's Pi works. They are session state, not config.
    const launch = prepareLaunch({
      dir: tmp(),
      mux: "herdr",
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "fixture-provider-key-not-real", SHELLOPTS: "braceexpand:hashall:interactive-comments", BASHOPTS: "checkwinsize", UID: "12345", PAIR_PI_BIN: join(bin, "pi") },
    });
    assert.doesNotMatch(readFileSync(launch.launcher, "utf8"), /^export (?:SHELLOPTS|BASHOPTS|UID)=/m, "dropped, not assigned and ignored");
    const { code, stdout, stderr } = await runLauncher(launch.launcher, { PATH: "/usr/bin", HC_TERMINAL_ID: "t7", UID: "12345" });
    assert.equal(code, 0, "the launch is not aborted by a readonly assignment");
    assert.doesNotMatch(stderr, /readonly/, "and no assignment error had to be swallowed");
    assert.match(stdout, /worker-started/);
    assert.match(stdout, /key-present/, "the caller's real provider variables still arrive");
    assert.equal(launcherExit(launch.exitFile, "t7"), 0);
  });

  it("starts the worker whatever shell options the core's environment turns on", { skip: POSIX_ONLY }, async () => {
    const bin = mkdtempSync(join(tmpdir(), "pair-bin-"));
    writeFileSync(join(bin, "pi"), "#!/bin/sh\necho worker-started\n", { mode: 0o700 });
    const launch = prepareLaunch({ dir: tmp(), mux: "herdr", env: { PATH: process.env.PATH, PAIR_PI_BIN: join(bin, "pi") } });
    // errexit would abort on the refused `unset` of readonly shell state, nounset on any unset reference: neither is
    // this launcher's option to inherit, and both would kill a worker that would otherwise start.
    const { code, stdout } = await runLauncher(launch.launcher, { PATH: "/fixture-no-env-binary", HC_TERMINAL_ID: "t7", SHELLOPTS: "braceexpand:hashall:errexit:nounset" });
    assert.equal(code, 0);
    assert.match(stdout, /worker-started/);
    assert.equal(launcherExit(launch.exitFile, "t7"), 0);
  });

  it("uses the interpreter pi's shebang names, ahead of the caller's PATH", { skip: process.platform === "win32" && "a #! shebang is not how Windows starts a program; windows.test.mjs covers .exe and PATHEXT resolution" }, () => {
    const dir = tmp();
    const node = join(dir, "node");
    const pi = join(dir, "pi");
    writeFileSync(node, "", { mode: 0o700 });
    writeFileSync(pi, `#!${node}\n`);
    const launch = resolveLaunch({ env: { PAIR_PI_BIN: pi, HOME: dir, PATH: "/nowhere" }, execPath: join(dir, "missing-node") });
    assert.deepEqual([launch.pi, launch.node, launch.PATH], [pi, node, `${dir}:/nowhere`]);
  });

  it("quotes values for the shell and writes a PowerShell launcher on Windows", () => {
    const dir = tmp();
    assert.ok(launcherScript({ env: { GREETING: "it's here" }, pi: "/opt/pi", platform: "linux" }).includes(`export GREETING='it'\\''s here'`), "a single quote cannot break out on the POSIX launcher");
    const file = writeLauncher({ dir, env: { PATH: "C:\\tools", HOME: "C:\\Users\\me", PERCENT: "50%" }, pi: "C:\\tools\\pi.cmd", exitFile: join(dir, LAUNCH_EXIT), idFile: join(dir, LAUNCH_ID), mux: "herdr", platform: "win32" });
    assert.equal(file, join(dir, "launch.ps1"));
    const script = readFileSync(file, "utf8");
    assert.ok(!script.includes("@echo off"), "no batch: cmd cannot run another batch and regain control to record the exit");
    assert.ok(script.includes("[Environment]::SetEnvironmentVariable('PATH', \"C:\\tools\")"));
    assert.ok(script.includes("[Environment]::SetEnvironmentVariable('PERCENT', \"50%\")"), "a value is a PowerShell string literal, so % needs no escaping");
    assert.ok(script.includes('& "C:\\tools\\pi.cmd" @args'), "the batch shim is a child, so the launcher continues afterwards");
    assert.ok(script.includes('$pairId = $env:HC_TERMINAL_ID'), "the launcher records the selected mux's identity");
    assert.ok(script.includes("exit $pairCode"), "and the exit code");
    assert.ok(script.includes(`[IO.File]::AppendAllText(\"${join(dir, LAUNCH_EXIT)}\", \"$pairId $pairCode\``), "appended to the same exit file");
    assert.ok(script.includes(`[IO.File]::WriteAllText(\"${join(dir, LAUNCH_ID)}\", \"$pairId\``), "and its identity, for recovery");
    assert.ok(script.indexOf("$pairId = $env:HC_TERMINAL_ID") < script.indexOf("@args"), "the identity is read before pi runs");
  });
});

/** A fake `pi` for the readiness probes: the `--list-models` table, the model auth checks, and provider checks. */
function fakePiChecks({ listed = {}, auth = {}, providers } = {}) {
  const calls = [];
  const answer = (result) => {
    if (result.status === "ready") return `${JSON.stringify(result)}\n`;
    // Exit 1 is not_ready, 2 invalid, with the structured reason on stdout as Pi prints it.
    throw Object.assign(new Error(`${fakePi} auth check: ${JSON.stringify(result)}`), { stdout: `${JSON.stringify(result)}\n`, code: result.status === "invalid" ? 2 : 1 });
  };
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== fakePi) throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    if (args[0] === "--list-models") {
      const search = args[1];
      const rows = Object.entries(listed).flatMap(([provider, ids]) => ids.map((id) => ({ provider, id })));
      const found = search ? rows.filter((row) => row.id.includes(search)) : rows;
      if (!found.length) return `No models matching "${search}"\n`;
      return ["provider  model  context  max-out  thinking  images", ...found.map((row) => `${row.provider}  ${row.id}  1M  128K  yes  yes`)].join("\n");
    }
    if (args[0] === "auth" && args[1] === "check") {
      const value = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : args[args.indexOf("--model") + 1];
      if (args[2] === "--provider") {
        if (!providers) throw new Error(`unexpected provider check ${value}`);
        return answer(providers[value] ?? { status: "not_ready", provider: value, reason: "provider_not_found" });
      }
      return answer(auth[value] ?? { status: "not_ready", provider: value.split("/")[0], reason: "credentials_not_configured" });
    }
    throw new Error(`unexpected pi call ${args.join(" ")}`);
  };
  return { exec, calls };
}
const checkerFor = (exec, env = {}) => modelChecker({ pi: fakePi, env, cwd: "/repo", exec });
const NOT_READY = { status: "not_ready", reason: "credentials_not_configured" };
const READY = { status: "ready", authType: "api_key" };
const INVALID_STATE = { status: "invalid", reason: "invalid_state" };
const PROVIDER_NOT_FOUND = { status: "not_ready", reason: "provider_not_found" };

describe("pair model readiness", () => {
  it("strips only a known reasoning level from the model id", () => {
    assert.deepEqual(modelParts("openai/gpt-6.1-sol:xhigh"), { spec: "openai/gpt-6.1-sol:xhigh", model: "openai/gpt-6.1-sol", thinking: "xhigh", provider: "openai", id: "gpt-6.1-sol" });
    assert.equal(modelParts("opencode/model:free").model, "opencode/model:free", "an id's own colon is not a thinking suffix");
    assert.deepEqual(modelParts("sonnet"), { spec: "sonnet", model: "sonnet", thinking: null, provider: null, id: "sonnet" });
    assert.deepEqual(parseModelList("provider  model  context\nopenai  gpt-4.1  1M\nNo models matching \"x\"\n"), [{ provider: "openai", model: "gpt-4.1" }]);
  });

  it("treats a listed model whose provider pi auth check cannot load as usable but unverified", async () => {
    // The incident (#4): `claude-code` is an extension-provided provider, and `pi auth check` builds its own model
    // runtime without extension providers. It therefore answers invalid_state for the model and provider_not_found
    // for the provider, while `pi --list-models` lists the model and `claude auth status` says logged in. Treating
    // that as not ready blocked every default run, so it is "listed, auth unverifiable" and the startup check (F1)
    // catches a worker that cannot authenticate after all.
    const { exec, calls } = fakePiChecks({
      listed: { "claude-code": ["claude-opus-5-5"], anthropic: ["claude-opus-5-5"], openai: ["gpt-6.1-sol"] },
      auth: { "claude-code/claude-opus-5-5": INVALID_STATE, "anthropic/claude-opus-5-5": NOT_READY, "openai/gpt-6.1-sol": READY },
      providers: { "claude-code": PROVIDER_NOT_FOUND },
    });
    const choices = await resolveModels({
      roles: ["implementer"],
      preferences: { implementer: ["claude-code/claude-opus-5-5", "anthropic/claude-opus-5-5"] },
      checker: checkerFor(exec),
    });
    assert.equal(choices.implementer.model, "claude-code/claude-opus-5-5", "the first preference is usable, so later ones are not probed");
    assert.equal(choices.implementer.ready, true);
    assert.equal(choices.implementer.verified, false, "but its auth was not verified");
    assert.deepEqual(choices.implementer.checked, [
      { model: "claude-code/claude-opus-5-5", ready: true, verified: false, detail: "listed; auth unverifiable (claude-code is not loaded by pi auth check (provider_not_found); pi --list-models lists the model)" },
    ]);
    assert.deepEqual(calls.filter((c) => c[1] === "auth").map((c) => c.slice(2).join(" ")), [
      "check --model claude-code/claude-opus-5-5 --json",
      "check --provider claude-code --json",
    ], "the provider is asked once, to tell an unloadable provider from an unauthorized one");
    // The same spec from the caller, which is how the orchestrator on claude-code runs /pair.
    const caller = await resolveModels({
      roles: ["implementer"],
      preferences: { implementer: ["anthropic/claude-opus-5-5"] },
      callerRole: "implementer",
      env: { PI_PROVIDER: "claude-code", PI_MODEL: "claude-opus-5-5" },
      checker: checkerFor(exec),
    });
    assert.equal(caller.implementer.model, "claude-code/claude-opus-5-5");
    // `models` reports it as ready and says why the auth could not be checked.
    let text = "";
    assert.equal(await main(["models"], { env: { PAIR_PI_BIN: fakePi, PATH: "/usr/bin" }, exec: fakePiChecks({ listed: { "claude-code": ["claude-opus-5-5"], openai: ["gpt-6.1-sol"] }, auth: { "claude-code/claude-opus-5-5": INVALID_STATE, "openai/gpt-6.1-sol": READY }, providers: { "claude-code": PROVIDER_NOT_FOUND } }).exec, log: (s) => (text = s) }), 0);
    assert.match(text, /implementer {2}claude-code\/claude-opus-5-5/);
    assert.match(text, /ready \(auth unverifiable\)/);
    assert.match(text, /auth: listed; auth unverifiable \(claude-code is not loaded by pi auth check/);
  });

  it("still blocks a built-in provider that reports a real not_ready", async () => {
    // A provider that `pi auth check` knows answers for itself: credentials_not_configured is a real answer, not an
    // unloadable provider, and no model of it may be used on the strength of --list-models alone.
    const { exec } = fakePiChecks({
      listed: { anthropic: ["claude-opus-5-5"], openai: ["gpt-6.1-sol"] },
      auth: { "anthropic/claude-opus-5-5": INVALID_STATE, "openai/gpt-6.1-sol": READY },
      providers: { anthropic: NOT_READY },
    });
    const choices = await resolveModels({ roles: ["implementer"], preferences: { implementer: ["anthropic/claude-opus-5-5"] }, checker: checkerFor(exec) });
    assert.equal(choices.implementer.model, null);
    assert.equal(choices.implementer.checked[0].detail, "credentials_not_configured");
    assert.deepEqual(choices.implementer.alternatives, ["openai/gpt-6.1-sol"]);
    assert.throws(() => requireModels(choices, ["implementer"]), /implementer model anthropic\/claude-opus-5-5 is not ready: credentials_not_configured; ready alternatives: openai\/gpt-6\.1-sol; pass --implementer-model/);
    // A provider that is authorized while the model stays unresolvable is not evidence against the model: the model
    // is listed, so it is usable but unverified too.
    const authorized = fakePiChecks({
      listed: { deep: ["alpha"] },
      auth: { "deep/alpha": INVALID_STATE },
      providers: { deep: READY },
    });
    const usable = await resolveModels({ roles: ["doer"], preferences: { doer: ["deep/alpha"] }, checker: checkerFor(authorized.exec) });
    assert.deepEqual([usable.doer.model, usable.doer.verified], ["deep/alpha", false]);
    assert.match(usable.doer.checked[0].detail, /cannot resolve deep\/alpha \(invalid_state\) although provider deep is authorized/);
  });

  it("picks the first ready preference and caches every probe for the run", async () => {
    const { exec, calls } = fakePiChecks({
      listed: { "claude-code": ["claude-opus-5-5"], anthropic: ["claude-opus-5-5"], openai: ["gpt-6.1-sol"] },
      auth: { "claude-code/claude-opus-5-5": NOT_READY, "anthropic/claude-opus-5-5": READY, "openai/gpt-6.1-sol": READY },
    });
    const choices = await resolveModels({
      roles: ["implementer", "auditor"],
      preferences: { implementer: ["claude-code/claude-opus-5-5", "anthropic/claude-opus-5-5"], auditor: ["openai/gpt-6.1-sol:xhigh"] },
      checker: checkerFor(exec),
    });
    assert.equal(choices.implementer.model, "anthropic/claude-opus-5-5", "the first ready preference, not the first one");
    assert.equal(choices.implementer.reason, "preference 2 of 2");
    assert.deepEqual(choices.implementer.checked.map((c) => [c.model, c.ready, c.detail]), [
      ["claude-code/claude-opus-5-5", false, "credentials_not_configured"],
      ["anthropic/claude-opus-5-5", true, "ready (api_key)"],
    ]);
    assert.equal(choices.auditor.model, "openai/gpt-6.1-sol:xhigh");
    assert.deepEqual(calls.filter((c) => c[1] === "auth").map((c) => c[4]), ["claude-code/claude-opus-5-5", "anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"], "the thinking suffix is not part of the id");
    // Probing the same model again (another role, another preference) is served from the run's cache.
    const before = calls.length;
    assert.equal((await resolveModels({ roles: ["a"], preferences: { a: ["anthropic/claude-opus-5-5"] }, checker: checkerFor(exec) })).a.model, "anthropic/claude-opus-5-5");
    assert.ok(calls.length > before, "a fresh checker probes again: the cache is per run");
  });

  it("uses the caller's own model for the orchestrator's role and only that role", async () => {
    const { exec } = fakePiChecks({
      listed: { "claude-code": ["claude-opus-5-5"], opencode: ["deepseek-v4.1-flash"], openai: ["gpt-6.1-sol"] },
      auth: { "claude-code/claude-opus-5-5": NOT_READY, "opencode/deepseek-v4.1-flash": READY, "openai/gpt-6.1-sol": READY },
    });
    const env = { PI_PROVIDER: "opencode", PI_MODEL: "deepseek-v4.1-flash" };
    const choices = await resolveModels({
      roles: ["doer", "verifier"],
      preferences: { doer: ["claude-code/claude-opus-5-5"], verifier: ["openai/gpt-6.1-sol"] },
      callerRole: "doer",
      env,
      checker: checkerFor(exec, env),
    });
    assert.equal(choices.doer.model, "opencode/deepseek-v4.1-flash");
    assert.match(choices.doer.reason, /PI_PROVIDER\/PI_MODEL/);
    assert.equal(choices.verifier.model, "openai/gpt-6.1-sol", "the reviewer stays a different model from the orchestrator");
    // An unready caller model is not used, and falls back to the role's preferences.
    const unready = await resolveModels({
      roles: ["doer"],
      preferences: { doer: ["openai/gpt-6.1-sol"] },
      callerRole: "doer",
      env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-opus-5-5" },
      checker: checkerFor(exec, env),
    });
    assert.equal(unready.doer.model, "openai/gpt-6.1-sol");
  });

  it("uses an explicit model as given, but still checks it before any pane opens", async () => {
    const { exec } = fakePiChecks({
      listed: { openai: ["gpt-6.1-sol", "gpt-4.1"], anthropic: ["claude-opus-5-5"] },
      auth: { "openai/gpt-4.1": READY, "openai/gpt-6.1-sol": NOT_READY },
    });
    const ready = await resolveModels({ roles: ["auditor"], preferences: { auditor: ["openai/gpt-6.1-sol"] }, overrides: { auditor: "openai/gpt-4.1" }, checker: checkerFor(exec) });
    assert.deepEqual([ready.auditor.model, ready.auditor.reason], ["openai/gpt-4.1", "passed as --auditor-model"]);
    const unready = await resolveModels({ roles: ["auditor"], preferences: { auditor: ["openai/gpt-6.1-sol"] }, overrides: { auditor: "openai/gpt-6.1-sol:xhigh" }, checker: checkerFor(exec) });
    assert.throws(() => requireModels(unready, ["auditor"]), /auditor model openai\/gpt-6\.1-sol:xhigh is not ready: credentials_not_configured; ready alternatives: openai\/gpt-4\.1; pass another --auditor-model/);
  });

  it("stops with the ready alternatives, and never swaps a model to another provider on its own", async () => {
    // `opencode/claude-opus-5-5` is ready, and the same model id. Using it would be a silent provider swap, so the
    // role fails and names it as something the user may pass deliberately.
    const { exec } = fakePiChecks({
      listed: { "claude-code": ["claude-opus-5-5"], opencode: ["claude-opus-5-5"], openai: ["gpt-6.1-sol"] },
      auth: { "claude-code/claude-opus-5-5": NOT_READY, "opencode/claude-opus-5-5": READY, "openai/gpt-6.1-sol": READY },
    });
    const choices = await resolveModels({ roles: ["implementer"], preferences: { implementer: ["claude-code/claude-opus-5-5"] }, checker: checkerFor(exec) });
    assert.equal(choices.implementer.model, null, "nothing is chosen");
    assert.deepEqual(choices.implementer.alternatives, ["opencode/claude-opus-5-5"], "named, never chosen: discovery stops at the first ready alternative");
    assert.throws(
      () => requireModels(choices, ["implementer"]),
      /^Error: implementer model claude-code\/claude-opus-5-5 is not ready: credentials_not_configured; ready alternatives: opencode\/claude-opus-5-5; pass --implementer-model$/,
    );
  });

  it("keeps a slash inside the caller's model id inside its provider", async () => {
    // Pi documents PI_MODEL as the raw model id; a router provider's ids contain slashes. Reading the slash as a
    // provider prefix would silently run anthropic/claude-opus-5-5 instead of the caller's openrouter model.
    assert.equal(callerModel({ PI_PROVIDER: "openrouter", PI_MODEL: "anthropic/claude-opus-5-5" }), "openrouter/anthropic/claude-opus-5-5");
    // An id can even begin with its own provider's name: OpenRouter's `openrouter/free` is provider `openrouter`,
    // id `openrouter/free`. Prefix-stripping would look for the id `free`.
    assert.equal(callerModel({ PI_PROVIDER: "openrouter", PI_MODEL: "openrouter/free" }), "openrouter/openrouter/free");
    assert.equal(callerModel({ PI_PROVIDER: "openai", PI_MODEL: "openai/gpt-6.1-sol" }), "openai/openai/gpt-6.1-sol", "the fields are literal, never pre-qualified");
    assert.equal(callerModel({ PI_MODEL: "sonnet" }), "sonnet", "with no PI_PROVIDER there is nothing to qualify it with");
    assert.equal(callerModel({}), null);

    const { exec, calls } = fakePiChecks({
      listed: { anthropic: ["claude-opus-5-5"], openrouter: ["anthropic/claude-opus-5-5", "openrouter/free", "free"], openai: ["gpt-6.1-sol"] },
      auth: { "anthropic/claude-opus-5-5": READY, "openrouter/anthropic/claude-opus-5-5": READY, "openrouter/openrouter/free": READY },
    });
    const env = { PI_PROVIDER: "openrouter", PI_MODEL: "anthropic/claude-opus-5-5" };
    const choices = await resolveModels({ roles: ["doer"], preferences: { doer: ["openai/gpt-6.1-sol"] }, callerRole: "doer", env, checker: checkerFor(exec, env) });
    assert.equal(choices.doer.model, "openrouter/anthropic/claude-opus-5-5", "the caller's own provider and id");
    assert.deepEqual(calls.filter((c) => c[1] === "auth").map((c) => c[4]), ["openrouter/anthropic/claude-opus-5-5"], "the id's slash is not read as a provider");

    // The regression the audit found: a literal `openrouter/free` id must be selected as openrouter/openrouter/free.
    const free = fakePiChecks({ listed: { openrouter: ["openrouter/free", "free"] }, auth: { "openrouter/openrouter/free": READY } });
    const picked = await resolveModels({
      roles: ["doer"],
      preferences: { doer: ["openrouter/other"] },
      callerRole: "doer",
      env: { PI_PROVIDER: "openrouter", PI_MODEL: "openrouter/free" },
      checker: checkerFor(free.exec),
    });
    assert.equal(picked.doer.model, "openrouter/openrouter/free", "the raw id is kept whole");
    assert.deepEqual(free.calls.filter((c) => c[1] === "auth").map((c) => c[4]), ["openrouter/openrouter/free"], "probed under that exact spec");
  });

  it("resolves the caller's pi and PATH from the caller directory, not the worker's --cwd", async () => {
    // A relative PAIR_PI_BIN and PATH entry belong to the directory the orchestrator runs in; `--cwd` moves the worker,
    // and resolving against it would fail preflight (`<worker>/bin/pi`) or check a different Pi than the one launched.
    const caller = tmp();
    const worker = tmp();
    // On Windows a command name resolves through PATHEXT, so the fixture pi is `pi.exe`; a shebang-less name is not
    // something Windows starts (E2). The relative-override and relative-PATH behaviour is the same.
    const piName = process.platform === "win32" ? "pi.exe" : "pi";
    const piRel = join("bin", piName);
    mkdirSync(join(caller, "bin"), { recursive: true });
    writeFileSync(join(caller, piRel), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const table = ["provider  model  context", "claude-code  claude-opus-5-5  1M", "anthropic  claude-opus-5-5  1M", "openai  gpt-6.1-sol  272K"].join("\n");
    const exec = async (cmd, args) => {
      assert.equal(realpathSync(cmd), realpathSync(join(caller, piRel)), "the caller's relative PAIR_PI_BIN, resolved against the caller");
      if (args[0] === "--list-models") return table;
      if (args[args.indexOf("--model") + 1] === "openai/gpt-6.1-sol") return '{"status":"ready","provider":"openai","authType":"oauth"}\n';
      throw Object.assign(new Error("not ready"), { stdout: '{"status":"not_ready","reason":"credentials_not_configured"}\n', code: 1 });
    };
    const env = { PAIR_PI_BIN: piRel, PATH: "bin", HOME: caller };
    assert.equal((await resolveModels({ roles: ["auditor"], preferences: { auditor: ["openai/gpt-6.1-sol"] }, env, cwd: worker, callerCwd: caller, exec })).auditor.model, "openai/gpt-6.1-sol");

    // The CLI keeps the same split: `models --cwd <worker>` resolves pi in the caller's directory and probes there.
    const cwd = process.cwd();
    try {
      process.chdir(caller);
      let text = "";
      assert.equal(await main(["models", "--cwd", worker], { env, exec, log: (s) => (text = s) }), 1, "the implementer has no ready default");
      assert.ok(text.includes(process.platform === "win32" ? `bin\\${piName})` : `bin/${piName})`), "the resolved caller-relative pi is named");
      assert.ok(!text.includes(worker), "the worker's --cwd is where the probes run, not where pi is found");
      assert.match(text, /auditor +openai\/gpt-6\.1-sol/);
      // `run` stops on the model, not on a pi that could not be found in the worker's directory.
      const task = join(worker, "task.md");
      writeFileSync(task, "# Task\n");
      await assert.rejects(
        main(["run", "--task-file", task, "--cwd", worker], { env: { ...env, HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc" }, exec, log: () => {}, progress: () => {} }),
        /implementer model claude-code\/claude-opus-5-5 is not ready/,
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it("finds a ready alternative beyond the first probe budget, for every failed role", async () => {
    // More unready catalog entries than one scan call probes, then the one ready model. Both failed roles must see it:
    // alternatives are derived after discovery finishes, never from a half-filled cache.
    const unready = Array.from({ length: 20 }, (_, i) => `model-${String(i).padStart(2, "0")}`);
    const { exec } = fakePiChecks({ listed: { deep: ["alpha", "beta", "gamma", "delta", ...unready, "good-model"] }, auth: { "deep/good-model": READY } });
    const choices = await resolveModels({
      roles: ["doer", "verifier"],
      preferences: { doer: ["deep/alpha", "deep/beta"], verifier: ["deep/gamma", "deep/delta"] },
      checker: checkerFor(exec),
    });
    assert.deepEqual([choices.doer.model, choices.verifier.model], [null, null]);
    assert.deepEqual(choices.doer.alternatives, ["deep/good-model"], "discovery continues past the first budget");
    assert.deepEqual(choices.verifier.alternatives, ["deep/good-model"], "and its result reaches every role");
    assert.match(notReadyMessage("doer", choices.doer), /ready alternatives: deep\/good-model; pass --doer-model$/);
    // A catalog with nothing ready is reported as how far discovery went, not as a claim about the machine.
    const empty = fakePiChecks({ listed: { deep: ["alpha", "beta"] }, auth: {} });
    const none = await resolveModels({ roles: ["doer"], preferences: { doer: ["deep/alpha"] }, checker: checkerFor(empty.exec) });
    assert.match(notReadyMessage("doer", none.doer), /ready alternatives: none found \(checked 2 models\); pass --doer-model$/);
  });

  it("reports every checked preference in the stop message", async () => {
    const { exec } = fakePiChecks({ listed: { "claude-code": ["claude-opus-5-5"], anthropic: ["claude-opus-5-5"], opencode: ["deepseek-v4.1-flash"] }, auth: { "opencode/deepseek-v4.1-flash": READY } });
    const choices = await resolveModels({
      roles: ["doer"],
      preferences: { doer: ["claude-code/claude-opus-5-5", "anthropic/claude-opus-5-5"] },
      checker: checkerFor(exec),
    });
    assert.throws(
      () => requireModels(choices, ["doer"]),
      (error) => {
        assert.match(error.message, /^doer model claude-code\/claude-opus-5-5 is not ready: credentials_not_configured; also not ready: anthropic\/claude-opus-5-5 \(credentials_not_configured\); ready alternatives: opencode\/deepseek-v4\.1-flash; pass --doer-model$/);
        return true;
      },
    );
  });

  it("stops a run before any pane opens when no default model is ready, naming the alternatives", async () => {
    const calls = [];
    const { exec } = fakePiChecks({
      listed: { "claude-code": ["claude-opus-5-5"], anthropic: ["claude-opus-5-5"], openai: ["gpt-6.1-sol"], opencode: ["gpt-6.1-sol"] },
      auth: { "opencode/gpt-6.1-sol": READY },
    });
    const record = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return exec(cmd, args);
    };
    const task = join(tmp(), "task.md");
    writeFileSync(task, "# Task\n\nAdd /health.\n");
    const env = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    await assert.rejects(
      main(["run", "--task-file", task], { env, exec: record, log: () => {}, progress: () => {} }),
      /^Error: implementer model claude-code\/claude-opus-5-5 is not ready: credentials_not_configured; also not ready: anthropic\/claude-opus-5-5 \(credentials_not_configured\); ready alternatives: opencode\/gpt-6\.1-sol:xhigh; pass --implementer-model$/,
    );
    assert.deepEqual(calls.filter((c) => c.some((arg) => String(arg).includes("pane.split"))), [], "no pane was opened");
    assert.deepEqual(calls.filter((c) => c[0] === "hc"), [], "the transport was never used");
  });

  it("prints models per role with the reason and the ready alternatives", async () => {
    const { exec } = fakePiChecks({
      listed: { "claude-code": ["claude-opus-5-5"], anthropic: ["claude-opus-5-5"], openai: ["gpt-6.1-sol"] },
      auth: { "claude-code/claude-opus-5-5": NOT_READY, "anthropic/claude-opus-5-5": READY, "openai/gpt-6.1-sol": READY },
    });
    const env = { PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    let text = "";
    assert.equal(await main(["models"], { env, exec, log: (s) => (text = s) }), 0);
    assert.match(text, /implementer {2}anthropic\/claude-opus-5-5/);
    assert.match(text, /why: preference 2 of 2/);
    assert.match(text, /auditor {6}openai\/gpt-6\.1-sol:xhigh/);
    assert.match(text, /ready alternatives: openai\/gpt-6\.1-sol/);
    let json = "";
    assert.equal(await main(["models", "--json"], { env, exec, log: (s) => (json = s) }), 0);
    const parsed = JSON.parse(json);
    assert.deepEqual([parsed.workflow, parsed.models.implementer.model, parsed.models.implementer.source], ["pair", "anthropic/claude-opus-5-5", "preference"]);
    // A role with nothing ready makes the command exit 1, so an orchestrator can check before running.
    const blocked = fakePiChecks({ listed: { "claude-code": ["claude-opus-5-5"] }, auth: {} });
    assert.equal(await main(["models"], { env, exec: blocked.exec, log: () => {} }), 1);
  });
});

describe("pair startup detection", () => {
  // Both workers get the same fake pane: the implementer starts first, so its startup check decides the run.
  const startupMux = (get, read = () => "Pi is starting\n") => async (cmd, args) => {
    if (args[0] === "ls") return appPaneLs([{ terminal: "t0", pane: "p0" }]);
    if (args[1] === "pane.split") return JSON.stringify({ pane: "p1", terminal: "t1" });
    if (args[0] === "get") return JSON.stringify(get());
    if (args[0] === "read") return read();
    return cmd.endsWith("herdr-app") ? "{}" : "";
  };

  it("ends the run failed, with the screen and launch record, when the worker dies at launch", async () => {
    const exec = startupMux(() => ({ state: "finished", exit_code: 127 }), () => "/usr/bin/env: 'node': No such file or directory\n");
    const dir = tmp();
    await assert.rejects(
      tracked({ dir, runId: "exit127", workflow: "pair", script: "pair.mjs", progress: () => {} }, () => runPair({ ...options("herdr", herdrEnv, dir), exec }), String),
      (error) => {
        assert.match(error.message, /worker implementer t1 did not start: its terminal is gone \(terminal t1 is finished \(exit 127\)\)/);
        assert.match(error.message, /Screen tail:\n.*No such file or directory/);
        assert.match(error.message, new RegExp(`Launch: pi ${fakePi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, node ${ABSOLUTE}`), "the launch record names the resolved pi and an absolute node");
        assert.match(error.message, new RegExp(`^PATH ${ABSOLUTE}`, "m"));
        assert.ok(error.message.includes(`Launcher and reports: ${dir}`));
        return true;
      },
    );
    const status = readStatus(dir);
    assert.equal(status.state, "failed");
    assert.match(status.reason, /did not start/);
    assert.equal(status.launch.pi, fakePi);
    assert.equal(status.launch.launcher, join(dir, launcherName));
  });

  it("ends the run failed when a live worker's screen shows a startup error", async () => {
    const exec = startupMux(() => ({ state: "live", status: { state: "idle" }, turn: 0 }), () => "No API key found for claude-code.\n\nUse /login to log into a provider via OAuth or API key.\n");
    await assert.rejects(runPair({ ...options("herdr", herdrEnv), exec }), /did not start: its screen shows a startup error: "No API key found for claude-code\."/);
  });

  it("fails a worker that stays idle at turn 0 instead of taking its first turn", async () => {
    const exec = startupMux(() => ({ state: "live", status: { state: "idle" }, turn: 0 }), () => "Pi 1.5.2, ready\n");
    await assert.rejects(runPair({ ...options("herdr", herdrEnv), exec }), /did not start: it reported "idle" at turn 0 for 20s/);
  });

  it("fails startup when the agent reports an error even after starting a turn", async () => {
    // Pi can report an error after turn 1 begins; that is not a successful launch, and the run must not wait for the
    // other worker's whole turn first.
    const exec = startupMux(() => ({ state: "live", status: { state: "error" }, turn: 1 }), () => "Error: provider exploded\n");
    const dir = tmp();
    await assert.rejects(
      tracked({ dir, runId: "agent-error", workflow: "pair", script: "pair.mjs", progress: () => {} }, () => runPair({ ...options("herdr", herdrEnv, dir), exec }), String),
      (error) => {
        assert.match(error.message, /worker implementer t1 did not start: the agent reported an error \(status: error\)/);
        assert.match(error.message, /Screen tail:\n.*provider exploded/);
        assert.match(error.message, new RegExp(`Launch: pi ${fakePi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, node ${ABSOLUTE}`));
        return true;
      },
    );
    assert.match(readStatus(dir).reason, /did not start/);
    // A provider limit on the same error status stays `stopped`, so the user is asked before anything is retried.
    const limited = startupMux(() => ({ state: "live", status: { state: "error" }, turn: 1 }), () => "Error: usage limit has been reached\n");
    await assert.rejects(runPair({ ...options("herdr", herdrEnv), exec: limited }), (error) => error.stopReason === "usage-limit" && /implementer t1 stopped on a provider limit/.test(error.message));
  });

  it("fails a turn whose started worker asks for a login instead of waiting out the turn timeout", async () => {
    // Both first reports are written at launch. After the first send the auditor really starts its turn (working,
    // turn 2) and then sits on a login banner without writing its report: that is a failure, not a slow turn.
    let turning = false;
    let gets = 0;
    let panes = 0;
    const exec = async (cmd, args) => {
      if (cmd === "git") return "## main\n";
      if (args[0] === "ls") return appPaneLs([{ terminal: "t0", pane: "p0" }]);
      if (args[1] === "pane.split") {
        reportWriter(readFileSync, writeFileSync, DONE)(JSON.parse(args[2]).argv.at(-1));
        return JSON.stringify({ pane: `p${++panes}`, terminal: `t${panes}` });
      }
      if (args[0] === "get") {
        if (turning && ++gets === 1) return JSON.stringify({ state: "live", status: { state: "working" }, turn: 2 });
        return JSON.stringify({ state: "live", status: { state: "done" }, turn: turning ? 2 : 1 });
      }
      if (args[0] === "send") {
        turning = true;
        gets = 0;
        return "{}";
      }
      if (args[0] === "read") return "No API key found for claude-code.\nUse /login to log into a provider.\n";
      return cmd.endsWith("herdr-app") ? "{}" : "";
    };
    await assert.rejects(
      runPair({ ...options("herdr", herdrEnv, tmp()), exec }),
      /auditor t2 shows "No API key found for claude-code\." instead of writing .*auditor-audit.*focus its pane/,
    );
  });

  it("does not fail a worker on the previous turn's transcript while the send is being picked up", async () => {
    // Right after hc send the status can still be the previous turn's `done`. The old screen quotes an error; the new
    // report arrives a couple of polls later. Judging that stale transcript would fail a healthy worker.
    let pending = null;
    let getsAfterSend = 0;
    let panes = 0;
    const exec = async (cmd, args) => {
      if (cmd === "git") return "## main\n";
      if (args[0] === "ls") return appPaneLs([{ terminal: "t0", pane: "p0" }]);
      if (args[1] === "pane.split") {
        reportWriter(readFileSync, writeFileSync, DONE)(JSON.parse(args[2]).argv.at(-1));
        return JSON.stringify({ pane: `p${++panes}`, terminal: `t${panes}` });
      }
      if (args[0] === "get") {
        if (pending && ++getsAfterSend >= 4) {
          writeFileSync(pending, `report\n${DONE}\n`);
          pending = null;
        }
        return JSON.stringify({ state: "live", status: { state: "done" }, turn: 1 });
      }
      if (args[0] === "send") {
        const prompt = args.at(-1);
        pending = readFileSync(/read (\S+\.turn\.md)/.exec(prompt)[1], "utf8").match(/write your report as Markdown to:\n\n(\S+)/)[1];
        getsAfterSend = 0;
        return "{}";
      }
      if (args[0] === "read") return "assert.match(screen, /No API key found/);\n";
      return cmd.endsWith("herdr-app") ? "{}" : "";
    };
    const result = await runPair({ ...options("herdr", herdrEnv, tmp()), exec, rounds: 1 });
    assert.equal(result.reports.length, 4, "every turn finished; the stale transcript was not treated as a failure");
  });

  it("counts a turn that advanced before the first observation as started", async () => {
    // The send is picked up and the turn ends quickly, so the first status this turn sees is already idle at turn 2.
    // A baseline taken now would fold that advance in, leave the turn "not started" and never look at the screen; the
    // login banner would then only be noticed by the turn timeout.
    let sent = false;
    let panes = 0;
    let reads = 0;
    const exec = async (cmd, args) => {
      if (cmd === "git") return "## main\n";
      if (args[0] === "ls") return appPaneLs([{ terminal: "t0", pane: "p0" }]);
      if (args[1] === "pane.split") {
        reportWriter(readFileSync, writeFileSync, DONE)(JSON.parse(args[2]).argv.at(-1));
        return JSON.stringify({ pane: `p${++panes}`, terminal: `t${panes}` });
      }
      if (args[0] === "get") return JSON.stringify({ state: "live", status: { state: "idle" }, turn: sent ? 2 : 1 });
      if (args[0] === "send") {
        sent = true;
        return "{}";
      }
      if (args[0] === "read") {
        reads++;
        return "No API key found for claude-code.\nUse /login to log into a provider.\n";
      }
      return cmd.endsWith("herdr-app") ? "{}" : "";
    };
    let t = 0;
    await assert.rejects(
      runPair({ ...options("herdr", herdrEnv, tmp()), exec, now: () => (t += 1000) }),
      /auditor t2 shows "No API key found for claude-code\." instead of writing .*auditor-audit/,
    );
    assert.ok(reads > 0, "the advanced turn's screen was read and diagnosed");
  });

  it("does not stop a transport without agent status on screen text, which is its transcript too", async () => {
    // Rex reports no agent status, so nothing says a turn ended: a login notice on a worker's screen is not evidence
    // that no report is coming. The run completes as usual.
    const written = new Set();
    const prompts = new Map();
    let blocks = 0;
    let captures = 0;
    const blockOf = (args) => args[args.indexOf("-b") + 1];
    const reportOf = (text) => readFileSync(/read (\S+\.turn\.md)/.exec(text ?? "")[1], "utf8").match(/write your report as Markdown to:\n\n(\S+)/)[1];
    const exec = async (cmd, args) => {
      if (cmd === "git") return "## main\n";
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      const [sub] = args;
      if (sub === "split") {
        const id = `blk${++blocks}`;
        prompts.set(id, args.at(-1));
        return JSON.stringify({ block_ids: [id] });
      }
      if (sub === "send") {
        prompts.set(blockOf(args), args.at(-1));
        return "{}";
      }
      if (sub === "capture") {
        // The first two reads are the startup checks; from then on the worker has a login notice on its screen and
        // still writes each report its turn asks for.
        if (++captures >= 3) {
          const report = reportOf(prompts.get(blockOf(args)));
          if (!written.has(report)) {
            writeFileSync(report, `report\n${DONE}\n`);
            written.add(report);
          }
        }
        return captures <= 2 ? "worker screen\n" : "No API key found for claude-code.\nnot authenticated\nworker screen\n";
      }
      return "{}";
    };
    const env = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    const result = await runPair({ ...options("rex", env), exec });
    assert.equal(result.reports.length, 8);
    assert.ok(captures >= 3, "the turn loop read the screen with the login notice on it");
    assert.equal(written.size, 8, "every turn still produced its report");
  });
});

describe("pair startup without agent status (Rex)", () => {
  // A transport with captures but no agent status: nothing says whether a capture predates the first turn.
  const noStatus = (screens) => {
    let index = 0;
    const panes = {
      layout: "panes",
      reads: 0,
      read: async () => {
        panes.reads++;
        return screens[Math.min(index++, screens.length - 1)];
      },
    };
    return panes;
  };
  const launch = tmp();
  const prepared = () => prepareLaunch({ dir: launch, env: { PATH: process.env.PATH, PAIR_PI_BIN: fakePi } });

  it("does not classify a first capture that quotes an error", async () => {
    const panes = noStatus(["doer read the report; the task text says: No API key found for example-provider.\n"]);
    const { record, exitFile } = prepared();
    // The window passes with no exit record and no agent status: the worker is assumed started, and its capture is
    // never treated as a startup failure.
    await awaitStartup("blk1", { panes, role: "doer", launch: record, dir: launch, exitFile, ...fast });
    assert.equal(panes.reads, 0, "a capture is not startup output, so it is not read or classified");
  });

  it("fails a worker whose launcher records an exit after an initially empty screen", async () => {
    const panes = noStatus([""]);
    const { record, exitFile } = prepared();
    let ticks = 0;
    let polls = 0;
    // The failure is delayed: two polls show nothing, then the launcher records exit 127 (e.g. `node` not found).
    const sleep = async () => {
      if (++polls === 2) writeFileSync(exitFile, "blk1 127\n");
    };
    await assert.rejects(
      awaitStartup("blk1", { panes, role: "doer", launch: record, dir: launch, exitFile, sleep, now: () => (ticks += 1000) }),
      /worker doer blk1 did not start: it exited \(code 127\) before taking its first turn/,
    );
    assert.ok(polls >= 2, "the startup window was observed, not a single instant");
  });

  it("reads the launcher's exit record by bare id, and treats an unnamed exit as a failure", () => {
    const dir = tmp();
    const file = join(dir, LAUNCH_EXIT);
    writeFileSync(file, "ubuntu/t1 0\nubuntu/t2 3\n");
    assert.equal(launcherExit(file, "ubuntu/t1"), 0);
    assert.equal(launcherExit(file, "t2"), 3, "a qualified id is matched by its bare address");
    assert.equal(launcherExit(file, "t9"), null);
    writeFileSync(file, "? 127\n");
    assert.equal(launcherExit(file, "blk1"), 127, "an unnamed exit counts for whichever worker is being watched");
    assert.equal(launcherExit(join(dir, "missing.exit"), "t1"), null, "no record yet");
  });
});

describe("pair startup with a status function that reports nothing", () => {
  // Herdr always exposes status(), including for a worker that has not reported OSC status yet or has status
  // reporting turned off. A null status says nothing about whether a capture is startup output, so the screen must
  // not be classified: the same rule as a capture-only transport, with the exit record as the death signal.
  const reportsNothing = (screens) => {
    let index = 0;
    const panes = {
      layout: "panes",
      reads: 0,
      status: async () => null,
      read: async () => {
        panes.reads++;
        return screens[Math.min(index++, screens.length - 1)];
      },
    };
    return panes;
  };
  const launch = tmp();
  const prepared = () => prepareLaunch({ dir: launch, env: { PATH: process.env.PATH, PAIR_PI_BIN: fakePi } });

  it("does not classify a capture that quotes an error when no status was reported", async () => {
    const panes = reportsNothing(["the task text quotes: No API key found for example-provider.\n"]);
    const { record, exitFile } = prepared();
    await awaitStartup("t1", { panes, role: "doer", launch: record, dir: launch, exitFile, ...fast });
    assert.equal(panes.reads, 0, "a capture without an affirmative status is not startup output");
  });

  it("still gives the exit record its startup window", async () => {
    const panes = reportsNothing(["", "the task text quotes: No API key found for example-provider.\n"]);
    const { record, exitFile } = prepared();
    let ticks = 0;
    let polls = 0;
    const sleep = async () => {
      if (++polls === 2) writeFileSync(exitFile, "t1 127\n");
    };
    await assert.rejects(
      awaitStartup("t1", { panes, role: "doer", launch: record, dir: launch, exitFile, sleep, now: () => (ticks += 1000) }),
      /worker doer t1 did not start: it exited \(code 127\) before taking its first turn/,
    );
    assert.ok(polls >= 2, "the window was observed instead of failing on the quoted text");
  });
});

describe("pair pi resolution", () => {
  it("resolves pi against the caller's directory, not the worker's cwd", () => {
    const caller = tmp();
    const worker = tmp();
    // Windows resolves a command name through PATHEXT, so the fixture is `pi.exe` there (the override path works with
    // either name). The caller-versus-worker directory split is the same on both hosts.
    const piName = process.platform === "win32" ? "pi.exe" : "pi";
    const piRel = join("bin", piName);
    mkdirSync(join(caller, "bin"));
    writeFileSync(join(caller, piRel), "#!/bin/sh\n", { mode: 0o700 });
    // A relative override and a relative PATH entry are the caller's files; the worker's cwd cannot change that.
    assert.equal(resolvePi({ env: { PAIR_PI_BIN: piRel }, cwd: caller }), join(caller, piRel));
    assert.equal(resolvePi({ env: { PATH: "bin" }, cwd: caller }), join(caller, piRel));
    assert.equal(resolvePi({ env: { PATH: ["bin", join(worker, "bin")].join(delimiter) }, cwd: caller }), join(caller, piRel));
    // The worker's PATH carries the caller's absolute folders, so a relative entry cannot mean the worker folder.
    const launch = resolveLaunch({ env: { PATH: "bin", PAIR_PI_BIN: piRel }, cwd: caller });
    assert.equal(launch.PATH.split(delimiter)[1], join(caller, "bin"));
  });

  it("fails with an actionable error instead of recording a bare pi", () => {
    assert.throws(() => resolvePi({ env: { PATH: "/nowhere" } }), /pi not found: no executable pi on PATH \(\/nowhere\); install pi/);
    assert.throws(() => resolvePi({ env: { PAIR_PI_BIN: join("missing", "pi") }, cwd: tmp() }), /pi not found: PAIR_PI_BIN=missing[\\/]pi resolves to \S+, which does not exist/);
    assert.throws(() => resolveLaunch({ env: { PAIR_PI_BIN: "not-a-command" }, cwd: tmp(), PATH: undefined }), /PAIR_PI_BIN=not-a-command is not a path and no executable not-a-command on PATH/);
  });
});

describe("qualified Herdr IDs", () => {
  const qualifiedLs = appPaneLs([
    { terminal: "ubuntu/t0", pane: "ubuntu/p0" },
    { terminal: "ubuntu/t1", pane: "ubuntu/p1" },
    { terminal: "ubuntu/t2", pane: "ubuntu/p2" },
  ]);
  const fake = () => {
    const calls = [];
    let n = 0;
    const answer = reportWriter(readFileSync, writeFileSync, DONE, (turn) => (turn.includes("auditor-audit") ? "Verdict: changes requested\n" : ""));
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git") return "## main\n";
      if (cmd === "herdr-app" && args[0] === "ls") return qualifiedLs;
      if (cmd === "herdr-app" && args[1] === "pane.split") {
        answer(JSON.parse(args[2]).argv.at(-1));
        return JSON.stringify({ pane: `ubuntu/p${++n}`, terminal: `ubuntu/t${n}` });
      }
      if (cmd === "herdr-app") return "{}";
      if (cmd === "hc" && args[0] === "send") answer(args.at(-1));
      if (cmd === "hc" && args[0] === "get") return JSON.stringify({ state: "live", status: { state: "done" }, turn: 1, labels: { "pair.run": "abcd1234", "pair.role": "implementer" } });
      if (cmd === "hc" && args[0] === "wait") return JSON.stringify({ reason: "status" });
      return "";
    };
    return { calls, exec };
  };
  const env = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };

  it("matches a machine-qualified caller address and keeps the qualified pane for splits", async () => {
    const { exec, calls } = fake();
    assert.deepEqual(await probeHerdr({ env, exec }), { layout: "panes", terminal: "t0", app: "herdr-app", appHow: "HERDR_APP_BIN" });

    const result = await runPair({ ...options("herdr", env), exec });
    const splits = calls.filter((c) => c[2] === "pane.split").map((c) => JSON.parse(c[3]));
    assert.deepEqual(splits.map((s) => s.pane), ["ubuntu/p0", "ubuntu/p1"], "the app needs the machine qualifier");
    assert.deepEqual(result.panes, { implementer: "ubuntu/t1", auditor: "ubuntu/t2" }, "the ids are kept as the app returned them");
    // The core addresses its own terminals by bare id, so hc must not be given the qualifier.
    assert.deepEqual(calls.filter((c) => c[0] === "hc" && c[1] === "send").map((c) => c[2]), ["t2", "t1", "t2", "t1", "t2", "t1"]);
    assert.deepEqual(calls.filter((c) => c[0] === "hc" && c[1] === "label").map((c) => c[2]), ["t1", "t2"]);
  });

  it("closes a qualified worker through its qualified pane and checks ownership by bare id", async () => {
    const { exec, calls } = fake();
    const logs = [];
    const quiet = { log: (s) => logs.push(s), progress: () => {} };
    assert.equal(await main(["close", "ubuntu/t1"], { env, exec, ...quiet }), 0);
    assert.deepEqual(calls.filter((c) => c[2] === "pane.close").map((c) => JSON.parse(c[3]).pane), ["ubuntu/p1"]);
    assert.deepEqual(calls.filter((c) => c[0] === "hc" && c[1] === "get").map((c) => c[2]), ["t1"]);
    assert.deepEqual(calls.filter((c) => c[0] === "hc" && c[1] === "rm").map((c) => c[2]), ["t1"]);
    assert.deepEqual(logs, ["closed ubuntu/t1"]);
    await assert.rejects(main(["close", "ubuntu/t0"], { env, exec, ...quiet }), /your own terminal/);
  });

  it("names the bare id in hc hints for a qualified worker", async () => {
    const { exec } = fake();
    // The auditor is qualified (`ubuntu/t2`) and blocked on a person; the implementer still reports normally.
    const blocked = async (cmd, args) =>
      (cmd === "hc" && args[0] === "get" && args[1] === "t2" ? JSON.stringify({ state: "live", status: { state: "blocked" }, turn: 1 }) : exec(cmd, args));
    const notes = [];
    let t = 0;
    await assert.rejects(
      runPair({ ...options("herdr", env), exec: blocked, sleep: async () => {}, now: () => (t += 10_000), progress: (s) => notes.push(s) }),
      /worker ubuntu\/t2 is still blocked .*hc read t2 --lines 100/,
    );
    assert.ok(notes.some((s) => s.includes("worker ubuntu/t2 is blocked and needs a person: hc attach t2 ")), "hc gets the bare id, not the app's qualifier");
  });
});

describe("pair doctor", () => {
  const table = ["provider  model  context", "claude-code  claude-opus-5-5  1M", "openai  gpt-6.1-sol  272K"].join("\n");
  // claude-code is listed by --list-models but cannot be resolved by `pi auth check`; openai is authorized.
  const probePi = ({ openai = READY } = {}) => async (args) => {
    if (args[0] === "--list-models") return table;
    const value = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : args[args.indexOf("--model") + 1];
    const answer = args.includes("--provider")
      ? value === "claude-code" ? PROVIDER_NOT_FOUND : value === "openai" ? openai : NOT_READY
      : value.startsWith("claude-code/") ? INVALID_STATE : openai;
    if (answer.status === "ready") return `${JSON.stringify(answer)}\n`;
    throw Object.assign(new Error("not ready"), { stdout: `${JSON.stringify(answer)}\n`, code: answer.status === "invalid" ? 2 : 1 });
  };

  /** Fake `rex` (and pi): the dry launch's block records how `pi --version` ended as soon as it is split. */
  const doctorRex = ({ exit = 0, screen = () => "1.5.2\n", pi = probePi(), record = (id) => `${id} ${exit}\n`, launchers = [] } = {}) => {
    const calls = [];
    let closed = false;
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git") return "## main\n";
      if (cmd === fakePi) return pi(args);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
      if (args[0] === "split") {
        const launcher = launcherOf(args);
        // Read it now: the doctor removes its temporary folder, with the launcher in it, before it returns.
        launchers.push({ path: launcher, script: readFileSync(launcher, "utf8") });
        if (record) writeFileSync(join(dirname(launcher), LAUNCH_EXIT), record("blk1"));
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      // A Rex block closes itself when its command exits, and both close and capture then answer "not found".
      if (args[0] === "capture") {
        if (closed) throw new Error("block not found");
        return screen();
      }
      // Closure is confirmed by the block list, not by an error message.
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: closed ? [] : [{ block_id: "blk1" }] });
      if (args[0] === "block" && args[1] === "close") {
        closed = true;
        return "{}";
      }
      return "{}";
    };
    return { exec, calls };
  };
  const rexEnv = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };

  it("checks the mux, the launch resolution, both roles, and pi --version through the workers' own launcher", async () => {
    const launchers = [];
    const { exec, calls } = doctorRex({ launchers });
    let text = "";
    assert.equal(await main(["doctor"], { env: rexEnv, exec, log: (s) => (text = s) }), 0);
    assert.match(text, /^pair doctor: \d+ pass, 0 fail/);
    assert.match(text, /  pass  mux: rex \(Rex panes\)\n {8}rex: REX_SESSION and REX_BLOCK are set/);
    assert.match(text, /  pass  pi: \S+ \(PAIR_PI_BIN\)/);
    assert.match(text, /  pass  node: \S+/);
    assert.match(text, /  pass  PATH: \d+ entries for the worker: /);
    assert.match(text, /  pass  implementer: claude-code\/claude-opus-5-5 .*listed; auth unverifiable/);
    assert.match(text, /  pass  auditor: openai\/gpt-6\.1-sol:xhigh .*ready \(api_key\)/);
    assert.match(text, /  pass  launch: pi --version in a Rex pane: exit 0, printed 1\.5\.2 \(blk1 closed\)/);

    // It went through the same launcher the workers use, with the environment resolved for the worker…
    const split = calls.find((c) => c[0] === "rex" && c[1] === "split");
    assert.ok(split.includes("--focus=false"));
    assert.deepEqual(split.slice(split.indexOf(launcherOf(split)) + 1), ["--version"], "the version probe is the launcher's only argument");
    const script = launchers[0].script;
    assert.ok(launcherRuns(script), "the doctor's launcher runs the resolved pi, on this host's shell");
    // …and it was closed and removed: no pane left open, no copy of the caller's environment left behind.
    assert.ok(calls.some((c) => c[0] === "rex" && c[1] === "block" && c[2] === "close"));
    assert.ok(!existsSync(launchers[0].path), "the doctor's temporary launch folder is removed");
    assert.ok(!existsSync(dirname(launchers[0].path)));

    let json = "";
    assert.equal(await main(["doctor", "--json"], { env: rexEnv, exec, log: (s) => (json = s) }), 0);
    const report = JSON.parse(json);
    assert.deepEqual([report.workflow, report.ok], ["pair", true]);
    assert.deepEqual(report.checks.map((c) => c.name), ["mux", "pi", "node", "PATH", "implementer", "auditor", "launch"]);
    assert.equal(report.checks.find((c) => c.name === "launch").fix, undefined, "a passing check has no fix line");
  });

  it("dry-launches through Herdr app panes, closes the pane, and shows each detection path tried", async () => {
    const calls = [];
    const terminals = new Map([["t0", "p0"]]);
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git") return "## main\n";
      if (cmd === fakePi) return probePi()(args);
      if (cmd === "herdr-app" && args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [...terminals].map(([terminal, pane]) => ({ terminal, pane })) }] }] });
      if (cmd === "herdr-app" && args[1] === "pane.split") {
        const launcher = JSON.parse(args[2]).argv.find((arg) => arg.endsWith(launcherName));
        writeFileSync(join(dirname(launcher), LAUNCH_EXIT), "t1 0\n");
        terminals.set("t1", "p1");
        return JSON.stringify({ pane: "p1", terminal: "t1" });
      }
      if (cmd === "herdr-app" && args[1] === "pane.close") {
        terminals.delete("t1");
        return "{}";
      }
      if (cmd === "herdr-app") return "{}";
      if (cmd === "hc" && args[0] === "get") {
        // Real hc answers a missing terminal with {"error":{"kind":"not_found",…}} on stdout, exit 3.
        if (!terminals.has(args[1])) throw Object.assign(new Error(`hc get ${args[1]} --json: exit 3`), { stdout: JSON.stringify({ error: { kind: "not_found", message: `no terminal "${args[1]}"` } }) });
        return JSON.stringify({ state: "live", status: { state: "done" } });
      }
      if (cmd === "hc" && args[0] === "read") return "1.5.2\n";
      if (cmd === "hc") return "{}";
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    };
    let text = "";
    const env = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    assert.equal(await main(["doctor"], { env, exec, log: (s) => (text = s) }), 0);
    assert.match(text, /  pass  mux: herdr: panes via herdr-app \(HERDR_APP_BIN\)\n {8}herdr: HC_TERMINAL_ID=t0\n {8}herdr-app: herdr-app \(HERDR_APP_BIN\)\n {8}herdr-app \(herdr-app\) ls: pane p0 shows t0/);
    assert.match(text, /  pass  launch: pi --version in a Herdr pane: exit 0, printed 1\.5\.2 \(t1 closed\)/);
    const split = JSON.parse(calls.find((c) => c[0] === "herdr-app" && c[2] === "pane.split")[3]);
    assert.ok(launcherOf(split.argv), "the same launcher as a worker, started directly: pane.split gets no /bin/sh wrapper");
    assert.ok(!split.argv.includes("/bin/sh"), "nothing here assumes a POSIX shell on the machine that opens terminals");
    assert.deepEqual(split.argv.slice(-1), ["--version"]);
    assert.deepEqual(calls.filter((c) => c[0] === "herdr-app" && c[2] === "pane.focus").map((c) => JSON.parse(c[3]).pane), ["p0"], "focus goes back to the caller after the split");
    assert.deepEqual(calls.filter((c) => c[0] === "herdr-app" && c[2] === "pane.close").map((c) => JSON.parse(c[3]).pane), ["p1"]);
    assert.ok(calls.some((c) => c[0] === "hc" && c[1] === "label" && c[2] === "t1"), "the temporary pane carries the run's ownership labels");
  });

  it("fails a role and the dry launch, with one fix per line, and still closes the pane", async () => {
    const { exec, calls } = doctorRex({ exit: 127, screen: () => "/usr/bin/env: 'node': No such file or directory\n", pi: probePi({ openai: NOT_READY }) });
    let text = "";
    assert.equal(await main(["doctor"], { env: rexEnv, exec, log: (s) => (text = s) }), 1);
    assert.match(text, /^pair doctor: \d+ pass, \d+ fail/);
    assert.match(text, /  fail  auditor: openai\/gpt-6\.1-sol:xhigh not ready \(credentials_not_configured\)/);
    assert.match(text, / {8}fix: log in with `pi auth login <provider>`, or pass --auditor-model .*claude-code\/claude-opus-5-5/);
    assert.match(text, /  fail  launch: pi --version in a Rex pane did not work: exit 127 \(blk1 closed\)/);
    assert.match(text, / {8}screen tail:\n {8}.*No such file or directory/);
    assert.match(text, / {8}fix: a worker starts through this launcher/);
    assert.ok(calls.some((c) => c[0] === "rex" && c[1] === "block" && c[2] === "close"), "the failed dry launch is closed too");
  });

  it("skips the dry launch with --no-launch", async () => {
    const { exec, calls } = doctorRex();
    let text = "";
    assert.equal(await main(["doctor", "--no-launch"], { env: rexEnv, exec, log: (s) => (text = s) }), 0);
    assert.match(text, /  skip  launch: skipped \(--no-launch\)/);
    assert.deepEqual(calls.filter((c) => c[0] === "rex"), [], "nothing was opened");
    await assert.rejects(main(["models", "--no-launch"], { env: rexEnv, exec, log: () => {} }), /--no-launch belongs to doctor/);
  });

  it("checks a model override as it would be used", async () => {
    const { exec } = doctorRex();
    let text = "";
    assert.equal(await main(["doctor", "--no-launch", "--auditor-model", "claude-code/claude-opus-5-5"], { env: rexEnv, exec, log: (s) => (text = s) }), 0);
    assert.match(text, /  pass  auditor: claude-code\/claude-opus-5-5 \(passed as --auditor-model\)/);
    // An unready override fails that role instead of falling back to its preferences.
    const unready = doctorRex({ pi: probePi({ openai: NOT_READY }) });
    let failed = "";
    assert.equal(await main(["doctor", "--no-launch", "--auditor-model", "openai/gpt-6.1-sol"], { env: rexEnv, exec: unready.exec, log: (s) => (failed = s) }), 1);
    assert.match(failed, /  fail  auditor: openai\/gpt-6\.1-sol not ready \(credentials_not_configured\)/);
    assert.match(failed, / {8}fix: log in with `pi auth login <provider>`, or pass another --auditor-model/);
  });

  it("shows each detection path it tried for core-only Herdr", async () => {
    const exec = async (cmd, args) => {
      if (cmd === fakePi) return probePi()(args);
      if (cmd === "herdr-app") throw new Error(`herdr-app ${args.join(" ")}: spawn herdr-app ENOENT`);
      if (cmd === "hc" && args[0] === "get") return JSON.stringify({ state: "live", status: { state: "working" } });
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    };
    let text = "";
    assert.equal(await main(["doctor", "--no-launch"], { env: herdrEnv, exec, log: (s) => (text = s) }), 0);
    assert.match(text, /  pass  mux: herdr: core-only \(hc terminals, no automatic panes: herdr-app unavailable here: herdr-app ls: spawn herdr-app ENOENT\)\n {8}herdr: HC_TERMINAL_ID=t0\n {8}herdr-app: herdr-app \(HERDR_APP_BIN\)\n {8}herdr-app \(herdr-app\): herdr-app ls: spawn herdr-app ENOENT\n {8}hc \(hc\) get t0: live; labels carry no herdr\.space, so worker terminals stay hidden \(core-only\)/);
  });

  it("reports no multiplexer instead of guessing, and does not launch", async () => {
    const { exec } = fakePiChecks({ listed: { "claude-code": ["claude-opus-5-5"], openai: ["gpt-6.1-sol"] }, auth: { "claude-code/claude-opus-5-5": READY, "openai/gpt-6.1-sol": READY } });
    let text = "";
    assert.equal(await main(["doctor"], { env: { PAIR_PI_BIN: fakePi, PATH: "/usr/bin" }, exec, log: (s) => (text = s) }), 1);
    assert.match(text, /  fail  mux: none: not running inside Herdr/);
    assert.match(text, / {8}fix: run doctor inside a Herdr pane or a Rex block/);
    assert.match(text, /  skip  launch: not run: no multiplexer/);
  });

  it("bounds the dry launch with a timeout, and collects the result from the screen when there is no record", async () => {
    const env = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    const rex = ({ capture, record } = {}) => {
      const calls = [];
      let closed = false;
      const exec = async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
        if (args[0] === "split") {
          if (record) writeFileSync(join(dirname(launcherOf(args)), LAUNCH_EXIT), record);
          return JSON.stringify({ block_ids: ["blk1"] });
        }
        if (args[0] === "capture") {
          if (closed) throw new Error("block not found");
          return capture();
        }
        // Closure is confirmed by the block list, not by an error message.
        if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: closed ? [] : [{ block_id: "blk1" }] });
        if (args[0] === "block" && args[1] === "close") {
          closed = true;
          return "{}";
        }
        return "{}";
      };
      return { exec, calls };
    };
    // Nothing on screen and no exit record: the wait is bounded, and the pane is closed before the result returns.
    let t = 0;
    const quiet = rex({ capture: () => "" });
    const timedOut = await dryLaunch({ mux: "rex", env, exec: quiet.exec, dir: tmp(), timeout: 1000, interval: 500, sleep: async () => {}, now: () => (t += 600) });
    assert.deepEqual([timedOut.ok, timedOut.timeout, timedOut.closed], [false, true, true]);
    assert.ok(quiet.calls.some((c) => c[1] === "block" && c[2] === "close"));
    // A startup error on the screen is the answer when no exit record arrives.
    const broken = rex({ capture: () => "/usr/bin/env: 'node': No such file or directory\n" });
    const failed = await dryLaunch({ mux: "rex", env, exec: broken.exec, dir: tmp(), sleep: async () => {}, now: () => 0 });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /No such file or directory/);
    // `pi --version` prints one bare version line, which is enough without a record.
    const printed = rex({ capture: () => "Pi is starting\n1.5.2\n" });
    const fromScreen = await dryLaunch({ mux: "rex", env, exec: printed.exec, dir: tmp(), sleep: async () => {}, now: () => 0 });
    assert.deepEqual([fromScreen.ok, fromScreen.version, fromScreen.fromScreen], [true, "1.5.2", true]);
    // The launcher's record is the answer even when the multiplexer names the block differently from its id.
    const renamed = rex({ capture: () => "1.5.2\n", record: "block:other 0\n" });
    const byRecord = await dryLaunch({ mux: "rex", env, exec: renamed.exec, dir: tmp(), sleep: async () => {}, now: () => 0 });
    assert.deepEqual([byRecord.ok, byRecord.exitCode], [true, 0]);
    // A launch that cannot even be prepared fails the check instead of opening something.
    const noPi = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PATH: "/nowhere" };
    const unused = rex({ capture: () => "" });
    await assert.rejects(dryLaunch({ mux: "rex", env: noPi, exec: unused.exec, sleep: async () => {}, now: () => 0 }), /pi not found/);
    assert.deepEqual(unused.calls, [], "nothing was opened");
  });
  it("bounds a stalled multiplexer command, and does not take an unanswered check as closure", async () => {
    const env = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    const calls = [];
    const hang = () => new Promise(() => {});
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") return JSON.stringify({ block_ids: ["blk1"] });
      if (args[0] === "block" && args[1] === "close") return "{}";
      // Neither the screen nor the block list answers: nothing about this pane can be confirmed.
      return hang();
    };
    const started = Date.now();
    const result = await dryLaunch({ mux: "rex", env, exec, dir: tmp(), timeout: 80, cleanupTimeout: 80, opTimeout: 80, interval: 10 });
    const elapsed = Date.now() - started;
    // A capture that never settles must not outlive the deadline: the check fails as a timeout instead.
    assert.deepEqual([result.ok, result.timeout], [false, true]);
    assert.equal(result.closed, false, "no answer is not evidence of closure");
    assert.match(result.closeError, /did not answer within \d+ ms/);
    assert.ok(elapsed < 2000, `the stalled capture did not keep the launch open (${elapsed} ms)`);
    assert.equal(calls.filter((c) => c[1] === "block" && c[2] === "close").length, 2, "cleanup is attempted twice before giving up");

    // A close that never settles is bounded too. Here the block was already gone, which the capture confirms, so the
    // launch still passes — and the stalled close is not waited for.
    const stalledClose = [];
    const closing = async (cmd, args) => {
      stalledClose.push([cmd, ...args]);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") return JSON.stringify({ block_ids: ["blk1"] });
      if (args[0] === "block" && args[1] === "close") return hang();
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: [] });
      if (args[0] === "capture") throw new Error("block not found");
      return "{}";
    };
    const closeStarted = Date.now();
    const closedAnyway = await dryLaunch({ mux: "rex", env, exec: closing, dir: tmp(), timeout: 60, cleanupTimeout: 60, opTimeout: 60, interval: 10, sleep: async () => {} });
    assert.deepEqual([closedAnyway.ok, closedAnyway.timeout, closedAnyway.closed], [false, true, true]);
    assert.ok(Date.now() - closeStarted < 2000, "the stalled close did not keep the check open");
    assert.equal(stalledClose.filter((c) => c[1] === "block" && c[2] === "close").length, 1, "one bounded close attempt was enough: the capture confirmed the block was gone");
  });

  it("keeps the identity a split created before its later steps can stall, and closes that pane", async () => {
    // The Herdr adapter knows the terminal the moment pane.split answers; focus restoration and ownership labeling
    // come after. A budget that expires during those must not lose the pane — it exists and has to be closed.
    const calls = [];
    const terminals = new Map([["t0", "p0"]]);
    const delayed = (value) => new Promise((resolvePromise) => setTimeout(() => resolvePromise(value), 120));
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "herdr-app" && args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [...terminals].map(([terminal, pane]) => ({ terminal, pane })) }] }] });
      if (cmd === "herdr-app" && args[1] === "pane.split") {
        const launcher = JSON.parse(args[2]).argv.find((arg) => arg.endsWith(launcherName));
        writeFileSync(join(dirname(launcher), LAUNCH_EXIT), "t1 0\n");
        terminals.set("t1", "p1");
        return JSON.stringify({ pane: "p1", terminal: "t1" });
      }
      if (cmd === "herdr-app" && args[1] === "pane.focus") return delayed("{}");
      if (cmd === "herdr-app" && args[1] === "pane.close") {
        terminals.delete("t1");
        return "{}";
      }
      if (cmd === "herdr-app") return "{}";
      if (cmd === "hc" && args[0] === "get") {
        if (!terminals.has(args[1])) throw Object.assign(new Error(`hc get ${args[1]} --json: exit 3`), { stdout: JSON.stringify({ error: { kind: "not_found", message: `no terminal "${args[1]}"` } }) });
        return JSON.stringify({ state: "live", status: { state: "done" } });
      }
      if (cmd === "hc" && args[0] === "label") return delayed("{}");
      if (cmd === "hc") return "{}";
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    };
    await assert.rejects(
      dryLaunch({ mux: "herdr", env: herdrEnv, exec, dir: tmp(), timeout: 40, cleanupTimeout: 1_000, opTimeout: 40, sleep: async () => {} }),
      (error) => {
        assert.match(error.message, /split did not answer/);
        assert.equal(error.id, "t1", "the terminal pane.split reported is kept even though the split timed out");
        assert.equal(error.closed, true, "so it is closed and its absence confirmed");
        return true;
      },
    );
    assert.deepEqual(calls.filter((c) => c[0] === "herdr-app" && c[2] === "pane.close").map((c) => JSON.parse(c[3]).pane), ["p1"]);
  });

  it("reconciles a creation answer that arrives after the split deadline", async () => {
    const calls = [];
    const blocks = new Set();
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
        blocks.add("blk1");
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: [...blocks].map((block_id) => ({ block_id })) });
      if (args[0] === "block" && args[1] === "close") {
        blocks.delete(args.at(-1));
        return "{}";
      }
      if (args[0] === "capture") throw new Error("block not found");
      return "{}";
    };
    await assert.rejects(
      dryLaunch({ mux: "rex", env: rexEnv, exec, dir: tmp(), timeout: 40, cleanupTimeout: 1_000, opTimeout: 1_000, interval: 10, sleep: async () => {} }),
      (error) => {
        assert.match(error.message, /split did not answer/);
        assert.equal(error.id, "blk1", "the late answer is adopted inside the cleanup budget");
        assert.equal(error.closed, true, "and the block it created is closed");
        return true;
      },
    );
    assert.ok(calls.some((c) => c[0] === "rex" && c[1] === "block" && c[2] === "close"), "the created block was closed");

    // The same, with the answer arriving well after any half-budget slice but still inside the creation lifetime the
    // split command was given (timeout + cleanupTimeout). Cleaning up must wait that whole lifetime, not a slice of it,
    // and must finish the job: recovered id, block confirmed closed, nothing left outstanding.
    const slowCalls = [];
    const slowBlocks = new Set();
    let settledAt = null;
    const slowExec = async (cmd, args) => {
      slowCalls.push([cmd, ...args]);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
        slowBlocks.add("blk1");
        settledAt = Date.now();
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: [...slowBlocks].map((block_id) => ({ block_id })) });
      if (args[0] === "block" && args[1] === "close") {
        slowBlocks.delete(args.at(-1));
        return "{}";
      }
      if (args[0] === "capture") throw new Error("block not found");
      return "{}";
    };
    await assert.rejects(
      dryLaunch({ mux: "rex", env: rexEnv, exec: slowExec, dir: tmp(), timeout: 40, cleanupTimeout: 1_000, closeTimeout: 1_000, opTimeout: 1_000, interval: 10, sleep: async () => {} }),
      (error) => {
        assert.match(error.message, /split did not answer/);
        assert.equal(error.id, "blk1", "an answer inside the creation lifetime is recovered, not half of it");
        assert.equal(error.closed, true);
        return true;
      },
    );
    assert.ok(settledAt !== null, "the creation command settled before dryLaunch returned: nothing is left outstanding");
    assert.equal(slowBlocks.size, 0, "and the block it created is gone");
    assert.ok(slowCalls.some((c) => c[0] === "rex" && c[1] === "block" && c[2] === "close"), "the close reached the recovered block");

    // A split whose CLI never ran at all proves nothing was created, so cleanup must give up at once instead of
    // waiting out an identity that cannot come. (A mux that *answered* an error has not proven that: see below.)
    const failedCalls = [];
    const failing = async (cmd, args) => {
      failedCalls.push([cmd, ...args]);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") throw Object.assign(new Error("rex split: spawn rex ENOENT"), { code: "ENOENT" });
      return "{}";
    };
    const started = Date.now();
    await assert.rejects(
      dryLaunch({ mux: "rex", env: rexEnv, exec: failing, dir: tmp(), timeout: 40, cleanupTimeout: 1_000, closeTimeout: 1_000, opTimeout: 1_000, interval: 10, sleep: async () => {} }),
      (error) => {
        assert.match(error.message, /ENOENT/);
        assert.equal(error.id, null, "nothing was created, so there is nothing to close");
        assert.equal(error.closed, false);
        return true;
      },
    );
    assert.ok(Date.now() - started < 500, "a creation that never ran is not waited out");
    assert.deepEqual(failedCalls.filter((c) => c[1] === "block"), [], "no close was attempted for a pane that never existed");

    // A rejected split does not prove no pane: the server can create the block and then lose the answer. The block
    // exists from 0 ms, `launch.id` is written at 100 ms, and the split rejects with a connection reset at 60 ms —
    // well inside the creation lifetime. The pane must still be found and closed, with its recovery folder in place.
    const resetBlocks = new Set();
    const resetCalls = [];
    const resetExec = async (cmd, args) => {
      resetCalls.push([cmd, ...args]);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        const launcher = launcherOf(args);
        resetBlocks.add("b1");
        setTimeout(() => writeFileSync(join(dirname(launcher), LAUNCH_ID), "b1\n"), 100);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
        throw new Error("rex split: connection reset by peer");
      }
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: [...resetBlocks].map((block_id) => ({ block_id })) });
      if (args[0] === "block" && args[1] === "close") {
        resetBlocks.delete(args.at(-1));
        return "{}";
      }
      if (args[0] === "capture") throw new Error("block not found");
      return "{}";
    };
    await assert.rejects(
      dryLaunch({ mux: "rex", env: rexEnv, exec: resetExec, dir: tmp(), timeout: 40, cleanupTimeout: 100, closeTimeout: 600, opTimeout: 1_000, interval: 10 }),
      (error) => {
        assert.match(error.message, /split did not answer/); // the launch's own split wait ended first (40 ms)
        assert.equal(error.id, "b1", "a rejected creation that may have created is not assumed empty");
        assert.equal(error.closed, true, "the block it created was confirmed closed");
        return true;
      },
    );
    assert.equal(resetBlocks.size, 0, "no block is left behind");
    assert.ok(resetCalls.some((c) => c[1] === "block" && c[2] === "close"), "the close reached the recovered block");

    // A split whose own command is killed at its bound can still have created the pane, and the launcher inside it
    // writes `launch.id` a moment later, after the creation lifetime. That identity is adopted in a window of its own
    // and closed with time to spare — not left behind because the creation had `settled`.
    const idBlocks = new Set();
    const idCalls = [];
    const idExec = async (cmd, args) => {
      idCalls.push([cmd, ...args]);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        const launcher = launcherOf(args);
        setTimeout(() => {
          idBlocks.add("blk1");
          writeFileSync(join(dirname(launcher), LAUNCH_ID), "blk1\n");
        }, 300); // the answer never comes; the pane's launcher records its identity anyway
        return new Promise(() => {});
      }
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: [...idBlocks].map((block_id) => ({ block_id })) });
      if (args[0] === "block" && args[1] === "close") {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 120)); // a close command with real cost
        idBlocks.delete(args.at(-1));
        return "{}";
      }
      if (args[0] === "capture") throw new Error("block not found");
      return "{}";
    };
    await assert.rejects(
      dryLaunch({ mux: "rex", env: rexEnv, exec: idExec, dir: tmp(), timeout: 40, cleanupTimeout: 100, closeTimeout: 600, opTimeout: 1_000, interval: 10 }),
      (error) => {
        assert.match(error.message, /split did not answer/);
        assert.equal(error.id, "blk1", "the launcher's late identity is adopted in its own window");
        assert.equal(error.closed, true, "and closed, because the close has a window that adoption cannot eat");
        return true;
      },
    );
    assert.equal(idBlocks.size, 0, "the block it created is gone");
    assert.ok(idCalls.some((c) => c[1] === "block" && c[2] === "close"), "the close reached the late block");
  });

  it("recovers a pane whose creation answer never arrives, from the launcher's identity record", async () => {
    // The pane really starts (its launcher writes launch.id) but the split answer is lost. Nothing else names the
    // block, so the launcher's own record is what lets doctor clean up after itself.
    const blocks = new Set();
    const exec = async (cmd, args) => {
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        const launcher = launcherOf(args);
        blocks.add("blk1");
        writeFileSync(join(dirname(launcher), LAUNCH_ID), "blk1\n");
        return new Promise(() => {}); // the answer never comes
      }
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: [...blocks].map((block_id) => ({ block_id })) });
      if (args[0] === "block" && args[1] === "close") {
        blocks.delete(args.at(-1));
        return "{}";
      }
      if (args[0] === "capture") throw new Error("block not found");
      return "{}";
    };
    await assert.rejects(
      dryLaunch({ mux: "rex", env: rexEnv, exec, dir: tmp(), timeout: 40, cleanupTimeout: 1_000, opTimeout: 40, interval: 10, sleep: async () => {} }),
      (error) => {
        assert.match(error.message, /split did not answer/);
        assert.equal(error.id, "blk1", "the launcher's identity record recovered the block");
        assert.equal(error.closed, true);
        return true;
      },
    );
  });

  it("does not accept generic 'not found' prose as proof that a pane is gone", async () => {
    // An unreachable control socket says "not found" too. Only a transport-specific answer about this block counts.
    const socket = async (cmd, args) => {
      if (cmd === fakePi) return probePi()(args);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        writeFileSync(join(dirname(launcherOf(args)), LAUNCH_EXIT), "blk1 0\n");
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      if (args[0] === "block" && args[1] === "close") throw new Error("control socket not found; application unreachable");
      if (args[0] === "block" && args[1] === "list") throw new Error("control socket not found; application unreachable");
      if (args[0] === "capture") throw new Error("control socket not found; application unreachable");
      return "{}";
    };
    let text = "";
    assert.equal(await main(["doctor"], { env: rexEnv, exec: socket, log: (s) => (text = s), sleep: async () => {} }), 1);
    assert.match(text, /  fail  launch: .*could not be confirmed closed \(control socket not found; application unreachable\)/);
    assert.match(text, / {8}fix: close the temporary Rex pane yourself: `node \S+ close blk1 --mux rex`/);
    // The same words from a missing executable prove nothing either.
    const missing = async (cmd, args) => {
      if (cmd === fakePi) return probePi()(args);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        writeFileSync(join(dirname(launcherOf(args)), LAUNCH_EXIT), "blk1 0\n");
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      throw new Error("rex: command not found");
    };
    assert.equal(await main(["doctor"], { env: rexEnv, exec: missing, log: (s) => (text = s), sleep: async () => {} }), 1);
    assert.match(text, /  fail  launch: .*could not be confirmed closed \(rex: command not found\)/);
    // A block list that simply does not contain it is the positive case.
    const list = async (cmd, args) => {
      if (cmd === fakePi) return probePi()(args);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        writeFileSync(join(dirname(launcherOf(args)), LAUNCH_EXIT), "blk1 0\n");
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: [{ block_id: "blk0" }] });
      if (args[0] === "block" && args[1] === "close") return "{}";
      if (args[0] === "capture") throw new Error("block not found");
      return "{}";
    };
    assert.equal(await main(["doctor"], { env: rexEnv, exec: list, log: (s) => (text = s), sleep: async () => {} }), 0);
    assert.match(text, /  pass  launch: .*\(blk1 closed\)/);
  });

  it("refuses to read an unexpected block-list answer as proof that a block is gone", async () => {
    // Absence is proven only by a successful list that is a list of identifiable blocks: an error envelope, `{}`, a
    // row without an identity or unparseable output all leave the answer unknown.
    const answering = (answer) => async (cmd, args) => {
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "block" && args[1] === "list") return answer;
      return "{}";
    };
    const env = { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PATH: "/usr/bin" };
    const gone = (answer) => adapter("rex", { exec: answering(answer), env }).gone("b1");
    assert.equal(await gone(JSON.stringify({ blocks: [] })), true, "an empty block list is evidence");
    assert.equal(await gone(JSON.stringify({ blocks: [{ block_id: "b0" }] })), true, "another block is fine");
    assert.equal(await gone(JSON.stringify({ blocks: [{ block_id: "b1" }] })), false, "a listed block is still there");
    for (const answer of ["{}", JSON.stringify({ error: { kind: "unreachable" } }), JSON.stringify({ blocks: [{}] }), JSON.stringify({ blocks: [{ id: "" }] }), "not json"]) {
      await assert.rejects(gone(answer), `must not be read as absence: ${answer}`);
    }
  });

  it("does not report its diagnostic block closed on an unexpected block-list answer", async () => {
    // The same through doctor: the check must fail and name the cleanup command rather than claim the block is gone.
    const exec = async (cmd, args) => {
      if (cmd === fakePi) return probePi()(args);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        writeFileSync(join(dirname(launcherOf(args)), LAUNCH_EXIT), "blk1 0\n");
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      if (args[0] === "capture") return "1.5.2\n";
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({});
      if (args[0] === "block" && args[1] === "close") return "{}"; // the block survives the close
      return "{}";
    };
    let text = "";
    assert.equal(await main(["doctor"], { env: rexEnv, exec, log: (s) => (text = s), sleep: async () => {} }), 1);
    assert.match(text, /  fail  launch: .*could not be confirmed closed \(rex block list: unexpected answer \{\}\)/);
    assert.match(text, / {8}fix: close the temporary Rex pane yourself: `node \S+ close blk1 --mux rex`/);
  });

  it("treats an unreachable Herdr core as unconfirmed closure, and its not_found answer as confirmed", async () => {
    const herdrFor = (getFailure) => async (cmd, args) => {
      if (cmd === fakePi) return probePi()(args);
      if (cmd === "herdr-app" && args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t0", pane: "p0" }, { terminal: "t1", pane: "p1" }] }] }] });
      if (cmd === "herdr-app" && args[1] === "pane.split") {
        writeFileSync(join(dirname(JSON.parse(args[2]).argv.find((arg) => arg.endsWith(launcherName))), LAUNCH_EXIT), "t1 0\n");
        return JSON.stringify({ pane: "p1", terminal: "t1" });
      }
      if (cmd === "herdr-app") return "{}";
      if (cmd === "hc" && args[0] === "get") throw getFailure(args[1]);
      if (cmd === "hc") return "{}";
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    };
    const socket = herdrFor(() => Object.assign(new Error("hc get t1 --json: connect: connection refused"), { stdout: "" }));
    let text = "";
    assert.equal(await main(["doctor"], { env: herdrEnv, exec: socket, log: (s) => (text = s), sleep: async () => {} }), 1);
    assert.match(text, /  fail  launch: .*could not be confirmed closed \(hc get t1 --json: connect: connection refused\)/);
    const gone = herdrFor(() => Object.assign(new Error("hc get t1 --json: exit 3"), { stdout: JSON.stringify({ error: { kind: "not_found", message: 'no terminal "t1"' } }) }));
    assert.equal(await main(["doctor"], { env: herdrEnv, exec: gone, log: (s) => (text = s), sleep: async () => {} }), 0);
    assert.match(text, /  pass  launch: .*\(t1 closed\)/);
    // hc 0.1.21 prints the not_found answer on stderr and nothing on stdout.
    const goneOnStderr = herdrFor(() => Object.assign(new Error("hc get t1 --json: exit 3"), { stdout: "", stderr: JSON.stringify({ error: { hint: "see `hc ls --all`", kind: "not_found", message: 'no terminal "t1"' } }) }));
    assert.equal(await main(["doctor"], { env: herdrEnv, exec: goneOnStderr, log: (s) => (text = s), sleep: async () => {} }), 0);
    assert.match(text, /  pass  launch: .*\(t1 closed\)/);
  });

  it("kills a command that overruns the timeout it is given", async () => {
    // `run()` passes the bound to execFile, so a real child is terminated instead of being left behind by the race.
    const started = Date.now();
    await assert.rejects(
      run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 150 }),
      (error) => error.killed === true || /timed out/i.test(error.message ?? ""),
    );
    assert.ok(Date.now() - started < 3000, "the child was killed instead of being waited for");

    // A helper that is not on this machine fails with a string `code` (`ENOENT`), and that is the only failure
    // `dryLaunch` treats as "nothing can have been created"; a killed child is ambiguous, as are the exit-status codes.
    await assert.rejects(run("pi-pair-definitely-not-a-command", [], {}), (error) => error.code === "ENOENT");
    await assert.rejects(run(process.execPath, ["-e", "process.exit(3)"], {}), (error) => error.code === 3);
  });

  it("kills a command that ignores SIGTERM, instead of leaving it running", async () => {
    const started = Date.now();
    let pid = null;
    await assert.rejects(
      run(process.execPath, ["-e", 'console.log(process.pid); process.on("SIGTERM", () => {}); setInterval(() => {}, 500);'], { timeout: 150 }),
      (error) => {
        pid = Number(String(error.stdout ?? "").trim());
        assert.ok(Number.isInteger(pid) && pid > 0, `the child reported its pid (${JSON.stringify(error.stdout)})`);
        return error.killed === true;
      },
    );
    assert.ok(Date.now() - started < 3000, "the timeout ended the child instead of waiting for it");
    // SIGKILL cannot be handled: the pid is gone rather than a running orphan that still holds our handles.
    for (let tries = 0; tries < 40; tries++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.fail(`child ${pid} was still alive after the timeout`);
  });

  it("fails the launch check when its temporary pane cannot be confirmed closed", async () => {
    // The auditor's repro: the launch worked, the close is refused, and the block is still readable afterwards. A
    // passing doctor with its own pane left open is exactly what F3 must not do.
    const stubborn = async (cmd, args) => {
      if (cmd === "git") return "## main\n";
      if (cmd === fakePi) return probePi()(args);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
      if (args[0] === "split") {
        writeFileSync(join(dirname(launcherOf(args)), LAUNCH_EXIT), "blk1 0\n");
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      if (args[0] === "capture") return "1.5.2\n"; // still there
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: [{ block_id: "blk1" }] });
      if (args[0] === "block" && args[1] === "close") throw new Error("mux refused to close block");
      return "{}";
    };
    let text = "";
    assert.equal(await main(["doctor"], { env: rexEnv, exec: stubborn, log: (s) => (text = s), sleep: async () => {} }), 1);
    assert.match(text, /  fail  launch: pi --version in a Rex pane worked \(exit 0, printed 1\.5\.2\), but its temporary blk1 could not be confirmed closed \(mux refused to close block\)/);
    assert.match(text, / {8}fix: close the temporary Rex pane yourself: `node \S+ close blk1 --mux rex`/);

    // A mux that cannot answer during verification is not evidence either: report it, do not pass.
    const unreachable = async (cmd, args) => {
      if (cmd === fakePi) return probePi()(args);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        writeFileSync(join(dirname(launcherOf(args)), LAUNCH_EXIT), "blk1 0\n");
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      if (args[0] === "block" && args[1] === "close") return "{}";
      if (args[0] === "block" && args[1] === "list") throw new Error("rex block list: spawn rex ENOENT");
      if (args[0] === "capture") throw new Error("rex capture: spawn rex ENOENT");
      return "{}";
    };
    let failed = "";
    assert.equal(await main(["doctor"], { env: rexEnv, exec: unreachable, log: (s) => (failed = s), sleep: async () => {} }), 1);
    assert.match(failed, /  fail  launch: .*could not be confirmed closed \(rex block list: spawn rex ENOENT\)/);

    // A launch that failed and a pane that will not close: neither hide the other, and both fixes are named.
    const both = async (cmd, args) => {
      if (cmd === fakePi) return probePi()(args);
      if (cmd !== "rex") throw new Error(`unexpected command ${cmd}`);
      if (args[0] === "split") {
        writeFileSync(join(dirname(launcherOf(args)), LAUNCH_EXIT), "blk1 127\n");
        return JSON.stringify({ block_ids: ["blk1"] });
      }
      if (args[0] === "capture") return "worker screen\n";
      if (args[0] === "block" && args[1] === "list") return JSON.stringify({ blocks: [{ block_id: "blk1" }] });
      if (args[0] === "block" && args[1] === "close") throw new Error("mux refused to close block");
      return "{}";
    };
    let untidy = "";
    assert.equal(await main(["doctor"], { env: rexEnv, exec: both, log: (s) => (untidy = s), sleep: async () => {} }), 1);
    assert.match(untidy, /  fail  launch: pi --version in a Rex pane did not work: exit 127 \(blk1 could not be confirmed closed \(mux refused to close block\)\)/);
    assert.match(untidy, / {8}fix: a worker starts through this launcher/);
    assert.match(untidy, / {8}fix: close the temporary Rex pane yourself/);
  });

  it("honours --mux instead of failing on ambiguous variables", async () => {
    // Both families set (an app terminal inside a Rex pane, or a shell that kept stale variables): a run accepts
    // --mux, so doctor must accept the same selection rather than recommend the flag it ignores.
    const both = { HC_TERMINAL_ID: "t0", HERDR_APP_BIN: "herdr-app", HC_BIN: "hc", REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" };
    const herdrExec = async (cmd, args) => {
      if (cmd === fakePi) return probePi()(args);
      if (cmd === "herdr-app" && args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t0", pane: "p0" }] }] }] });
      if (cmd === "hc" && args[0] === "get") return JSON.stringify({ state: "live", status: { state: "idle" } });
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    };
    let text = "";
    assert.equal(await main(["doctor", "--no-launch"], { env: both, exec: doctorRex().exec, log: (s) => (text = s) }), 1);
    assert.match(text, /  fail  mux: none: both Herdr \(HC_TERMINAL_ID\) and Rex variables are set; pass --mux herdr\|rex/);
    assert.equal(await main(["doctor", "--no-launch", "--mux", "rex"], { env: both, exec: doctorRex().exec, log: (s) => (text = s) }), 0);
    assert.match(text, /  pass  mux: rex \(Rex panes\)\n {8}selected with --mux rex\n {8}rex: REX_SESSION and REX_BLOCK are set/);
    assert.equal(await main(["doctor", "--no-launch", "--mux", "herdr"], { env: both, exec: herdrExec, log: (s) => (text = s) }), 0);
    assert.match(text, /  pass  mux: herdr: panes via herdr-app \(HERDR_APP_BIN\)\n {8}selected with --mux herdr\n {8}herdr: HC_TERMINAL_ID=t0\n {8}herdr-app: herdr-app \(HERDR_APP_BIN\)\n {8}herdr-app \(herdr-app\) ls: pane p0 shows t0/);
    // A selection still has to be a mux, and still needs the environment it runs in.
    assert.equal(await main(["doctor", "--no-launch", "--mux", "both"], { env: both, exec: doctorRex().exec, log: (s) => (text = s) }), 1);
    assert.match(text, /  fail  mux: none: --mux must be herdr or rex, not both/);
    assert.match(text, / {8}fix: pass a mux this machine can run in/);
    assert.equal(await main(["doctor", "--no-launch", "--mux", "rex"], { env: { HC_TERMINAL_ID: "t0", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" }, exec: doctorRex().exec, log: (s) => (text = s) }), 1);
    assert.match(text, /  fail  mux: none: --mux rex needs REX_SESSION and REX_BLOCK/);
    assert.equal(await main(["doctor", "--no-launch", "--mux", "herdr"], { env: { REX_SESSION: "s", REX_BLOCK: "b", PAIR_PI_BIN: fakePi, PATH: "/usr/bin" }, exec: doctorRex().exec, log: (s) => (text = s) }), 1);
    assert.match(text, /  fail  mux: none: --mux herdr needs HC_TERMINAL_ID/);
  });

});
