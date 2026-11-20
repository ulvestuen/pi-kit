// Pair model picker: before pair, pair-review, or pair-work starts its workers, show a pop-up where the user picks
// each role's model and thinking level and the number of rounds. The skill still runs the workflow; this extension
// only decides the `run` flags. See a3/pair-model-picker.md.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cliThinkingLevels,
  describeSelection,
  fromThreema,
  joinSpec,
  loadPicks,
  modelList,
  preselect,
  runFlags,
  sameModelWarning,
  savePicks,
  shellArg,
  thinkingChoices,
  WORKFLOW_IDS,
  WORKFLOWS,
  type CliModelEntry,
  type Requested,
  type Selection,
  type Workflow,
} from "./lib.ts";
import { PairPicker } from "./picker.ts";

const SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
// The skill scripts require Node; process.execPath is Pi itself in standalone installs.
const NODE = "node";
const PICKS_FILE = () => join(getAgentDir(), "pair-picker.json");
const CHECK_TIMEOUT = 120_000;
const CLI_MODELS_TIMEOUT = 6_000;
const CLI_MODELS_TTL = 60_000;

interface CliModelsSnapshot {
  specs: string[];
  levels: Map<string, readonly string[]>;
  at: number;
}
const cliModelsCache = new Map<string, CliModelsSnapshot>();

export interface PairSetupResult {
  status: "chosen" | "cancelled" | "not-ready";
  workflow: Workflow;
  /** "overlay", "select" (RPC), or "saved" (no UI: last picks or defaults). */
  via?: "overlay" | "select" | "saved";
  selection?: Selection;
  flags?: string[];
  problem?: string;
}

const scriptFor = (workflow: Workflow) => join(SKILLS, workflow, `${workflow}.mjs`);

/** The readiness check: the skill's own `models --json --no-scan`, run where the workers will run. */
async function checkSelection(pi: ExtensionAPI, selection: Selection, cwd: string, signal?: AbortSignal): Promise<string | null> {
  const roles = WORKFLOWS[selection.workflow].roles;
  const args = [scriptFor(selection.workflow), "models", "--json", "--no-scan", "--cwd", cwd];
  for (const { id } of roles) args.push(`--${id}-model`, joinSpec(selection.roles[id]));
  const result = await pi.exec(NODE, args, { cwd, timeout: CHECK_TIMEOUT, signal });
  let report: any;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    const why = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
    return `Readiness check failed (exit ${result.code}): ${why || "no output"}`;
  }
  const problems = roles.flatMap(({ id, label }) => {
    const choice = report?.models?.[id];
    if (choice?.ready) return [];
    const first = choice?.checked?.[0];
    const alternatives = choice?.alternatives?.length ? `; ready: ${choice.alternatives.slice(0, 3).join(", ")}` : "";
    return [`${label}: ${first?.model ?? joinSpec(selection.roles[id])} is not ready (${first?.detail ?? "unknown"})${alternatives}`];
  });
  return problems.length ? problems.join(" · ") : null;
}

