import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {createPlan,getTask,setTaskStatus} from "../planner/plan.ts";
import {createRunState,makeResumable,restoreRunState} from "./state.ts";
import {driveController} from "./controller.ts";
import {runBarrierPipelines,runTaskPipeline} from "./pipeline.ts";
import {compactDetails} from "./report.ts";
import {buildTaskBrief,buildEvidenceBrief,buildCriticSubject,capUtf8,createControllerEffects} from "./index.ts";
import {runCommandCheck} from "./checks.ts";
import type {AgentDefinition,RunId,SpawnOutcome,SpawnRequest} from "@pi-kit/agent-types";
import type {OrchestratorConfig} from "./config.ts";
const input=(id:string,dependsOn:string[]=[])=>({id,title:id,description:"d",dependsOn,criteria:["works"]});
const impl=(status:"ok"|"error"|"aborted"="ok")=>({agent:"a",status,output:"ok",truncated:false,durationMs:7,exitCode:status==="ok"?0:1});
const outcome=async(id:string,attempt:number)=>runTaskPipeline(id,attempt,{implement:async()=>impl(),checks:async()=>[],review:async()=>({scores:[],passed:true,weaknesses:[],raw:""})});
describe("controller runtime",()=>{
 it("launches one success once and final checks exactly once",async()=>{let launches=0,finals=0;const state=createRunState(createPlan("g",[input("a")]),"r",1);const effects={persist(){},pipeline:async(p:any,id:string,a:number)=>{launches++;return outcome(id,a)},finalChecks:async()=>{finals++;return[{id:"f",command:"true",passed:true,exitCode:0,timedOut:false,durationMs:1,outputTail:""}]}};let r=await driveController(state,{maxConcurrent:1,maxAttempts:1},effects,true);r=await driveController(r.state,{maxConcurrent:1,maxAttempts:1},effects,true);assert.equal(launches,1);assert.equal(finals,1);assert.equal(r.terminal,"verified")});
 it("runs four independent pipelines concurrently",async()=>{let active=0,peak=0;const plan=createPlan("g",[input("a"),input("b"),input("c"),input("d")]);const r=await driveController(createRunState(plan),{maxConcurrent:4,maxAttempts:1},{persist(){},pipeline:async(p,id,a)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;return outcome(id,a)}},false);assert.equal(peak,4);assert.equal(r.state.plan.tasks.every(t=>t.status==="done"),true)});
 it("obeys a serial DAG",async()=>{const order:string[]=[];const plan=createPlan("g",[input("A"),input("b",["a"]),input("c",["B"])]);await driveController(createRunState(plan),{maxConcurrent:4,maxAttempts:1},{persist(){},pipeline:async(p,id,a)=>{order.push(id);return outcome(id,a)}});assert.deepEqual(order,["A","b","c"])});
 it("retries once with bounded feedback",async()=>{let n=0;const r=await driveController(createRunState(createPlan("g",[input("a")])),{maxConcurrent:1,maxAttempts:2},{persist(){},pipeline:async(p,id,a)=>n++?outcome(id,a):runTaskPipeline(id,a,{implement:async()=>({...impl("error"),output:"x".repeat(10000)}),checks:async()=>[]})});assert.equal(n,2);assert.equal(Buffer.byteLength(getTask(r.state.plan,"a")!.attemptFeedback[0].summary)<=2048,true)});
 it("honors dispatch budget and pre-abort",async()=>{let n=0;const plan=createPlan("g",[input("a"),input("b")]);const b=await driveController(createRunState(plan),{maxConcurrent:1,maxAttempts:1,maxDispatches:1},{persist(){},pipeline:async(p,id,a)=>{n++;return outcome(id,a)}});assert.equal(b.terminal,"budget_exhausted");const ac=new AbortController();ac.abort();const s=await driveController(createRunState(plan),{maxConcurrent:2,maxAttempts:1,signal:ac.signal},{persist(){},pipeline:async()=>{throw Error("launched")}});assert.equal(s.terminal,"stopped");assert.equal(n,1)});
 it("starts review for a fast task before a slow implementation finishes",async()=>{const phases:string[]=[];const plan=createPlan("g",[input("fast"),input("slow")]);await driveController(createRunState(plan),{maxConcurrent:2,maxAttempts:1},{persist(){},pipeline:async(_p,id,a)=>runTaskPipeline(id,a,{implement:async()=>{phases.push(`${id}:implement:start`);await new Promise(r=>setTimeout(r,id==="slow"?30:2));phases.push(`${id}:implement:end`);return impl()},checks:async()=>[],review:async()=>{phases.push(`${id}:review`);return{scores:[],passed:true,weaknesses:[],raw:""}}})});assert.ok(phases.indexOf("fast:review")<phases.indexOf("slow:implement:end"))});
});
describe("pipeline, state and reporting",()=>{
 it("skips review after failed checks and supports review none",async()=>{let reviews=0;const p=await runTaskPipeline("a",1,{implement:async()=>impl(),checks:async()=>[{id:"x",command:"x",passed:false,exitCode:1,timedOut:false,durationMs:1,outputTail:"bad"}],review:async()=>{reviews++;return{scores:[],passed:true,weaknesses:[],raw:""}}});assert.equal(p.terminal,"retry");assert.equal(reviews,0);const n=await runTaskPipeline("a",1,{implement:async()=>impl(),checks:async()=>[]});assert.equal(n.terminal,"done")});
 it("migrates legacy, prefers V2, and recovery does not duplicate completed work",()=>{const plan=createPlan("g",[input("a")]);const v=createRunState(plan,"new",2);const e=[{type:"custom",customType:"planner-state",data:plan},{type:"custom",customType:"orchestrator-state-v2",data:{...v,status:"complete"}}];const r=restoreRunState(e,3);assert.equal(r.state!.runId,"new");assert.equal(r.state!.status,"complete");assert.equal(r.migrated,false)});
 it("re-dispatches an interrupted default-budget attempt under the same attempt number",async()=>{let plan=createPlan("g",[input("a")]);plan={...plan,tasks:plan.tasks.map(t=>({...t,status:"running" as const,attempts:1}))};const base=createRunState(plan,"resume",1);const restored=restoreRunState([{type:"custom",customType:"orchestrator-state-v2",data:{...base,status:"running",activePipelines:{a:{runId:"resume",taskId:"a",attempt:1,wave:1}}}}],2).state!;let observed=0;const result=await driveController(restored,{maxConcurrent:1,maxAttempts:1},{persist(){},pipeline:async(_p,id,attempt)=>{observed=attempt;return outcome(id,attempt)}});assert.equal(observed,1);assert.equal(getTask(result.state.plan,"a")!.attempts,1)});
 it("serializes eight oversized outcomes below 32KiB with valid JSON",()=>{const plan=createPlan("g",Array.from({length:8},(_,i)=>input(String(i))));const summaries=Object.fromEntries(plan.tasks.map(t=>[t.id,{status:"done",durationMs:1,attempt:1,checkSummary:"x".repeat(100000),fullOutputPath:"y".repeat(100000)}]));const d=compactDetails(plan,summaries,[],[]);const json=JSON.stringify(d);assert.ok(Buffer.byteLength(json)<32768);assert.deepEqual(JSON.parse(json),d)});
 it("brief and evidence obey exact caps and retain latest feedback",()=>{const plan=createPlan("g",[{...input("a"),description:"d".repeat(10000)}]);const t=getTask(plan,"a")!;t.attemptFeedback=[{attempt:1,source:"execution",status:"failed",summary:"LATEST",createdAt:1}];assert.ok(Buffer.byteLength(buildTaskBrief(plan,t))<=4096);assert.match(buildTaskBrief(plan,t),/LATEST/);assert.ok(Buffer.byteLength(buildEvidenceBrief(t,{...impl(),output:"o".repeat(10000)}))<=4096)});
 it("caps multibyte text including the truncation marker",()=>{for(const n of [3,4,8,2048,4096])assert.ok(Buffer.byteLength(capUtf8("🙂".repeat(5000),n))<=n)});
 it("surfaces commit failures as bounded retry feedback",async()=>{const p=await runTaskPipeline("a",1,{implement:async()=>impl(),checks:async()=>[],commit:async()=>{throw Error("git commit exploded")}});assert.equal(p.terminal,"retry");assert.match(p.implementation.output,/git commit exploded/)});
 it("runs command checks directly and fails closed",async()=>{const pass=await runCommandCheck({id:"pass",command:process.execPath,args:["-e","process.stdout.write('ok')"]},process.cwd());assert.equal(pass.passed,true);const fail=await runCommandCheck({id:"fail",command:process.execPath,args:["-e","process.exit(7)"]},process.cwd());assert.equal(fail.passed,false);assert.equal(fail.exitCode,7);const missing=await runCommandCheck({id:"missing",command:"definitely-not-a-real-command",args:[]},process.cwd());assert.equal(missing.passed,false);assert.match(missing.outputTail,/spawn error/);const ac=new AbortController();ac.abort();const aborted=await runCommandCheck({id:"abort",command:process.execPath,args:["-e","process.exit(0)"]},process.cwd(),ac.signal);assert.equal(aborted.passed,false);assert.equal(aborted.exitCode,null)});
});

