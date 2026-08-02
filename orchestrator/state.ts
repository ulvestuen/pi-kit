import type { RunEvent, RunId } from "@pi-kit/agent-types";
import { normalizePlan, type Plan } from "../planner/plan.ts";
import type { CheckResult } from "./checks.ts";

export const ORCHESTRATOR_STATE_TYPE = "orchestrator-state-v2";
export const LEGACY_PLAN_STATE_TYPE = "planner-state";
export type RunStatus = "planning" | "running" | "blocked" | "stopped" | "complete";
export type FinalChecksStatus = "not_started" | "running" | "passed" | "failed";
export interface CompactTaskOutcome { status: string; durationMs: number; attempt: number; branch?: string; fullOutputPath?: string; checkSummary?: string; reviewPassed?: boolean }
export interface OrchestratorRunStateV2 {
  schemaVersion: 2; runId: string; status: RunStatus; plan: Plan;
  activePipelines: Record<string, RunId>; taskOutcomes: Record<string, CompactTaskOutcome>;
  finalChecks: CheckResult[]; finalChecksStatus: FinalChecksStatus;
  runLog: RunEvent[]; createdAt: number; updatedAt: number;
}
export function createRunState(plan: Plan, runId = `orchestrator-${Date.now()}`, now = Date.now()): OrchestratorRunStateV2 {
  return { schemaVersion: 2, runId, status: "planning", plan: normalizePlan(plan), activePipelines: {}, taskOutcomes: {}, finalChecks: [], finalChecksStatus: "not_started", runLog: [], createdAt: now, updatedAt: now };
}
export function makeResumable(state: OrchestratorRunStateV2, now = Date.now()): OrchestratorRunStateV2 {
  if (state.status === "complete" || state.status === "blocked" || state.status === "stopped") return state;
  const active = new Set(Object.keys(state.activePipelines).map(x => x.toLowerCase()));
  const plan = { ...state.plan, tasks: state.plan.tasks.map(t =>
    active.has(t.id.toLowerCase()) && (t.status === "running" || t.status === "review")
      ? { ...t, status: "ready" as const, attempts: Math.max(0, t.attempts - 1) }
      : t), updatedAt: now };
  const taskOutcomes = { ...state.taskOutcomes };
  for (const id of Object.keys(state.activePipelines)) {
    const prior = taskOutcomes[id];
    taskOutcomes[id] = {
      status: "interrupted",
      durationMs: prior?.durationMs ?? 0,
      attempt: state.activePipelines[id].attempt,
      branch: prior?.branch,
      fullOutputPath: prior?.fullOutputPath,
      checkSummary: prior?.checkSummary,
      reviewPassed: prior?.reviewPassed,
    };
  }
  const interruptedFinalChecks = state.finalChecksStatus === "running";
  return {
    ...state,
    status: state.status === "planning" ? "planning" : "running",
    plan,
    activePipelines: {},
    taskOutcomes,
    finalChecks: interruptedFinalChecks ? [] : state.finalChecks,
    finalChecksStatus: interruptedFinalChecks ? "not_started" : state.finalChecksStatus,
    updatedAt: now,
  };
}
export function normalizeRunState(value: unknown): OrchestratorRunStateV2 {
  const r = value as any;
  if (!r || r.schemaVersion !== 2 || typeof r.runId !== "string" || !r.plan) throw new Error("invalid orchestrator V2 state");
  const now = Date.now();
  const legacyStatus: RunStatus = r.stopped ? "stopped" : r.finalChecksRun && r.finalCheckPassed ? "complete" : "running";
  const finalChecks = Array.isArray(r.finalChecks) ? r.finalChecks : [];
  const finalChecksStatus: FinalChecksStatus = ["not_started", "running", "passed", "failed"].includes(r.finalChecksStatus)
    ? r.finalChecksStatus
    : r.finalChecksRun
      ? r.finalCheckPassed ? "passed" : "failed"
      : "not_started";
  return { schemaVersion: 2, runId:r.runId, status:["planning","running","blocked","stopped","complete"].includes(r.status)?r.status:legacyStatus, plan:normalizePlan(r.plan), activePipelines:r.activePipelines??{}, taskOutcomes:r.taskOutcomes??{}, finalChecks, finalChecksStatus, runLog:Array.isArray(r.runLog)?r.runLog:[], createdAt:Number(r.createdAt)||Number(r.updatedAt)||now, updatedAt:Number(r.updatedAt)||now };
}
export function restoreRunState(entries: readonly any[], now=Date.now()): {state:OrchestratorRunStateV2|null;migrated:boolean} {
  let v2:any, legacy:any;
  for (const e of entries) if(e?.type==="custom") { if(e.customType===ORCHESTRATOR_STATE_TYPE)v2=e.data; else if(e.customType===LEGACY_PLAN_STATE_TYPE)legacy=e.data; }
  if(v2) return {state:makeResumable(normalizeRunState(v2),now),migrated:false};
  if(legacy) return {state:createRunState(normalizePlan(legacy),`orchestrator-migrated-${now}`,now),migrated:true};
  return {state:null,migrated:false};
}
