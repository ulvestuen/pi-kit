#!/usr/bin/env node
// Reflect on how agent sessions went, from local Pi session logs.
// Zero dependencies; Node.js 22+. Reads only; prints redacted excerpts.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Short user replies that only keep the agent going or approve without input.
const NUDGE = /^((please )?(continue|contiue|contine|go on|go ahead|carry on|keep going|proceed|do (it|that|so))\b.*|please do( that| it)?|what('s| is) next\b.*|how do i continue\b.*|next|resume)\W*$/i;
const NOISE = /^(hi|hello|hey|test|clear|cler|clera|exit|quit|\/\w+)\W*$/i;
const STAMP = /^(y|ye|yes|yep|yeah|ok|okay|sure|approve|approved|lgtm|yes,? (to all|please|do it)|yest to all|ya)\W*$/i;
const REPEAT = /^(send (it )?again|do it again|try again|again|retry|test .* again)\W*$/i;
// Prompts that correct or reject the previous result.
const CORRECTION = new RegExp(
  [
    String.raw`^no\b`,
    String.raw`^(that'?s|this is) (not|wrong)`,
    String.raw`(does ?n[o']?t|do not|did not|didn'?t|isn'?t|is not) work`,
    String.raw`not working`,
    String.raw`\bstill (get|getting|fails?|failing|broken|not|see|no)\b`,
    String.raw`\bcan'?t (see|find)\b.*\b(change|improvement|difference|update)`,
    String.raw`\bwhat was done\b`,
    String.raw`\bcome on\b`,
    String.raw`\byou (need|have) to stick\b`,
    String.raw`\bcan you decide\b`,
    String.raw`\bi (said|told you|asked)\b`,
    String.raw`\b(wrong|incorrect)\b`,
    String.raw`^but\b`,
    String.raw`^did you\b`,
    String.raw`\bi thought\b`,
    String.raw`\bis it really\b`,
    String.raw`\bi (do not|don'?t) want\b`,
    String.raw`\bcan'?t be\b`,
    String.raw`\byou only\b`,
    String.raw`\blooks (really |very )?(boring|wrong|bad|broken|off)\b`,
    String.raw`\bi always seem to\b`,
  ].join("|"),
  "i",
);
const SHIP = /\b(commit|push|rerun deploy\w*|redeploy|babysit ci|ci (is |until )?(it is )?green)\b/i;
const SKILL = /^<skill name="([^"]+)"/;
const TEMPLATE = /^Run a \*\*([^*]+)\*\*|^Create or revise a plan for this goal/;

export const KINDS = ["nudge", "stamp", "approval", "answer", "repeat", "correction", "ship", "skill", "template", "task", "noise"];

// An agent message with this many questions is a batch; "yes" to it is a rubber stamp.
export const BATCH = 3;
export const countQuestions = (text) => (text.match(/\?(?=[\s*_)"'”`]|$)/g) ?? []).length;

export function classify(text) {
  const t = text.trim().replace(/\s+/g, " ");
  const skill = SKILL.exec(t);
  if (skill) return { kind: "skill", skill: skill[1] };
  const template = TEMPLATE.exec(t);
  if (template) return { kind: "template", skill: (template[1] ?? "plan").toLowerCase() };
  if (t.length <= 60) {
    if (NOISE.test(t)) return { kind: "noise" };
    if (REPEAT.test(t)) return { kind: "repeat" };
    if (NUDGE.test(t)) return { kind: "nudge" };
    if (STAMP.test(t)) return { kind: "stamp" };
  }
  if (CORRECTION.test(t.slice(0, 240))) return { kind: "correction" };
  if (SHIP.test(t) && t.length <= 120) return { kind: "ship" };
  return { kind: "task" };
}

// ---------- reading sessions ----------

export function agentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "";

const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(please|again|can you|a|the|it)\b/g, "").replace(/\s+/g, " ").trim();

export function parseSession(jsonl, file = "") {
  let lastAgentText = "";
  const session = { file, cwd: "", project: "", start: null, prompts: [], assistant: 0, toolCalls: 0, toolErrors: 0, modelErrors: 0, aborted: 0, cost: 0, tokens: 0, models: {} };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") {
      session.cwd = entry.cwd ?? "";
      session.project = path.basename(entry.cwd ?? "") || "(unknown)";
      session.start = entry.timestamp ?? null;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const m = entry.message;
    if (m.role === "user") {
      const text = textOf(m.content).trim();
      if (!text) continue;
      const prompt = { at: entry.timestamp ?? null, text, ...classify(text) };
      // Context: "yes" to one permission question is an approval; to a batch, a rubber stamp.
      const asked = countQuestions(lastAgentText);
      lastAgentText = "";
      if (prompt.kind === "stamp" && asked < BATCH) prompt.kind = "approval";
      else if (prompt.kind === "task" && asked >= BATCH) prompt.kind = "answer";
      // Asking for the same task again in one session means the first attempt did not land.
      const key = normalize(text);
      if (prompt.kind === "task" && key.length >= 12 && session.prompts.some((p) => normalize(p.text) === key)) prompt.kind = "repeat";
      session.prompts.push(prompt);
    } else if (m.role === "assistant") {
      session.assistant++;
      const said = textOf(m.content).trim();
      if (said) lastAgentText = said;
      session.toolCalls += Array.isArray(m.content) ? m.content.filter((c) => c?.type === "toolCall").length : 0;
      if (m.stopReason === "error" || m.stopReason === "length") session.modelErrors++;
      if (m.stopReason === "aborted") session.aborted++;
      session.cost += Number(m.usage?.cost?.total) || 0;
      session.tokens += Number(m.usage?.totalTokens) || 0;
      if (m.model) session.models[m.model] = (session.models[m.model] ?? 0) + 1;
    } else if (m.role === "toolResult" && m.isError) {
      session.toolErrors++;
    }
  }
  return session;
}

export function loadSessions(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const name of readdirSync(path.join(dir, project.name))) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, project.name, name);
      out.push(parseSession(readFileSync(file, "utf8"), file));
    }
  }
  return out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

