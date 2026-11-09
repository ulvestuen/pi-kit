#!/usr/bin/env node
// Pair programming between two visible Pi workers: an implementer and an auditor.
// Detects the Herdr app (herdr-app + herdr-core `hc`) or Rex, opens one pane per worker,
// and relays turns through files.
// Zero dependencies; Node.js 22+.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULTS = {
  rounds: 3,
  implementerModel: "claude-code/claude-opus-5-5",
  auditorModel: "openai-codex/gpt-6.1-sol",
  turnTimeout: "60m",
};
export const DONE = "<!-- pair:done -->";
const REX_APP_BINS = ["/Applications/Rex.app", "/Applications/Rex Beta.app"].map((app) => `${app}/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`);

const USAGE = `Usage:
  pair.mjs detect [--json]
  pair.mjs run --task-file <path> [options]
  pair.mjs close <worker>... [--mux herdr|rex]   close finished worker panes (ids from run)

Options:
  --rounds <n>               audit → address cycles (default ${DEFAULTS.rounds})
  --implementer-model <m>    provider/id[:thinking] (default ${DEFAULTS.implementerModel})
  --auditor-model <m>        provider/id[:thinking] (default ${DEFAULTS.auditorModel})
  --mux herdr|rex            override environment detection
  --turn-timeout <dur>       per-turn limit, e.g. 45m (default ${DEFAULTS.turnTimeout})
  --cwd <dir>                worker working directory (default: current)
  --json                     machine-readable result`;

