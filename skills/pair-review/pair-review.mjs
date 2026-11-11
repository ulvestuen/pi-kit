#!/usr/bin/env node
// Pair review between two visible, read-only Pi workers: a lead reviewer and a peer reviewer.
// They review independently, cross-check each other's findings, and the lead consolidates one review.
// Reuses the pane and turn-file plumbing of the sibling pair skill. Zero dependencies; Node.js 22+.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DONE, closeWorkers, detect, parseArgs, run, runOptions, workers } from "../pair/pair.mjs";

export const DEFAULTS = {
  rounds: 1,
  leadModel: "claude-code/claude-opus-5-5",
  peerModel: "openai/gpt-6.1-sol:xhigh",
  turnTimeout: "60m",
};

const FLAGS = ["task-file", "rounds", "lead-model", "peer-model", "mux", "turn-timeout", "cwd"];
const USAGE = `Usage:
  pair-review.mjs detect [--json]
  pair-review.mjs run --task-file <path> [options]
  pair-review.mjs close <worker>... [--mux herdr|rex]   close finished reviewer panes (ids from run)

Options:
  --rounds <n>               cross-check rounds after the independent reviews (default ${DEFAULTS.rounds})
  --lead-model <m>           provider/id[:thinking] (default ${DEFAULTS.leadModel})
  --peer-model <m>           provider/id[:thinking] (default ${DEFAULTS.peerModel})
  --mux herdr|rex            override environment detection
  --turn-timeout <dur>       per-turn limit, e.g. 45m (default ${DEFAULTS.turnTimeout})
  --cwd <dir>                worker working directory (default: current)
  --json                     machine-readable result`;

const RULES = `You are the {ROLE} REVIEWER in a pair review with a second, independent reviewer.
- This is a review only. Do not modify, create, or delete repository files, and do not stage, commit, push, or post comments.
- You may read files and run read-only commands and tests (git log/diff/show, gh pr view/diff, the test suite).
- Review the target named in the task against its intent: correctness, missed requirements, edge cases, security, tests, and maintainability.
- Report only actionable findings, ordered by severity (blocker, major, minor), each with file:line, evidence, and a concrete fix.
- Mark each finding's confidence (high, medium, low). Do not pad the report with style nits or praise.`;

export function reviewTurnText({ role, kind, task, report, previous, round, rounds, baseline }) {
  const steps = {
    review: () => "Review the target described in the task below on your own. Do not look for or read the other reviewer's report.",
    "cross-check": () => `Cross-check round ${round} of ${rounds}. Read the other reviewer's latest report at ${previous}. For each of their findings, verify it against the code and say whether you confirm or dispute it, with evidence. Then list anything both of you missed. Update or withdraw your own earlier findings if their report changed your mind.`,
    consolidate: () => `Write the final pair review. Read every report listed here:\n\n${(previous ?? []).map((p) => `- ${p}`).join("\n")}\n\nMerge them into one list ordered by severity. Mark each finding as agreed, or as disputed with both positions in one line each. Drop findings that were withdrawn or refuted with evidence. End with a verdict line: "Verdict: approve" or "Verdict: changes requested".`,
  }[kind]();
  return [
    RULES.replace("{ROLE}", role === "lead" ? "LEAD" : "PEER"),
    "",
    `## This turn\n\n${steps}`,
    "",
    `When finished, write your report as Markdown to:\n\n${report}\n\nWrite the report file last. Its final line must be exactly: ${DONE}`,
    "",
    baseline ? `## Repository state before the review\n\n${baseline}\n` : "",
    `## Review target\n\n${task}`,
  ].join("\n");
}

export async function runReview({ task, mux, cwd, dir, rounds, leadModel, peerModel, turnTimeout, exec = run, env = process.env, sleep, now, progress = () => {} }) {
  const render = (o) => reviewTurnText({ rounds, ...o });
  const { panes, reports, prepare, spawn, finish } = await workers({ task, mux, cwd, dir, turnTimeout, label: "Pair review", render, exec, env, sleep, now, progress });
  const firstLead = prepare("lead", "review");
  const lead = await spawn(await panes.anchor(), "right", "pair-review: lead", leadModel, firstLead.prompt);
  const firstPeer = prepare("peer", "review");
  const peer = await spawn(lead, "below", "pair-review: peer", peerModel, firstPeer.prompt);
  progress(`${mux}: lead ${lead} (${leadModel}), peer ${peer} (${peerModel}); files in ${dir}`);

  // Both reviewers work at the same time; each cross-check reads the other's previous report.
  let latest = { lead: firstLead.report, peer: firstPeer.report };
  await Promise.all([finish("lead", lead, firstLead), finish("peer", peer, firstPeer)]);
  for (let round = 1; round <= rounds; round++) {
    const leadTurn = prepare("lead", "cross-check", { round, previous: latest.peer });
    const peerTurn = prepare("peer", "cross-check", { round, previous: latest.lead });
    await panes.send(lead, leadTurn.prompt);
    await panes.send(peer, peerTurn.prompt);
    await Promise.all([finish("lead", lead, leadTurn), finish("peer", peer, peerTurn)]);
    latest = { lead: leadTurn.report, peer: peerTurn.report };
  }
  const consolidate = prepare("lead", "consolidate", { previous: reports.map((r) => r.path) });
  await panes.send(lead, consolidate.prompt);
  const final = await finish("lead", lead, consolidate);
  const verdict = /verdict:\s*([^\n]*)/i.exec(final)?.[1].trim() ?? "";
  return { mux, dir, panes: { lead, peer }, models: { lead: leadModel, peer: peerModel }, rounds, verdict, reports, finalReview: final.replace(DONE, "").trim() };
}

export function formatResult(r) {
  return [
    `Pair review complete (${r.mux}, ${r.rounds} cross-check round${r.rounds === 1 ? "" : "s"}). Reviewer panes still open: lead ${r.panes.lead}, peer ${r.panes.peer}.`,
    `After reading the review, close them: node ${fileURLToPath(import.meta.url)} close ${r.panes.lead} ${r.panes.peer} --mux ${r.mux}`,
    `Verdict: ${r.verdict || "(none given)"}`,
    `Reports:`,
    ...r.reports.map((x) => `  ${x.role.padEnd(4)} ${x.path}`),
    "",
    "Consolidated review:",
    "",
    r.finalReview,
  ].join("\n");
}

export async function main(argv, { env = process.env, exec = run, log = console.log, progress = console.error, sleep, now } = {}) {
  const { positional, flags } = parseArgs(argv, FLAGS);
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

  const options = runOptions(flags, { found, env, now, defaults: DEFAULTS, dirName: "pi-pair-review" });
  const result = await runReview({
    ...options,
    leadModel: flags["lead-model"] ?? DEFAULTS.leadModel,
    peerModel: flags["peer-model"] ?? DEFAULTS.peerModel,
    exec,
    env,
    sleep,
    now,
    progress,
  });
  log(flags.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`pair-review: ${error.message}`);
      // The other reviewer's wait may still be polling; do not linger until its timeout.
      process.exit(2);
    },
  );
}
