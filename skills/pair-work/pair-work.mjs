#!/usr/bin/env node
// Pair work between two visible Pi workers: a doer who carries out a broad piece of work and a verifier who checks it.
// Not limited to code: research, writing, analysis, data, operations runbooks, and similar deliverables.
// The verifier plans its checks before seeing the work, then verifies each round until it accepts or rounds run out.
// Reuses the pane and turn-file plumbing of the sibling pair skill. Zero dependencies; Node.js 22+.

import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DONE, closeWorkers, detect, detectCommand, newRunId, parseArgs, run, runOptions, tracked, waitCommand, workerLines, workers } from "../pair/pair.mjs";

export const DEFAULTS = {
  rounds: 3,
  doerModel: "claude-code/claude-opus-5-5",
  verifierModel: "openai/gpt-6.1-sol:xhigh",
  turnTimeout: "60m",
};

const FLAGS = ["task-file", "rounds", "doer-model", "verifier-model", "mux", "turn-timeout", "cwd", "run", "timeout"];
const USAGE = `Usage:
  pair-work.mjs detect [--json]
  pair-work.mjs run --task-file <path> [options]
  pair-work.mjs wait <run-id|run-dir> [--timeout 15m] [--json]  block until the run ends or the timeout passes
  pair-work.mjs close <worker>... [--mux herdr|rex] [--run <id>]   close finished workers (ids from run)

Options:
  --rounds <n>               at most this many verify → address cycles; stops early on "Verdict: accept" (default ${DEFAULTS.rounds})
  --doer-model <m>           provider/id[:thinking] (default ${DEFAULTS.doerModel})
  --verifier-model <m>       provider/id[:thinking] (default ${DEFAULTS.verifierModel})
  --mux herdr|rex            override environment detection
  --turn-timeout <dur>       per-turn limit, e.g. 45m (default ${DEFAULTS.turnTimeout})
  --cwd <dir>                worker working directory (default: current)
  --json                     machine-readable result`;

const RULES = {
  doer: `You are the DOER in a pair-work session with a separate verifier.
- Carry out the piece of work described in the task. It may be research, writing, analysis, planning, data work, or anything else, not only code.
- Put deliverables where the task says. If it does not say, put them in the work folder named below and list every path in your report.
- Back every claim with evidence the verifier can check: sources with links, commands with their output, files, figures, or calculations.
- State assumptions and open questions explicitly instead of guessing silently.
- Do not take irreversible or external actions: no commits, pushes, deploys, purchases, publishing, or sending messages. If the task needs one, prepare it and leave it for the user.
- The verifier checks your work after each turn. Address every finding: fix it or explain concretely why not.`,
  verifier: `You are the VERIFIER in a pair-work session with a separate doer.
- Do not modify the doer's deliverables or other existing files. You may read anything, run read-only commands, re-run calculations, and check sources.
- Verify independently: do not take the doer's report as proof. Re-check claims, sources, numbers, and the deliverables themselves against the task.
- Judge against the task's goal and acceptance criteria: completeness, correctness, evidence, missed requirements, unstated assumptions, and fitness for the intended reader or use.
- Report only actionable findings, ordered by severity (blocker, major, minor), each with location (file:line, section, or claim), evidence, and a concrete fix.
- End with a verdict line: "Verdict: accept" or "Verdict: changes requested".`,
};

export function workTurnText({ role, kind, task, report, previous, plan, round, rounds, baseline, workDir }) {
  const steps = {
    plan: () => "Before you see any work, read the task below and write a verification plan: the acceptance criteria you will check (explicit ones from the task and implicit ones it clearly needs), and how you will check each one. Do not verify yet; there is nothing to verify.",
    do: () => "Carry out the task below.",
    verify: () => `Verification round ${round} of ${rounds}. Read the doer's latest report at ${previous}${plan ? ` and your verification plan at ${plan}` : ""}. Verify the work against the plan and the task, and update the plan if the work revealed criteria you missed.`,
    address: () => `Address the verifier's round ${round} findings in ${previous}.${round === rounds ? " This is the final round: also summarize the end state, deliverable paths, remaining risks or open questions, and how the work was verified." : ""}`,
  }[kind]();
  return [
    RULES[role],
    "",
    `## This turn\n\n${steps}`,
    "",
    workDir ? `## Work folder\n\n${workDir}\n` : "",
    `When finished, write your report as Markdown to:\n\n${report}\n\nWrite the report file last. Its final line must be exactly: ${DONE}`,
    "",
    baseline ? `## Repository state before the session\n\n${baseline}\n` : "",
    `## Task\n\n${task}`,
  ].join("\n");
}