export function run(cmd, args, { cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${cmd} ${args.join(" ")}: ${(stderr || error.message).trim()}`), { stdout }));
      else resolvePromise(stdout);
    });
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseDuration(value) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value).trim());
  if (!m) throw new Error(`invalid duration ${value} (use e.g. 90s, 45m)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"];
}

// ---------- environment ----------

/**
 * Decide which multiplexer hosts this process, from the variables each one injects.
 * Herdr app terminals are herdr-core terminals and carry HC_TERMINAL_ID (an address like t7, not a pane id).
 */
export function detect(env = process.env) {
  const herdr = Boolean(env.HC_TERMINAL_ID);
  const rex = Boolean(env.REX_SESSION && env.REX_BLOCK);
  if (herdr && rex) return { mux: null, reason: "both Herdr (HC_TERMINAL_ID) and Rex variables are set; pass --mux herdr|rex" };
  if (herdr) return { mux: "herdr", terminal: env.HC_TERMINAL_ID };
  if (rex) return { mux: "rex", session: env.REX_SESSION, pane: env.REX_BLOCK };
  return { mux: null, reason: "not running inside Herdr (HC_TERMINAL_ID) or Rex (REX_SESSION/REX_BLOCK)" };
}

/**
 * Pane operations behind one interface: anchor() → id, split(anchor, direction, label, argv) → id, send, read,
 * and optionally alive (throws when the worker is gone) and idle (true once the agent stopped working).
 */
export function adapter(mux, { exec = run, env = process.env, cwd }) {
  if (mux === "herdr") return herdrAdapter({ exec, env, cwd });
  if (mux === "rex") {
    const bin = env.REX_BIN || onPath("rex", env.PATH) || REX_APP_BINS.find((p) => existsSync(p)) || "rex";
    const session = env.REX_SESSION;
    const rex = async (args) => exec(bin, args);
    return {
      anchor: async () => env.REX_BLOCK,
      async split(anchor, direction, label, argv) {
        const out = JSON.parse(await rex(["split", "-s", session, "-b", anchor, `--split=${direction}`, "-c", cwd, "--label", label, "--focus=false", "--json", "--", ...argv]));
        const id = out.block_ids?.[0];
        if (!id) throw new Error("rex split returned no block id");
        return id;
      },
      async send(id, text) {
        await rex(["send", "-s", session, "-b", id, text]);
        await rex(["send-key", "-s", session, "-b", id, "enter"]);
      },
      read: (id) => rex(["capture", "-s", session, "-b", id, "--trim"]),
      close: (id) => rex(["block", "close", "-s", session, id]),
    };
  }
  throw new Error(`unsupported multiplexer ${mux}`);
}

/** A CLI found via an override variable, PATH, or Herdr's install folder (~/.local/bin by default). */
function findBin(name, override, env) {
  if (override) return override;
  const installDir = env.HC_INSTALL_DIR || join(env.HOME || homedir(), ".local", "bin");
  return onPath(name, env.PATH) || [join(installDir, name)].find((p) => existsSync(p)) || name;
}

/**
 * Herdr app: `herdr-app` arranges panes in the window, herdr-core `hc` talks to the terminals in them.
 * Workers are identified by their terminal address (t7); the adapter remembers each one's pane for splitting.
 */
function herdrAdapter({ exec, env, cwd }) {
  const app = findBin("herdr-app", env.HERDR_APP_BIN, env);
  const hcBin = findBin("hc", env.HC_BIN, env);
  const herdrApp = async (command, args) => {
    // On failure herdr-app prints {"error": "..."} on stdout and exits 1.
    const stdout = await exec(app, ["do", command, JSON.stringify(args)]).catch((error) => error.stdout || Promise.reject(error));
    const out = JSON.parse(stdout);
    if (out?.error) throw new Error(`herdr-app ${command}: ${out.error}`);
    return out;
  };
  const hc = (args) => exec(hcBin, args);
  const paneOf = new Map();
  let home = null;
  return {
    // The caller's pane: the window's pane showing our own terminal ($HC_TERMINAL_ID).
    async anchor() {
      const self = env.HC_TERMINAL_ID;
      const { spaces = [] } = JSON.parse(await exec(app, ["ls"]));
      const found = spaces.flatMap((s) => s.tabs ?? []).flatMap((t) => t.terminals ?? []).find((t) => t.terminal === self);
      if (!found?.pane) throw new Error(`terminal ${self} is not shown in a Herdr app pane (herdr-app ls)`);
      paneOf.set(self, found.pane);
      home = found.pane;
      return self;
    },
    async split(anchor, direction, label, argv) {
      // pane.split has no folder argument, so start the worker through a tiny cd wrapper.
      const inCwd = ["/bin/sh", "-c", 'cd -- "$1" && shift && exec "$@"', "pair", cwd, ...argv];
      const out = await herdrApp("pane.split", { direction: direction === "below" ? "down" : "right", pane: paneOf.get(anchor) ?? anchor, argv: inCwd });
      if (!out.terminal || !out.pane) throw new Error("herdr-app pane.split returned no terminal");
      paneOf.set(out.terminal, out.pane);
      // pane.split focuses the new pane; give the keyboard back to the user's pane.
      if (home) await herdrApp("pane.focus", { pane: home }).catch(() => {});
      await hc(["label", out.terminal, `pair.role=${label.replace(/^pair:\s*/, "")}`]).catch(() => {});
      return out.terminal;
    },
    send: (id, text) => hc(["send", id, text]),
    read: (id) => hc(["read", id, "--lines", "40"]),
    // `hc read` still works after a terminal finished, so ask the core whether it is live.
    async alive(id) {
      const t = JSON.parse(await hc(["get", id, "--json"]));
      if (t.state !== "live") throw new Error(`terminal ${id} is ${t.state}${t.exit_code == null ? "" : ` (exit ${t.exit_code})`}`);
    },
    // Close the worker's pane (ending its terminal), then drop the finished terminal from herdr-core.
    async close(id) {
      const { spaces = [] } = JSON.parse(await exec(app, ["ls"]));
      const pane = spaces.flatMap((s) => s.tabs ?? []).flatMap((t) => t.terminals ?? []).find((t) => t.terminal === id)?.pane;
      if (pane) await herdrApp("pane.close", { pane });
      else await hc(["kill", id]).catch(() => {});
      await hc(["rm", id]).catch(() => {});
    },
    // Pi reports its status to herdr-core (OSC 7501); `hc wait` returns once it stops working.
    idle: (id) => hc(["wait", id, "--timeout", "120", "--json"]).then((out) => JSON.parse(out).reason !== "timeout", () => false),
  };
}

/** Absolute path of an executable, so non-interactive pane shells need not share our PATH. */
export function onPath(name, path = "") {
  for (const dir of path.split(":").filter(Boolean)) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

// ---------- turn files ----------

const RULES = {
  implementer: `You are the IMPLEMENTER in a pair-programming session with a separate auditor.
- Carry out the task in this repository. Follow AGENTS.md and the repo's conventions.
- Run the relevant checks yourself and report the commands and results.
- Do not commit, push, deploy, or send external messages.
- The auditor reviews your work after each turn. Address every finding: fix it or explain concretely why not.`,
  auditor: `You are the AUDITOR in a pair-programming session with a separate implementer.
- Do not modify repository files. You may read files and run read-only commands and tests.
- Review the working-tree changes (git status, git diff, and untracked files) against the task.
- Report only actionable findings, ordered by severity (blocker, major, minor), each with file:line and a concrete fix.
- Check correctness, missed requirements, edge cases, tests, and whether the claimed verification really passed.
- End with a verdict line: "Verdict: approve" or "Verdict: changes requested".`,
};

export function turnText({ role, kind, task, report, previous, round, rounds, baseline }) {
  const steps = {
    orient: "Read the task below and familiarize yourself with the relevant code. Do not review yet; there are no changes to audit.",
    implement: "Implement the task below.",
    audit: `Audit round ${round} of ${rounds}. Read the implementer's report at ${previous} and review the current changes.`,
    address: `Address the auditor's round ${round} feedback in ${previous}.${round === rounds ? " This is the final round: also summarize the end state, remaining risks, and verification." : ""}`,
  }[kind];
  return [
    RULES[role],
    "",
    `## This turn\n\n${steps}`,
    "",
    `When finished, write your report as Markdown to:\n\n${report}\n\nWrite the report file last. Its final line must be exactly: ${DONE}`,
    "",
    baseline ? `## Repository state before the session\n\n${baseline}\n` : "",
    `## Task\n\n${task}`,
  ].join("\n");
}

// ---------- orchestration ----------

/** Poll for a finished report; every `checkEvery` polls, `isAlive` may throw if the worker's pane is gone. */
export async function waitForReport(path, { sleep = sleepMs, now = Date.now, timeout, interval = 2000, checkEvery = 15, isAlive }) {
  const start = now();
  for (let poll = 1; ; poll++) {
    if (existsSync(path) && readFileSync(path, "utf8").trimEnd().endsWith(DONE)) return readFileSync(path, "utf8");
    if (now() - start > timeout) throw new Error(`timed out waiting for ${path}`);
    if (isAlive && poll % checkEvery === 0) await isAlive();
    await sleep(interval);
  }
}

/** Wait until a pane's output stops changing, so the next prompt is not sent mid-response. */
export async function settle(read, { sleep = sleepMs, interval = 1500, maxPolls = 20 } = {}) {
  let previous = null;
  for (let i = 0; i < maxPolls; i++) {
    const current = await read().catch(() => "");
    if (current === previous) return;
    previous = current;
    await sleep(interval);
  }
}

/**
 * Shared worker plumbing for pair sessions (also used by the pair-review skill): numbered turn/report files in `dir`,
 * Pi workers started in new panes, and waiting for a worker's finished report.
 */
export async function workers({ task, mux, cwd, dir, turnTimeout, label = "Pair session", render, exec = run, env = process.env, sleep = sleepMs, now = Date.now, progress = () => {} }) {
  const panes = adapter(mux, { exec, env, cwd });
  mkdirSync(dir, { recursive: true });
  const baseline = await exec("git", ["status", "--short", "--branch"], { cwd }).then((s) => `\`git status --short --branch\`:\n\n\`\`\`\n${s.trim()}\n\`\`\``, () => "");
  writeFileSync(join(dir, "task.md"), task);

  let step = 0;
  const reports = [];
  const timeout = parseDuration(turnTimeout);
  const pi = env.PAIR_PI_BIN || onPath("pi", env.PATH) || "pi";
  return {
    panes,
    reports,
    /** Write the next turn file; `render` gets the role, kind, report path, task, and baseline plus `extra`. */
    prepare(role, kind, extra = {}) {
      const base = join(dir, `${String(++step).padStart(2, "0")}-${role}-${kind}`);
      const turn = `${base}.turn.md`;
      const report = `${base}.report.md`;
      writeFileSync(turn, render({ role, kind, task, report, baseline, ...extra }));
      return { turn, report, prompt: `${label} (${role}, ${kind}): read ${turn} and follow it exactly.` };
    },
    spawn: (anchor, direction, name, model, prompt) => panes.split(anchor, direction, name, [pi, "--model", model, prompt]),
    async finish(role, id, { report }) {
      progress(`waiting for ${role}: ${report}`);
      const isAlive = () => (panes.alive ?? panes.read)(id).then(() => {}, (error) => {
        throw new Error(`${role} pane ${id} is gone (${error.message}); reports so far are in ${dir}`);
      });
      const text = await waitForReport(report, { sleep, now, timeout, isAlive });
      reports.push({ role, path: report });
      if (!(await panes.idle?.(id))) await settle(() => panes.read(id), { sleep });
      return text;
    },
  };
}

export async function runPair({ task, mux, cwd, dir, rounds, implementerModel, auditorModel, turnTimeout, exec = run, env = process.env, sleep = sleepMs, now = Date.now, progress = () => {} }) {
  const { panes, reports, prepare, spawn, finish } = await workers({ task, mux, cwd, dir, turnTimeout, render: (o) => turnText({ rounds, ...o }), exec, env, sleep, now, progress });
  const first = prepare("implementer", "implement");
  const implementer = await spawn(await panes.anchor(), "right", "pair: implementer", implementerModel, first.prompt);
  const orient = prepare("auditor", "orient");
  const auditor = await spawn(implementer, "below", "pair: auditor", auditorModel, orient.prompt);
  progress(`${mux}: implementer ${implementer} (${implementerModel}), auditor ${auditor} (${auditorModel}); files in ${dir}`);

  await finish("auditor", auditor, orient);
  let last = await finish("implementer", implementer, first);
  let verdict = "";
  for (let round = 1; round <= rounds; round++) {
    const audit = prepare("auditor", "audit", { round, previous: reports.at(-1).path });
    await panes.send(auditor, audit.prompt);
    const feedback = await finish("auditor", auditor, audit);
    verdict = /verdict:\s*([^\n]*)/i.exec(feedback)?.[1].trim() ?? "";
    const address = prepare("implementer", "address", { round, previous: audit.report });
    await panes.send(implementer, address.prompt);
    last = await finish("implementer", implementer, address);
  }
  return { mux, dir, panes: { implementer, auditor }, models: { implementer: implementerModel, auditor: auditorModel }, rounds, lastAuditVerdict: verdict, reports, finalReport: last.replace(DONE, "").trim() };
}

// ---------- CLI ----------

const PAIR_FLAGS = ["task-file", "rounds", "implementer-model", "auditor-model", "mux", "turn-timeout", "cwd"];

export function parseArgs(argv, valueFlags = PAIR_FLAGS) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--help" || arg === "-h") flags[arg.replace(/^-+/, "")] = true;
    else if (arg.startsWith("--")) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = argv[++i];
    } else positional.push(arg);
  }
  const known = new Set(["json", "help", "h", ...valueFlags]);
  for (const name of Object.keys(flags)) if (!known.has(name)) throw new Error(`unknown option --${name}`);
  return { positional, flags };
}

