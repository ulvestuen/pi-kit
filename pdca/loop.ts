/**
 * pdca loop engine — pure, dependency-free state model for a
 * Plan-Do-Check-Act self-checking loop.
 *
 * This module has no pi or Node dependencies so it can be unit tested in
 * isolation and reused by the extension, commands, and tools.
 */

export const DEFAULT_PASS_THRESHOLD = 8;
export const DEFAULT_SCALE_MAX = 10;
export const DEFAULT_MAX_ITERATIONS = 25;

/** A single success criterion the work is scored against. */
export interface Criterion {
  /** Short, unique, human-readable name. */
  name: string;
  /** Minimum score (inclusive) on the scale required to pass this criterion. */
  threshold: number;
}

/** Raw criterion input accepted by createLoop — a bare name or an object. */
export type CriterionInput = string | { name: string; threshold?: number };

/** A score recorded for one criterion during a VERIFY step. */
export interface CriterionScore {
  name: string;
  /** Integer score on [1, scaleMax]. */
  score: number;
  /** Honest note on what is still weak. Required when below threshold. */
  weakness?: string;
}

/** PDCA phase labels, in loop order. */
export type Phase = "plan" | "do" | "check" | "act";

/** One full pass through the loop. */
export interface Iteration {
  /** 1-based pass number. */
  index: number;
  /** PLAN: the single next step taken this pass. */
  plan: string;
  /** DO: a terse summary of what was produced or changed. */
  changes: string;
  /** CHECK: scores for every criterion. */
  scores: CriterionScore[];
  /** Whether every criterion met its threshold. */
  passed: boolean;
  /** Name of the weakest failing criterion, or null when all passed. */
  weakest: string | null;
  timestamp: number;
}

export type LoopStatus = "active" | "final" | "stopped";

export interface LoopState {
  task: string;
  criteria: Criterion[];
  passThreshold: number;
  scaleMax: number;
  maxIterations: number;
  iterations: Iteration[];
  status: LoopStatus;
  startedAt: number;
  updatedAt: number;
}

export interface CreateLoopOptions {
  task: string;
  criteria: CriterionInput[];
  passThreshold?: number;
  scaleMax?: number;
  maxIterations?: number;
  now?: number;
}

export interface CheckpointInput {
  /** PLAN: the single next step for this pass. */
  plan: string;
  /** DO: terse summary of what changed. */
  changes: string;
  /** CHECK: scores for the criteria. */
  scores: CriterionScore[];
  now?: number;
}

export type Verdict = "FINAL" | "ITERATING" | "STOPPED";

export interface Decision {
  verdict: Verdict;
  /** 1-based number of the pass this decision describes. */
  iteration: number;
  passed: boolean;
  /** Weakest failing criterion to fix next, or null when all passed. */
  weakest: string | null;
  /** All criteria that did not meet their threshold, weakest first. */
  failing: CriterionScore[];
  /** Human-readable ACT summary. */
  message: string;
}

function normalizeName(name: string): string {
  return name.trim();
}

function nameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

/**
 * Validate and normalize raw criterion input into Criterion records.
 * Throws on empty input, blank names, duplicates, or out-of-range thresholds.
 */
export function normalizeCriteria(
  input: CriterionInput[],
  defaultThreshold: number,
  scaleMax: number,
): Criterion[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("At least one success criterion is required");
  }

  const seen = new Set<string>();
  const criteria: Criterion[] = [];

  for (const raw of input) {
    const name = normalizeName(typeof raw === "string" ? raw : raw.name ?? "");
    if (!name) {
      throw new Error("Criterion name must not be empty");
    }
    const key = nameKey(name);
    if (seen.has(key)) {
      throw new Error(`Duplicate criterion name: ${name}`);
    }
    seen.add(key);

    const threshold =
      typeof raw === "object" && raw.threshold !== undefined
        ? raw.threshold
        : defaultThreshold;
    if (
      !Number.isFinite(threshold) ||
      threshold < 1 ||
      threshold > scaleMax
    ) {
      throw new Error(
        `Threshold for "${name}" must be between 1 and ${scaleMax} (got: ${threshold})`,
      );
    }

    criteria.push({ name, threshold: Math.round(threshold) });
  }

  return criteria;
}

