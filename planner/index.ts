import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { getConfigPath, loadConfig, type PlannerConfig } from "./config.ts";
import {
  addTasks,
  createPlan,
  resetRunningTasks,
  setTaskStatus,
  statusLine,
  summarizePlan,
  updateTask,
  TASK_STATUSES,
  type Plan,
  type PlanTaskInput,
  type TaskStatus,
} from "./plan.ts";

const STATE_ENTRY_TYPE = "planner-state";
const STATUS_KEY = "planner";

/**
 * The planner discipline injected into the system prompt. Kept short on
 * purpose: the detailed decomposition guidance lives in the
 * `plan-decomposition` skill, which the model can pull in on demand.
 */
function buildSystemPrompt(config: PlannerConfig): string {
  return [
    "You have the planner extension for structured, persistent plans.",
    "A plan is data — a task DAG with per-task acceptance criteria — not prose, so progress tracking is mechanical.",
    "",
    "When a goal decomposes into multiple tasks:",
    "1. Call plan_create with the goal and small, independently verifiable tasks (see the plan-decomposition skill). Give every task strict, scoreable criteria" +
      ` (default pass bar ${config.defaultThreshold}/${config.scaleMax}) and only real ordering constraints as dependencies.`,
    "2. Keep the plan live with plan_update: set tasks running when you start them, review/done/failed as they finish, and append follow-up tasks as they surface.",
    "3. /plan shows the live dashboard; the plan persists with the session.",
  ].join("\n");
}

/** Restore the most recent plan from the session entry log. */
function restoreState(ctx: ExtensionContext): Plan | null {
  let latest: Plan | null = null;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
      const data = entry.data as Plan | undefined;
      if (data && typeof data.goal === "string" && Array.isArray(data.tasks)) {
        latest = data;
      }
    }
  }
  return latest;
}

const STATUS_LABEL_WIDTH = Math.max(...TASK_STATUSES.map((s) => s.length));

function renderDashboard(plan: Plan): string {
  const s = summarizePlan(plan);
  const headline = s.complete
    ? "COMPLETE"
    : s.stalled
      ? "STALLED"
      : `${s.counts.done}/${s.total} done`;

  const lines = [
    `planner plan — ${headline}`,
    `  Goal:  ${s.goal}`,
    `  Tasks:`,
  ];
  for (const task of plan.tasks) {
    const extras = [
      task.dependsOn.length > 0 ? `deps: ${task.dependsOn.join(", ")}` : "",
      task.agent ? `agent: ${task.agent}` : "",
      task.attempts > 1 ? `attempt ${task.attempts}` : "",
    ].filter(Boolean);
    lines.push(
      `    [${task.status.padEnd(STATUS_LABEL_WIDTH)}] ${task.id} — ${task.title}` +
        (extras.length > 0 ? ` (${extras.join("; ")})` : ""),
    );
  }
  if (s.ready.length > 0) {
    lines.push(`  Ready now:     ${s.ready.join(", ")}`);
  }
  if (s.blockers.length > 0) {
    lines.push(`  Failed:        ${s.blockers.join(", ")}`);
  }
  if (s.blocked.length > 0) {
    lines.push(`  Blocked by them: ${s.blocked.join(", ")}`);
  }
  if (s.criticalPath.length > 1) {
    lines.push(`  Critical path: ${s.criticalPath.join(" -> ")}`);
  }
  return lines.join("\n");
}

const criteriaSchema = Type.Array(
  Type.Object({
    name: Type.String({ description: "Short, unique name of the criterion." }),
    threshold: Type.Optional(
      Type.Number({
        description:
          "Minimum passing score for this criterion. Defaults to the configured bar.",
      }),
    ),
  }),
  {
    description:
      "Strict, scoreable acceptance criteria for this task. Provide at least one.",
    minItems: 1,
  },
);