export async function main(argv, { env = process.env, exec = run, log = console.log, progress = console.error, sleep, now } = {}) {
  const { positional, flags } = parseArgs(argv);
  const [command] = positional;
  if (!command || flags.help || flags.h) {
    log(USAGE);
    return command || flags.help || flags.h ? 0 : 2;
  }
  const found = detect(env);
  if (command === "detect") {
    log(flags.json ? JSON.stringify(found) : found.mux ?? `none: ${found.reason}`);
    return found.mux ? 0 : 1;
  }
  if (command === "close") return closeWorkers(positional.slice(1), { mux: flags.mux ?? found.mux, reason: found.reason, env, exec, log });
  if (command !== "run") throw new Error(`unknown command ${command}\n\n${USAGE}`);

  const { mux, task, rounds, turnTimeout, cwd, dir } = runOptions(flags, { found, env, now, defaults: DEFAULTS, dirName: "pi-pair" });
  const result = await runPair({
    task,
    mux,
    cwd,
    dir,
    rounds,
    implementerModel: flags["implementer-model"] ?? DEFAULTS.implementerModel,
    auditorModel: flags["auditor-model"] ?? DEFAULTS.auditorModel,
    turnTimeout,
    exec,
    env,
    sleep,
    now,
    progress,
  });
  log(flags.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return 0;
}

/** Validate the shared `run` flags: multiplexer, task file, rounds, timeout; pick the worker folder and report folder. */
export function runOptions(flags, { found, env, now, defaults, dirName }) {
  const mux = flags.mux ?? found.mux;
  if (!["herdr", "rex"].includes(mux)) throw new Error(found.reason ?? `--mux must be herdr or rex`);
  if (mux === "herdr" && !env.HC_TERMINAL_ID) throw new Error("--mux herdr needs HC_TERMINAL_ID (run inside a Herdr app pane)");
  if (mux === "rex" && !(env.REX_SESSION && env.REX_BLOCK)) throw new Error("--mux rex needs REX_SESSION and REX_BLOCK (run inside a Rex pane)");
  if (!flags["task-file"]) throw new Error("run needs --task-file");
  const task = readFileSync(flags["task-file"], "utf8").trim();
  if (!task) throw new Error("task file is empty");
  const rounds = Number(flags.rounds ?? defaults.rounds);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer");
  const turnTimeout = flags["turn-timeout"] ?? defaults.turnTimeout;
  parseDuration(turnTimeout);
  const dir = join(tmpdir(), dirName, new Date(now ? now() : Date.now()).toISOString().replace(/[:.]/g, "-"));
  return { mux, task, rounds, turnTimeout, cwd: resolve(flags.cwd ?? process.cwd()), dir };
}

/** Close worker panes from a finished run. Never closes the caller's own pane. */
export async function closeWorkers(ids, { mux, reason, env = process.env, exec = run, log = console.log }) {
  if (!["herdr", "rex"].includes(mux)) throw new Error(reason ?? "--mux must be herdr or rex");
  if (!ids.length) throw new Error("close needs the worker ids printed by run, e.g. close t1 t2");
  const self = mux === "herdr" ? env.HC_TERMINAL_ID : env.REX_BLOCK;
  if (ids.includes(self)) throw new Error(`refusing to close ${self}: that is your own pane`);
  const panes = adapter(mux, { exec, env, cwd: process.cwd() });
  const failed = [];
  for (const id of ids) {
    try {
      await panes.close(id);
      log(`closed ${id}`);
    } catch (error) {
      failed.push(`${id}: ${error.message}`);
    }
  }
  if (failed.length) throw new Error(`could not close ${failed.join("; ")}`);
  return 0;
}

export function formatResult(r) {
  return [
    `Pair session complete (${r.mux}, ${r.rounds} rounds). Worker panes still open: implementer ${r.panes.implementer}, auditor ${r.panes.auditor}.`,
    `After reviewing the result, close them: node ${fileURLToPath(import.meta.url)} close ${r.panes.implementer} ${r.panes.auditor} --mux ${r.mux}`,
    `Last audit verdict: ${r.lastAuditVerdict || "(none given)"}`,
    `Reports:`,
    ...r.reports.map((x) => `  ${x.role.padEnd(11)} ${x.path}`),
    "",
    "Final implementer report:",
    "",
    r.finalReport,
  ].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`pair: ${error.message}`);
      process.exitCode = 2;
    },
  );
}