/** Discover ready external CLI models (`agy/*`, `claude/*`, `codex/*`), cached briefly so the pop-up stays fast. */
async function loadCliModels(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<{ specs: string[]; levels: Map<string, readonly string[]> }> {
  const cached = cliModelsCache.get(cwd);
  if (cached && Date.now() - cached.at < CLI_MODELS_TTL) {
    return { specs: cached.specs, levels: cached.levels };
  }
  const empty = { specs: [] as string[], levels: new Map<string, readonly string[]>() };
  try {
    const result = await pi.exec(NODE, [scriptFor("pair"), "cli-models", "--json", "--cwd", cwd], {
      cwd,
      timeout: CLI_MODELS_TIMEOUT,
      signal,
    });
    if (result.code !== 0) return empty;
    const parsed = JSON.parse(result.stdout) as { models?: CliModelEntry[] };
    const specs: string[] = [];
    const levels = new Map<string, readonly string[]>();
    for (const entry of parsed.models ?? []) {
      if (!entry?.spec) continue;
      specs.push(entry.spec);
      if (Array.isArray(entry.levels) && entry.levels.length) levels.set(entry.spec, entry.levels);
    }
    cliModelsCache.set(cwd, { specs, levels, at: Date.now() });
    return { specs, levels };
  } catch {
    return empty;
  }
}

function models(ctx: ExtensionContext, extra: readonly string[] = []): string[] {
  const scoped = ctx.scopedModels.map((entry) => entry.model);
  let available: { provider: string; id: string }[] = [];
  try {
    available = ctx.modelRegistry.getAvailable();
  } catch {
    available = [];
  }
  return modelList(scoped, available, extra);
}

function levelsFor(ctx: ExtensionContext, cliLevels?: ReadonlyMap<string, readonly string[]>) {
  return (spec: string): readonly string[] | undefined => {
    const cli = cliThinkingLevels(spec, cliLevels);
    if (cli) return cli;
    const slash = spec.indexOf("/");
    if (slash <= 0) return undefined;
    const model = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
    return model ? getSupportedThinkingLevels(model) : undefined;
  };
}

/** RPC clients get plain select dialogs: one per role's model, one per thinking level, then rounds. */
async function selectDialogs(ctx: ExtensionContext, start: Selection, list: string[], check: (s: Selection) => Promise<string | null>, cliLevels?: ReadonlyMap<string, readonly string[]>): Promise<Selection | null> {
  const selection = structuredClone(start);
  const info = WORKFLOWS[selection.workflow];
  const levels = levelsFor(ctx, cliLevels);
  for (;;) {
    for (const { id, label } of info.roles) {
      const current = selection.roles[id];
      const options = [...new Set([current.model, ...list])];
      const model = await ctx.ui.select(`${info.title}: ${label} model`, options);
      if (model === undefined) return null;
      current.model = model;
      const thinkingOptions = thinkingChoices(levels(model));
      const ordered = [...new Set([thinkingOptions.includes(current.thinking) ? current.thinking : "default", ...thinkingOptions])];
      const thinking = await ctx.ui.select(`${label} thinking level`, ordered);
      if (thinking === undefined) return null;
      current.thinking = thinking;
    }
    const roundOptions = [...new Set([selection.rounds, info.rounds, 1, 2, 3, 4, 5])].map(String);
    const rounds = await ctx.ui.select(`${info.title}: ${info.roundsLabel}`, roundOptions);
    if (rounds === undefined) return null;
    selection.rounds = Number(rounds);
    const warning = sameModelWarning(selection);
    const problem = await check(selection);
    if (!problem) {
      if (warning) ctx.ui.notify(warning, "warning");
      return selection;
    }
    const again = await ctx.ui.confirm("Models not ready", `${problem}\n\nChoose again?`);
    if (!again) return null;
  }
}

/** The whole picking flow for one workflow, by mode. Saves and returns the confirmed picks. */
export async function pickModels(pi: ExtensionAPI, ctx: ExtensionContext, workflow: Workflow, requested: Requested, task: string | undefined, signal?: AbortSignal): Promise<PairSetupResult> {
  const file = PICKS_FILE();
  const cli = await loadCliModels(pi, ctx.cwd, signal);
  const list = models(ctx, cli.specs);
  const { selection: start, sources } = preselect(workflow, { requested, saved: loadPicks(file), models: list });
  const check = (selection: Selection) => checkSelection(pi, selection, ctx.cwd, signal);
  const awayOnThreema = fromThreema(ctx.sessionManager.getBranch());

  let chosen: Selection | null;
  let via: PairSetupResult["via"];
  if (ctx.mode === "tui" && !awayOnThreema) {
    via = "overlay";
    chosen = await ctx.ui.custom<Selection | null>(
      (tui, theme, _keybindings, done) =>
        new PairPicker(theme, { selection: start, sources, models: list, task, levelsFor: levelsFor(ctx, cli.levels), check, done, requestRender: () => tui.requestRender() }),
      { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "80%" } },
    );
  } else if (ctx.mode === "rpc" && ctx.hasUI && !awayOnThreema) {
    via = "select";
    chosen = await selectDialogs(ctx, start, list, check, cli.levels);
  } else {
    via = "saved";
    const problem = await check(start);
    if (problem) return { status: "not-ready", workflow, via, selection: start, problem };
    chosen = start;
  }
  if (!chosen) return { status: "cancelled", workflow, via };
  savePicks(file, chosen);
  return { status: "chosen", workflow, via, selection: chosen, flags: runFlags(chosen) };
}

