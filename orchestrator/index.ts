import type { ArtifactRef } from "@pi-kit/agent-types";
import { Type } from "@mariozechner/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildCriticPrompt,
  parseCriticOutput,
  type ReviewRequest,
} from "../critic/review.ts";
import {
  createFullOutputSaver,
  createWorktreeRoot,
  discoverAgents,
  nodeSpawn,
} from "../fleet/host.ts";
import { getAgent, type AgentDefinition } from "../fleet/registry.ts";
import {
  runTasks,
  type SpawnFn,
  type TaskResult,
  type TaskSpec,
} from "../fleet/runner.ts";
import { DEFAULT_SCALE_MAX } from "../pdca/loop.ts";
import {
  getTask,
  normalizePlan,
  renderAttemptFeedback,
  summarizePlan,
  type Plan,
  type PlanTask,
} from "../planner/plan.ts";
import { runChecks, type CheckResult } from "./checks.ts";
import {
  loadConfig,
  getConfigPath,
  type OrchestratorConfig,
} from "./config.ts";
import {
  driveController,
  type ControllerEffects,
  type PipelineDispatch,
} from "./controller.ts";
import { buildHandoffSection, findParentBranch } from "./handoff.ts";
import {
  runBarrierPipelines,
  runTaskPipeline,
  type PipelinePhases,
  type VerificationEvidence,
} from "./pipeline.ts";
import { compactDetails } from "./report.ts";
import {
  createRunState,
  ORCHESTRATOR_STATE_TYPE,
  restoreRunState,
  type OrchestratorRunStateV2,
} from "./state.ts";

const execFileAsync = promisify(execFile);

const TASK_BRIEF_CAP_BYTES = 4096;
const DESCRIPTION_CAP_BYTES = 2048;
const IMPLEMENTATION_CAP_BYTES = 2048;
const CRITIC_IMPLEMENTATION_CAP_BYTES = 1024;
const CRITIC_CHECKS_CAP_BYTES = 1200;
const CRITIC_REFERENCES_CAP_BYTES = 512;
const CRITIC_EVIDENCE_CAP_BYTES = 1024;
const OUTPUT_CAP_BYTES = 8192;

const TERMINAL_RUN_STATUSES = new Set(["complete", "blocked", "stopped"]);

export const REQUIRED_TOOLS = ["plan_create", "plan_update"] as const;

export function capUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;

  const marker = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let result = "";

  for (const character of value) {
    if (Buffer.byteLength(result + character) > budget) break;
    result += character;
  }

  return result + marker;
}

export function buildTaskBrief(plan: Plan, task: PlanTask): string {
  const parentBranch = findParentBranch(plan, task);
  const sections = [
    `GOAL: ${plan.goal}`,
    `TASK ${task.id}: ${task.title}`,
    capUtf8(task.description, DESCRIPTION_CAP_BYTES),
    "ATTEMPT FEEDBACK (bounded; newest first):",
    renderAttemptFeedback([...task.attemptFeedback].reverse()),
    "CRITERIA:",
    ...task.criteria.map(
      criterion =>
        `- ${criterion.name} (${criterion.threshold}/${DEFAULT_SCALE_MAX})`,
    ),
    buildHandoffSection(plan, task, parentBranch),
    "Implement only this task. Report files changed and verification.",
  ];

  return capUtf8(sections.join("\n"), TASK_BRIEF_CAP_BYTES);
}

export function buildEvidenceBrief(
  task: PlanTask,
  result: TaskResult,
): string {
  const criteria = task.criteria
    .map(criterion => `- ${criterion.name}`)
    .join("\n");
  const implementation = capUtf8(result.output, IMPLEMENTATION_CAP_BYTES);

  return capUtf8(
    [
      `Independently verify task ${task.id}: ${task.title}.`,
      "Criteria:",
      criteria,
      "Implementer summary (claims only):",
      implementation,
      "Run non-mutating checks and report commands, status, and output tails.",
    ].join("\n"),
    TASK_BRIEF_CAP_BYTES,
  );
}

function defaultConfig(): OrchestratorConfig {
  return {
    reviewMode: "critic",
    pipelineMode: "per-task",
    controlMode: "deterministic",
    planReview: false,
    verboseDetails: false,
    maxConcurrent: 4,
    maxAttempts: 1,
    isolation: "none",
    taskTimeoutMs: 600_000,
    reviewTimeoutMs: 300_000,
    integrationTimeoutMs: 300_000,
    outputCapBytes: OUTPUT_CAP_BYTES,
    defaultAgent: "implementer",
    piBinary: "pi",
  };
}

