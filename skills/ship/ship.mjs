#!/usr/bin/env node
// Watch GitHub Actions for a commit and verify a deployed URL.
// Zero dependencies; Node.js 22+; uses the authenticated `gh` CLI.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RUN_FIELDS = "databaseId,workflowName,status,conclusion,url,event,headBranch,attempt";
const OK = new Set(["success", "skipped", "neutral"]);
const CACHE_HEADERS = ["age", "cache-control", "x-cache", "cf-cache-status", "x-vercel-cache", "last-modified", "etag"];

// ---------- gh / git ----------

export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cmd} ${args.join(" ")}: ${(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseDuration(value) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value).trim());
  if (!m) throw new Error(`invalid duration ${value} (use e.g. 90s, 30m)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"];
}

// ---------- CI ----------

export const runOk = (r) => r.status === "completed" && OK.has(r.conclusion);
const runKey = (r) => `${r.databaseId}:${r.attempt ?? 1}:${r.status}:${r.conclusion ?? ""}`;

/** Poll runs for a commit until all complete and the set is stable for one more poll. */
export async function watchRuns({ sha, gh, sleep = sleepMs, now = Date.now, interval = 15_000, timeout = 30 * 60_000, appearTimeout = 2 * 60_000, onUpdate = () => {} }) {
  const start = now();
  let previous = "";
  let settled = false;
  for (;;) {
    const runs = JSON.parse(await gh(["run", "list", "--commit", sha, "--json", RUN_FIELDS, "--limit", "50"]));
    const key = runs.map(runKey).sort().join("|");
    const complete = runs.length > 0 && runs.every((r) => r.status === "completed");
    if (key !== previous) onUpdate(runs);
    if (complete && (settled || key === previous)) {
      return { state: runs.every(runOk) ? "success" : "failure", runs };
    }
    settled = false;
    if (complete) settled = key === previous;
    previous = key;
    const elapsed = now() - start;
    if (runs.length === 0 && elapsed >= appearTimeout) return { state: "missing", runs };
    if (elapsed >= timeout) return { state: "timeout", runs };
    await sleep(interval);
  }
}

const cleanLine = (line) =>
  line
    .replace(/^\uFEFF/, "")
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
    .replace(/(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]/g, "");

/** Turn `gh run view --log-failed` output into a short excerpt per job, ending at each ##[error]. */
export function extractErrors(log, { context = 30, max = 80 } = {}) {
  const jobs = new Map();
  for (const raw of log.split(/\r?\n/)) {
    if (!raw) continue;
    const parts = raw.split("\t");
    const job = parts.length >= 3 ? parts[0] : "(log)";
    const text = cleanLine(parts.length >= 3 ? parts.slice(2).join("\t") : raw);
    if (!jobs.has(job)) jobs.set(job, []);
    jobs.get(job).push(text);
  }
  const result = [];
  for (const [job, lines] of jobs) {
    const keep = new Set();
    const errors = lines.flatMap((line, i) => (line.includes("##[error]") ? [i] : []));
    const ends = errors.length ? errors : [lines.length - 1];
    for (const end of ends) for (let i = Math.max(0, end - context); i <= end; i++) keep.add(i);
    let excerpt = [...keep].sort((a, b) => a - b).map((i) => lines[i]).filter((l) => l.trim() && !/^##\[(end)?group\]/.test(l));
    if (excerpt.length > max) excerpt = ["…", ...excerpt.slice(-max)];
    result.push({ job, errors: errors.map((i) => lines[i].replace(/^.*##\[error\]/, "")), excerpt });
  }
  return result;
}

export async function diagnose(r, gh) {
  const view = JSON.parse(await gh(["run", "view", String(r.databaseId), "--json", "jobs"]));
  const jobs = (view.jobs ?? [])
    .filter((j) => j.conclusion && !OK.has(j.conclusion))
    .map((j) => ({
      name: j.name,
      conclusion: j.conclusion,
      url: j.url,
      failedSteps: (j.steps ?? []).filter((s) => s.conclusion && !OK.has(s.conclusion)).map((s) => s.name),
    }));
  let excerpts = [];
  try {
    excerpts = extractErrors(await gh(["run", "view", String(r.databaseId), "--log-failed"]));
  } catch (error) {
    excerpts = [{ job: "(log)", errors: [], excerpt: [`log unavailable: ${error.message}`] }];
  }
  return { run: r, jobs, excerpts };
}

const icon = (r) => (r.status !== "completed" ? "…" : runOk(r) ? "✓" : "✗");
const runLine = (r) => `${icon(r)} ${r.workflowName} (${r.event}): ${r.status === "completed" ? r.conclusion : r.status} ${r.url}`;

export function formatCi(sha, outcome, diagnoses = []) {
  const lines = [`CI ${outcome.state} for ${sha.slice(0, 12)}`];
  if (outcome.state === "missing") {
    lines.push("No workflow runs found. Was the commit pushed, and does a workflow trigger on this branch/event?");
  }
  for (const r of outcome.runs) lines.push(`- ${runLine(r)}`);
  for (const d of diagnoses) {
    lines.push("", `## ${d.run.workflowName} #${d.run.databaseId}`);
    for (const j of d.jobs) {
      lines.push(`- job "${j.name}" ${j.conclusion}${j.failedSteps.length ? `; failed step: ${j.failedSteps.join(", ")}` : ""}${j.url ? ` ${j.url}` : ""}`);
    }
    for (const e of d.excerpts) lines.push("", `### ${e.job}`, "```", ...e.excerpt, "```");
  }
  return lines.join("\n");
}