const accepted = (verdict) => /^accept/i.test(verdict);

export async function runWork({ task, mux, cwd, dir, rounds, doerModel, verifierModel, turnTimeout, exec = run, env = process.env, sleep, now, progress = () => {}, runId }) {
  const workDir = join(dir, "work");
  mkdirSync(workDir, { recursive: true });
  const render = (o) => workTurnText({ rounds, workDir, ...o });
  const { panes, reports, meta, prepare, spawn, finish } = await workers({ task, mux, cwd, dir, turnTimeout, label: "Pair work", render, exec, env, sleep, now, progress, runId });
  const first = prepare("doer", "do");
  const doer = await spawn(await panes.anchor(), "right", "pair-work: doer", doerModel, first.prompt);
  const planTurn = prepare("verifier", "plan");
  const verifier = await spawn(doer, "below", "pair-work: verifier", verifierModel, planTurn.prompt);
  progress(`${mux}: doer ${doer} (${doerModel}), verifier ${verifier} (${verifierModel}); files in ${dir}`);

  // The verifier plans its checks while the doer works, so the plan is not shaped by the work.
  await finish("verifier", verifier, planTurn);
  let latest = first.report;
  let last = await finish("doer", doer, first);
  let verdict = "";
  let completed = 0;
  for (let round = 1; round <= rounds; round++) {
    const verify = prepare("verifier", "verify", { round, previous: latest, plan: planTurn.report });
    await panes.send(verifier, verify.prompt);
    const findings = await finish("verifier", verifier, verify);
    verdict = /verdict:\s*([^\n]*)/i.exec(findings)?.[1].trim() ?? "";
    completed = round;
    if (accepted(verdict)) break;
    const address = prepare("doer", "address", { round, previous: verify.report });
    await panes.send(doer, address.prompt);
    last = await finish("doer", doer, address);
    latest = address.report;
  }
  return {
    mux,
    ...meta,
    dir,
    workDir,
    panes: { doer, verifier },
    models: { doer: doerModel, verifier: verifierModel },
    rounds: completed,
    maxRounds: rounds,
    accepted: accepted(verdict),
    lastVerdict: verdict,
    reports,
    finalReport: last.replace(DONE, "").trim(),
  };
}

export function formatResult(r) {
  const [where, ...how] = workerLines(r, fileURLToPath(import.meta.url), ["doer", "verifier"]);
  return [
    `Pair work complete (${r.mux}, ${r.rounds} of at most ${r.maxRounds} verification round${r.maxRounds === 1 ? "" : "s"}). ${where}`,
    ...how.map((line) => line.replace("After reviewing the result", "After checking the result")),
    `Last verdict: ${r.lastVerdict || "(none given)"}`,
    `Default work folder: ${r.workDir}`,
    `Reports:`,
    ...r.reports.map((x) => `  ${x.role.padEnd(8)} ${x.path}`),
    "",
    "Final doer report:",
    "",
    r.finalReport,
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
  if (command === "detect") return detectCommand(flags, { env, exec, log });
  if (command === "close") return closeWorkers(positional.slice(1), { mux: flags.mux ?? found.mux, reason: found.reason, runId: flags.run, env, exec, log });
  if (command === "wait") return waitCommand(positional[1], flags, { log, sleep, now });
  if (command !== "run") throw new Error(`unknown command ${command}\n\n${USAGE}`);

  const options = runOptions(flags, { found, env, now, defaults: DEFAULTS, dirName: "pi-pair-work" });
  const runId = newRunId();
  const result = await tracked({ dir: options.dir, runId, workflow: "pair-work", script: fileURLToPath(import.meta.url), progress }, (note) => runWork({
    ...options,
    doerModel: flags["doer-model"] ?? DEFAULTS.doerModel,
    verifierModel: flags["verifier-model"] ?? DEFAULTS.verifierModel,
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`pair-work: ${error.message}`);
      process.exitCode = 2;
    },
  );
}
