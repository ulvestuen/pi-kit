#!/usr/bin/env node
// A3 problem-solving reports: Markdown source for agents, HTML sheet for people.
// Zero dependencies; Node.js 22+.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SECTIONS = [
  "Background",
  "Current condition",
  "Goal",
  "Root cause analysis",
  "Countermeasures",
  "Implementation plan",
  "Follow-up",
];
const LEFT = new Set(SECTIONS.slice(0, 4));
export const STATUSES = ["open", "blocked", "done", "dropped"];
export const RESULTS = ["pending", "confirmed", "refuted"];
const FIELDS = ["Addresses", "Prediction", "Check", "Result"];
const REQUIRED_FIELDS = ["Prediction", "Check", "Result"];

export function template(title, date = today()) {
  return `---
title: ${title}
status: open
owner:
updated: ${date}
---

## Background
<!-- Why this matters now: context, impact, who is affected. -->

## Current condition
<!-- What actually happens, observed first-hand. Cite evidence: log lines,
run URLs, \`commands\` and their output, request IDs, measurements. -->

## Goal
<!-- Observable targets, one checkbox each. Tick only with evidence.
- [ ] Example: nightly ingest creates a quiz in production for 3 days running
-->

## Root cause analysis
<!-- Why the current condition misses the goal. Ask "why?" until you reach a
cause you can act on. Say which causes are confirmed by evidence. -->

## Countermeasures
<!-- One block per countermeasure. Each is a hypothesis to test.
### C1: Short name of the change
- Addresses: the root cause it targets
- Prediction: if we do this, we expect to observe ...
- Check: how we will observe it (command, metric, URL)
- Result: pending
-->

## Implementation plan
<!-- Small ordered steps, one change at a time.
- [ ] C1: first step
-->

## Follow-up
<!-- After checking: predicted vs observed, what was learned, what to
standardize, and any new A3 this leads to. -->
`;
}

// ---------- parsing ----------

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");
const canonical = new Map(SECTIONS.map((name) => [name.toLowerCase(), name]));

export function parseA3(text) {
  const source = text.replace(/\r\n?/g, "\n");
  const meta = {};
  let body = source;
  const fm = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = /^([\w-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
      if (m) meta[m[1]] = m[2].replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2");
    }
    body = source.slice(fm[0].length);
  }

  const sections = new Map();
  const order = [];
  const duplicates = [];
  const unknown = [];
  let current = null;
  let inFence = false;
  for (const line of stripComments(body).split("\n")) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence && /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (h) {
      current = canonical.get(h[1].toLowerCase()) ?? h[1];
      if (sections.has(current)) duplicates.push(current);
      else {
        sections.set(current, "");
        order.push(current);
        if (!canonical.has(current.toLowerCase())) unknown.push(current);
      }
      continue;
    }
    if (current) sections.set(current, `${sections.get(current)}${line}\n`);
  }
  return { meta, hasFrontmatter: Boolean(fm), sections, order, duplicates, unknown };
}

export function parseCountermeasures(text = "") {
  const intro = [];
  const items = [];
  let cm = null;
  for (const line of text.split("\n")) {
    const h = /^###[ \t]+(.+?)[ \t]*$/.exec(line);
    if (h) {
      cm = { title: h[1], fields: {}, rest: [] };
      items.push(cm);
    } else if (cm) cm.rest.push(line);
    else intro.push(line);
  }
  for (const item of items) {
    const rest = [];
    let last = null;
    for (const line of item.rest) {
      const f = /^[-*][ \t]+\**(addresses|prediction|check|result)\**[ \t]*:[ \t]*\**[ \t]*(.*)$/i.exec(line);
      if (f) {
        last = FIELDS.find((name) => name.toLowerCase() === f[1].toLowerCase());
        item.fields[last] = f[2].trim();
      } else if (last && /^\s{2,}\S/.test(line)) {
        item.fields[last] = `${item.fields[last]} ${line.trim()}`.trim();
      } else {
        last = null;
        rest.push(line);
      }
    }
    item.rest = rest;
    const r = /^(pending|confirmed|refuted)\b/i.exec(item.fields.Result ?? "");
    item.result = r ? r[1].toLowerCase() : null;
  }
  return { intro: intro.join("\n"), items };
}

export function checkboxes(text = "") {
  return [...text.matchAll(/^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(.*)$/gm)].map((m) => ({
    done: m[1] !== " ",
    text: m[2].trim(),
  }));
}

