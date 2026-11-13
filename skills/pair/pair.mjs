#!/usr/bin/env node
// Pair programming between two visible Pi workers: an implementer and an auditor.
// Detects Herdr (herdr-core `hc`, with herdr-app panes when that CLI can see the caller) or Rex,
// starts one interactive worker per role, and relays turns through files.
// Zero dependencies; Node.js 22+.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULTS = {
  rounds: 3,
  implementerModel: "claude-code/claude-opus-5-5",
  auditorModel: "openai/gpt-6.1-sol:xhigh",
  turnTimeout: "60m",
};
export const DONE = "<!-- pair:done -->";
const REX_APP_BINS = ["/Applications/Rex.app", "/Applications/Rex Beta.app"].map((app) => `${app}/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`);

const USAGE = `Usage:
  pair.mjs detect [--json]
  pair.mjs run --task-file <path> [options]
  pair.mjs wait <run-id|run-dir> [--timeout 15m] [--json]  block until the run ends or the timeout passes
  pair.mjs close <worker>... [--mux herdr|rex] [--run <id>]   close finished workers (ids from run)

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
 * Worker operations behind one interface: anchor() → id, split(anchor, direction, label, argv) → id, send, read,
 * close, and optionally alive (throws when the worker is gone) and idle (true once the agent stopped working).
 * `layout` says whether workers get desktop panes ("panes") or only attachable Herdr core terminals ("terminals").
 * Herdr picks its layout at runtime; see `herdrTransport`.
 */
export function adapter(mux, { exec = run, env = process.env, cwd, ...rest }) {
  if (mux === "herdr") return herdrAdapter({ exec, env, cwd, ...rest });
  if (mux === "rex") {
    const bin = env.REX_BIN || onPath("rex", env.PATH) || REX_APP_BINS.find((p) => existsSync(p)) || "rex";
    const session = env.REX_SESSION;
    const rex = async (args) => exec(bin, args);
    return {
      layout: "panes",
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

const herdrBins = (env) => ({ app: findBin("herdr-app", env.HERDR_APP_BIN, env), hc: findBin("hc", env.HC_BIN, env) });
const errorText = (error) => String(error?.message ?? error).split("\n")[0];

/** The Herdr app pane showing terminal `id`, from `herdr-app ls`; throws when the app CLI is missing or has no window. */
async function appPaneOf(exec, app, id) {
  const { spaces = [] } = JSON.parse(await exec(app, ["ls"]));
  return spaces.flatMap((s) => s.tabs ?? []).flatMap((t) => t.terminals ?? []).find((t) => t.terminal === id)?.pane ?? null;
}

/**
 * Which Herdr controls work from here. `HC_TERMINAL_ID` names a Herdr core terminal; it does not mean the desktop
 * app CLI runs on this machine (over SSH it usually does not). Prefer app panes when `herdr-app ls` shows the caller;
 * otherwise fall back to core-only terminals if `hc` can see the caller. Never needs SSH variables.
 */
export async function probeHerdr({ exec = run, env = process.env } = {}) {
  const self = env.HC_TERMINAL_ID;
  const bins = herdrBins(env);
  let appReason;
  try {
    if (await appPaneOf(exec, bins.app, self)) return { layout: "panes", terminal: self };
    appReason = `terminal ${self} is not shown in a Herdr app pane (herdr-app ls)`;
  } catch (error) {
    appReason = `herdr-app unavailable here: ${errorText(error)}`;
  }
  let state;
  try {
    state = JSON.parse(await exec(bins.hc, ["get", self, "--json"])).state;
  } catch (error) {
    throw new Error(`Herdr app panes unusable (${appReason}) and Herdr core cannot see ${self} (hc get ${self}: ${errorText(error)})`);
  }
  if (state !== "live") throw new Error(`Herdr app panes unusable (${appReason}) and hc get ${self} reports state ${state ?? "unknown"}`);
  return { layout: "terminals", terminal: self, appReason };
}

/** "pair-review: lead" → { workflow: "pair-review", role: "lead" } */
const parseLabel = (label) => {
  const m = /^([\w-]+):\s*([\w-]+)$/.exec(label);
  return m ? { workflow: m[1], role: m[2] } : { workflow: "pair", role: label.replace(/\W+/g, "-") };
};
const ownerLabels = (label, runId) => {
  const { workflow, role } = parseLabel(label);
  return [`pair.workflow=${workflow}`, `pair.role=${role}`, ...(runId ? [`pair.run=${runId}`] : [])];
};

/**
 * Talking to Herdr core terminals, shared by both Herdr layouts. Pi reports its status to the core (OSC 7501);
 * `ready` waits with `hc wait` while a worker is working, never types into a blocked worker, and gives up at `timeout`.
 */
function hcControls({ hc, sleep = sleepMs, now = Date.now, timeout = 3_600_000, progress = () => {} }) {
  const noted = new Set();
  const get = async (id) => JSON.parse(await hc(["get", id, "--json"]));
  const gone = (id, t) => new Error(`terminal ${id} is ${t.state}${t.exit_code == null ? "" : ` (exit ${t.exit_code})`}`);
  const noteBlocked = (id) => {
    if (noted.has(id)) return;
    noted.add(id);
    progress(`worker ${id} is blocked and needs a person: hc attach ${id} (or open it in Herdr), answer it, then the run continues`);
  };
  /** True while the worker's agent reports that it is working on a turn. */
  const working = async (id) => (await get(id)).status?.state === "working";
  /** True once the worker reported a status other than working; false when it never reports status. */
  async function ready(id) {
    const start = now();
    for (;;) {
      const t = await get(id);
      if (t.state !== "live") throw gone(id, t);
      const status = t.status?.state;
      if (!status) return false;
      if (status !== "working" && status !== "blocked") return true;
      if (now() - start > timeout) throw new Error(`worker ${id} is still ${status} after ${Math.round(timeout / 60_000)}m; inspect it with hc read ${id} --lines 100`);
      // hc wait returns when the turn ends (or checks in after 120s); if hc itself fails, back off instead of spinning.
      if (status === "working") await hc(["wait", id, "--timeout", "120", "--json"]).catch(() => sleep(5_000));
      else {
        noteBlocked(id);
        await sleep(15_000);
      }
    }
  }
  return {
    working,
    // After a finished report: true once the turn ended. Errors (e.g. the worker exited) fall back to settling its screen.
    idle: (id) => ready(id).catch(() => false),
    // Before a send: wait while it works; throws if it is gone or stays blocked past the turn timeout.
    async send(id, text) {
      await ready(id);
      await hc(["send", id, text]);
    },
    read: (id) => hc(["read", id, "--lines", "40"]),
    // `hc read` still works after a terminal finished, so ask the core whether it is live.
    async alive(id) {
      const t = await get(id);
      if (t.state !== "live") throw gone(id, t);
      if (t.status?.state === "blocked") noteBlocked(id);
    },
  };
}

/**
 * Herdr core only (e.g. over SSH, where `herdr-app` is absent): workers are background `hc` terminals started in
 * the worker folder with their first task as Pi's argument. They are attachable but not placed in desktop panes.
 */
function herdrCoreAdapter({ exec, env, cwd, runId, ...controls }) {
  const hcBin = herdrBins(env).hc;
  const hc = (args) => exec(hcBin, args);
  return {
    layout: "terminals",
    ...hcControls({ hc, ...controls }),
    anchor: async () => env.HC_TERMINAL_ID,
    async split(_anchor, _direction, label, argv) {
      const { workflow, role } = parseLabel(label);
      const name = `${workflow}-${role}-${runId}`.slice(0, 32);
      const labels = ownerLabels(label, runId).flatMap((l) => ["--label", l]);
      // --no-notify: hc must not type notes into the caller while it runs this orchestration.
      const out = JSON.parse(await hc(["run", "--bg", "--json", "--no-notify", "--name", name, "--cwd", cwd, ...labels, "--", ...argv]));
      if (!out.address) throw new Error("hc run returned no terminal address");
      return out.address;
    },
    async close(id) {
      await hc(["kill", id]).catch(() => {});
      await hc(["rm", id]).catch(() => {});
    },
  };
}

/** Herdr with a usable app CLI or core-only, chosen by `probeHerdr`. */
export async function herdrTransport(options) {
  const probe = await probeHerdr(options);
  if (probe.layout === "terminals") (options.progress ?? (() => {}))(`herdr: no automatic panes (${probe.appReason}); using Herdr core terminals`);
  return probe.layout === "panes" ? herdrAdapter(options) : herdrCoreAdapter(options);
}

/**
 * Herdr app: `herdr-app` arranges panes in the window, herdr-core `hc` talks to the terminals in them.
 * Workers are identified by their terminal address (t7); the adapter remembers each one's pane for splitting.
 */
function herdrAdapter({ exec, env, cwd, runId, ...controls }) {
  const { app, hc: hcBin } = herdrBins(env);
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
    layout: "panes",
    ...hcControls({ hc, ...controls }),
    // The caller's pane: the window's pane showing our own terminal ($HC_TERMINAL_ID).
    async anchor() {
      const self = env.HC_TERMINAL_ID;
      const pane = await appPaneOf(exec, app, self);
      if (!pane) throw new Error(`terminal ${self} is not shown in a Herdr app pane (herdr-app ls)`);
      paneOf.set(self, pane);
      home = pane;
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
      // Ownership labels let `close` refuse terminals that this run did not start.
      await hc(["label", out.terminal, ...ownerLabels(label, runId)]).catch(() => {});
      return out.terminal;
    },
    // Close the worker's pane (ending its terminal), then drop the finished terminal from herdr-core.
    async close(id) {
      const pane = await appPaneOf(exec, app, id).catch(() => null);
      if (pane) await herdrApp("pane.close", { pane });
      else await hc(["kill", id]).catch(() => {});
      await hc(["rm", id]).catch(() => {});
    },
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

/**
 * Provider errors that end a worker's turn without a report: plan usage limits and requests charged to paid usage
 * credits. These stop the run so the user decides; the script never switches models or enables credits itself.
 */
export const LIMIT_PATTERNS = [
  /usage limit (?:has been reached|exceeded|reached)/i,
  /charged to (?:\w+ )?usage credits/i,
  /UsageLimitError/,
  /out of (?:plan )?(?:usage|quota)/i,
];

/**
 * The provider-limit error line in the last lines of a worker's screen, or null. Only lines that read as an error or
 * billing notice count, so a worker that merely discusses rate limits in its output is not mistaken for a stop.
 */
export function usageLimit(screen, lines = 12) {
  for (const line of String(screen).split("\n").slice(-lines)) {
    if (/error|billing|\b4\d\d\b/i.test(line) && LIMIT_PATTERNS.some((p) => p.test(line))) return line.trim().slice(0, 200);
  }
  return null;
}

/** Thrown when a worker stopped on a provider limit; the run ends as `stopped` rather than `failed`. */
export class StoppedError extends Error {
  constructor(message) {
    super(message);
    this.stopReason = "usage-limit";
  }
}

// ---------- run status (for `wait`) ----------

export const STATUS_FILE = "status.json";
const RUN_DIRS = ["pi-pair", "pi-pair-review", "pi-pair-work"];

export function readStatus(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, STATUS_FILE), "utf8"));
  } catch {
    return null;
  }
}

export function updateStatus(dir, patch) {
  mkdirSync(dir, { recursive: true });
  const next = { ...readStatus(dir), ...patch, updated: new Date().toISOString() };
  writeFileSync(join(dir, STATUS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Run a workflow while keeping `<dir>/status.json` current, so `wait` in another process can follow it:
 * `running` (with the last progress line), then `done` with the result and its summary, `stopped` on a provider
 * limit, or `failed` on any other error.
 */
export async function tracked({ dir, runId, workflow, script, progress = () => {} }, body, format) {
  updateStatus(dir, { state: "running", workflow, runId, dir, pid: process.pid, started: new Date().toISOString() });
  progress(`${workflow} run ${runId}: follow it with \`node ${script} wait ${runId}\` (status in ${join(dir, STATUS_FILE)})`);
  const note = (message) => {
    progress(message);
    updateStatus(dir, { last: message });
  };
  try {
    const result = await body(note);
    updateStatus(dir, { state: "done", result, summary: format(result) });
    return result;
  } catch (error) {
    updateStatus(dir, { state: error.stopReason ? "stopped" : "failed", stopReason: error.stopReason, reason: error.message });
    throw error;
  }
}

