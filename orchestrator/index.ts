import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import {
  createFullOutputSaver,
  cleanupHostSpawnJobs,
  createHostSpawn,
  createWorktreeRoot,
  discoverAgents,
  isTmuxAvailable,
  loadHostSpawnConfig,
} from "../fleet/host.ts";
import { DEFAULT_TMUX_SESSION } from "../fleet/tmux.ts";
import { getAgent, type AgentDefinition } from "../fleet/registry.ts";
import { runTasks, type TaskResult, type TaskSpec } from "../fleet/runner.ts";
import {
  buildCriticPrompt,
  parseCriticOutput,
  type ReviewRequest,
  type ReviewResult,
} from "../critic/review.ts";
import { DEFAULT_SCALE_MAX } from "../pdca/loop.ts";
import {
  coverageByCriterion,
  getTask,
  setTaskStatus,
  summarizePlan,
  type Plan,
  type PlanTask,
} from "../planner/plan.ts";
import type { RunId, RunEvent, ArtifactRef } from "@pi-kit/agent-types";
import {
  buildHandoffSection,
  findParentBranch,
  recordPassingArtifacts,
} from "./handoff.ts";
import {
  applyReview,
  applyTaskResult,
  nextActions,
  setPlanTaskRunning,
  type SchedulerPolicy,
} from "./scheduler.ts";
import {
  DEFAULT_EVIDENCE_AGENT,
  getConfigPath,
  loadConfig,
  type OrchestratorConfig,
} from "./config.ts";

const STATE_ENTRY_TYPE = "orchestrator-state";
const PLAN_ENTRY_TYPE = "planner-state";

/** Tools other extensions must provide for /orchestrate to run. */
const REQUIRED_TOOLS = [
  "pdca_start",
  "pdca_checkpoint",
  "plan_create",
  "plan_update",
];

interface OrchestratorState {
  stopped: boolean;
  wave: number;
}

interface RunPromptOptions {
  /** critic_advise is registered, so the plan review gate can run. */
  planReviewGate: boolean;
  /** The configured integration-gate command, if any. */
  integrationCheck?: string;
}

function buildRunPrompt(goal: string, options: RunPromptOptions): string {
  let step = 1;
  const steps = [
    "1. Open the goal loop: derive strict goal-level success criteria (use the `success-criteria` skill; typically \"all plan tasks done\", \"end-to-end verification passes\", plus goal-specific bars) and call `pdca_start` with the goal and those criteria. Do NOT run the returned automated prompt's single-agent loop — the orchestration below is the loop body.",
    `${++step}. Plan: decompose the goal into a task DAG with \`plan_create\`, following the \`plan-decomposition\` skill. Every task needs a self-contained brief, an agent, dependencies, strict acceptance criteria, and a \`covers\` list naming the exact goal-level criteria it helps satisfy — every goal criterion that tasks can advance should be covered by at least one task.`,
  ];
  if (options.planReviewGate) {
    steps.push(
      `${++step}. Plan review gate: before dispatching anything, call \`critic_advise\` with the plan as the subject (goal, the task DAG with dependencies and file scopes, per-task criteria) and the goal-level criteria as context. Act on the prioritized concerns — revise the plan with \`plan_update\` until no remaining concern would change the decomposition. Only then dispatch.`,
    );
  }
  steps.push(
    `${++step}. Dispatch: call \`orchestrate_step\`. It dispatches the ready wave to fleet sub-agents, gathers independent verification evidence, has an independent critic review each completed task against its own criteria, applies retries with critic feedback, and returns the wave report.`,
    `${++step}. Checkpoint: after each wave, follow the AUTOMATED NEXT STEP in the \`orchestrate_step\` result — ` +
      (options.integrationCheck
        ? `merge the wave's passed branches, run the integration gate with \`orchestrate_verify\`, then call \`pdca_checkpoint\` scoring the goal-level criteria honestly from the critic verdicts and the integration-gate verdict. `
        : `call \`pdca_checkpoint\` scoring the goal-level criteria honestly from the critic-derived evidence in the wave report. `) +
      "On ITERATING, call `orchestrate_step` again (repairing the plan first with `plan_update` if the report says so). On FINAL, finish and summarize. On STOPPED, report honestly what still fails.",
  );
  return [
    "Run a **multi-agent orchestration** on the following goal, following the `orchestration` skill.",
    "",
    "GOAL:",
    goal,
    "",
    "Proceed exactly like this, without waiting for user input between steps:",
    "",
    ...steps,
    "",
    "Do not implement plan tasks yourself — the sub-agents do the work. Do not inflate checkpoint scores to end the run.",
  ].join("\n");
}