function loadOrchestratorConfig(): OrchestratorConfig {
  try {
    return loadConfig();
  } catch (error: any) {
    console.error(
      `[orchestrator] ${error.message}; using defaults; fix ${getConfigPath()}`,
    );
    return defaultConfig();
  }
}

function dependencyBranches(plan: Plan, taskId?: string): string[] {
  const tasks = taskId
    ? (getTask(plan, taskId)?.dependsOn
        .map(dependencyId => getTask(plan, dependencyId))
        .filter((task): task is PlanTask => task !== undefined) ?? [])
    : plan.tasks;

  return [
    ...new Set(
      tasks.flatMap(task =>
        task.artifacts
          .filter(artifact => artifact.type === "branch")
          .map(artifact => artifact.location ?? artifact.id),
      ),
    ),
  ];
}

function formatCheckEvidence(task: PlanTask, results: CheckResult[]): string {
  if (!results.length) return "none configured";
  return results
    .map(result => {
      const definition = task.checks.find(check => check.id === result.id);
      const command = [result.command, ...(definition?.args ?? [])]
        .map(part => JSON.stringify(part))
        .join(" ");
      return [
        `${result.id}: ${result.passed ? "passed" : "failed"}`,
        `command=${command}`,
        `exit=${result.exitCode ?? "none"}`,
        `timedOut=${result.timedOut}`,
        `output=${result.outputTail || "(empty)"}`,
      ].join("; ");
    })
    .join("\n");
}

function formatImplementationReferences(result: TaskResult): string {
  const references = [
    result.branch ? `branch: ${result.branch}` : undefined,
    result.worktreePath ? `worktree: ${result.worktreePath}` : undefined,
    result.fullOutputPath ? `transcript: ${result.fullOutputPath}` : undefined,
    ...(result.outputArtifacts ?? []).map(
      artifact =>
        `${artifact.type}: ${artifact.id}${artifact.location ? ` (${artifact.location})` : ""}`,
    ),
  ].filter((value): value is string => value !== undefined);
  return references.length ? references.join("\n") : "none";
}

export function buildCriticSubject(
  task: PlanTask,
  taskId: string,
  implementation: TaskResult,
  checks: CheckResult[],
  evidence?: VerificationEvidence,
): string {
  return capUtf8(
    [
      `Task ${taskId}`,
      "Implementer:",
      capUtf8(implementation.output, CRITIC_IMPLEMENTATION_CAP_BYTES),
      "Deterministic checks:",
      capUtf8(formatCheckEvidence(task, checks), CRITIC_CHECKS_CAP_BYTES),
      "Artifact references:",
      capUtf8(
        formatImplementationReferences(implementation),
        CRITIC_REFERENCES_CAP_BYTES,
      ),
      "Evidence:",
      capUtf8(evidence?.output ?? "none", CRITIC_EVIDENCE_CAP_BYTES),
    ].join("\n"),
    TASK_BRIEF_CAP_BYTES,
  );
}

async function branchesAreIntegrated(
  cwd: string,
  plan: Plan,
  taskId?: string,
): Promise<boolean> {
  for (const branch of dependencyBranches(plan, taskId)) {
    try {
      await execFileAsync(
        "git",
        ["merge-base", "--is-ancestor", branch, "HEAD"],
        { cwd },
      );
    } catch {
      return false;
    }
  }

  return true;
}

export interface ControllerEffectsFactoryOptions {
  config: OrchestratorConfig;
  cwd: string;
  runtime: { spawn: SpawnFn };
  registry: Map<string, AgentDefinition>;
  persist(state: OrchestratorRunStateV2): void | Promise<void>;
  getState(): OrchestratorRunStateV2;
  signal?: AbortSignal;
  saveFullOutput?: ReturnType<typeof createFullOutputSaver>;
  worktreeRoot?: string;
  branchesIntegrated?(plan: Plan, taskId?: string): Promise<boolean>;
}