/** The run folder for a run id (searched under the temp folder) or a run folder path. */
export function findRun(target, { roots = RUN_DIRS.map((name) => join(tmpdir(), name)) } = {}) {
  if (readStatus(target)) return target;
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) if (readStatus(join(root, entry))?.runId === target) return join(root, entry);
  }
  throw new Error(`no pair run ${target} found (pass the run id printed by run, or its report folder)`);
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * Block until the run is no longer `running` or `timeout` passes, then return its status. A run whose orchestrating
 * process died without writing a result is marked `failed`.
 */
export async function waitForRun(dir, { timeout = 900_000, interval = 5_000, sleep = sleepMs, now = Date.now, alive = pidAlive } = {}) {
  const start = now();
  for (;;) {
    let status = readStatus(dir);
    if (!status) throw new Error(`no ${STATUS_FILE} in ${dir}`);
    if (status.state === "running" && status.pid && !alive(status.pid)) {
      status = updateStatus(dir, { state: "failed", reason: `the run process (pid ${status.pid}) exited without a result; read the workers and reports in ${dir}` });
    }
    if (status.state !== "running" || now() - start >= timeout) return status;
    await sleep(interval);
  }
}

export function formatWait(status) {
  const workers = Object.entries(status.workers ?? {}).map(([role, id]) => `${role} ${id}`).join(", ");
  const where = `Reports: ${status.dir}${workers ? `. Workers: ${workers}` : ""}`;
  if (status.state === "done") return status.summary ?? `done: ${where}`;
  if (status.state === "running") return `running: ${status.workflow ?? "pair"} run ${status.runId} is still working${status.last ? ` (last: ${status.last})` : ""}. Call wait again; do not end your turn.`;
  if (status.state === "stopped") return `stopped: ${status.reason}\n${where}\nAsk the user how to continue. Do not switch models or enable paid credits.`;
  return `failed: ${status.reason}\n${where}`;
}