function buildTaskBrief(
  plan: Plan,
  task: PlanTask,
  scaleMax: number,
  parentBranch?: string,
): string {
  const criteria = task.criteria
    .map((c) => `- ${c.name} (threshold ${c.threshold}/${scaleMax})`)
    .join("\n");
  const handoff = buildHandoffSection(plan, task, parentBranch);
  return [
    "You are executing one task of a larger orchestrated plan.",
    "",
    "OVERALL GOAL (context only — do not work beyond your task):",
    plan.goal,
    "",
    `YOUR TASK (${task.id}): ${task.title}`,
    task.description,
    ...handoff ? [handoff] : [],
    "",
    "ACCEPTANCE CRITERIA — an independent critic will score each one afterwards:",
    criteria,
    "",
    "Work only within this task's scope. End with a terse report: what changed (files touched), how a reviewer can verify each criterion, and any assumptions made.",
  ].join("\n");
}

function requireSuccessfulCommand(
  label: string,
  outcome: { exitCode: number | null; stdout: string; stderr: string },
): void {
  if (outcome.exitCode === 0) return;
  const detail = outcome.stderr.trim() || outcome.stdout.trim() || "no diagnostic output";
  throw new Error(`${label} failed (exit ${outcome.exitCode ?? "signal"}): ${detail}`);
}

/** Outcome of the pre-review evidence run attached to a review subject. */
interface VerificationEvidence {
  agent: string;
  status: TaskResult["status"];
  output: string;
}

function buildEvidenceBrief(task: PlanTask, result?: TaskResult): string {
  const criteria = task.criteria.map((c) => `- ${c.name}`).join("\n");
  return [
    "You are gathering independent verification evidence for a completed task, before an independent critic scores it. Do not score anything yourself.",
    "",
    `TASK (${task.id}): ${task.title}`,
    task.description,
    "",
    "ACCEPTANCE CRITERIA the critic will score:",
    criteria,
    ...(result?.output.trim()
      ? ["", "IMPLEMENTER'S REPORT (claims to re-check):", result.output.trim()]
      : ["", "No implementer report is available; derive the checks from the criteria alone."]),
    "",
    "Re-run the verification the criteria imply and the report claims — test suites, type checks, builds, lints — using only non-mutating commands in the current working tree. For each check paste the exact command, its exit status, and the relevant output tail. If a claimed verification cannot be re-run, paste the exact error and say so.",
    "",
    "End with exactly one line: EVIDENCE VERDICT: all checks passed | failures observed | could not verify.",
  ].join("\n");
}