describe("oracle remediation regressions", () => {
  function fanInPlan(unrelatedIds: string[] = []) {
    let plan = createPlan("g", [
      input("left"),
      input("right"),
      input("fan", ["left", "right"]),
      ...unrelatedIds.map(id => input(id)),
    ]);
    for (const id of ["left", "right"]) {
      plan = setTaskStatus(plan, id, "ready");
      plan = setTaskStatus(plan, id, "running");
      plan = setTaskStatus(plan, id, "review");
      plan = setTaskStatus(plan, id, "done");
      plan = {
        ...plan,
        tasks: plan.tasks.map(task => task.id === id ? {
          ...task,
          artifacts: [{ type: "branch" as const, id: `branch-${id}`, description: id }],
        } : task),
      };
    }
    return plan;
  }

  it("keeps planning runs editable and resets interrupted final checks", () => {
    const planning = makeResumable(createRunState(createPlan("g", [input("a")]), "planning", 1), 2);
    assert.equal(planning.status, "planning");

    const interrupted = {
      ...planning,
      status: "running" as const,
      finalChecksStatus: "running" as const,
      finalChecks: [{ id: "old", command: "true", passed: true, exitCode: 0, timedOut: false, durationMs: 1, outputTail: "" }],
    };
    const resumed = makeResumable(interrupted, 3);
    assert.equal(resumed.finalChecksStatus, "not_started");
    assert.deepEqual(resumed.finalChecks, []);
  });

  it("turns a thrown pipeline into a persisted failed outcome", async () => {
    const persisted: any[] = [];
    const result = await driveController(
      createRunState(createPlan("g", [input("a")])),
      { maxConcurrent: 1, maxAttempts: 1 },
      {
        persist(state) { persisted.push(state); },
        async pipeline() { throw new Error("unknown agent"); },
      },
    );
    assert.equal(getTask(result.state.plan, "a")!.status, "failed");
    assert.equal(result.state.activePipelines.a, undefined);
    assert.match(getTask(result.state.plan, "a")!.attemptFeedback[0].summary, /unknown agent/);
    assert.equal(persisted.at(-1).taskOutcomes.a.status, "retry");
  });

  it("dispatches unrelated work while a fan-in task awaits integration", async () => {
    const plan = fanInPlan(["unrelated"]);
    const launched: string[] = [];
    const result = await driveController(
      createRunState(plan),
      { maxConcurrent: 2, maxAttempts: 1 },
      {
        persist() {},
        branchesIntegrated: async (_plan, taskId) => taskId !== "fan",
        pipeline: async (_plan, id, attempt) => {
          launched.push(id);
          return outcome(id, attempt);
        },
      },
    );
    assert.deepEqual(launched, ["unrelated"]);
    assert.equal(result.terminal, "tasks_complete_needs_merge");
  });

  it("reports budget exhaustion while unrelated ready work remains", async () => {
    const result = await driveController(
      createRunState(fanInPlan(["one", "two"])),
      { maxConcurrent: 1, maxAttempts: 1, maxDispatches: 1 },
      {
        persist() {},
        branchesIntegrated: async (_plan, taskId) => taskId !== "fan",
        pipeline: async (_plan, id, attempt) => outcome(id, attempt),
      },
    );
    assert.equal(result.terminal, "budget_exhausted");
    assert.equal(getTask(result.state.plan, "two")!.status, "pending");
  });

  it("does not dispatch when abort arrives during branch readiness", async () => {
    const abort = new AbortController();
    let launches = 0;
    const result = await driveController(
      createRunState(fanInPlan()),
      { maxConcurrent: 1, maxAttempts: 1, signal: abort.signal },
      {
        persist() {},
        branchesIntegrated: async () => {
          await Promise.resolve();
          abort.abort();
          return true;
        },
        pipeline: async (_plan, id, attempt) => {
          launches++;
          return outcome(id, attempt);
        },
      },
    );
    assert.equal(result.terminal, "stopped");
    assert.equal(launches, 0);
    assert.equal(getTask(result.state.plan, "fan")!.attempts, 0);
  });

  it("adopts the latest undispatched planning revision before first dispatch", async () => {
    const initial = createRunState(createPlan("old", [input("old")]));
    const revised = {
      ...initial,
      plan: createPlan("revised", [input("new-a"), input("new-b")]),
      updatedAt: initial.updatedAt + 1,
    };
    let current = revised;
    const launched: string[] = [];
    const result = await driveController(
      initial,
      {
        maxConcurrent: 2,
        maxAttempts: 1,
        currentState: () => current,
      },
      {
        persist(state) { current = state; },
        pipeline: async (_plan, id, attempt) => {
          launched.push(id);
          return outcome(id, attempt);
        },
      },
    );
    assert.deepEqual(launched.sort(), ["new-a", "new-b"]);
    assert.equal(result.state.plan.goal, "revised");
  });

  it("records one start/end event for every executed phase", async () => {
    const result = await driveController(
      createRunState(createPlan("g", [input("a")])),
      { maxConcurrent: 1, maxAttempts: 1 },
      {
        persist() {},
        pipeline: async (_plan, id, attempt) => runTaskPipeline(id, attempt, {
          implement: async () => impl(),
          checks: async () => [],
          evidence: async () => ({ agent: "auditor", status: "ok", output: "verified" }),
          review: async () => ({ scores: [], passed: true, weaknesses: [], raw: "" }),
          commit: async () => [],
        }),
      },
    );
    for (const phase of ["check", "evidence", "review", "commit"]) {
      assert.equal(result.state.runLog.filter(event => event.type === `${phase}_start`).length, 1);
      assert.equal(result.state.runLog.filter(event => event.type === `${phase}_end`).length, 1);
    }
  });

  it("retains paired phase and task events when a phase throws", async () => {
    const result = await driveController(
      createRunState(createPlan("g", [input("a")])),
      { maxConcurrent: 1, maxAttempts: 1 },
      {
        persist() {},
        pipeline: async (_plan, id, attempt) => runTaskPipeline(id, attempt, {
          implement: async () => impl(),
          checks: async () => { throw new Error("check crashed"); },
        }),
      },
    );
    assert.equal(result.state.runLog.filter(event => event.type === "task_start").length, 1);
    assert.equal(result.state.runLog.filter(event => event.type === "check_start").length, 1);
    assert.equal(result.state.runLog.filter(event => event.type === "check_end").length, 1);
    assert.equal(result.state.runLog.filter(event => event.type === "task_end").length, 1);
    assert.match(getTask(result.state.plan, "a")!.attemptFeedback[0].summary, /check crashed/);
  });

  it("persists paired events and refunds the attempt after phase cancellation", async () => {
    const abort = new AbortController();
    const result = await driveController(
      createRunState(createPlan("g", [input("a")])),
      { maxConcurrent: 1, maxAttempts: 1, signal: abort.signal },
      {
        persist() {},
        pipeline: async (_plan, id, attempt) => runTaskPipeline(id, attempt, {
          aborted: () => abort.signal.aborted,
          implement: async () => impl(),
          checks: async () => {
            abort.abort();
            return [];
          },
        }),
      },
    );
    assert.equal(result.terminal, "stopped");
    assert.equal(getTask(result.state.plan, "a")!.attempts, 0);
    assert.deepEqual(
      result.state.runLog.map(event => event.type),
      ["task_start", "check_start", "check_end", "task_end"],
    );
  });

  it("bounds the run log without splitting retained attempt event pairs", async () => {
    const plan = createPlan(
      "g",
      Array.from({ length: 20 }, (_, index) => input(`task-${index}`)),
    );
    const result = await driveController(
      createRunState(plan),
      { maxConcurrent: 20, maxAttempts: 1 },
      {
        persist() {},
        pipeline: async (_plan, id, attempt) => runTaskPipeline(id, attempt, {
          implement: async () => impl(),
          checks: async () => [],
          evidence: async () => ({ agent: "auditor", status: "ok", output: "ok" }),
          review: async () => ({ scores: [], passed: true, weaknesses: [], raw: "" }),
          commit: async () => [],
        }),
      },
    );
    assert.ok(result.state.runLog.length <= 128);
    const retainedTasks = new Set(result.state.runLog.map(event => event.runId.taskId));
    for (const taskId of retainedTasks) {
      const types = result.state.runLog
        .filter(event => event.runId.taskId === taskId)
        .map(event => event.type);
      assert.equal(types.includes("task_start"), true);
      assert.equal(types.includes("task_end"), true);
      for (const phase of ["check", "evidence", "review", "commit"]) {
        assert.equal(types.includes(`${phase}_start` as any), true);
        assert.equal(types.includes(`${phase}_end` as any), true);
      }
    }
  });

  it("never evicts the start event of a live attempt", async () => {
    const persisted: any[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
    let completedFastTasks = 0;
    const plan = createPlan("g", [
      input("slow"),
      ...Array.from({ length: 20 }, (_, index) => input(`fast-${index}`)),
    ]);
    const result = await driveController(
      createRunState(plan),
      { maxConcurrent: 2, maxAttempts: 1 },
      {
        persist(state) {
          persisted.push(structuredClone(state));
        },
        pipeline: async (_plan, id, attempt) => runTaskPipeline(id, attempt, {
          implement: async () => {
            if (id === "slow") await slowGate;
            return impl();
          },
          checks: async () => [],
          evidence: async () => ({ agent: "auditor", status: "ok", output: "ok" }),
          review: async () => ({ scores: [], passed: true, weaknesses: [], raw: "" }),
          commit: async () => {
            if (id !== "slow" && ++completedFastTasks === 20) releaseSlow();
            return [];
          },
        }),
      },
    );

    const liveSnapshots = persisted.filter(state => state.activePipelines.slow);
    assert.ok(liveSnapshots.some(state => state.runLog.length >= 120));
    for (const snapshot of liveSnapshots) {
      const runId = snapshot.activePipelines.slow;
      assert.equal(
        snapshot.runLog.some((event: any) =>
          event.type === "task_start" && event.runId.wave === runId.wave),
        true,
      );
    }
    assert.ok(result.state.runLog.length <= 128);
    const retainedWaves = new Set(result.state.runLog.map(event => event.runId.wave));
    for (const wave of retainedWaves) {
      const types = result.state.runLog
        .filter(event => event.runId.wave === wave)
        .map(event => event.type);
      assert.equal(types.includes("task_start"), true);
      assert.equal(types.includes("task_end"), true);
    }
  });

  it("uses a new dispatch identity when an aborted attempt is refunded", async () => {
    const abort = new AbortController();
    const first = await driveController(
      createRunState(createPlan("g", [input("a")]), "redispatch", 1),
      { maxConcurrent: 1, maxAttempts: 1, signal: abort.signal },
      {
        persist() {},
        pipeline: async (_plan, id, attempt) => runTaskPipeline(id, attempt, {
          aborted: () => abort.signal.aborted,
          implement: async () => {
            abort.abort();
            return impl();
          },
          checks: async () => [],
        }),
      },
    );
    const resumed = {
      ...first.state,
      status: "running" as const,
      updatedAt: first.state.updatedAt + 1,
    };
    const second = await driveController(
      resumed,
      { maxConcurrent: 1, maxAttempts: 1 },
      {
        persist() {},
        pipeline: async (_plan, id, attempt) => outcome(id, attempt),
      },
    );
    const starts = second.state.runLog.filter(event => event.type === "task_start");
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map(event => event.runId.attempt), [1, 1]);
    assert.notEqual(starts[0].runId.wave, starts[1].runId.wave);
    for (const start of starts) {
      assert.equal(
        second.state.runLog.some(event =>
          event.type === "task_end" && event.runId.wave === start.runId.wave),
        true,
      );
    }
  });

  it("rejects missing barrier support before consuming an attempt", async () => {
    const state = createRunState(createPlan("g", [input("a")]));
    await assert.rejects(
      driveController(
        state,
        { maxConcurrent: 1, maxAttempts: 1, pipelineMode: "barrier" },
        { persist() {}, pipeline: async (_plan, id, attempt) => outcome(id, attempt) },
      ),
      /requires pipelineWave/,
    );
    assert.equal(getTask(state.plan, "a")!.attempts, 0);
    assert.deepEqual(state.runLog, []);
  });

  it("gives the critic bounded deterministic checks and artifact references", () => {
    const task = getTask(createPlan("g", [{
      ...input("a"),
      checks: [{ id: "unit", command: "npm", args: ["test"] }],
    }]), "a")!;
    const subject = buildCriticSubject(
      task,
      "a",
      {
        ...impl(),
        output: "implementation",
        branch: "fleet/a",
        worktreePath: "/tmp/a",
        fullOutputPath: "/tmp/a.log",
      },
      [{ id: "unit", command: "npm", passed: true, exitCode: 0, timedOut: false, durationMs: 10, outputTail: "64 passed" }],
      { agent: "auditor", status: "ok", output: "independent evidence" },
    );
    assert.match(subject, /command="npm" "test"/);
    assert.match(subject, /exit=0/);
    assert.match(subject, /branch: fleet\/a/);
    assert.match(subject, /transcript: \/tmp\/a\.log/);
    assert.match(subject, /independent evidence/);
    assert.ok(Buffer.byteLength(subject) <= 4096);
  });

  it("barrier mode finishes every implementation before checks and reviews", async () => {
    const order: string[] = [];
    const work = ["fast", "slow"].map(id => ({
      taskId: id,
      attempt: 1,
      phases: {
        implement: async () => {
          order.push(`${id}:implement:start`);
          await new Promise(resolve => setTimeout(resolve, id === "slow" ? 20 : 1));
          order.push(`${id}:implement:end`);
          return impl();
        },
        checks: async () => { order.push(`${id}:check`); return []; },
        review: async () => {
          order.push(`${id}:review`);
          return { scores: [], passed: true, weaknesses: [], raw: "" };
        },
      },
    }));
    const results = await runBarrierPipelines(work);
    const lastImplementation = Math.max(...order.map((entry, index) => entry.endsWith("implement:end") ? index : -1));
    const firstCheck = order.findIndex(entry => entry.endsWith(":check"));
    const lastCheck = Math.max(...order.map((entry, index) => entry.endsWith(":check") ? index : -1));
    const firstReview = order.findIndex(entry => entry.endsWith(":review"));
    assert.ok(lastImplementation < firstCheck);
    assert.ok(lastCheck < firstReview);
    assert.equal(results.every(result => result.terminal === "done"), true);
  });

});