// ---------- metrics ----------

export function parseDate(value, now = new Date()) {
  const rel = /^(\d+)d$/.exec(value);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * 86_400_000);
  if (!/^\d{4}-\d\d-\d\d/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`invalid date ${value} (use YYYY-MM-DD or e.g. 30d)`);
  return new Date(value);
}

export function filterSessions(sessions, { since, until, project } = {}) {
  return sessions.filter((s) => {
    const t = s.start ? Date.parse(s.start) : NaN;
    if (since && !(t >= since.getTime())) return false;
    if (until && !(t < until.getTime())) return false;
    if (project && !s.project.toLowerCase().includes(project.toLowerCase()) && !s.cwd.toLowerCase().includes(project.toLowerCase())) return false;
    return true;
  });
}

export function metrics(sessions) {
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const skills = {};
  let prompts = 0;
  const totals = { sessions: sessions.length, assistant: 0, toolCalls: 0, toolErrors: 0, modelErrors: 0, aborted: 0, cost: 0, tokens: 0 };
  for (const s of sessions) {
    for (const key of ["assistant", "toolCalls", "toolErrors", "modelErrors", "aborted", "cost", "tokens"]) totals[key] += s[key];
    for (const p of s.prompts) {
      counts[p.kind]++;
      if (p.kind === "noise") continue;
      prompts++;
      if (p.skill) skills[p.skill] = (skills[p.skill] ?? 0) + 1;
    }
  }
  const per100 = (n) => (prompts ? Math.round((n / prompts) * 1000) / 10 : 0);
  return {
    ...totals,
    prompts,
    counts,
    skills,
    rates: {
      nudge: per100(counts.nudge),
      stamp: per100(counts.stamp),
      approval: per100(counts.approval),
      // Of replies to question batches, how many carried the user's own input.
      batchInput: counts.stamp + counts.answer ? Math.round((counts.answer / (counts.stamp + counts.answer)) * 1000) / 10 : 0,
      correction: per100(counts.correction),
      repeat: per100(counts.repeat),
      toolError: totals.toolCalls ? Math.round((totals.toolErrors / totals.toolCalls) * 1000) / 10 : 0,
    },
    costPerSession: sessions.length ? totals.cost / sessions.length : 0,
  };
}

// ---------- output ----------