const isEmpty = (text) => !text || !text.trim();
const hasEvidence = (text) => /`[^`\n]+`|\]\(|https?:\/\/|^[ \t]*>/m.test(text);

// ---------- lint ----------

export function lintA3(input) {
  const a3 = typeof input === "string" ? parseA3(input) : input;
  const errors = [];
  const warnings = [];
  const { meta, sections } = a3;
  const status = (meta.status ?? "").toLowerCase();

  if (!a3.hasFrontmatter) errors.push("missing front matter (--- title / status ---)");
  if (!meta.title) errors.push("front matter: title is required");
  if (!STATUSES.includes(status)) errors.push(`front matter: status must be one of ${STATUSES.join(", ")}`);

  for (const name of SECTIONS) if (!sections.has(name)) errors.push(`missing section "## ${name}"`);
  for (const name of a3.duplicates) errors.push(`duplicate section "## ${name}"`);
  for (const name of a3.unknown) warnings.push(`unknown section "## ${name}" (rendered after Follow-up)`);
  const positions = a3.order.filter((name) => canonical.has(name.toLowerCase())).map((name) => SECTIONS.indexOf(name));
  if (positions.some((p, i) => i > 0 && p < positions[i - 1])) warnings.push("sections are out of A3 order");

  const cms = parseCountermeasures(sections.get("Countermeasures")).items;
  for (const [i, cm] of cms.entries()) {
    const label = `countermeasure "${cm.title}"`;
    for (const field of REQUIRED_FIELDS) if (isEmpty(cm.fields[field])) errors.push(`${label}: missing ${field}`);
    if (!isEmpty(cm.fields.Result) && !cm.result) {
      errors.push(`${label}: Result must start with ${RESULTS.join(", ")}`);
    }
    if (isEmpty(cm.fields.Addresses)) warnings.push(`${label}: no Addresses (which root cause does it target?)`);
    if (cms.findIndex((other) => other.title === cm.title) !== i) errors.push(`${label}: duplicate title`);
  }

  // No countermeasure without understanding: analysis is mandatory once one is proposed.
  const analysis = cms.length > 0 || status === "done" ? errors : warnings;
  const current = sections.get("Current condition");
  if (isEmpty(current)) analysis.push("Current condition is empty (go and see first)");
  else if (!hasEvidence(current)) analysis.push("Current condition cites no evidence (link, `code`, or > quote)");
  const goals = checkboxes(sections.get("Goal"));
  if (goals.length === 0) analysis.push("Goal has no checkbox targets");
  if (isEmpty(sections.get("Root cause analysis"))) analysis.push("Root cause analysis is empty");

  if (status === "done" || status === "dropped") {
    for (const cm of cms) if (cm.result === "pending") errors.push(`status ${status} but "${cm.title}" is still pending`);
    if (isEmpty(sections.get("Follow-up"))) errors.push(`status ${status} requires a Follow-up`);
  }
  if (status === "done") {
    for (const goal of goals) if (!goal.done) errors.push(`status done but goal not met: ${goal.text}`);
    for (const step of checkboxes(sections.get("Implementation plan"))) {
      if (!step.done) errors.push(`status done but plan step open: ${step.text}`);
    }
  }
  return { errors, warnings };
}

// ---------- status ----------

export function summarize(input) {
  const a3 = typeof input === "string" ? parseA3(input) : input;
  const { meta, sections } = a3;
  const status = (meta.status ?? "").toLowerCase() || "?";
  const goals = checkboxes(sections.get("Goal"));
  const cms = parseCountermeasures(sections.get("Countermeasures")).items;
  const count = (result) => cms.filter((cm) => cm.result === result).length;
  const step = checkboxes(sections.get("Implementation plan")).find((s) => !s.done);
  const pending = cms.find((cm) => cm.result === "pending");
  const unmet = goals.find((g) => !g.done);

  let next;
  if (status === "done" || status === "dropped") next = "—";
  else if (status === "blocked") next = "blocked: see Follow-up";
  else if (isEmpty(sections.get("Current condition"))) next = "go and see: document the current condition";
  else if (goals.length === 0) next = "set observable goal targets";
  else if (isEmpty(sections.get("Root cause analysis"))) next = "analyze the root cause";
  else if (cms.length === 0) next = "propose countermeasures with predictions";
  else if (step) next = `do: ${step.text}`;
  else if (pending) next = `check: ${pending.title}`;
  else if (unmet) next = `goal not met, revise countermeasures: ${unmet.text}`;
  else next = "write Follow-up and set status: done";

  return {
    title: meta.title ?? "(untitled)",
    status,
    goals: { met: goals.filter((g) => g.done).length, total: goals.length },
    countermeasures: { confirmed: count("confirmed"), refuted: count("refuted"), pending: count("pending") },
    next,
  };
}

// ---------- Markdown subset → HTML ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const safeUrl = (url) => (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(https?|mailto):/i.test(url) ? "#" : url);

const emphasis = (s) =>
  s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");

export function inline(text) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = text
    .replace(/`([^`]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => keep(`<a href="${esc(safeUrl(url))}">${emphasis(esc(label))}</a>`))
    .replace(/https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/g, (url) => keep(`<a href="${esc(url)}">${esc(url)}</a>`));
  s = emphasis(esc(s));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const isTableSep = (line = "") => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const isTableStart = (lines, i) => lines[i].trim().startsWith("|") && isTableSep(lines[i + 1]);
const isBlockStart = (lines, i) =>
  /^```/.test(lines[i]) || /^#{1,6}\s/.test(lines[i]) || /^>/.test(lines[i]) || LIST_RE.test(lines[i]) || isTableStart(lines, i);

export function markdownToHtml(text = "") {
  const lines = stripComments(text).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      i++;
    } else if ((m = /^```\s*([\w-]*)/.exec(line))) {
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      const code = esc(body.join("\n"));
      out.push(m[1] === "mermaid" ? `<pre class="mermaid">${code}</pre>` : `<pre><code>${code}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
    } else if (isTableStart(lines, i)) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++]);
      out.push(table(rows));
    } else if (/^>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
    } else if (LIST_RE.test(line)) {
      const block = [];
      while (i < lines.length) {
        const l = lines[i];
        const continues = (s = "") => LIST_RE.test(s) || /^\s+\S/.test(s);
        if (continues(l)) block.push(lines[i++]);
        else if (!l.trim() && continues(lines[i + 1])) i++;
        else break;
      }
      out.push(list(block));
    } else {
      const para = [];
      do para.push(lines[i++].trim());
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i));
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

