import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import {
  createFullOutputSaver,
  createHostSpawn,
  createWorktreeRoot,
  discoverAgents,
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
import { DEFAULT_SCALE_MAX } from "../lykkja/loop.ts";
import {
  summarizePlan,
  type Plan,
  type PlanTask,
} from "../planner/plan.ts";
import {
  applyReview,
  applyTaskResult,
  nextActions,
  setPlanTaskRunning,
  type SchedulerPolicy,
} from "./scheduler.ts";
import {
  getConfigPath,
  loadConfig,
  type OrchestratorConfig,
} from "./config.ts";

const STATE_ENTRY_TYPE = "orchestrator-state";
const PLAN_ENTRY_TYPE = "planner-state";

/** Tools other extensions must provide for /orchestrate to run. */
const REQUIRED_TOOLS = [
  "lykkja_start",
  "lykkja_checkpoint",
  "plan_create",
  "plan_update",
];

interface OrchestratorState {
  stopped: boolean;
  wave: number;
}

function buildRunPrompt(goal: string): string {
  return [
    "Run a **multi-agent orchestration** on the following goal, following the `orchestration` skill.",
    "",
    "GOAL:",
    goal,
    "",
    "Proceed exactly like this, without waiting for user input between steps:",
    "",
    "1. Open the goal loop: derive strict goal-level success criteria (use the `success-criteria` skill; typically \"all plan tasks done\", \"end-to-end verification passes\", plus goal-specific bars) and call `lykkja_start` with the goal and those criteria. Do NOT run the returned automated prompt's single-agent loop — the orchestration below is the loop body.",
    "2. Plan: decompose the goal into a task DAG with `plan_create`, following the `plan-decomposition` skill. Every task needs a self-contained brief, an agent, dependencies, and strict acceptance criteria.",
    "3. Dispatch: call `orchestrate_step`. It dispatches the ready wave to fleet sub-agents, has an independent critic review each completed task against its own criteria, applies retries with critic feedback, and returns the wave report.",
    "4. Checkpoint: after each wave, follow the AUTOMATED NEXT STEP in the `orchestrate_step` result — call `lykkja_checkpoint` scoring the goal-level criteria honestly from the critic-derived evidence in the wave report. On ITERATING, call `orchestrate_step` again (repairing the plan first with `plan_update` if the report says so). On FINAL, finish and summarize. On STOPPED, report honestly what still fails.",
    "",
    "Do not implement plan tasks yourself — the sub-agents do the work. Do not inflate checkpoint scores to end the run.",
  ].join("\n");
}

function buildTaskBrief(plan: Plan, task: PlanTask, scaleMax: number): string {
  const criteria = task.criteria
    .map((c) => `- ${c.name} (threshold ${c.threshold}/${scaleMax})`)
    .join("\n");
  return [
    "You are executing one task of a larger orchestrated plan.",
    "",
    "OVERALL GOAL (context only — do not work beyond your task):",
    plan.goal,
    "",
    `YOUR TASK (${task.id}): ${task.title}`,
    task.description,
    "",
    "ACCEPTANCE CRITERIA — an independent critic will score each one afterwards:",
    criteria,
    "",
    "Work only within this task's scope. End with a terse report: what changed (files touched), how a reviewer can verify each criterion, and any assumptions made.",
  ].join("\n");
}

function buildReviewSubject(task: PlanTask, result?: TaskResult): string {
  const lines = [`Task ${task.id}: ${task.title}`];
  if (result?.output.trim()) {
    lines.push("", "Implementer's report:", result.output.trim());
  } else {
    lines.push("", "No implementer report is available; verify from the tree alone.");
  }
  if (result?.branch) {
    lines.push(
      "",
      `The work lives on branch ${result.branch}; you are running inside its worktree.`,
    );
  } else {
    lines.push("", "The work is in the current working tree.");
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
      outputCapBytes: 50 * 1024,
      defaultAgent: "implementer",
      piBinary: "pi",
      tmux: true,
      tmuxSession: DEFAULT_TMUX_SESSION,
      tmuxCloseWindows: false,
    };
  }

  const spawn = createHostSpawn(config, "pi-orchestrator");

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
                  "2. Run the goal-level end-to-end verification.",
                  "3. Call lykkja_checkpoint scoring every goal-level criterion honestly from that evidence.",
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
                  "1. Call lykkja_checkpoint scoring the goal-level criteria honestly (they cannot all pass while the DAG is blocked).",
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
          const specs: TaskSpec[] = dispatched.map((task) => ({
            agent: task.agent ?? config.defaultAgent,
            task: buildTaskBrief(plan!, task, scaleMax),
            isolation: config.isolation,
            timeoutMs: config.taskTimeoutMs,
          }));
          const results = await runTasks(registry, specs, {
            ...runnerBase,
            maxBatch: Math.max(specs.length, 1),
            worktreeRoot:
              config.isolation === "worktree"
                ? createWorktreeRoot("pi-orchestrator")
                : undefined,
            onEvent: (e) => pi.events.emit(`fleet:${e.type}`, e),
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
        if (reviewTargets.length > 0 && !signal?.aborted) {
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
          const reviewSpec = (task: PlanTask): TaskSpec => {
            const result = resultsById.get(task.id);
            const request: ReviewRequest = {
              subject: buildReviewSubject(task, result),
              context: `Goal: ${plan!.goal}\n\nTask brief:\n${task.description}`,
              criteria: task.criteria,
              scaleMax,
            };
            requests.set(task.id, request);
            return {
              agent: critic.name,
              task: buildCriticPrompt(request),
              cwd: result?.worktreePath,
              timeoutMs: config.reviewTimeoutMs,
            };
          };

          const runReviews = async (
            targets: PlanTask[],
          ): Promise<Map<string, ReviewResult>> => {
            const specs = targets.map(reviewSpec);
            const outcomes = await runTasks(criticRegistry, specs, {
              ...runnerBase,
              maxBatch: Math.max(specs.length, 1),
            });
            const parsed = new Map<string, ReviewResult>();
            outcomes.forEach((outcome, i) => {
              const task = targets[i];
              const request = requests.get(task.id)!;
              parsed.set(
                task.id,
                outcome.status === "ok"
                  ? parseCriticOutput(outcome.output, request)
                  : {
                      scores: [],
                      passed: false,
                      weaknesses: [
                        `unscorable output: critic run ${outcome.status}`,
                      ],
                      raw: outcome.output,
                    },
              );
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
          }
          publishPlan(plan);
        }

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

        const branches = [...resultsById.entries()]
          .filter(([id, r]) => r.branch && plan!.tasks.find((t) => t.id === id)?.status === "done")
          .map(([id, r]) => `${r.branch} (${id})`);
        if (branches.length > 0) {
          lines.push(
            "",
            `Branches that passed review, to merge serially in DAG order: ${branches.join(", ")}`,
          );
        }

        lines.push(
          "",
          `Plan: ${summary.counts.done}/${summary.total} done, ${summary.counts.ready + summary.counts.pending} waiting, ${summary.counts.review} in review, ${summary.counts.failed} failed.` +
            (summary.ready.length > 0 ? ` Ready next: ${summary.ready.join(", ")}.` : ""),
          "",
          "AUTOMATED NEXT STEP:",
          `1. Call lykkja_checkpoint for this wave now: plan = "wave ${wave}: dispatch ${dispatched.map((t) => t.id).join(", ") || "(reviews only)"}", changes = a one-line wave summary, scores = every goal-level criterion scored honestly using the critic verdicts above as evidence — do not inflate.`,
          "2. On ITERATING: call orchestrate_step again immediately" +
            (summary.counts.failed > 0
              ? " — but first repair the plan with plan_update (follow-up tasks addressing the recorded weaknesses, or explicit descoping) since tasks have failed."
              : "."),
          "3. On FINAL: merge any listed branches, then summarize the run. On STOPPED: report honestly which criteria still fail.",
        );

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            wave,
            terminal: decision.terminal,
            dispatched: dispatched.map((t) => t.id),
            results: Object.fromEntries(resultsById),
            reviews: Object.fromEntries(reviewsById),
            summary,
          },
        };
      },
    }),
  );

  pi.on("session_start", async (_event, ctx) => {
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
          `  tmux:        ${config.tmux ? `live agent windows in session "${config.tmuxSession}" (tmux attach -t ${config.tmuxSession})` : "disabled"}`,
          `  Plan:        ${plan ? `${summarizePlan(plan).counts.done}/${plan.tasks.length} done — "${plan.goal}"` : "(none)"}`,
          missing.length > 0
            ? `  MISSING dependencies: ${missing.join(", ")} — install the lykkja and planner packages.`
            : "  Dependencies: lykkja + planner tools present.",
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
          `Cannot orchestrate — missing tools: ${missing.join(", ")}. Install the lykkja and planner packages (pi-kit ships both), then /reload.`,
          "error",
        );
        return;
      }

      state = { stopped: false, wave: 0 };
      persistState();
      pi.sendUserMessage(buildRunPrompt(raw));
    },
  });
}