/** Mask secrets and the home directory before showing any prompt text. */
export function redact(text, home = os.homedir()) {
  return text
    .replace(/(-----BEGIN [A-Z ]+-----)[\s\S]*?(-----END [A-Z ]+-----)/g, "$1 [redacted] $2")
    .replace(/\b(Bearer|Bot|token|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b/g, "[redacted]")
    .replace(/\b[a-f0-9]{40,}\b/gi, "[hex]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replaceAll(home, "~");
}

const excerpt = (text, n = 110) => {
  const t = redact(text.replace(/\s+/g, " ").trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const money = (n) => `$${n.toFixed(2)}`;

function table(head, rows) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

const ROWS = [
  ["sessions", (m) => m.sessions],
  ["prompts", (m) => m.prompts],
  ["nudges (continue…) per 100 prompts", (m) => m.rates.nudge],
  [`rubber stamps (yes to ≥${BATCH} questions) per 100`, (m) => m.rates.stamp],
  ["batch replies with own input %", (m) => m.rates.batchInput],
  ["approvals (yes to one ask) per 100", (m) => m.rates.approval],
  ["corrections per 100", (m) => m.rates.correction],
  ["repeats per 100", (m) => m.rates.repeat],
  ["commit/push requests", (m) => m.counts.ship],
  ["tool error % of tool calls", (m) => m.rates.toolError],
  ["model errors / aborts", (m) => `${m.modelErrors} / ${m.aborted}`],
  ["cost per session", (m) => money(m.costPerSession)],
];

export function formatReport(sessions, { examples = 3, split } = {}) {
  const out = [];
  if (split) {
    const before = metrics(sessions.filter((s) => Date.parse(s.start) < split.getTime()));
    const after = metrics(sessions.filter((s) => Date.parse(s.start) >= split.getTime()));
    const day = split.toISOString().slice(0, 10);
    out.push(`# Before vs after ${day}`, "", table(["metric", `before ${day}`, "after"], ROWS.map(([name, f]) => [name, f(before), f(after)])));
    if (after.prompts < 20) out.push("", `Only ${after.prompts} prompts after ${day}: too few to conclude anything yet.`);
    return out.join("\n");
  }

  const m = metrics(sessions);
  out.push("# Overall", "", table(["metric", "value"], ROWS.map(([name, f]) => [name, f(m)])));

  const byProject = Map.groupBy(sessions, (s) => s.project);
  const projectRows = [...byProject]
    .map(([name, list]) => [name, metrics(list)])
    .sort((a, b) => b[1].prompts - a[1].prompts)
    .map(([name, p]) => [name, p.sessions, p.prompts, p.counts.nudge, p.counts.stamp, p.counts.approval, p.counts.correction, p.counts.ship, `${p.rates.toolError}%`, money(p.cost)]);
  out.push("", "# By project", "", table(["project", "sessions", "prompts", "nudge", "stamp", "approve", "correct", "ship", "tool err", "cost"], projectRows));

  const skillRows = Object.entries(m.skills).sort((a, b) => b[1] - a[1]);
  if (skillRows.length) out.push("", "# Skills and workflow templates invoked", "", table(["skill", "times"], skillRows));

  if (examples > 0) {
    for (const kind of ["correction", "stamp", "nudge", "repeat"]) {
      const hits = sessions.flatMap((s) => s.prompts.filter((p) => p.kind === kind).map((p) => ({ s, p }))).slice(-examples);
      if (!hits.length) continue;
      out.push("", `# Recent ${kind}s`, "");
      for (const { s, p } of hits) {
        out.push(`- ${String(p.at ?? s.start).slice(0, 10)} ${s.project}: ${excerpt(p.text)}`, `  ${s.file.replace(os.homedir(), "~")}`);
      }
    }
  }
  return out.join("\n");
}

// ---------- CLI ----------

const USAGE = `Usage: node hansei.mjs [options]

  --since <YYYY-MM-DD|30d>   only sessions starting on/after this date
  --until <YYYY-MM-DD>       only sessions starting before this date
  --project <text>           only projects whose name or path contains text
  --split <YYYY-MM-DD>       compare metrics before vs after a change
  --examples <n>             recent example prompts per signal (default 3, 0 = none)
  --dir <path>               sessions directory (default $PI_CODING_AGENT_DIR/sessions)
  --json                     metrics as JSON (no prompt text)`;

export function main(argv, { log = console.log, env = process.env, now = new Date() } = {}) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--help" || arg === "-h") flags[arg.replace(/^-+/, "")] = true;
    else if (["--since", "--until", "--project", "--split", "--examples", "--dir"].includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument ${arg}\n\n${USAGE}`);
  }
  if (flags.help || flags.h) {
    log(USAGE);
    return 0;
  }
  const dir = flags.dir ?? path.join(agentDir(env), "sessions");
  const sessions = filterSessions(loadSessions(dir), {
    since: flags.since && parseDate(flags.since, now),
    until: flags.until && parseDate(flags.until, now),
    project: flags.project,
  });
  if (!sessions.length) {
    log(`no sessions found in ${dir.replace(os.homedir(), "~")} for that filter`);
    return 1;
  }
  const split = flags.split && parseDate(flags.split, now);
  if (flags.json) {
    const result = split
      ? {
          split: split.toISOString().slice(0, 10),
          before: metrics(sessions.filter((s) => Date.parse(s.start) < split.getTime())),
          after: metrics(sessions.filter((s) => Date.parse(s.start) >= split.getTime())),
        }
      : metrics(sessions);
    log(JSON.stringify(result, null, 2));
  } else {
    const examples = Number(flags.examples ?? 3);
    if (!Number.isInteger(examples) || examples < 0) throw new Error("--examples must be a whole number");
    log(formatReport(sessions, { examples, split }));
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`hansei: ${error.message}`);
    process.exitCode = 2;
  }
}