/** Coerce a raw score to an integer clamped to [1, scaleMax]. */
export function clampScore(score: number, scaleMax: number): number {
  if (!Number.isFinite(score)) {
    throw new Error(`Score must be a finite number (got: ${score})`);
  }
  return Math.min(scaleMax, Math.max(1, Math.round(score)));
}

/** Create a fresh loop in the "active" state. */
export function createLoop(options: CreateLoopOptions): LoopState {
  const task = normalizeName(options.task);
  if (!task) {
    throw new Error("Loop task must not be empty");
  }

  const scaleMax = options.scaleMax ?? DEFAULT_SCALE_MAX;
  if (!Number.isFinite(scaleMax) || scaleMax < 2) {
    throw new Error(`scaleMax must be at least 2 (got: ${scaleMax})`);
  }

  const passThreshold = options.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  if (passThreshold < 1 || passThreshold > scaleMax) {
    throw new Error(
      `passThreshold must be between 1 and ${scaleMax} (got: ${passThreshold})`,
    );
  }

  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isFinite(maxIterations) || maxIterations < 1) {
    throw new Error(`maxIterations must be at least 1 (got: ${maxIterations})`);
  }

  const now = options.now ?? Date.now();
  return {
    task,
    criteria: normalizeCriteria(options.criteria, passThreshold, scaleMax),
    passThreshold: Math.round(passThreshold),
    scaleMax: Math.round(scaleMax),
    maxIterations: Math.round(maxIterations),
    iterations: [],
    status: "active",
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * Reconcile raw scores against the loop's criteria.
 * Requires exactly one score per criterion and rejects unknown names.
 */
function reconcileScores(
  state: LoopState,
  rawScores: CriterionScore[],
): CriterionScore[] {
  if (!Array.isArray(rawScores)) {
    throw new Error("scores must be an array");
  }

  const byKey = new Map<string, CriterionScore>();
  for (const raw of rawScores) {
    const name = normalizeName(raw?.name ?? "");
    if (!name) {
      throw new Error("Each score must name a criterion");
    }
    const key = nameKey(name);
    if (byKey.has(key)) {
      throw new Error(`Duplicate score for criterion: ${name}`);
    }
    byKey.set(key, {
      name,
      score: clampScore(raw.score, state.scaleMax),
      weakness: raw.weakness?.trim() || undefined,
    });
  }

  const knownKeys = new Set(state.criteria.map((c) => nameKey(c.name)));
  const unknown = [...byKey.keys()].filter((k) => !knownKeys.has(k));
  if (unknown.length > 0) {
    const unknownNames = [...byKey.values()]
      .filter((s) => unknown.includes(nameKey(s.name)))
      .map((s) => s.name);
    throw new Error(`Unknown criteria scored: ${unknownNames.join(", ")}`);
  }

  const missing = state.criteria.filter((c) => !byKey.has(nameKey(c.name)));
  if (missing.length > 0) {
    throw new Error(
      `Missing scores for: ${missing.map((c) => c.name).join(", ")}`,
    );
  }

  // Return in criterion order, using each criterion's canonical name.
  return state.criteria.map((c) => {
    const score = byKey.get(nameKey(c.name))!;
    return { name: c.name, score: score.score, weakness: score.weakness };
  });
}

function thresholdFor(state: LoopState, name: string): number {
  const match = state.criteria.find((c) => nameKey(c.name) === nameKey(name));
  return match ? match.threshold : state.passThreshold;
}

/** Criteria whose score is below their threshold, weakest (smallest margin) first. */
export function failingScores(
  state: LoopState,
  scores: CriterionScore[],
): CriterionScore[] {
  return scores
    .filter((s) => s.score < thresholdFor(state, s.name))
    .sort((a, b) => {
      const marginA = a.score - thresholdFor(state, a.name);
      const marginB = b.score - thresholdFor(state, b.name);
      if (marginA !== marginB) return marginA - marginB;
      return a.score - b.score;
    });
}

/**
 * Record one full PLAN/DO/CHECK pass and compute the ACT verdict.
 * Mutates and returns the same state object, plus the decision.
 */
export function recordCheckpoint(
  state: LoopState,
  input: CheckpointInput,
): { state: LoopState; decision: Decision } {
  if (state.status !== "active") {
    throw new Error(`Loop is ${state.status}; start a new loop to continue`);
  }

  const plan = normalizeName(input.plan);
  if (!plan) {
    throw new Error("plan (the single next step) must not be empty");
  }
  const changes = normalizeName(input.changes);
  if (!changes) {
    throw new Error("changes (what you did this pass) must not be empty");
  }

  const scores = reconcileScores(state, input.scores);
  const failing = failingScores(state, scores);
  const passed = failing.length === 0;
  const weakest = passed ? null : failing[0].name;
  const now = input.now ?? Date.now();

  const iteration: Iteration = {
    index: state.iterations.length + 1,
    plan,
    changes,
    scores,
    passed,
    weakest,
    timestamp: now,
  };
  state.iterations.push(iteration);
  state.updatedAt = now;

  let verdict: Verdict;
  if (passed) {
    state.status = "final";
    verdict = "FINAL";
  } else if (state.iterations.length >= state.maxIterations) {
    state.status = "stopped";
    verdict = "STOPPED";
  } else {
    verdict = "ITERATING";
  }

  return {
    state,
    decision: {
      verdict,
      iteration: iteration.index,
      passed,
      weakest,
      failing,
      message: buildDecisionMessage(state, iteration, verdict, failing),
    },
  };
}

function buildDecisionMessage(
  state: LoopState,
  iteration: Iteration,
  verdict: Verdict,
  failing: CriterionScore[],
): string {
  const header = `Pass ${iteration.index} — ${verdict}`;
  const scoreLine = iteration.scores
    .map((s) => {
      const t = thresholdFor(state, s.name);
      const mark = s.score >= t ? "ok" : "LOW";
      return `${s.name} ${s.score}/${t} [${mark}]`;
    })
    .join(", ");

  if (verdict === "FINAL") {
    return `${header}. Every criterion met its threshold (${scoreLine}). Print FINAL and stop.`;
  }
  if (verdict === "STOPPED") {
    return (
      `${header}. Reached the ${state.maxIterations}-pass safety limit with ` +
      `failing criteria: ${failing.map((f) => f.name).join(", ")}. ` +
      `Scores: ${scoreLine}. Stop and report what is still weak.`
    );
  }
  const weakest = failing[0];
  return (
    `${header}. Scores: ${scoreLine}. Fix the weakest point first: ` +
    `"${weakest.name}" at ${weakest.score}/${thresholdFor(state, weakest.name)}` +
    (weakest.weakness ? ` — ${weakest.weakness}` : "") +
    `. Then run the loop again.`
  );
}

export interface LoopSummary {
  task: string;
  status: LoopStatus;
  passThreshold: number;
  scaleMax: number;
  iterationCount: number;
  maxIterations: number;
  latest: Iteration | undefined;
  /** Current weakest failing criterion across the latest pass, if any. */
  weakest: string | null;
}

export function summarizeLoop(state: LoopState): LoopSummary {
  const latest = state.iterations[state.iterations.length - 1];
  return {
    task: state.task,
    status: state.status,
    passThreshold: state.passThreshold,
    scaleMax: state.scaleMax,
    iterationCount: state.iterations.length,
    maxIterations: state.maxIterations,
    latest,
    weakest: latest ? latest.weakest : null,
  };
}

/** One-line status suitable for a footer/status bar. */
export function statusLine(state: LoopState): string {
  const s = summarizeLoop(state);
  if (s.status === "final") {
    return `pdca: FINAL after ${s.iterationCount} pass${s.iterationCount === 1 ? "" : "es"}`;
  }
  if (s.status === "stopped") {
    return `pdca: stopped at safety limit (${s.iterationCount}/${s.maxIterations})`;
  }
  if (!s.latest) {
    return `pdca: pass 1 — plan the first step`;
  }
  return s.weakest
    ? `pdca: pass ${s.iterationCount + 1} — fix "${s.weakest}"`
    : `pdca: pass ${s.iterationCount + 1}`;
}
