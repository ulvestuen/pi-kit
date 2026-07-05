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
  getTask,
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

function buildSystemPrompt(config: PlannerConfig): string {
  return [
    "You have the planner extension for structured, persistent plans.",
    "For multi-step goals, represent the plan as data instead of prose: call plan_create with a goal and a task DAG — each task gets an id, a full brief, dependencies, and strict acceptance criteria (see the plan-decomposition skill).",
    `Default criterion pass bar is ${config.passThreshold}/${config.scaleMax}.`,
    "Keep the plan current with plan_update as tasks start, finish, fail, or grow follow-ups. Run /plan for the live dashboard.",
  ].join("\n");
}

function renderDashboard(plan: Plan): string {
  const s = summarizePlan(plan);
  const lines = [
    `plan — ${s.done ? "COMPLETE" : "IN PROGRESS"}`,
    `  Goal:   ${plan.goal}`,
    `  Tasks:  ${s.total} (${TASK_STATUSES.map((st) => `${s.counts[st]} ${st}`)
      .filter((part) => !part.startsWith("0 "))
      .join(", ")})`,
    `  Critical path: ${s.criticalPathLength} task(s) remaining`,
  ];
  if (s.ready.length > 0) lines.push(`  Ready:  ${s.ready.join(", ")}`);
  if (s.blocked.length > 0) {
    lines.push(`  Blocked by failure: ${s.blocked.join(", ")}`);
  }
  lines.push("  Tasks:");
  for (const task of plan.tasks) {
    const deps = task.dependsOn.length > 0 ? ` <- [${task.dependsOn.join(", ")}]` : "";
    const attempts = task.attempts > 0 ? ` (attempt ${task.attempts})` : "";
    lines.push(
      `    [${task.status.padEnd(7)}] ${task.id}: ${task.title}${deps}${attempts}`,
    );
  }
  return lines.join("\n");
}

const CRITERION_SCHEMA = Type.Object({
  name: Type.String({ description: "Short, unique name of the criterion." }),
  threshold: Type.Optional(
    Type.Number({
      description:
        "Minimum passing score for this criterion. Defaults to the configured pass bar.",
    }),
  ),
});

