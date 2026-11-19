// Pure logic for the pair model picker: workflows and roles, model specs, the saved picks, preselection, and the
// flags handed to the skill scripts. No Pi runtime imports, so it is tested directly.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Workflow = "pair" | "pair-review" | "pair-work";

export interface RoleInfo {
  id: string;
  label: string;
}

export interface WorkflowInfo {
  id: Workflow;
  title: string;
  roles: [RoleInfo, RoleInfo];
  rounds: number;
  /** What `--rounds` counts, for the pop-up label. */
  roundsLabel: string;
  /** Today's first preference per role, used when nothing was saved. */
  defaults: Record<string, string>;
}

const CLAUDE = "claude-code/claude-opus-5-5";
const GPT = "openai/gpt-6.1-sol:xhigh";

export const WORKFLOWS: Record<Workflow, WorkflowInfo> = {
  pair: {
    id: "pair",
    title: "Pair programming",
    roles: [{ id: "implementer", label: "Implementer" }, { id: "auditor", label: "Auditor" }],
    rounds: 3,
    roundsLabel: "audit rounds",
    defaults: { implementer: CLAUDE, auditor: GPT },
  },
  "pair-review": {
    id: "pair-review",
    title: "Pair review",
    roles: [{ id: "lead", label: "Lead reviewer" }, { id: "peer", label: "Peer reviewer" }],
    rounds: 1,
    roundsLabel: "cross-check rounds",
    defaults: { lead: CLAUDE, peer: GPT },
  },
  "pair-work": {
    id: "pair-work",
    title: "Pair work",
    roles: [{ id: "doer", label: "Doer" }, { id: "verifier", label: "Verifier" }],
    rounds: 3,
    roundsLabel: "verification rounds",
    defaults: { doer: CLAUDE, verifier: GPT },
  },
};

export const WORKFLOW_IDS = Object.keys(WORKFLOWS) as Workflow[];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** "default" means no `:level` suffix: the worker uses the model's own default. */
export const DEFAULT_THINKING = "default";
export const MAX_ROUNDS = 10;

export interface RolePick {
  /** `provider/id` */
  model: string;
  /** a THINKING_LEVELS entry or DEFAULT_THINKING */
  thinking: string;
}

export interface Selection {
  workflow: Workflow;
  roles: Record<string, RolePick>;
  rounds: number;
}

/** `openai/gpt-6.1-sol:xhigh` → model `openai/gpt-6.1-sol`, thinking `xhigh`. Same rule as `modelParts` in pair.mjs. */
export function splitSpec(spec: string): RolePick {
  const text = String(spec ?? "").trim();
  const suffix = /^(.*):([a-z]+)$/.exec(text);
  if (suffix && THINKING_LEVELS.includes(suffix[2])) return { model: suffix[1], thinking: suffix[2] };
  return { model: text, thinking: DEFAULT_THINKING };
}

export function joinSpec(pick: RolePick): string {
  return pick.thinking && pick.thinking !== DEFAULT_THINKING ? `${pick.model}:${pick.thinking}` : pick.model;
}

/**
 * Resolve what a request named ("sonnet", "claude-sonnet-4-5", "anthropic/claude-sonnet-4-5:high") to a listed
 * `provider/id`. Exact `provider/id`, then exact id, then the shortest id containing the text. Unknown text is kept
 * as given, so the readiness check reports it instead of the picker silently replacing it.
 */
export function matchModel(text: string, models: readonly string[]): RolePick {
  const { model, thinking } = splitSpec(text);
  const lower = model.toLowerCase();
  const exact = models.find((m) => m.toLowerCase() === lower);
  if (exact) return { model: exact, thinking };
  const byId = models.find((m) => m.slice(m.indexOf("/") + 1).toLowerCase() === lower);
  if (byId) return { model: byId, thinking };
  const partial = models.filter((m) => m.toLowerCase().includes(lower)).sort((a, b) => a.length - b.length);
  return { model: partial[0] ?? model, thinking };
}