const taskInputSchema = Type.Object({
  id: Type.String({
    description: 'Short slug id, unique within the plan (e.g. "parser-core").',
  }),
  title: Type.String({ description: "One-line task title." }),
  description: Type.String({
    description:
      "Full brief for whoever executes the task: scope, relevant files, constraints.",
  }),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Ids of tasks that must be done first. Only real ordering constraints.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description:
        "Fleet agent to execute this task. Omit for the default implementer.",
    }),
  ),
  criteria: criteriaSchema,
});

const statusSchema = Type.Union(
  TASK_STATUSES.map((s) => Type.Literal(s)),
  {
    description: `New status: ${TASK_STATUSES.join(", ")}.`,
  },
);

export default function (pi: ExtensionAPI) {
  let config: PlannerConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[planner] ${e.message}`);
    console.error(
      `[planner] Using defaults. Fix ${getConfigPath()} or the PLANNER_* env vars, then /reload.`,
    );
    config = {
      defaultAgent: "implementer",
      defaultThreshold: 8,
      scaleMax: 10,
      injectSystemPrompt: true,
      showStatus: true,
    };
  }

  let plan: Plan | null = null;

  const planOptions = () => ({
    defaultThreshold: config.defaultThreshold,
    scaleMax: config.scaleMax,
  });

  const updateStatus = (ctx: ExtensionContext) => {
    if (!config.showStatus || !ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, plan ? statusLine(plan) : undefined);
  };

  const persist = () => {
    if (plan) pi.appendEntry(STATE_ENTRY_TYPE, plan);
  };

  pi.registerTool(
    defineTool({
      name: "plan_create",
      label: "planner: Create Plan",
      description:
        "Create a structured plan for a goal: a validated task DAG with per-task acceptance criteria. Each task gets a unique id, a full brief, optional dependencies, and strict, scoreable criteria. Use for multi-step goals where progress should be tracked as data, not prose.",
      promptSnippet:
        "plan_create: turn a goal into a persistent task DAG with per-task acceptance criteria.",
      promptGuidelines: [
        "Use plan_create when a goal decomposes into several tasks worth tracking; follow the plan-decomposition skill for how to split it.",
        "Make tasks small and independently verifiable; declare only real ordering constraints as dependsOn so independent tasks can run in parallel.",
        "Give every task strict, scoreable criteria (see the success-criteria skill) — vague bars like 'works well' cannot be reviewed.",
      ],
      parameters: Type.Object({
        goal: Type.String({ description: "The overall goal this plan achieves." }),
        tasks: Type.Array(taskInputSchema, {
          description: "The plan's tasks. Provide at least one.",
          minItems: 1,
        }),
        replace: Type.Optional(
          Type.Boolean({
            description:
              "Set true to deliberately replace an existing incomplete plan.",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (plan && !summarizePlan(plan).complete && !params.replace) {
          throw new Error(
            "An incomplete plan already exists. Use plan_update to extend it, or pass replace: true to start over.",
          );
        }

        plan = createPlan(params.goal, params.tasks as PlanTaskInput[], planOptions());
        persist();
        updateStatus(ctx);
        pi.events.emit("planner:plan_created", {
          goal: plan.goal,
          tasks: plan.tasks.map((t) => t.id),
        });

        const text =
          `Plan created (${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"}).\n\n` +
          `${renderDashboard(plan)}\n\n` +
          "Keep this plan live: call plan_update as tasks start, finish, fail, or as follow-up tasks surface.";
        return {
          content: [{ type: "text" as const, text }],
          details: summarizePlan(plan),
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "plan_update",
      label: "planner: Update Plan",
      description:
        "Update the active plan: set task statuses (pending/ready/running/review/done/failed), edit task briefs, and/or append follow-up tasks. Edits are applied first, then new tasks, then status changes; the DAG is re-validated and the pending/ready boundary re-resolved. Provide at least one of setStatus, addTasks, editTasks.",
      promptSnippet:
        "plan_update: record task status changes, edit tasks, or append follow-up tasks on the active plan.",
      promptGuidelines: [
        "Call plan_update the moment a task starts (running), finishes (review or done), or fails — a stale plan is worse than none.",
        "Marking a task done automatically promotes dependents from pending to ready.",
        "Append follow-up tasks with addTasks instead of silently widening an existing task's scope.",
      ],
      parameters: Type.Object({
        setStatus: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.String({ description: "Task id." }),
              status: statusSchema,
            }),
            {
              description: "Status changes to apply, in order.",
              minItems: 1,
            },
          ),
        ),
        addTasks: Type.Optional(
          Type.Array(taskInputSchema, {
            description: "Follow-up tasks to append to the plan.",
            minItems: 1,
          }),
        ),
        editTasks: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.String({ description: "Task id to edit." }),
              title: Type.Optional(Type.String()),
              description: Type.Optional(Type.String()),
              agent: Type.Optional(
                Type.String({
                  description: "New agent; empty string clears to the default.",
                }),
              ),
              dependsOn: Type.Optional(Type.Array(Type.String())),
              criteria: Type.Optional(criteriaSchema),
            }),
            {
              description: "Task edits to apply (brief, agent, deps, criteria).",
              minItems: 1,
            },
          ),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!plan) {
          throw new Error("No active plan. Call plan_create first.");
        }
        if (!params.setStatus && !params.addTasks && !params.editTasks) {
          throw new Error(
            "Nothing to update: provide setStatus, addTasks, and/or editTasks.",
          );
        }

        // Work on a local copy so a validation error leaves the plan untouched.
        let next = plan;
        const statusEvents: {
          id: string;
          from: TaskStatus;
          to: TaskStatus;
          attempts: number;
        }[] = [];

        for (const edit of params.editTasks ?? []) {
          const { id, ...patch } = edit;
          next = updateTask(next, id, patch, planOptions());
        }
        if (params.addTasks) {
          next = addTasks(next, params.addTasks as PlanTaskInput[], planOptions());
        }
        for (const change of params.setStatus ?? []) {
          const from = next.tasks.find((t) => t.id === change.id)?.status;
          next = setTaskStatus(next, change.id, change.status);
          const task = next.tasks.find((t) => t.id === change.id)!;
          statusEvents.push({
            id: task.id,
            from: from!,
            to: task.status,
            attempts: task.attempts,
          });
        }

        plan = next;
        persist();
        updateStatus(ctx);
        for (const event of statusEvents) {
          pi.events.emit("planner:task_status", event);
        }

        return {
          content: [
            { type: "text" as const, text: `Plan updated.\n\n${renderDashboard(plan)}` },
          ],
          details: summarizePlan(plan),
        };
      },
    }),
  );

  pi.on("before_agent_start", async (event) => {
    if (!config.injectSystemPrompt) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config)}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    plan = restoreState(ctx);
    if (plan) {
      // Sub-agent children do not survive the parent process: anything that
      // was running when the session ended is re-dispatched idempotently.
      const { plan: reconciled, reset } = resetRunningTasks(plan);
      if (reset.length > 0) {
        plan = reconciled;
        persist();
      }
    }
    updateStatus(ctx);
  });

  pi.registerCommand("plan", {
    description:
      "planner dashboard. Args: (none) show the plan DAG, ready set, and blockers; 'reset' clear the plan.",
    getArgumentCompletions: (prefix) => {
      const subcommands = [{ value: "reset", label: "reset — clear the plan" }];
      const matches = subcommands.filter((s) =>
        s.value.startsWith(prefix.toLowerCase()),
      );
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim().toLowerCase();

      if (raw === "reset" || raw === "clear") {
        plan = null;
        pi.appendEntry(STATE_ENTRY_TYPE, undefined);
        updateStatus(ctx);
        ctx.ui.notify("planner plan cleared.", "info");
        return;
      }

      if (!plan) {
        ctx.ui.notify(
          [
            "No active plan.",
            "  Ask for a plan (the agent calls plan_create), then:",
            "  /plan        show the dashboard",
            "  /plan reset  clear the plan",
          ].join("\n"),
          "info",
        );
        return;
      }
      ctx.ui.notify(renderDashboard(plan), "info");
    },
  });
}