const TASK_INPUT_SCHEMA = Type.Object({
  id: Type.String({ description: "Unique task id, e.g. 't1'." }),
  title: Type.String({ description: "Short task title." }),
  description: Type.String({
    description:
      "Full self-contained brief handed to the sub-agent: what to do, relevant paths, constraints.",
  }),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), {
      description: "Ids of tasks that must be done first.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description: 'Fleet agent name; defaults to "implementer".',
    }),
  ),
  criteria: Type.Array(CRITERION_SCHEMA, {
    description: "Strict, measurable acceptance criteria for this task.",
    minItems: 1,
  }),
});

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
      passThreshold: 8,
      scaleMax: 10,
      defaultAgent: "implementer",
      injectSystemPrompt: true,
      showStatus: true,
    };
  }

  let plan: Plan | null = null;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!config.showStatus || !ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, plan ? statusLine(plan) : undefined);
  };

  const persist = () => {
    pi.appendEntry(STATE_ENTRY_TYPE, plan ?? undefined);
  };

  const restoreState = (ctx: ExtensionContext): Plan | null => {
    let latest: Plan | null = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as Plan | undefined;
        latest = data && typeof data.goal === "string" ? data : null;
      }
    }
    return latest;
  };

  pi.registerTool(
    defineTool({
      name: "plan_create",
      label: "planner: Create Plan",
      description:
        "Create a structured plan for a goal: a validated task DAG where every task has an id, a self-contained brief, dependencies, an agent, and strict acceptance criteria. Replaces any existing plan. The plan persists with the session and is tracked with plan_update.",
      promptSnippet:
        "plan_create: turn a goal into a persistent task DAG with per-task acceptance criteria.",
      promptGuidelines: [
        "Use plan_create for multi-step goals so the plan is data, not prose; follow the plan-decomposition skill for task sizing and criteria.",
        "Give every task a self-contained description — sub-agents executing it share none of your context.",
        "Declare dependencies by id and keep independent tasks free of false ordering so they can run in parallel.",
      ],
      parameters: Type.Object({
        goal: Type.String({ description: "The overall goal of the plan." }),
        tasks: Type.Array(TASK_INPUT_SCHEMA, {
          description: "The task DAG.",
          minItems: 1,
        }),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        plan = createPlan(params.goal, params.tasks as PlanTaskInput[], {
          passThreshold: config.passThreshold,
          scaleMax: config.scaleMax,
        });
        persist();
        updateStatus(ctx);
        pi.events.emit("planner:plan_created", { plan });

        const text = `Plan created.\n\n${renderDashboard(plan)}`;
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
        "Update the active plan: change task statuses, edit task briefs/criteria/agents, or append follow-up tasks (the DAG is re-validated). Returns the refreshed dashboard.",
      promptSnippet:
        "plan_update: change task statuses, edit tasks, or append follow-up tasks to the active plan.",
      promptGuidelines: [
        "Keep the plan truthful: mark tasks running when dispatched, review when awaiting verification, done only when their criteria verifiably pass, failed when abandoned.",
        "Append follow-up tasks instead of silently widening an existing task's scope.",
      ],
      parameters: Type.Object({
        setStatus: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.String({ description: "Task id." }),
              status: Type.Union(
                TASK_STATUSES.map((s) => Type.Literal(s)),
                { description: "New status." },
              ),
            }),
            { description: "Status changes to apply." },
          ),
        ),
        edit: Type.Optional(
          Type.Array(
            Type.Object({
              id: Type.String({ description: "Task id." }),
              title: Type.Optional(Type.String()),
              description: Type.Optional(Type.String()),
              agent: Type.Optional(Type.String()),
              criteria: Type.Optional(Type.Array(CRITERION_SCHEMA)),
            }),
            { description: "Task edits to apply." },
          ),
        ),
        addTasks: Type.Optional(
          Type.Array(TASK_INPUT_SCHEMA, {
            description: "Follow-up tasks to append to the DAG.",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!plan) {
          throw new Error("No active plan. Call plan_create first.");
        }

        let next = plan;
        const options = {
          passThreshold: config.passThreshold,
          scaleMax: config.scaleMax,
        };
        for (const change of params.setStatus ?? []) {
          next = setTaskStatus(next, change.id, change.status as TaskStatus);
          pi.events.emit("planner:task_status", {
            id: getTask(next, change.id)!.id,
            status: change.status,
          });
        }
        for (const edit of params.edit ?? []) {
          next = updateTask(
            next,
            edit.id,
            {
              title: edit.title,
              description: edit.description,
              agent: edit.agent,
              criteria: edit.criteria,
            },
            options,
          );
        }
        if (params.addTasks && params.addTasks.length > 0) {
          next = addTasks(next, params.addTasks as PlanTaskInput[], options);
        }

        plan = next;
        persist();
        updateStatus(ctx);
        pi.events.emit("planner:plan_updated", { plan });

        const text = `Plan updated.\n\n${renderDashboard(plan)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: summarizePlan(plan),
        };
      },
    }),
  );

  // Loose extension-to-extension composition: the orchestrator applies
  // scheduler results by emitting the whole updated plan on the shared bus.
  pi.events.on("planner:set_plan", (data) => {
    const incoming = (data as { plan?: Plan } | undefined)?.plan;
    if (!incoming || typeof incoming.goal !== "string") return;
    plan = incoming;
    persist();
  });

  pi.on("before_agent_start", async (event) => {
    if (!config.injectSystemPrompt) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config)}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    plan = restoreState(ctx);
    // Children do not survive a restart: reset in-flight work so the next
    // scheduling pass re-dispatches it idempotently.
    if (plan) {
      let changed = false;
      for (const task of plan.tasks) {
        if (task.status === "running") {
          plan = setTaskStatus(plan, task.id, "ready");
          changed = true;
        }
      }
      if (changed) persist();
    }
    updateStatus(ctx);
  });

  pi.registerCommand("plan", {
    description:
      "Plan dashboard. Args: (none) show the DAG and progress, 'reset' clear the plan.",
    getArgumentCompletions: (prefix) => {
      const subcommands = [{ value: "reset", label: "reset — clear the plan" }];
      const matches = subcommands.filter((s) => s.value.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim().toLowerCase();
      if (raw === "reset" || raw === "clear") {
        plan = null;
        persist();
        updateStatus(ctx);
        ctx.ui.notify("Plan cleared.", "info");
        return;
      }
      if (!plan) {
        ctx.ui.notify(
          "No active plan. Ask the agent to create one with plan_create, or /orchestrate a goal.",
          "info",
        );
        return;
      }
      ctx.ui.notify(renderDashboard(plan), "info");
    },
  });
}
