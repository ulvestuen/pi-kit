import type { RunEvent } from "@pi-kit/agent-types";
import { summarizePlan,type Plan,type PlanSummary } from "../planner/plan.ts";
import type { CompactTaskOutcome } from "./state.ts";
export type CompactTaskSummary=CompactTaskOutcome;
export interface OrchestrateStepDetailsV2{schemaVersion:2;taskSummaries:Record<string,CompactTaskSummary>;summary:PlanSummary;artifactWarnings:string[];runLog:RunEvent[]}
const MAX=32767;
function shrinkString(s:string,n:number){const b=Buffer.from(s);return b.length<=n?s:b.subarray(0,n-3).toString("utf8").replace(/�+$/g,"")+"…"}
export function compactDetails(plan:Plan,summaries:Record<string,CompactTaskSummary>,warnings:string[],events:RunEvent[]):OrchestrateStepDetailsV2{
 const bounded=Object.fromEntries(Object.entries(summaries).slice(-8).map(([k,v])=>[k,{...v,checkSummary:v.checkSummary&&shrinkString(v.checkSummary,512),fullOutputPath:v.fullOutputPath&&shrinkString(v.fullOutputPath,512)}]));
 let result:OrchestrateStepDetailsV2={schemaVersion:2,taskSummaries:bounded,summary:summarizePlan(plan),artifactWarnings:warnings.slice(-16).map(x=>shrinkString(x,512)),runLog:events.slice(-16).map(e=>({...e,payload:shrinkString(JSON.stringify(e.payload??null),512)}))};
 while(Buffer.byteLength(JSON.stringify(result))>MAX&&result.runLog.length)result={...result,runLog:result.runLog.slice(1)};
 while(Buffer.byteLength(JSON.stringify(result))>MAX&&result.artifactWarnings.length)result={...result,artifactWarnings:result.artifactWarnings.slice(1)};
 return result;
}