/** Build the production controller/Fleet pipeline with injectable host seams. */
export function createControllerEffects(
  options: ControllerEffectsFactoryOptions,
): ControllerEffects {
  const {
    config,
    cwd,
    runtime,
    registry,
    persist,
    getState,
    signal,
  } = options;

  async function runOne(
    spec: TaskSpec,
    selectedRegistry: typeof registry = registry,
  ): Promise<TaskResult> {
    const results = await runTasks(selectedRegistry, [spec], {
      spawn: runtime.spawn,
      cwd,
      piBinary: config.piBinary,
      maxConcurrent: 1,
      signal,
      outputCapBytes: config.outputCapBytes,
      saveFullOutput: options.saveFullOutput,
      worktreeRoot: options.worktreeRoot,
    });
    return results[0];
  }

  async function collectEvidence(
    task: PlanTask,
    implementation: TaskResult,
    runId?: PipelineDispatch["runId"],
  ): Promise<VerificationEvidence> {
    const evidenceAgent = getAgent(registry, config.evidenceAgent!);
    if (!evidenceAgent) {
      return {
        agent: config.evidenceAgent!,
        status: "error",
        output: "evidence agent unavailable",
      };
    }

    const evidenceRegistry = new Map([
      [evidenceAgent.name.toLowerCase(), evidenceAgent],
    ]);
    const result = await runOne(
      {
        agent: evidenceAgent.name,
        task: buildEvidenceBrief(task, implementation),
        cwd: implementation.worktreePath,
        timeoutMs: config.reviewTimeoutMs,
        runId,
      },
      evidenceRegistry,
    );
    return {
      agent: evidenceAgent.name,
      status: result.status,
      output: result.output,
    };
  }

  async function reviewImplementation(
    task: PlanTask,
    taskId: string,
    implementation: TaskResult,
    checks: CheckResult[],
    evidence?: VerificationEvidence,
    runId?: PipelineDispatch["runId"],
  ) {
    const foundCritic = getAgent(registry, "critic");
    if (!foundCritic) {
      return {
        scores: [],
        passed: false,
        weaknesses: ["critic unavailable"],
        raw: "",
      };
    }

    const critic = config.criticModel
      ? { ...foundCritic, model: config.criticModel }
      : foundCritic;
    const request: ReviewRequest = {
      subject: buildCriticSubject(
        task,
        taskId,
        implementation,
        checks,
        evidence,
      ),
      context: capUtf8(task.description, DESCRIPTION_CAP_BYTES),
      criteria: task.criteria,
      scaleMax: DEFAULT_SCALE_MAX,
    };
    const criticRegistry = new Map([[critic.name.toLowerCase(), critic]]);
    const result = await runOne(
      {
        agent: critic.name,
        task: buildCriticPrompt(request),
        cwd: implementation.worktreePath,
        timeoutMs: config.reviewTimeoutMs,
        runId,
      },
      criticRegistry,
    );

    if (result.status === "ok") return parseCriticOutput(result.output, request);
    return {
      scores: [],
      passed: false,
      weaknesses: [`unscorable: critic ${result.status}`],
      raw: result.output,
    };
  }

  async function commitImplementation(
    taskId: string,
    implementation: TaskResult,
  ): Promise<ArtifactRef[]> {
    if (implementation.worktreePath) {
      await execFileAsync("git", ["add", "-A"], {
        cwd: implementation.worktreePath,
      });
      await execFileAsync(
        "git",
        ["commit", "--allow-empty", "-m", `orchestrator: complete ${taskId}`],
        { cwd: implementation.worktreePath },
      );
    }

    const artifacts = [...(implementation.outputArtifacts ?? [])];
    if (implementation.fullOutputPath) {
      artifacts.push({
        type: "path",
        id: `${taskId}-transcript`,
        description: "Full agent output",
        location: implementation.fullOutputPath,
      });
    }
    if (implementation.branch) {
      artifacts.push({
        type: "branch",
        id: implementation.branch,
        description: `Task ${taskId} branch`,
        location: implementation.branch,
      });
    }
    return artifacts;
  }

  function createPipelinePhases(
    plan: Plan,
    taskId: string,
    attempt: number,
    dispatchRunId?: PipelineDispatch["runId"],
  ): PipelinePhases {
    const task = getTask(plan, taskId)!;
    const taskDependencyBranches = dependencyBranches(plan, taskId);
    const parentBranch =
      taskDependencyBranches.length > 1
        ? undefined
        : findParentBranch(plan, task);
    const currentState = getState();

    return {
      aborted: () => signal?.aborted ?? false,
      implement: () =>
        runOne({
          agent: task.agent ?? config.defaultAgent,
          task: buildTaskBrief(plan, task),
          isolation: config.isolation,
          parentBranch,
          worktreeKey: `${currentState.runId}-${taskId}-a${attempt}`,
          resumeWorktree:
            currentState.taskOutcomes[taskId]?.status === "interrupted",
          runId: dispatchRunId ?? {
            runId: currentState.runId,
            taskId,
            attempt,
            wave: attempt,
          },
          timeoutMs: config.taskTimeoutMs,
        }),
      checks: implementation =>
        runChecks(
          task.checks,
          implementation.worktreePath ?? cwd,
          signal,
        ),
      evidence: config.evidenceAgent
        ? implementation =>
            collectEvidence(task, implementation, dispatchRunId)
        : undefined,
      review:
        config.reviewMode === "critic"
          ? (implementation, checks, evidence) =>
              reviewImplementation(
                task,
                taskId,
                implementation,
                checks,
                evidence,
                dispatchRunId,
              )
          : undefined,
      commit: implementation => commitImplementation(taskId, implementation),
    };
  }

  const pipeline = (
    plan: Plan,
    taskId: string,
    attempt: number,
    runId?: PipelineDispatch["runId"],
  ) =>
    runTaskPipeline(
      taskId,
      attempt,
      createPipelinePhases(plan, taskId, attempt, runId),
    );
  const pipelineWave = (plan: Plan, tasks: PipelineDispatch[]) =>
    runBarrierPipelines(
      tasks.map(task => ({
        taskId: task.id,
        attempt: task.attempt,
        phases: createPipelinePhases(
          plan,
          task.id,
          task.attempt,
          task.runId,
        ),
      })),
    );

  return {
    persist,
    pipeline,
    pipelineWave,
    branchesIntegrated: options.branchesIntegrated,
    finalChecks: async plan => {
      let checks = plan.finalChecks;
      if (!checks.length && config.integrationCheck) {
        console.warn(
          "[orchestrator] integrationCheck is deprecated; use plan finalChecks",
        );
        checks = [{
          id: "legacy-integration",
          command: "sh",
          args: ["-c", config.integrationCheck],
          timeoutMs: config.integrationTimeoutMs,
        }];
      }
      return runChecks(checks, cwd, signal);
    },
  };
}