function buildReviewSubject(
  task: PlanTask,
  result?: TaskResult,
  evidence?: VerificationEvidence,
): string {
  const lines = [`Task ${task.id}: ${task.title}`];
  if (result?.output.trim()) {
    lines.push("", "Implementer's report:", result.output.trim());
  } else {
    lines.push("", "No implementer report is available; verify from the tree alone.");
  }
  if (evidence) {
    if (evidence.status === "ok" && evidence.output.trim()) {
      lines.push(
        "",
        `INDEPENDENT VERIFICATION EVIDENCE (agent "${evidence.agent}" re-ran the checks; weigh this over the implementer's claims):`,
        evidence.output.trim(),
      );
    } else {
      lines.push(
        "",
        `Independent verification evidence is unavailable (agent "${evidence.agent}" run ${evidence.status}); verify claims yourself from the tree.`,
      );
    }
  }
  if (result?.branch) {
    lines.push(
      "",
      `The work lives on branch ${result.branch}; you are running inside its worktree.`,
    );
  } else {
    lines.push("", "The work is in the current working tree.");
  }
  if (result?.outputArtifacts && result.outputArtifacts.length > 0) {
    lines.push("", "Implementer's output artifacts:");
    for (const art of result.outputArtifacts)
      lines.push(`  - ${art.type}: ${art.description}${art.location ? ` at ${art.location}` : ""}`);
  }
  if (task.artifacts.length > 0) {
    lines.push("", "Recorded task artifacts:");
    for (const art of task.artifacts)
      lines.push(`  - ${art.type}: ${art.description}${art.location ? ` at ${art.location}` : ""}`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let config: OrchestratorConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[orchestrator] ${e.message}`);
    console.error(
      `[orchestrator] Using defaults. Fix ${getConfigPath()} or the ORCHESTRATOR_* env vars, then /reload.`,
    );
    config = {
      maxConcurrent: 4,
      maxAttempts: 2,
      isolation: "none",
      taskTimeoutMs: 10 * 60 * 1000,
      reviewTimeoutMs: 5 * 60 * 1000,
      integrationTimeoutMs: 5 * 60 * 1000,
      evidenceAgent: DEFAULT_EVIDENCE_AGENT,
      outputCapBytes: 50 * 1024,
      defaultAgent: "implementer",
      piBinary: "pi",
      tmux: true,
      tmuxSession: DEFAULT_TMUX_SESSION,
      tmuxCloseWindows: false,
    };
  }

  const spawnConfig = loadHostSpawnConfig(config, "pi-orchestrator");
  const spawnTmuxLive = spawnConfig.backend === "tmux" && isTmuxAvailable();
  const spawn = createHostSpawn(config, "pi-orchestrator", spawnConfig);

  const policy: SchedulerPolicy = {
    maxConcurrent: config.maxConcurrent,
    maxAttempts: config.maxAttempts,
  };

  let state: OrchestratorState = { stopped: false, wave: 0 };

  const persistState = () => {
    pi.appendEntry(STATE_ENTRY_TYPE, state);
  };

  /** Latest plan from the session entry log (planner's persisted state). */
  const readPlan = (ctx: ExtensionContext): Plan | null => {
    let latest: Plan | null = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === PLAN_ENTRY_TYPE) {
        const data = entry.data as Plan | undefined;
        latest = data && typeof data.goal === "string" ? data : null;
      }
    }
    return latest;
  };

  /** Hand the updated plan back to the planner extension via the shared bus. */
  const publishPlan = (plan: Plan) => {
    pi.events.emit("planner:set_plan", { plan });
  };

  const missingDependencies = (): string[] => {
    const names = new Set(pi.getAllTools().map((t) => t.name));
    return REQUIRED_TOOLS.filter((t) => !names.has(t));
  };

  pi.registerTool(
    defineTool({
      name: "orchestrate_step",
      label: "orchestrator: Run Dispatch Wave",
      description:
        "Run one wave of the orchestration: dispatch the plan's ready tasks to fleet sub-agents in parallel, have an independent critic review each completed task against its own acceptance criteria, apply retries with critic feedback, and report the wave outcome. Requires an active plan (plan_create). Follow the AUTOMATED NEXT STEP in the result.",
      promptSnippet:
        "orchestrate_step: dispatch the ready plan tasks to sub-agents, review results with the critic, and report the wave.",
      promptGuidelines: [
        "During an orchestration run, call orchestrate_step for each wave and follow the AUTOMATED NEXT STEP in its result; do not implement plan tasks yourself.",
      ],
      parameters: Type.Object({}),
      async execute(_id, _params, signal, onUpdate, ctx) {
        if (state.stopped) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Orchestration stopped by user (/orchestrate stop). Do not dispatch further waves. Report the current plan state honestly and finish.",
              },
            ],
            details: { stopped: true },
          };
        }

        let plan = readPlan(ctx);
        if (!plan) {
          throw new Error(
            "No active plan. Create one with plan_create before calling orchestrate_step.",
          );
        }

        const { registry, errors: registryErrors } = discoverAgents(ctx.cwd);
        const decision = nextActions(plan, policy);
        const summaryBefore = summarizePlan(plan);

        if (decision.terminal === "complete") {
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `All ${summaryBefore.total} plan tasks are done.`,
                  "",
                  "AUTOMATED NEXT STEP:",
                  "1. Merge any unmerged task branches serially in DAG order (resolve trivial conflicts yourself; dispatch a fleet task for messy ones).",
                  config.integrationCheck
                    ? `2. Run the goal-level end-to-end verification: call orchestrate_verify (configured integration check: ${config.integrationCheck}).`
                    : "2. Run the goal-level end-to-end verification.",
                  "3. Call pdca_checkpoint scoring every goal-level criterion honestly from that evidence.",
                ].join("\n"),
              },
            ],
            details: { terminal: "complete", summary: summaryBefore },
          };
        }

        if (decision.terminal === "blocked") {
          const failed = plan.tasks
            .filter((t) => t.status === "failed")
            .map((t) => t.id);
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `The plan is BLOCKED: failed task(s) [${failed.join(", ")}] hold back [${summaryBefore.blocked.join(", ") || "none"}], and nothing is dispatchable.`,
                  "",
                  "AUTOMATED NEXT STEP:",
                  "1. Call pdca_checkpoint scoring the goal-level criteria honestly (they cannot all pass while the DAG is blocked).",
                  "2. On ITERATING: repair the plan with plan_update — append follow-up tasks that address the recorded weaknesses of the failed tasks (their briefs carry the critic feedback), or mark abandoned work failed and reduce scope explicitly.",
                  "3. Then call orchestrate_step again. On STOPPED: report honestly which criteria still fail and why; nothing is silently discarded.",
                ].join("\n"),
              },
            ],
            details: { terminal: "blocked", failed, summary: summaryBefore },
          };
        }

        // --- Dispatch the wave -------------------------------------------
        state = { ...state, wave: state.wave + 1 };
        persistState();
        const wave = state.wave;
        const runLog: RunEvent[] = [];
        const appendRunEvent = (
          type: RunEvent["type"],
          runId: RunId,
          payload: unknown,
        ) => {
          runLog.push({ timestamp: Date.now(), type, runId, payload });
        };
        appendRunEvent(
          "wave_start",
          { runId: `wave-${wave}`, taskId: "", attempt: 0, wave },
          { dispatch: decision.dispatch.map((task) => task.id) },
        );
        pi.events.emit("orchestrator:wave_start", {
          wave,
          dispatch: decision.dispatch.map((t) => t.id),
        });

        const dispatched = decision.dispatch;
        for (const task of dispatched) {
          plan = setPlanTaskRunning(plan, task.id);
        }
        publishPlan(plan);

        const progress = (text: string) =>
          onUpdate?.({
            content: [{ type: "text", text: `wave ${wave}: ${text}` }],
            details: { wave },
          });

        const scaleMax = DEFAULT_SCALE_MAX;
        const resultsById = new Map<string, TaskResult>();
        const artifactWarnings: string[] = [];
        const runnerBase = {
          spawn,
          cwd: ctx.cwd,
          piBinary: config.piBinary,
          maxConcurrent: config.maxConcurrent,
          outputCapBytes: config.outputCapBytes,
          signal,
          saveFullOutput: createFullOutputSaver("pi-orchestrator"),
        };

        if (dispatched.length > 0) {
          progress(
            `dispatching ${dispatched.length} task(s): ${dispatched.map((t) => t.id).join(", ")}`,
          );
          const specs: TaskSpec[] = dispatched.map((task) => {
            const parentBranch = config.isolation === "worktree"
              ? findParentBranch(plan!, task)
              : undefined;
            return {
              agent: task.agent ?? config.defaultAgent,
              task: buildTaskBrief(plan!, task, scaleMax, parentBranch),
              isolation: config.isolation,
              timeoutMs: config.taskTimeoutMs,
              parentBranch,
              runId: {
                runId: `${task.id}-w${wave}-a${task.attempts + 1}`,
                taskId: task.id,
                attempt: task.attempts + 1,
                wave,
              },
            };
          });
          const results = await runTasks(registry, specs, {
            ...runnerBase,
            maxBatch: Math.max(specs.length, 1),
            worktreeRoot:
              config.isolation === "worktree"
                ? createWorktreeRoot("pi-orchestrator")
                : undefined,
            onEvent: (event) => {
              pi.events.emit(`fleet:${event.type}`, event);
              const spec = specs[event.index];
              const task = dispatched[event.index];
              if (event.type === "task_start") {
                appendRunEvent("task_start", spec.runId!, {
                  taskId: task.id,
                  agent: event.agent,
                });
              } else if (event.type === "task_end") {
                appendRunEvent("task_end", event.result.runId ?? spec.runId!, {
                  taskId: task.id,
                  status: event.result.status,
                  durationMs: event.result.durationMs,
                });
              }
            },
          });
          results.forEach((result, i) => {
            const task = dispatched[i];
            resultsById.set(task.id, result);
            plan = applyTaskResult(plan!, task.id, result, policy);
          });
          publishPlan(plan);
        }

        // --- Review everything now awaiting the critic --------------------
        const reviewTargets = plan.tasks.filter((t) => t.status === "review");
        const reviewsById = new Map<string, ReviewResult>();
        const evidenceById = new Map<string, VerificationEvidence>();
        const evidenceNotes: string[] = [];
        if (reviewTargets.length > 0 && !signal?.aborted) {
          // Independent verification evidence: an execution-capable agent
          // re-runs the checks the criteria imply, so the critic scores from
          // observed command output instead of the implementer's claims.
          const evidenceAgentDef = config.evidenceAgent
            ? getAgent(registry, config.evidenceAgent)
            : undefined;
          if (config.evidenceAgent && !evidenceAgentDef) {
            evidenceNotes.push(
              `Evidence agent "${config.evidenceAgent}" was not found in the registry; reviews ran without independently executed verification evidence.`,
            );
          }
          if (evidenceAgentDef) {
            progress(
              `gathering verification evidence for ${reviewTargets.length} task(s) via ${evidenceAgentDef.name}`,
            );
            const evidenceRegistry = new Map([
              [evidenceAgentDef.name.toLowerCase(), evidenceAgentDef],
            ]);
            const evidenceSpecs: TaskSpec[] = reviewTargets.map((task) => ({
              agent: evidenceAgentDef.name,
              task: buildEvidenceBrief(task, resultsById.get(task.id)),
              cwd: resultsById.get(task.id)?.worktreePath,
              timeoutMs: config.reviewTimeoutMs,
              runId: {
                runId: `evidence-${task.id}-w${wave}-a${task.attempts}`,
                taskId: task.id,
                attempt: task.attempts,
                wave,
              },
            }));
            const evidenceOutcomes = await runTasks(
              evidenceRegistry,
              evidenceSpecs,
              {
                ...runnerBase,
                maxBatch: Math.max(evidenceSpecs.length, 1),
                onEvent: (event) => pi.events.emit(`fleet:${event.type}`, event),
              },
            );
            evidenceOutcomes.forEach((outcome, i) => {
              evidenceById.set(reviewTargets[i].id, {
                agent: evidenceAgentDef.name,
                status: outcome.status,
                output: outcome.output,
              });
            });
          }

          progress(
            `reviewing ${reviewTargets.length} task(s): ${reviewTargets.map((t) => t.id).join(", ")}`,
          );
          const criticBase = getAgent(registry, "critic");
          if (!criticBase) {
            throw new Error(
              'No "critic" agent definition found; is the fleet package installed?',
            );
          }
          const critic: AgentDefinition = config.criticModel
            ? { ...criticBase, model: config.criticModel }
            : criticBase;
          const criticRegistry = new Map([[critic.name.toLowerCase(), critic]]);

          const requests = new Map<string, ReviewRequest>();
          const reviewSpec = (task: PlanTask, attempt: number): TaskSpec => {
            const result = resultsById.get(task.id);
            // Collect prerequisite artifacts for evidence context
            const depArtifacts: ArtifactRef[] = [];
            for (const depId of task.dependsOn) {
              const dep = getTask(plan!, depId);
              if (dep && dep.status === "done" && dep.artifacts.length > 0) {
                depArtifacts.push(...dep.artifacts);
              }
            }
            const request: ReviewRequest = {
              subject: buildReviewSubject(task, result, evidenceById.get(task.id)),
              context: `Goal: ${plan!.goal}\n\nTask brief:\n${task.description}`,
              criteria: task.criteria,
              scaleMax,
              artifacts: depArtifacts.length > 0 ? depArtifacts : undefined,
            };
            requests.set(task.id, request);
            return {
              agent: critic.name,
              task: buildCriticPrompt(request),
              cwd: result?.worktreePath,
              timeoutMs: config.reviewTimeoutMs,
              runId: {
                runId: `review-${task.id}-w${wave}-a${attempt}`,
                taskId: task.id,
                attempt,
                wave,
              },
            };
          };

          const parseReviewOutcome = (
            task: PlanTask,
            outcome: TaskResult,
          ): ReviewResult => {
            const request = requests.get(task.id)!;
            return outcome.status === "ok"
              ? parseCriticOutput(outcome.output, request)
              : {
                  scores: [],
                  passed: false,
                  weaknesses: [
                    `unscorable output: critic run ${outcome.status}`,
                  ],
                  raw: outcome.output,
                };
          };

          let reviewAttempt = 0;
          const runReviews = async (
            targets: PlanTask[],
          ): Promise<Map<string, ReviewResult>> => {
            const attempt = ++reviewAttempt;
            const specs = targets.map((task) => reviewSpec(task, attempt));
            const outcomes = await runTasks(criticRegistry, specs, {
              ...runnerBase,
              maxBatch: Math.max(specs.length, 1),
              onEvent: (event) => {
                pi.events.emit(`fleet:${event.type}`, event);
                const task = targets[event.index];
                const runId = event.type === "task_end"
                  ? event.result.runId ?? specs[event.index].runId!
                  : specs[event.index].runId!;
                if (event.type === "task_start") {
                  appendRunEvent("review_start", runId, {
                    taskId: task.id,
                    reviewer: event.agent,
                  });
                } else if (event.type === "task_end") {
                  const review = parseReviewOutcome(task, event.result);
                  appendRunEvent("review_end", runId, {
                    taskId: task.id,
                    status: event.result.status,
                    durationMs: event.result.durationMs,
                    passed: review.passed,
                    scoreCount: review.scores.length,
                  });
                }
              },
            });
            const parsed = new Map<string, ReviewResult>();
            outcomes.forEach((outcome, i) => {
              const task = targets[i];
              parsed.set(task.id, parseReviewOutcome(task, outcome));
            });
            return parsed;
          };

          const firstPass = await runReviews(reviewTargets);
          // One automatic critic re-run for unscorable reviews before the
          // failed attempt counts.
          const unscorable = reviewTargets.filter(
            (t) => firstPass.get(t.id)!.scores.length === 0,
          );
          const secondPass =
            unscorable.length > 0 && !signal?.aborted
              ? await runReviews(unscorable)
              : new Map<string, ReviewResult>();
          for (const task of reviewTargets) {
            const retry = secondPass.get(task.id);
            const review =
              retry && retry.scores.length > 0 ? retry : firstPass.get(task.id)!;
            reviewsById.set(task.id, review);
            plan = applyReview(plan!, task.id, review, policy);
            // Record artifacts and commit worktree when the review passes
            if (review.passed) {
              const result = resultsById.get(task.id);
              const worktreeCommit = config.isolation === "worktree" && result?.worktreePath
                ? async (_branch: string) => {
                    // Use a default signal if none provided (should not happen in practice).
                    const commitSignal = signal ?? new AbortController().signal;
                    const addOutcome = await spawn({
                      command: "git",
                      args: ["add", "-A"],
                      cwd: result.worktreePath!,
                      signal: commitSignal,
                    });
                    requireSuccessfulCommand("git add", addOutcome);
                    const commitOutcome = await spawn({
                      command: "git",
                      args: ["commit", "-m", `[orchestrator] auto-commit task ${getTask(plan!, task.id)!.id} after passing review`],
                      cwd: result.worktreePath!,
                      signal: commitSignal,
                    });
                    requireSuccessfulCommand("git commit", commitOutcome);
                  }
                : undefined;
              plan = await recordPassingArtifacts(
                plan!,
                getTask(plan!, task.id)!,
                result,
                worktreeCommit,
                (warning) => artifactWarnings.push(`[${task.id}] ${warning}`),
              );
            }
          }
          publishPlan(plan);
        }

        appendRunEvent(
          "wave_end",
          { runId: `wave-${wave}-end`, taskId: "", attempt: 0, wave },
          {},
        );
        pi.events.emit("orchestrator:wave_end", { wave });

        // --- Report the wave ----------------------------------------------
        const summary = summarizePlan(plan);
        const lines = [`orchestrate wave ${wave} finished.`];
        if (registryErrors.length > 0) {
          lines.push(`Agent definition warnings:\n${registryErrors.join("\n")}`);
        }

        if (dispatched.length > 0) {
          lines.push("", "Dispatched:");
          for (const task of dispatched) {
            const r = resultsById.get(task.id)!;
            const branch = r.branch ? `, branch ${r.branch}` : "";
            lines.push(
              `  [${task.id}] ${r.agent}: ${r.status} in ${Math.round(r.durationMs / 1000)}s${branch}`,
            );
            if (r.status !== "ok") {
              const now = plan.tasks.find((t) => t.id === task.id)!;
              lines.push(
                `      -> ${now.status === "failed" ? "attempt limit reached, task FAILED" : "re-queued for retry"}`,
              );
            }
          }
        } else {
          lines.push("", "Nothing to dispatch this wave (waiting on reviews or running tasks).");
        }

        if (reviewsById.size > 0) {
          lines.push("", "Critic reviews:");
          for (const [id, review] of reviewsById) {
            const scoreText = review.scores
              .map((s) => `${s.name} ${s.score}/${scaleMax}`)
              .join(", ");
            lines.push(
              `  [${id}] ${review.passed ? "PASSED" : "FAILED"}${scoreText ? ` (${scoreText})` : ""}`,
            );
            for (const weakness of review.weaknesses) {
              lines.push(`      - ${weakness}`);
            }
            if (!review.passed) {
              const now = plan.tasks.find(
                (t) => t.id.toLowerCase() === id.toLowerCase(),
              )!;
              lines.push(
                `      -> ${now.status === "failed" ? "attempt limit reached, task FAILED" : "re-queued with critic feedback in the brief"}`,
              );
            }
          }
        }

        if (artifactWarnings.length > 0) {
          lines.push("", "Artifact handoff warnings:");
          for (const warning of artifactWarnings) lines.push(`  - ${warning}`);
        }

        if (evidenceNotes.length > 0) {
          lines.push("", "Verification evidence notes:");
          for (const note of evidenceNotes) lines.push(`  - ${note}`);
        }

        const branches = [...new Set([...resultsById.keys(), ...reviewsById.keys()])]
          .flatMap((id) => {
            const task = plan!.tasks.find((candidate) => candidate.id === id);
            if (task?.status !== "done") return [];
            return task.artifacts
              .filter((artifact) => artifact.type === "branch")
              .map((artifact) => `${artifact.location ?? artifact.id} (${id})`);
          });
        if (branches.length > 0) {
          lines.push(
            "",
            `Branches that passed review, to merge serially in DAG order: ${branches.join(", ")}`,
          );
        }

        const coverage = coverageByCriterion(plan);
        if (coverage.length > 0) {
          lines.push("", "Goal-criterion coverage (from task `covers` tags):");
          for (const entry of coverage) {
            const failedText =
              entry.failed.length > 0 ? `; failed: ${entry.failed.join(", ")}` : "";
            lines.push(
              `  ${entry.criterion}: ${entry.done.length}/${entry.tasks.length} covering task(s) done (${entry.tasks.join(", ")})${failedText}`,
            );
          }
        }

        lines.push(
          "",
          `Plan: ${summary.counts.done}/${summary.total} done, ${summary.counts.ready + summary.counts.pending} waiting, ${summary.counts.review} in review, ${summary.counts.failed} failed.` +
            (summary.ready.length > 0 ? ` Ready next: ${summary.ready.join(", ")}.` : ""),
          "",
          "AUTOMATED NEXT STEP:",
        );
        let nextStep = 0;
        const tasksLandedThisWave =
          reviewsById.size > 0 &&
          [...reviewsById.keys()].some(
            (id) => plan!.tasks.find((t) => t.id === id)?.status === "done",
          );
        if (config.integrationCheck && tasksLandedThisWave) {
          lines.push(
            `${++nextStep}. Integration gate: ${branches.length > 0 ? "merge the listed passed branches serially in DAG order, then " : ""}call orchestrate_verify to run the configured integration check (${config.integrationCheck}). Do not skip it — tasks landed this wave, and its verdict is the integration-level CHECK evidence.`,
          );
        }
        lines.push(
          `${++nextStep}. Call pdca_checkpoint for this wave now: plan = "wave ${wave}: dispatch ${dispatched.map((t) => t.id).join(", ") || "(reviews only)"}", changes = a one-line wave summary, scores = every goal-level criterion scored honestly using the critic verdicts${config.integrationCheck && tasksLandedThisWave ? ", the integration-gate verdict," : ""} and the goal-criterion coverage above as evidence — do not inflate.`,
          `${++nextStep}. On ITERATING: call orchestrate_step again immediately` +
            (summary.counts.failed > 0
              ? " — but first repair the plan with plan_update (follow-up tasks addressing the recorded weaknesses, or explicit descoping) since tasks have failed."
              : "."),
          `${++nextStep}. On FINAL: merge any listed branches, then summarize the run. On STOPPED: report honestly which criteria still fail.`,
        );

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            wave,
            terminal: decision.terminal,
            dispatched: dispatched.map((t) => t.id),
            results: Object.fromEntries(resultsById),
            reviews: Object.fromEntries(reviewsById),
            evidence: Object.fromEntries(evidenceById),
            coverage,
            summary,
            artifactWarnings,
            runLog,
          },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "orchestrate_verify",
      label: "orchestrator: Integration Gate",
      description:
        "Run the configured integration check (orchestrator config integrationCheck, e.g. \"npm test\") in the working tree and report PASSED or FAILED with the command output. Call it after merging a wave's passed branches — and before pdca_checkpoint — so integration-level verification is observed, not assumed.",
      promptSnippet:
        "orchestrate_verify: run the configured integration check in the working tree and report PASSED/FAILED.",
      promptGuidelines: [
        "During an orchestration run with an integrationCheck configured, call orchestrate_verify after each wave's merges and use its verdict as checkpoint evidence.",
      ],
      parameters: Type.Object({}),
      async execute(_id, _params, signal, _onUpdate, ctx) {
        const command = config.integrationCheck;
        if (!command) {
          return {
            content: [
              {
                type: "text" as const,
                text: 'No integration check is configured. Set "integrationCheck" (e.g. "npm test") in the orchestrator config to enable the gate. Until then, run the goal-level verification yourself and score the checkpoint from what you actually observed.',
              },
            ],
            details: { configured: false },
          };
        }

        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(
          () => controller.abort(),
          config.integrationTimeoutMs,
        );
        const started = Date.now();
        let outcome: { exitCode: number | null; stdout: string; stderr: string };
        try {
          outcome = await spawn({
            command: "sh",
            args: ["-c", command],
            cwd: ctx.cwd,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }

        const durationMs = Date.now() - started;
        const passed = outcome.exitCode === 0;
        const timedOut =
          !passed && controller.signal.aborted && !signal?.aborted;
        const combined = [outcome.stdout.trim(), outcome.stderr.trim()]
          .filter(Boolean)
          .join("\n");
        const cap = 8 * 1024;
        const outputTail =
          combined.length > cap ? `…${combined.slice(-cap)}` : combined;
        const verdict = passed
          ? "PASSED"
          : timedOut
            ? `FAILED (timed out after ${config.integrationTimeoutMs} ms)`
            : `FAILED (exit ${outcome.exitCode ?? "signal"})`;

        const lines = [
          `Integration gate ${verdict} in ${Math.round(durationMs / 1000)}s — command: ${command}`,
          "",
          "Output tail:",
          outputTail || "(no output)",
          "",
          "AUTOMATED NEXT STEP:",
        ];
        if (passed) {
          lines.push(
            "Use this pass as the integration-level evidence when scoring the next pdca_checkpoint.",
          );
        } else {
          lines.push(
            "1. This failure is integration-level CHECK evidence: the affected goal-level criteria cannot pass at the next pdca_checkpoint while the gate fails — score them honestly.",
            "2. Repair through the plan, never silently: use plan_update to re-queue the merged task(s) whose changes broke the gate (append the failing output to their briefs) or append a dedicated fix task, then call orchestrate_step again.",
          );
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            configured: true,
            passed,
            timedOut,
            exitCode: outcome.exitCode,
            durationMs,
            command,
          },
        };
      },
    }),
  );

  pi.on("session_start", async (_event, ctx) => {
    await cleanupHostSpawnJobs(spawnConfig, "pi-orchestrator");
    let latest: OrchestratorState | null = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as OrchestratorState | undefined;
        if (data && typeof data.wave === "number") latest = data;
      }
    }
    state = latest ?? { stopped: false, wave: 0 };
  });

  pi.registerCommand("orchestrate", {
    description:
      "Multi-agent orchestration. Args: <goal> run a full orchestration, 'status' show run state, 'stop' halt after the current wave.",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        { value: "status", label: "status — show run state and dependencies" },
        { value: "stop", label: "stop — halt the run after the current wave" },
      ];
      const matches = subcommands.filter((s) =>
        s.value.startsWith(prefix.toLowerCase()),
      );
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim();
      const word = raw.toLowerCase();

      if (!raw || word === "status") {
        const missing = missingDependencies();
        const plan = readPlan(ctx);
        const lines = [
          "orchestrator — thin composition layer",
          `  Wave:        ${state.wave}${state.stopped ? " (stopped)" : ""}`,
          `  Policy:      ${config.maxConcurrent} concurrent, ${config.maxAttempts} attempt(s) per task, isolation ${config.isolation}`,
          `  Gates:       evidence agent ${config.evidenceAgent ?? "(disabled)"}, integration check ${config.integrationCheck ?? "(none configured)"}`,
          `  spawn:       backend ${spawnConfig.backend} (config: ${spawnConfig.configPath ?? "defaults / environment variables"})`,
          `  tmux:        ${spawnTmuxLive ? `sub-agent runner windows in session "${spawnConfig.tmuxSession}" (tmux attach -t ${spawnConfig.tmuxSession})` : spawnConfig.backend === "tmux" ? "spawn backend selected but tmux is not installed" : "not used by selected spawn backend"}`,
          `  Plan:        ${plan ? `${summarizePlan(plan).counts.done}/${plan.tasks.length} done — "${plan.goal}"` : "(none)"}`,
          missing.length > 0
            ? `  MISSING dependencies: ${missing.join(", ")} — install the pdca and planner packages.`
            : "  Dependencies: pdca + planner tools present.",
        ];
        if (!raw) {
          lines.push("  Usage: /orchestrate <goal> | status | stop");
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (word === "stop") {
        state = { ...state, stopped: true };
        persistState();
        ctx.ui.notify(
          "Orchestration will halt: the next orchestrate_step reports the stop instead of dispatching.",
          "info",
        );
        return;
      }

      const missing = missingDependencies();
      if (missing.length > 0) {
        ctx.ui.notify(
          `Cannot orchestrate — missing tools: ${missing.join(", ")}. Install the pdca and planner packages (pi-kit ships both), then /reload.`,
          "error",
        );
        return;
      }

      state = { stopped: false, wave: 0 };
      persistState();
      pi.sendUserMessage(
        buildRunPrompt(raw, {
          planReviewGate: pi
            .getAllTools()
            .some((t) => t.name === "critic_advise"),
          integrationCheck: config.integrationCheck,
        }),
      );
    },
  });
}