// ---------- verify ----------

export function matcher(expect) {
  const re = /^\/(.+)\/([a-z]*)$/.exec(expect);
  return re ? (text) => new RegExp(re[1], re[2]).test(text) : (text) => text.includes(expect);
}

export async function verifyUrl(url, { expect = [], reject = [], status = 200, timeout = 15_000, fetchImpl = fetch, now = Date.now } = {}) {
  const started = now();
  const checks = [];
  let res;
  let body = "";
  try {
    res = await fetchImpl(url, { redirect: "follow", headers: { "user-agent": "pi-kit-ship" }, signal: AbortSignal.timeout(timeout) });
    body = await res.text();
  } catch (error) {
    return { ok: false, url, at: new Date(started).toISOString(), error: error.message, checks, headers: {} };
  }
  const ms = now() - started;
  checks.push({ check: `status ${status}`, ok: res.status === status, actual: String(res.status) });
  for (const e of expect) checks.push({ check: `contains ${e}`, ok: matcher(e)(body) });
  for (const e of reject) checks.push({ check: `lacks ${e}`, ok: !matcher(e)(body) });
  const headers = Object.fromEntries(CACHE_HEADERS.flatMap((h) => (res.headers.get(h) ? [[h, res.headers.get(h)]] : [])));
  return { ok: checks.every((c) => c.ok), url, finalUrl: res.url || url, at: new Date(started).toISOString(), ms, bytes: Buffer.byteLength(body), checks, headers };
}

export function formatVerify(v) {
  if (v.error) return `✗ ${v.at} GET ${v.url}: ${v.error}`;
  const checks = v.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.check}${c.ok || !c.actual ? "" : ` (got ${c.actual})`}`).join("; ");
  const cache = Object.entries(v.headers).map(([k, val]) => `${k}: ${val}`).join(", ");
  const target = v.finalUrl !== v.url ? `${v.url} → ${v.finalUrl}` : v.url;
  return `${v.ok ? "✓" : "✗"} ${v.at} GET ${target} in ${v.ms} ms (${v.bytes} B): ${checks}${cache ? `\n  cache: ${cache}` : ""}`;
}

// ---------- CLI ----------

const USAGE = `Usage: node ship.mjs <command>

  ci [sha|ref] [--timeout 30m] [--interval 15s] [--json]
      wait for every GitHub Actions run on the commit (default HEAD);
      on failure print failed jobs, steps, and the log lines before ##[error]
  verify <url> [--expect text|/re/]... [--reject text|/re/]... [--status 200] [--json]
      fetch the deployed URL and check status and content; reports cache headers

Exit codes: 0 pass, 1 failed check, 2 usage error, 3 timeout or no runs.`;

function parseArgs(argv) {
  const positional = [];
  const flags = { expect: [], reject: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--help" || arg === "-h") flags[arg.replace(/^-+/, "")] = true;
    else if (["--timeout", "--interval", "--status", "--expect", "--reject"].includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      const name = arg.slice(2);
      if (Array.isArray(flags[name])) flags[name].push(argv[++i]);
      else flags[name] = argv[++i];
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

export async function main(argv, { gh = (args) => run("gh", args), git = (args) => run("git", args), log = console.log, progress = console.error, sleep, now, fetchImpl } = {}) {
  const { positional, flags } = parseArgs(argv);
  const [command, target] = positional;
  if (!command || flags.help || flags.h) {
    log(USAGE);
    return command || flags.help || flags.h ? 0 : 2;
  }

  if (command === "ci") {
    const sha = (await git(["rev-parse", "--verify", `${target ?? "HEAD"}^{commit}`])).trim();
    const outcome = await watchRuns({
      sha,
      gh,
      sleep,
      now,
      timeout: parseDuration(flags.timeout ?? "30m"),
      interval: parseDuration(flags.interval ?? "15s"),
      onUpdate: (runs) => progress(runs.length ? runs.map(runLine).join("\n") : `waiting for runs on ${sha.slice(0, 12)}…`),
    });
    const diagnoses = [];
    for (const r of outcome.runs) if (r.status === "completed" && !runOk(r)) diagnoses.push(await diagnose(r, gh));
    log(flags.json ? JSON.stringify({ sha, ...outcome, diagnoses }, null, 2) : formatCi(sha, outcome, diagnoses));
    return { success: 0, failure: 1 }[outcome.state] ?? 3;
  }

  if (command === "verify") {
    if (!target || !/^https?:\/\//.test(target)) throw new Error("verify needs an http(s) URL");
    const status = Number(flags.status ?? 200);
    if (!Number.isInteger(status)) throw new Error("--status must be an HTTP status code");
    const v = await verifyUrl(target, { expect: flags.expect, reject: flags.reject, status, fetchImpl, now });
    log(flags.json ? JSON.stringify(v, null, 2) : formatVerify(v));
    return v.ok ? 0 : 1;
  }

  throw new Error(`unknown command ${command}\n\n${USAGE}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`ship: ${error.message}`);
      process.exitCode = 2;
    },
  );
}