export const CLI_DEFAULT_LEVELS: Record<string, readonly string[]> = {
  agy: ["low", "medium", "high", "xhigh"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
};

export interface CliModelEntry {
  spec: string;
  levels?: readonly string[];
}

/** Supported thinking levels for an external CLI model spec (`agy/*`, `claude/*`, `codex/*`), or undefined for Pi models. */
export function cliThinkingLevels(
  spec: string,
  discovered?: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined {
  const { model } = splitSpec(spec);
  const exact = discovered?.get(model);
  if (exact?.length) return exact;
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = model.slice(0, slash).toLowerCase();
  return CLI_DEFAULT_LEVELS[provider];
}

/** The models the picker lists: scoped ones when scoping is configured, else every available one, plus ready CLI backends. Deduplicated. */
export function modelList(
  scoped: readonly { provider: string; id: string }[],
  available: readonly { provider: string; id: string }[],
  extra: readonly string[] = [],
): string[] {
  const source = scoped.length ? scoped : available;
  return [...new Set([...source.map((m) => `${m.provider}/${m.id}`), ...extra])];
}

// ---------- saved picks ----------

export interface SavedPicks {
  [workflow: string]: { roles?: Record<string, string>; rounds?: number } | undefined;
}

export function loadPicks(file: string): SavedPicks {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function savePicks(file: string, selection: Selection): void {
  const all = loadPicks(file);
  all[selection.workflow] = {
    roles: Object.fromEntries(Object.entries(selection.roles).map(([role, pick]) => [role, joinSpec(pick)])),
    rounds: selection.rounds,
  };
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(temp, file);
}

// ---------- preselection ----------

export interface Requested {
  /** role → spec text as the request named it */
  models?: Record<string, string>;
  rounds?: number;
}

/** Where each value came from, so the pop-up and the no-UI report can say it. */
export type Source = "request" | "last pick" | "default";

export interface Preselection {
  selection: Selection;
  sources: Record<string, Source>;
}

export function clampRounds(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_ROUNDS) : fallback;
}

/** Request values win, then the last pick for this workflow, then today's defaults. */
export function preselect(workflow: Workflow, { requested = {}, saved = {}, models = [] }: { requested?: Requested; saved?: SavedPicks; models?: readonly string[] }): Preselection {
  const info = WORKFLOWS[workflow];
  const last = saved[workflow] ?? {};
  const roles: Record<string, RolePick> = {};
  const sources: Record<string, Source> = {};
  for (const { id } of info.roles) {
    const asked = requested.models?.[id];
    if (asked && asked.trim()) {
      roles[id] = matchModel(asked, models);
      sources[id] = "request";
    } else if (typeof last.roles?.[id] === "string" && last.roles[id]) {
      roles[id] = splitSpec(last.roles[id]);
      sources[id] = "last pick";
    } else {
      roles[id] = splitSpec(info.defaults[id]);
      sources[id] = "default";
    }
  }
  let rounds = info.rounds;
  sources.rounds = "default";
  if (requested.rounds !== undefined && clampRounds(requested.rounds, 0) > 0) {
    rounds = clampRounds(requested.rounds, info.rounds);
    sources.rounds = "request";
  } else if (last.rounds !== undefined && clampRounds(last.rounds, 0) > 0) {
    rounds = clampRounds(last.rounds, info.rounds);
    sources.rounds = "last pick";
  }
  return { selection: { workflow, roles, rounds }, sources };
}

/** The warning the pop-up shows when both roles run the same model (thinking level aside). */
export function sameModelWarning(selection: Selection): string | null {
  const [a, b] = WORKFLOWS[selection.workflow].roles;
  const left = selection.roles[a.id]?.model;
  return left && left === selection.roles[b.id]?.model
    ? `Both roles use ${left}: the second opinion is weaker than with two different models.`
    : null;
}

/** The thinking levels offered for a model: "default" plus what it supports (all levels when unknown). */
export function thinkingChoices(supported: readonly string[] | undefined): string[] {
  return [DEFAULT_THINKING, ...(supported?.length ? supported : THINKING_LEVELS)];
}

// ---------- flags ----------

/** The exact `run` flags for the skill script, in role order. */
export function runFlags(selection: Selection): string[] {
  const flags: string[] = [];
  for (const { id } of WORKFLOWS[selection.workflow].roles) flags.push(`--${id}-model`, joinSpec(selection.roles[id]));
  flags.push("--rounds", String(selection.rounds));
  return flags;
}

/** Quote a flag value for a POSIX shell only when it needs it. */
export function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function describeSelection(selection: Selection): string {
  return WORKFLOWS[selection.workflow].roles
    .map(({ id }) => `${id} ${joinSpec(selection.roles[id])}`)
    .concat(`${selection.rounds} round${selection.rounds === 1 ? "" : "s"}`)
    .join(", ");
}

/** A user message from the Threema extension: the user is away from the terminal, so no pop-up is shown. */
export const THREEMA_PREFIX = "[Threema message from ";

export function lastUserText(entries: readonly any[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.type === "message" ? entries[i].message : null;
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
    return "";
  }
  return null;
}

export function fromThreema(entries: readonly any[]): boolean {
  return (lastUserText(entries) ?? "").startsWith(THREEMA_PREFIX);
}
