/**
 * critic review engine — pure, dependency-free prompt construction and
 * output parsing for independent reviews.
 *
 * The only import is lykkja's pure loop engine, so scores land in lykkja's
 * exact CriterionScore shape and can feed straight into lykkja_checkpoint.
 * Robustness lives in parseCriticOutput: a review that cannot be parsed is a
 * failed review, never a silent pass.
 */

import {
  clampScore,
  type Criterion,
  type CriterionScore,
} from "../lykkja/loop.ts";
import type { ArtifactRef } from "@pi-kit/agent-types";

export const DEFAULT_SCALE_MAX = 10;

export interface ReviewRequest {
  /** What is being reviewed: a diff, file list, artifact, or task result. */
  subject: string;
  /** Task brief, constraints — everything the critic needs to judge. */
  context?: string;
  /** The rubric — the same Criterion objects the planner attached to the task. */
  criteria: Criterion[];
  /** Top of the scoring scale. */
  scaleMax: number;
  /** Artifacts from prerequisite tasks or the implementer for evidence context. */
  artifacts?: ArtifactRef[];
}

export interface ReviewResult {
  /** lykkja-shaped: score + weakness per criterion. */
  scores: CriterionScore[];
  /** True only when every criterion met its threshold. */
  passed: boolean;
  /** Prioritized, actionable weaknesses (worst margin first). */
  weaknesses: string[];
  /** The critic's full prose, for the details view. */
  raw: string;
}

export interface AdviseRequest {
  /** The plan, approach, or design to critique before implementation. */
  subject: string;
  context?: string;
}

function validateRequest(req: ReviewRequest): void {
  if (!req.subject?.trim()) {
    throw new Error("Review subject must not be empty");
  }
  if (!Array.isArray(req.criteria) || req.criteria.length === 0) {
    throw new Error("A review needs at least one criterion");
  }
  if (!Number.isFinite(req.scaleMax) || req.scaleMax < 2) {
    throw new Error(`scaleMax must be at least 2 (got: ${req.scaleMax})`);
  }
}

/** Turn a rubric into strict scoring instructions for the critic agent. */
export function buildCriticPrompt(req: ReviewRequest): string {
  validateRequest(req);
  const rubric = req.criteria
    .map((c) => `- "${c.name}" (passing threshold: ${c.threshold}/${req.scaleMax})`)
    .join("\n");

  return [
    "Review the following subject against the rubric below. You are an independent critic: verify claims against the actual files with your read-only tools; never take the subject's description at face value.",
    "",
    "SUBJECT:",
    req.subject.trim(),
    ...(req.context?.trim() ? ["", "CONTEXT:", req.context.trim()] : []),
    ...(req.artifacts && req.artifacts.length > 0
      ? [
          "",
          "PREREQUISITE ARTIFACTS (for evidence context):",
          ...req.artifacts.map((a) =>
            `  - ${a.type}: ${a.description}${a.location ? ` at ${a.location}` : ""}`,
          ),
        ]
      : []),
    "",
    "RUBRIC (score every criterion, integers 1.." + req.scaleMax + "):",
    rubric,
    "",
    "Scoring rules:",
    "- Score strictly from evidence you verified yourself. When in doubt, score lower.",
    "- For every criterion below its threshold, give a precise, actionable weakness.",
    "- Score every criterion in the rubric, by its exact name. Do not add criteria.",
    "",
    "After your analysis, output your verdict as exactly one fenced JSON block in this shape:",
    "",
    "```json",
    JSON.stringify(
      {
        scores: [
          { name: "<criterion name>", score: 0, weakness: "<required when below threshold>" },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/** Pre-implementation design feedback prompt — concerns, not scores. */
export function buildAdvisePrompt(req: AdviseRequest): string {
  if (!req.subject?.trim()) {
    throw new Error("Advise subject must not be empty");
  }
  return [
    "Give pre-implementation design feedback on the following plan or approach. You are an independent advisor with fresh context: inspect the repository with your read-only tools where the plan references it.",
    "",
    "SUBJECT:",
    req.subject.trim(),
    ...(req.context?.trim() ? ["", "CONTEXT:", req.context.trim()] : []),
    "",
    "Respond with:",
    "1. A one-paragraph overall assessment.",
    "2. A prioritized list of concerns (most important first). For each: what is at risk, why, and a concrete improvement.",
    "3. Anything missing from the plan that is likely to bite.",
    "",
    "Do not implement anything and do not produce scores — concerns and recommendations only.",
  ].join("\n");
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A failed review with a diagnostic weakness — the unparseable path. */
function failedReview(raw: string, reason: string): ReviewResult {
  return {
    scores: [],
    passed: false,
    weaknesses: [`unscorable output: ${reason}`],
    raw,
  };
}

/** Extract candidate JSON payloads from the critic's reply, best first. */
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  // Fenced blocks first (last one wins the top spot — the verdict comes last).
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const match of fenced.reverse()) {
    candidates.push(match[1]);
  }
  // Fallback: bare {...} regions that mention "scores".
  const braceStart = text.indexOf("{");
  if (braceStart !== -1) {
    const braceEnd = text.lastIndexOf("}");
    if (braceEnd > braceStart) {
      candidates.push(text.slice(braceStart, braceEnd + 1));
    }
  }
  return candidates;
}

/**
 * Parse the critic's reply into a ReviewResult: tolerant JSON-block
 * extraction, per-criterion validation, and score clamping. Never throws on
 * bad critic output — an unscorable review fails loudly instead.
 */
export function parseCriticOutput(
  text: string,
  req: ReviewRequest,
): ReviewResult {
  validateRequest(req);
  const raw = text ?? "";

  let parsed: any = null;
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && Array.isArray(value.scores)) {
        parsed = value;
        break;
      }
    } catch {
      // try the next candidate
    }
  }
  if (!parsed) {
    return failedReview(raw, "no valid JSON scores block found in the reply");
  }

  const byKey = new Map<string, { score: number; weakness?: string }>();
  for (const entry of parsed.scores) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const scoreNum = Number(entry.score);
    if (!Number.isFinite(scoreNum)) continue;
    byKey.set(nameKey(name), {
      score: clampScore(scoreNum, req.scaleMax),
      weakness:
        typeof entry.weakness === "string" && entry.weakness.trim()
          ? entry.weakness.trim()
          : undefined,
    });
  }

  const missing = req.criteria.filter((c) => !byKey.has(nameKey(c.name)));
  if (missing.length > 0) {
    return failedReview(
      raw,
      `criteria not scored: ${missing.map((c) => c.name).join(", ")}`,
    );
  }

  const scores: CriterionScore[] = req.criteria.map((c) => {
    const entry = byKey.get(nameKey(c.name))!;
    return { name: c.name, score: entry.score, weakness: entry.weakness };
  });

  const failing = scores
    .map((score) => ({
      score,
      threshold: req.criteria.find((c) => nameKey(c.name) === nameKey(score.name))!
        .threshold,
    }))
    .filter(({ score, threshold }) => score.score < threshold)
    .sort(
      (a, b) => a.score.score - a.threshold - (b.score.score - b.threshold),
    );

  return {
    scores,
    passed: failing.length === 0,
    weaknesses: failing.map(({ score, threshold }) =>
      score.weakness
        ? `${score.name}: ${score.weakness}`
        : `${score.name}: scored ${score.score}/${threshold} with no stated weakness`,
    ),
    raw,
  };
}