function table(rows) {
  const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim()));
  const [head, , ...body] = rows;
  return `<table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${cells(row).map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function list(block) {
  const root = { indent: -1, children: [] };
  const stack = [root];
  for (const line of block) {
    const m = LIST_RE.exec(line);
    if (!m) {
      const last = stack.at(-1);
      if (last === root) continue;
      if (/^\s*>/.test(line) || last.quote.length) last.quote.push(line.trim());
      else last.text += ` ${line.trim()}`;
      continue;
    }
    const item = { indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), text: m[3], quote: [], children: [] };
    while (stack.length > 1 && item.indent <= stack.at(-1).indent) stack.pop();
    stack.at(-1).children.push(item);
    stack.push(item);
  }
  return listItems(root.children);
}

function listItems(items) {
  const tag = items[0].ordered ? "ol" : "ul";
  const tasks = items.some((it) => /^\[[ xX]\]\s/.test(it.text));
  const html = items.map((it) => {
    const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
    const nested = (it.quote.length ? markdownToHtml(it.quote.join("\n")) : "") + (it.children.length ? listItems(it.children) : "");
    if (!task) return `<li>${inline(it.text)}${nested}</li>`;
    const done = task[1] !== " ";
    return `<li class="${done ? "done" : "todo"}"><input type="checkbox" disabled${done ? " checked" : ""}> ${inline(task[2])}${nested}</li>`;
  });
  return `<${tag}${tasks ? ' class="tasks"' : ""}>${html.join("")}</${tag}>`;
}

// ---------- A3 sheet ----------

function countermeasuresHtml(text) {
  const { intro, items } = parseCountermeasures(text);
  const cards = items.map((cm) => {
    const result = cm.result ?? "pending";
    const fields = FIELDS.filter((f) => !isEmpty(cm.fields[f]))
      .map((f) => `<dt>${f}</dt><dd>${inline(cm.fields[f])}</dd>`)
      .join("");
    return `<article class="cm r-${result}"><h3><span>${inline(cm.title)}</span><span class="badge b-${result}">${result}</span></h3><dl>${fields}</dl>${markdownToHtml(cm.rest.join("\n"))}</article>`;
  });
  return markdownToHtml(intro) + cards.join("\n");
}

export function renderA3(text) {
  const a3 = parseA3(text);
  const summary = summarize(a3);
  const { errors, warnings } = lintA3(a3);
  const names = [...SECTIONS.filter((n) => a3.sections.has(n)), ...a3.unknown];
  const section = (name) => {
    const body = a3.sections.get(name);
    const number = SECTIONS.indexOf(name) + 1;
    const html = name === "Countermeasures" ? countermeasuresHtml(body) : markdownToHtml(body);
    return `<section><h2>${number ? `<span>${number}</span>` : ""}${esc(name)}</h2>${
      html.trim() ? html : '<p class="empty">Not yet written</p>'
    }</section>`;
  };
  const left = names.filter((n) => LEFT.has(n)).map(section).join("\n");
  const right = names.filter((n) => !LEFT.has(n)).map(section).join("\n");
  const { met, total } = summary.goals;
  const c = summary.countermeasures;
  const meta = [
    ["Status", `<span class="badge b-${esc(summary.status)}">${esc(summary.status)}</span>`],
    ["Owner", esc(a3.meta.owner || "—")],
    ["Updated", esc(a3.meta.updated || "—")],
    ["Goals met", `${met}/${total}`],
    ["Countermeasures", `${c.confirmed} confirmed · ${c.refuted} refuted · ${c.pending} pending`],
    ["Next", esc(summary.next)],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
  const issues = [...errors.map((e) => ["error", e]), ...warnings.map((w) => ["warning", w])];
  const lint = issues.length
    ? `<footer class="lint"><strong>a3 lint</strong><ul>${issues.map(([k, m]) => `<li class="${k}">${k}: ${esc(m)}</li>`).join("")}</ul></footer>`
    : "";
  const mermaid = /<pre class="mermaid">/.test(left + right)
    ? `<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";mermaid.initialize({startOnLoad:true});</script>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A3 · ${esc(summary.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