export default function orchestrator(pi: ExtensionAPI): void {
  const config = loadOrchestratorConfig();
  const runtime = { spawn: nodeSpawn };

  let state: OrchestratorRunStateV2 | null = null;
  let inFlight: Promise<any> | null = null;
  let runAbort: AbortController | null = null;

  function persist(nextState: OrchestratorRunStateV2): void {
    state = nextState;
    pi.appendEntry(ORCHESTRATOR_STATE_TYPE, nextState);
    pi.events.emit("orchestrator:plan_projection", {
      schemaVersion: 1,
      runId: nextState.runId,
      active:
        nextState.status !== "planning" &&
        !TERMINAL_RUN_STATUSES.has(nextState.status),
      plan: nextState.plan,
    });
  }

  function ensureState(ctx: ExtensionContext): OrchestratorRunStateV2 {
    if (state) return state;

    const entries = ctx.sessionManager.getEntries();
    const restored = restoreRunState(entries);
    if (restored.state) {
      state = restored.state;
      if (restored.migrated) persist(state);
      return state;
    }

    let legacyPlan: unknown;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "planner-state") {
        legacyPlan = entry.data;
      }
    }

    if (!legacyPlan) {
      throw new Error("No active plan. Call plan_create first.");
    }

    state = createRunState(normalizePlan(legacyPlan));
    persist(state);
    return state;
  }

  function createEffects(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): ControllerEffects {
    const { registry } = discoverAgents(ctx.cwd);
    return createControllerEffects({
      config,
      cwd: ctx.cwd,
      runtime,
      registry,
      persist,
      getState: () => state!,
      signal,
      saveFullOutput: createFullOutputSaver("pi-orchestrator"),
      worktreeRoot:
        config.isolation === "worktree"
          ? createWorktreeRoot("pi-orchestrator")
          : undefined,
      branchesIntegrated: (plan, taskId) =>
        branchesAreIntegrated(ctx.cwd, plan, taskId),
    });
  }

  function execute(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    runFinalChecks: boolean,
  ): Promise<any> {
    if (inFlight) {
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: "Orchestration is already in progress; wait for the active invocation to finish or stop it first.",
          },
        ],
        details: { status: "already_running" },
      });
    }

    const ownedAbort = new AbortController();
    runAbort = ownedAbort;
    const forwardAbort = () => ownedAbort.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });

    inFlight = (async () => {
      const maxConcurrent = config.maxConcurrent;
      const result = await driveController(
        ensureState(ctx),
        {
          maxConcurrent,
          maxAttempts: config.maxAttempts,
          pipelineMode: config.pipelineMode,
          currentState: () => state,
          maxDispatches: Math.max(
            1,
            maxConcurrent * config.maxAttempts * 8,
          ),
          signal: ownedAbort.signal,
        },
        createEffects(ctx, ownedAbort.signal),
        runFinalChecks,
      );

      state = result.state;
      const details = compactDetails(
        state.plan,
        state.taskOutcomes,
        [],
        state.runLog,
      );
      const summary = summarizePlan(state.plan);
      const failedTasks = result.failedAndBlocked.length
        ? ` Failed/blocked: ${result.failedAndBlocked.join(", ")}`
        : "";
      const failedFinalChecks = state.finalChecks.filter(
        check => !check.passed,
      );
      const finalCheckFailures = failedFinalChecks.length
        ? ` Final check failures: ${failedFinalChecks.map(check => check.id).join(", ")}`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Orchestration ${result.terminal}. ` +
              `${summary.counts.done}/${state.plan.tasks.length} done.` +
              failedTasks +
              finalCheckFailures,
          },
        ],
        details: config.verboseDetails
          ? { ...details, plan: state.plan }
          : details,
      };
    })().finally(() => {
      signal?.removeEventListener("abort", forwardAbort);
      if (runAbort === ownedAbort) runAbort = null;
      inFlight = null;
    });

    return inFlight;
  }

  function registerOrchestrationTool(
    name: "orchestrate_step" | "orchestrate_run",
    runFinalChecks: boolean,
  ): void {
    pi.registerTool(
      defineTool({
        name,
        label: `orchestrator: ${runFinalChecks ? "Run to terminal" : "Step"}`,
        description: runFinalChecks
          ? "Drive the task DAG and final verification to a terminal state."
          : "Drain currently and dynamically ready task pipelines.",
        parameters: Type.Object({}),
        execute: (_id, _parameters, signal, _update, ctx) =>
          execute(ctx, signal, runFinalChecks),
      }),
    );
  }

  function acceptPlan(data: unknown): void {
    const plan = (data as { plan: Plan }).plan;
    if (!state || TERMINAL_RUN_STATUSES.has(state.status)) {
      persist(createRunState(normalizePlan(plan)));
      return;
    }

    const isUndispatchedPlanningRun =
      state.status === "planning" &&
      Object.keys(state.activePipelines).length === 0 &&
      state.plan.tasks.every(task => task.attempts === 0);
    if (isUndispatchedPlanningRun) {
      persist({
        ...state,
        plan: normalizePlan(plan),
        updatedAt: Date.now(),
      });
    }
  }

  registerOrchestrationTool("orchestrate_step", false);
  registerOrchestrationTool("orchestrate_run", true);

  pi.on("session_start", (_event, ctx) => {
    const restored = restoreRunState(ctx.sessionManager.getEntries());
    if (restored.state) {
      state = restored.state;
      persist(state);
    }
  });

  pi.events.on("planner:plan_created", acceptPlan);
  pi.events.on("planner:plan_updated", acceptPlan);

  pi.registerCommand("orchestrate", {
    description:
      "Plan and deterministically execute a multi-agent task DAG (or /orchestrate stop)",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "stop") {
        if (runAbort) {
          runAbort.abort();
          ctx.ui.notify(
            "Stopping orchestration; active work will settle.",
            "info",
          );
        } else if (state) {
          state = { ...state, status: "stopped", updatedAt: Date.now() };
          persist(state);
          ctx.ui.notify("Orchestration stopped.", "info");
        } else {
          ctx.ui.notify("No orchestration is active.", "info");
        }
        return;
      }

      const requiredTools =
        config.controlMode === "pdca"
          ? [...REQUIRED_TOOLS, "pdca_start", "pdca_checkpoint"]
          : [...REQUIRED_TOOLS];
      const availableTools = pi.getAllTools();
      const missingTools = requiredTools.filter(
        name => !availableTools.some(tool => tool.name === name),
      );

      if (missingTools.length) {
        ctx.ui.notify(`Missing tools: ${missingTools.join(", ")}`, "error");
        return;
      }

      const reviewInstruction = config.planReview
        ? " Then optionally call critic_advise once and revise the plan from its concerns."
        : "";
      const controlInstruction =
        config.controlMode === "pdca"
          ? " Start a goal-level pdca_start loop, call orchestrate_step, and score pdca_checkpoint after each step until terminal."
          : " Then call orchestrate_run. Do not use PDCA checkpoints.";

      pi.sendUserMessage(
        `Create or revise a plan for this goal using plan_create/plan_update: ${args}.` +
          reviewInstruction +
          controlInstruction,
      );
    },
  });
}