export function resultText(result: PairSetupResult): string {
  const name = result.workflow;
  if (result.status === "cancelled") return `The user cancelled the ${name} model picker. Do not start ${name}; ask what they want instead.`;
  if (result.status === "not-ready") {
    return [
      `No pop-up could be shown (no interactive UI), and the saved/default ${name} models are not ready: ${result.problem}.`,
      `Do not start ${name}. Tell the user and ask which models to use; pass them to pair_setup as models.`,
    ].join("\n");
  }
  const flags = result.flags!.map(shellArg).join(" ");
  const how =
    result.via === "saved"
      ? "No pop-up could be shown (no interactive UI), so the last picks (or defaults) were used; they passed the readiness check. Say so in your report."
      : "The user chose these in the picker and they passed the readiness check.";
  return [
    `${name}: ${describeSelection(result.selection!)}.`,
    how,
    `Follow the ${name} skill and pass exactly these flags to \`${name}.mjs run\` (after --task-file): ${flags}`,
    "Do not run the skill's `models` step again and do not change these models or rounds.",
  ].join("\n");
}

const Params = Type.Object({
  workflow: StringEnum(WORKFLOW_IDS as unknown as ["pair", "pair-review", "pair-work"], {
    description: "pair = build or change code; pair-review = read-only review of a diff/branch/commit/PR; pair-work = non-coding work with a doer and a verifier",
  }),
  task: Type.Optional(Type.String({ description: "One-line summary of the task or review target, shown in the pop-up" })),
  models: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Only models the user named, by role (implementer/auditor, lead/peer, doer/verifier) → model text as given, e.g. {\"auditor\": \"sonnet:high\"}. Omit roles the user did not name.",
    }),
  ),
  rounds: Type.Optional(Type.Integer({ minimum: 1, description: "Only when the user named a number of rounds" })),
});

export default function pairPicker(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pair_setup",
    label: "Pair setup",
    description:
      "Opens a pop-up where the user picks the models, thinking levels, and rounds for a pair, pair-review, or pair-work run, checks they are ready, and returns the exact flags for the skill's `run` command. Without an interactive UI it uses the user's last picks (or defaults).",
    promptSnippet: "Choose models and rounds for pair, pair-review, or pair-work before starting workers",
    promptGuidelines: [
      "Call pair_setup before starting the pair, pair-review, or pair-work skill, whenever the user asks for pair programming, a pair review, or a doer/verifier pair (in plain words or via /pair, /pair-review, /pair-work), unless a pair_setup result for this request is already in the conversation.",
      "Pass to pair_setup only the models and rounds the user actually named; it fills in the rest and the user confirms in the pop-up.",
      "After pair_setup returns flags, run the skill with exactly those flags; if pair_setup reports the user cancelled, do not start the run.",
    ],
    parameters: Params,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const workflow = params.workflow as Workflow;
      const result = await pickModels(pi, ctx, workflow, { models: params.models, rounds: params.rounds }, params.task, signal);
      return { content: [{ type: "text", text: resultText(result) }], details: result };
    },
  });

  for (const workflow of WORKFLOW_IDS) {
    const info = WORKFLOWS[workflow];
    pi.registerCommand(workflow, {
      description: `${info.title}: pick models and rounds in a pop-up, then run the ${workflow} skill`,
      handler: async (args, ctx) => {
        const task = args.trim();
        const target = workflow === "pair-review" ? "Review target (optional; empty means the skill's default target):" : "Task:";
        const body = [
          `Use the \`${workflow}\` skill: read its SKILL.md and follow it for the ${workflow === "pair-review" ? "review target" : "task"} below.`,
          `First call pair_setup with workflow "${workflow}", a one-line summary as task, and only the models and rounds this text names; then pass the flags it returns to \`${workflow}.mjs run\`. If the user cancels, stop.`,
          "",
          target,
          "",
          task,
        ].join("\n");
        if (ctx.isIdle()) pi.sendUserMessage(body);
        else pi.sendUserMessage(body, { deliverAs: "followUp" });
      },
    });
  }
}