<header class="head"><div><p class="kicker">A3</p><h1>${esc(summary.title)}</h1></div><dl class="meta">${meta}</dl></header>
<main class="sheet"><div class="col">${left}</div><div class="col">${right}</div></main>
${lint}
</div>
${mermaid}
</body>
</html>
`;
}

const CSS = `
:root{--ink:#1d232a;--muted:#5b6672;--line:#d5dbe1;--paper:#fff;--bg:#eef1f4;--accent:#2f5d8a;--ok:#1f7a4d;--bad:#b3261e;--wait:#9a6700;--block:#7a3fb0;--soft:#f5f7f9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.page{max-width:1400px;margin:24px auto;background:var(--paper);border:1px solid var(--line);box-shadow:0 1px 4px #0002}
.head{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;padding:16px 24px;border-bottom:3px solid var(--ink)}
.kicker{margin:0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h1{margin:2px 0 0;font-size:22px;line-height:1.2}
.meta{display:flex;flex-wrap:wrap;gap:6px 20px;margin:0;justify-content:flex-end}
.meta div{display:flex;flex-direction:column;max-width:320px}
.meta dt{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.meta dd{margin:0;font-weight:600}
.sheet{display:grid;grid-template-columns:1fr 1fr}
.col+.col{border-left:1px solid var(--line)}
section{padding:12px 24px 14px;border-bottom:1px solid var(--line)}
section:last-child{border-bottom:0}
section>h2{display:flex;align-items:center;margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent)}
section>h2 span{display:inline-grid;place-items:center;width:20px;height:20px;margin-right:8px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;letter-spacing:0}
h3,h4{margin:8px 0 4px;font-size:14px}
p{margin:0 0 8px}
ul,ol{margin:0 0 8px;padding-left:20px}
ul.tasks{list-style:none;padding-left:2px}
ul.tasks ul.tasks{padding-left:20px}
li.done{color:var(--ok)}
input[type=checkbox]{accent-color:var(--ok);margin:0 4px 0 0;vertical-align:-2px}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}
pre{background:var(--soft);border:1px solid var(--line);border-radius:4px;padding:8px;overflow:auto;font-size:12px}
pre code{background:none;padding:0}
pre.mermaid{background:none;border:0;text-align:center}
blockquote{margin:0 0 8px;padding:4px 12px;border-left:3px solid var(--line);color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:0 0 8px;font-size:13px}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
th{background:var(--soft)}
a{color:var(--accent);overflow-wrap:anywhere}
.empty{color:var(--muted);font-style:italic}
.cm{border:1px solid var(--line);border-left:4px solid var(--wait);border-radius:4px;padding:8px 12px;margin:0 0 10px}
.cm.r-confirmed{border-left-color:var(--ok)}
.cm.r-refuted{border-left-color:var(--bad)}
.cm h3{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 0 6px}
.cm dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 12px;margin:0}
.cm dt{color:var(--muted);font-size:12px;padding-top:1px}
.cm dd{margin:0}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#fff;background:var(--muted);white-space:nowrap}
.b-confirmed,.b-done{background:var(--ok)}
.b-refuted{background:var(--bad)}
.b-open,.b-pending{background:var(--wait)}
.b-blocked{background:var(--block)}
.lint{padding:10px 24px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);background:var(--soft)}
.lint ul{margin:4px 0 0}
.lint .error{color:var(--bad)}
@media (max-width:900px){.sheet{grid-template-columns:1fr}.col+.col{border-left:0;border-top:1px solid var(--line)}.head{flex-direction:column;align-items:flex-start}.meta{justify-content:flex-start}}
@page{size:A3 landscape;margin:10mm}
@media print{body{background:#fff}.page{margin:0;border:0;box-shadow:none;max-width:none}.lint{display:none}section,.cm{break-inside:avoid}}
`;

// ---------- CLI ----------

const USAGE = `Usage: node a3.mjs <command>

  new <slug> [--title "..."] [--dir a3]          create <dir>/<slug>.md from the template
  lint <file.md>                                 check structure and A3 discipline
  status [dir] [--json]                          one line per A3, with its next step
  render <file.md> [--out file.html] [--open]    write the two-column A3 sheet as HTML`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--open" || arg === "--help" || arg === "-h") flags[arg.replace(/^-+/, "")] = true;
    else if (["--title", "--dir", "--out"].includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

function openFile(file) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [file]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", file]]
        : ["xdg-open", [file]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

export function main(argv, { log = console.log, error = console.error } = {}) {
  const { positional, flags } = parseArgs(argv);
  const [command, target] = positional;
  if (!command || flags.help || flags.h) {
    log(USAGE);
    return command || flags.help || flags.h ? 0 : 2;
  }

  if (command === "new") {
    if (!target || !/^[a-z0-9][a-z0-9-]*$/.test(target)) throw new Error("new needs a lowercase slug, e.g. quiz-ingest-stalls");
    const dir = flags.dir ?? "a3";
    const file = path.join(dir, `${target}.md`);
    if (existsSync(file)) throw new Error(`${file} already exists; edit it instead`);
    mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "# Rendered A3 sheets; regenerate with a3.mjs render\n*.html\n");
    writeFileSync(file, template(flags.title ?? target.replace(/-/g, " ")));
    log(file);
    return 0;
  }

  if (command === "lint") {
    if (!target) throw new Error("lint needs a file");
    const { errors, warnings } = lintA3(readFileSync(target, "utf8"));
    for (const e of errors) error(`error: ${e}`);
    for (const w of warnings) error(`warning: ${w}`);
    log(errors.length ? `${target}: ${errors.length} error(s), ${warnings.length} warning(s)` : `${target}: ok${warnings.length ? ` (${warnings.length} warning(s))` : ""}`);
    return errors.length ? 1 : 0;
  }

  if (command === "status") {
    const dir = target ?? "a3";
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
    const rows = files.map((f) => ({ file: path.join(dir, f), ...summarize(readFileSync(path.join(dir, f), "utf8")) }));
    if (flags.json) {
      log(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (!rows.length) {
      log(`no A3 files in ${dir}/`);
      return 0;
    }
    const table = rows.map((r) => [
      path.basename(r.file, ".md"),
      r.status,
      `${r.goals.met}/${r.goals.total}`,
      `✓${r.countermeasures.confirmed} ✗${r.countermeasures.refuted} ?${r.countermeasures.pending}`,
      r.next,
    ]);
    const head = ["A3", "Status", "Goals", "Countermeasures", "Next"];
    const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
    const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join(" | ");
    log([line(head), widths.map((w) => "-".repeat(w)).join("-|-"), ...table.map(line)].join("\n"));
    return 0;
  }

  if (command === "render") {
    if (!target) throw new Error("render needs a file");
    const out = flags.out ?? target.replace(/\.md$/i, "") + ".html";
    writeFileSync(out, renderA3(readFileSync(target, "utf8")));
    log(out);
    if (flags.open) openFile(path.resolve(out));
    return 0;
  }

  throw new Error(`unknown command ${command}\n\n${USAGE}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`a3: ${err.message}`);
    process.exitCode = 2;
  }
}