/** `wait <run-id|dir> [--timeout 15m] [--json]`: exit 0 while running or done, 1 when stopped or failed. */
export async function waitCommand(target, flags, { log = console.log, sleep, now, roots } = {}) {
  if (!target) throw new Error("wait needs the run id printed by run (or the run's report folder)");
  const status = await waitForRun(findRun(target, roots ? { roots } : undefined), { timeout: parseDuration(flags.timeout ?? "15m"), sleep, now });
  const { result, ...brief } = status;
  log(flags.json ? JSON.stringify(status.state === "done" ? status : brief, null, 2) : formatWait(status));
  return status.state === "running" || status.state === "done" ? 0 : 1;
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

/** The worker transport for `mux`: Rex panes, Herdr app panes, or Herdr core terminals (see `probeHerdr`). */
export async function transport(mux, options) {
  return mux === "herdr" ? herdrTransport(options) : adapter(mux, options);
}

/** Eight hex characters that tag this run's workers so concurrent runs and `close` cannot confuse them. */
export const newRunId = () => randomBytes(4).toString("hex");

/**
 * Shared worker plumbing for pair, pair-review, and pair-work: numbered turn/report files in `dir`, two Pi workers
 * started through the chosen transport, and waiting for a worker's finished report. Reports stay on this machine.
 */
export async function workers({ task, mux, cwd, dir, turnTimeout, label = "Pair session", render, exec = run, env = process.env, sleep = sleepMs, now = Date.now, progress = () => {}, runId = newRunId() }) {
  const timeout = parseDuration(turnTimeout);
  const panes = await transport(mux, { exec, env, cwd, runId, sleep, now, timeout, progress });
  mkdirSync(dir, { recursive: true });
  const baseline = await exec("git", ["status", "--short", "--branch"], { cwd }).then((s) => `\`git status --short --branch\`:\n\n\`\`\`\n${s.trim()}\n\`\`\``, () => "");
  writeFileSync(join(dir, "task.md"), task);

  let step = 0;
  const reports = [];
  const pi = env.PAIR_PI_BIN || onPath("pi", env.PATH) || "pi";
  return {
    panes,
    reports,
    runId,
    /** Fields every workflow's result carries: transport layout, run id, and the caller's own pane or terminal. */
    meta: { layout: panes.layout, runId, caller: mux === "herdr" ? env.HC_TERMINAL_ID : env.REX_BLOCK },
    /** Write the next turn file; `render` gets the role, kind, report path, task, and baseline plus `extra`. */
    prepare(role, kind, extra = {}) {
      const base = join(dir, `${String(++step).padStart(2, "0")}-${role}-${kind}`);
      const turn = `${base}.turn.md`;
      const report = `${base}.report.md`;
      writeFileSync(turn, render({ role, kind, task, report, baseline, ...extra }));
      return { turn, report, prompt: `${label} (${role}, ${kind}): read ${turn} and follow it exactly.` };
    },
    // The first task is Pi's launch argument, so it cannot be dropped by a send to a booting agent.
    async spawn(anchor, direction, name, model, prompt) {
      const id = await panes.split(anchor, direction, name, [pi, "--model", model, prompt]);
      const status = readStatus(dir);
      if (status) updateStatus(dir, { mux, layout: panes.layout, workers: { ...status.workers, [parseLabel(name).role]: id } });
      return id;
    },
    async finish(role, id, { report }) {
      progress(`waiting for ${role}: ${report}`);
      const isAlive = async () => {
        await (panes.alive ?? panes.read)(id).then(() => {}, (error) => {
          throw new Error(`${role} ${panes.layout === "terminals" ? "terminal" : "pane"} ${id} is gone (${error.message}); reports so far are in ${dir}`);
        });
        // A worker that stopped on a provider limit never writes its report; do not wait out the turn timeout.
        if (await panes.working?.(id).catch(() => false)) return;
        const hit = usageLimit(await panes.read(id).catch(() => ""));
        if (hit) throw new StoppedError(`${role} ${id} stopped on a provider limit: "${hit}". Reports so far are in ${dir}`);
      };
      const text = await waitForReport(report, { sleep, now, timeout, isAlive });
      reports.push({ role, path: report });
      if (!(await panes.idle?.(id))) await settle(() => panes.read(id), { sleep });
      return text;
    },
  };
}

export async function runPair({ task, mux, cwd, dir, rounds, implementerModel, auditorModel, turnTimeout, exec = run, env = process.env, sleep = sleepMs, now = Date.now, progress = () => {}, runId }) {
  const { panes, reports, meta, prepare, spawn, finish } = await workers({ task, mux, cwd, dir, turnTimeout, render: (o) => turnText({ rounds, ...o }), exec, env, sleep, now, progress, runId });
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
  return { mux, ...meta, dir, panes: { implementer, auditor }, models: { implementer: implementerModel, auditor: auditorModel }, rounds, lastAuditVerdict: verdict, reports, finalReport: last.replace(DONE, "").trim() };
}

// ---------- CLI ----------

const PAIR_FLAGS = ["task-file", "rounds", "implementer-model", "auditor-model", "mux", "turn-timeout", "cwd", "run", "timeout"];

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
  if (command === "detect") return detectCommand(flags, { env, exec, log });
  if (command === "close") return closeWorkers(positional.slice(1), { mux: flags.mux ?? found.mux, reason: found.reason, runId: flags.run, env, exec, log });
  if (command === "wait") return waitCommand(positional[1], flags, { log, sleep, now });
  if (command !== "run") throw new Error(`unknown command ${command}\n\n${USAGE}`);

  const { mux, task, rounds, turnTimeout, cwd, dir } = runOptions(flags, { found, env, now, defaults: DEFAULTS, dirName: "pi-pair" });
  const runId = newRunId();
  const script = fileURLToPath(import.meta.url);
  const result = await tracked({ dir, runId, workflow: "pair", script, progress }, (note) => runPair({
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
    progress: note,
    runId,
  }), formatResult);
  log(flags.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return 0;
}

/**
 * Detection with Herdr's usable controls checked: `herdr` (app panes), `herdr (core-only: ...)` when only `hc` works,
 * or `none: <reason>`. Missing `herdr-app` alone never makes Herdr unavailable. Exit code 0 when a transport is usable.
 */
export async function environment({ env = process.env, exec = run } = {}) {
  const found = detect(env);
  if (found.mux !== "herdr") return found;
  try {
    const probe = await probeHerdr({ exec, env });
    return { ...found, layout: probe.layout, ...(probe.appReason ? { appReason: probe.appReason } : {}) };
  } catch (error) {
    return { mux: null, reason: error.message };
  }
}

export function formatDetect(found) {
  if (!found.mux) return `none: ${found.reason}`;
  if (found.layout === "terminals") return `herdr (core-only: hc terminals, no automatic panes; ${found.appReason})`;
  return found.mux;
}

export async function detectCommand(flags, { env, exec, log }) {
  const found = await environment({ env, exec });
  log(flags.json ? JSON.stringify(found) : formatDetect(found));
  return found.mux ? 0 : 1;
}

/** Validate the shared `run` flags: multiplexer, task file, rounds, timeout; pick the worker folder and report folder. */
export function runOptions(flags, { found, env, now, defaults, dirName }) {
  const mux = flags.mux ?? found.mux;
  if (!["herdr", "rex"].includes(mux)) throw new Error(found.reason ?? `--mux must be herdr or rex`);
  if (mux === "herdr" && !env.HC_TERMINAL_ID) throw new Error("--mux herdr needs HC_TERMINAL_ID (run inside a Herdr app pane)");
  if (mux === "rex" && !(env.REX_SESSION && env.REX_BLOCK)) throw new Error("--mux rex needs REX_SESSION and REX_BLOCK (run inside a Rex pane)");
  if (flags.run) throw new Error("--run belongs to close; run creates its own run id");
  if (flags.timeout) throw new Error("--timeout belongs to wait; use --turn-timeout for run");
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

/**
 * Refuse Herdr terminals that no pair run started (no `pair.run`/`pair.role` label), or that belong to another run
 * when `runId` is given. Checks every id before anything is closed.
 */
async function checkOwnership(ids, { env, exec, runId }) {
  const hcBin = herdrBins(env).hc;
  for (const id of ids) {
    let t;
    try {
      t = JSON.parse(await exec(hcBin, ["get", id, "--json"]));
    } catch (error) {
      throw new Error(`refusing to close ${id}: hc get ${id} failed (${errorText(error)})`);
    }
    const labels = t.labels ?? {};
    const owner = labels["pair.run"];
    if (!owner && !labels["pair.role"]) throw new Error(`refusing to close ${id}: ${id} was not started by a pair run (no pair.run label)`);
    if (runId && owner !== runId) throw new Error(`refusing to close ${id}: ${id} belongs to pair run ${owner ?? "(unlabelled)"}, not ${runId}`);
  }
}

/**
 * Close workers from a finished run. Never closes the caller's own pane or terminal. In Herdr, closes only terminals
 * labelled by a pair run (and by `runId` when given): the app pane when one shows it, else `hc kill` then `hc rm`.
 */
export async function closeWorkers(ids, { mux, reason, runId, env = process.env, exec = run, log = console.log }) {
  if (!["herdr", "rex"].includes(mux)) throw new Error(reason ?? "--mux must be herdr or rex");
  if (!ids.length) throw new Error("close needs the worker ids printed by run, e.g. close t1 t2");
  const self = mux === "herdr" ? env.HC_TERMINAL_ID : env.REX_BLOCK;
  if (ids.includes(self)) throw new Error(`refusing to close ${self}: that is your own ${mux === "herdr" ? "terminal" : "pane"}`);
  if (mux === "herdr") await checkOwnership(ids, { env, exec, runId });
  // The pane adapter closes the app pane when one shows the worker and falls back to hc kill + rm otherwise.
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

/**
 * The "where are the workers" lines shared by every workflow's result: still-open panes, or, in core-only Herdr,
 * the terminal ids and how to open them, because nothing was placed in a desktop pane.
 */
export function workerLines(r, script, roles) {
  const ids = roles.map((role) => r.panes[role]);
  const list = roles.map((role) => `${role} ${r.panes[role]}`).join(", ");
  const close = `node ${script} close ${ids.join(" ")} --mux ${r.mux}${r.mux === "herdr" && r.runId ? ` --run ${r.runId}` : ""}`;
  if (r.layout !== "terminals") return [`Worker panes still open: ${list}.`, `After reviewing the result, close them: ${close}`];
  return [
    `Worker terminals still running (Herdr core, not placed in desktop panes): ${list}; labels pair.run=${r.runId}.`,
    `To watch one, attach from any terminal on this machine: ${ids.map((id) => `hc attach ${id}`).join(" or ")} (Ctrl+\\ detaches), or open it from Herdr's terminal list.`,
    `After reviewing the result, close them: ${close}`,
  ];
}

export function formatResult(r) {
  const [where, ...how] = workerLines(r, fileURLToPath(import.meta.url), ["implementer", "auditor"]);
  return [
    `Pair session complete (${r.mux}, ${r.rounds} rounds). ${where}`,
    ...how,
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