describe("production runtime baseline instrumentation", () => {
  const config: OrchestratorConfig = {
    reviewMode: "critic",
    pipelineMode: "per-task",
    controlMode: "deterministic",
    planReview: false,
    verboseDetails: false,
    maxConcurrent: 4,
    maxAttempts: 1,
    isolation: "none",
    taskTimeoutMs: 10_000,
    reviewTimeoutMs: 10_000,
    integrationTimeoutMs: 10_000,
    evidenceAgent: "auditor",
    outputCapBytes: 256,
    defaultAgent: "implementer",
    piBinary: "pi",
  };
  const agents = new Map<string, AgentDefinition>(
    ["implementer", "auditor", "critic"].map(name => [name, {
      name,
      description: name,
      systemPrompt: `role:${name}`,
      source: `${name}.md`,
    }]),
  );

  function assistantLine(text: string): string {
    return `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text }],
      },
    })}\n`;
  }

  function taskIdFromPrompt(role: string, prompt: string): string {
    const pattern = role === "implementer"
      ? /TASK ([^:]+):/
      : role === "auditor"
        ? /verify task ([^:]+):/
        : /SUBJECT:\nTask ([^\n]+)/;
    return pattern.exec(prompt)?.[1] ?? "unknown";
  }

  interface BaselineOptions {
    mode?: "per-task" | "barrier";
    maxAttempts?: number;
    unscorableCritic?: boolean;
    failFirstImplementation?: string;
    crossedDurations?: boolean;
  }

  async function runBaseline(
    tasks: ReturnType<typeof input>[],
    options: BaselineOptions = {},
  ) {
    const mode = options.mode ?? "per-task";
    const launches = { implementer: 0, auditor: 0, critic: 0 };
    const launchOrder: string[] = [];
    const attempts = new Map<string, number>();
    const childRunIds: { agent: string; runId?: RunId }[] = [];
    let visibleBytes = 0;
    let virtualNow = 0;
    let wakeScheduler: (() => void) | undefined;
    const pending: {
      due: number;
      outcome: SpawnOutcome;
      resolve(outcome: SpawnOutcome): void;
    }[] = [];

    const runtime = {
      spawn: (request: SpawnRequest) => {
        const systemPrompt = request.args[request.args.indexOf("--system-prompt") + 1];
        const role = systemPrompt.slice("role:".length) as keyof typeof launches;
        const prompt = request.args.at(-1)!;
        const taskId = taskIdFromPrompt(role, prompt);
        launches[role]++;
        launchOrder.push(`${role}:${taskId}`);

        const duration = !options.crossedDurations
          ? 1
          : role === "implementer"
            ? taskId === "slow" ? 60 : 5
            : role === "critic"
              ? taskId === "fast" ? 60 : 5
              : 0;

        let outcome: SpawnOutcome;
        if (role === "implementer") {
          const attempt = (attempts.get(taskId) ?? 0) + 1;
          attempts.set(taskId, attempt);
          if (options.failFirstImplementation === taskId && attempt === 1) {
            outcome = {
              exitCode: 1,
              stdout: "",
              stderr: "first attempt failed",
            };
          } else {
            outcome = {
              exitCode: 0,
              stdout: assistantLine("x".repeat(1024)),
              stderr: "",
            };
          }
        } else if (role === "critic") {
          const verdict = options.unscorableCritic
            ? "not a scored verdict"
            : "```json\n{\"scores\":[{\"name\":\"works\",\"score\":10}]}\n```";
          outcome = {
            exitCode: 0,
            stdout: assistantLine(verdict),
            stderr: "",
          };
        } else {
          outcome = {
            exitCode: 0,
            stdout: assistantLine("verified"),
            stderr: "",
          };
        }

        return new Promise<SpawnOutcome>(resolve => {
          pending.push({ due: virtualNow + duration, outcome, resolve });
          wakeScheduler?.();
          wakeScheduler = undefined;
        });
      },
    };

    let state = createRunState(createPlan("baseline", tasks));
    const baseEffects = createControllerEffects({
      config,
      cwd: process.cwd(),
      runtime,
      registry: agents,
      persist(next) { state = next; },
      getState: () => state,
      saveFullOutput: (_index, spec) => {
        childRunIds.push({ agent: spec.agent, runId: spec.runId });
        return "/tmp/baseline.jsonl";
      },
      branchesIntegrated: async () => true,
    });
    const effects = {
      ...baseEffects,
      pipeline: async (...args: Parameters<typeof baseEffects.pipeline>) => {
        const result = await baseEffects.pipeline(...args);
        visibleBytes += Buffer.byteLength(result.implementation.output);
        return result;
      },
      pipelineWave: async (...args: Parameters<NonNullable<typeof baseEffects.pipelineWave>>) => {
        const results = await baseEffects.pipelineWave!(...args);
        visibleBytes += results.reduce(
          (total, result) => total + Buffer.byteLength(result.implementation.output),
          0,
        );
        return results;
      },
    };
    let result: Awaited<ReturnType<typeof driveController>> | undefined;
    let failure: unknown;
    let settled = false;
    const controller = driveController(
      state,
      {
        maxConcurrent: 4,
        maxAttempts: options.maxAttempts ?? 1,
        pipelineMode: mode,
      },
      effects,
    );
    controller.then(
      value => {
        result = value;
        settled = true;
        wakeScheduler?.();
      },
      error => {
        failure = error;
        settled = true;
        wakeScheduler?.();
      },
    );

    while (!settled) {
      if (!pending.length) {
        await new Promise<void>(resolve => {
          wakeScheduler = resolve;
          if (pending.length || settled) {
            wakeScheduler = undefined;
            resolve();
          }
        });
      }
      if (!pending.length) continue;
      const nextDue = Math.min(...pending.map(job => job.due));
      virtualNow = nextDue;
      const ready = pending.filter(job => job.due === nextDue);
      for (const job of ready) pending.splice(pending.indexOf(job), 1);
      for (const job of ready) job.resolve(job.outcome);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (failure) throw failure;
    const completed = result!;
    return {
      result: completed,
      launches,
      launchOrder,
      childRunIds,
      visibleBytes,
      makespan: virtualNow,
      phaseTimestamps: completed.state.runLog
        .filter(event => event.type.endsWith("_start"))
        .map(event => event.timestamp),
    };
  }

  it("captures all six baseline scenarios through controller, Fleet, and host seams", async () => {
    const one = await runBaseline([input("one")]);
    assert.deepEqual(one.launches, { implementer: 1, auditor: 1, critic: 1 });
    assert.equal(one.visibleBytes, 256);
    assert.equal(one.phaseTimestamps.every(Number.isFinite), true);
    assert.deepEqual(
      one.childRunIds.map(child => child.agent).sort(),
      ["auditor", "critic", "implementer"],
    );
    assert.equal(one.childRunIds.every(child => child.runId !== undefined), true);
    const controllerRunId = one.result.state.runLog.find(
      event => event.type === "task_start",
    )!.runId;
    for (const child of one.childRunIds) {
      assert.deepEqual(child.runId, controllerRunId);
    }

    const independent = await runBaseline(
      ["a", "b", "c", "d"].map(id => input(id)),
    );
    assert.deepEqual(independent.launches, {
      implementer: 4,
      auditor: 4,
      critic: 4,
    });
    assert.equal(independent.visibleBytes, 4 * 256);

    const crossedPerTask = await runBaseline(
      [input("fast"), input("slow")],
      { crossedDurations: true },
    );
    const crossedBarrier = await runBaseline(
      [input("fast"), input("slow")],
      { crossedDurations: true, mode: "barrier" },
    );
    assert.ok(crossedPerTask.makespan <= crossedBarrier.makespan * 0.6);

    const serial = await runBaseline([input("first"), input("second", ["first"])]);
    assert.deepEqual(
      serial.launchOrder.filter(entry => entry.startsWith("implementer:")),
      ["implementer:first", "implementer:second"],
    );

    const unscorable = await runBaseline(
      [input("unscorable")],
      { unscorableCritic: true },
    );
    assert.equal(unscorable.launches.critic, 1);
    assert.equal(getTask(unscorable.result.state.plan, "unscorable")!.status, "failed");

    const retried = await runBaseline(
      [input("retry")],
      { failFirstImplementation: "retry", maxAttempts: 2 },
    );
    assert.deepEqual(retried.launches, { implementer: 2, auditor: 1, critic: 1 });
    assert.equal(getTask(retried.result.state.plan, "retry")!.status, "done");
  });
});
