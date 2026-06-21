import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { getConfigPath, loadConfig, type LykkjaConfig } from "./config.ts";
import {
  createLoop,
  recordCheckpoint,
  statusLine,
  summarizeLoop,
  type CriterionInput,
  type LoopState,
} from "./loop.ts";

const STATE_ENTRY_TYPE = "lykkja-state";
const STATUS_KEY = "lykkja";

/**
 * The lykkja discipline injected into the system prompt. Kept short on purpose:
 * the detailed protocol lives in the `pdca-loop` skill, which the model can
 * pull in on demand.
 */
function buildSystemPrompt(config: LykkjaConfig): string {
  return [
    "You have the lykkja loop framework for disciplined, loop-based work.",
    "lykkja runs a Plan-Do-Check-Act self-checking loop until the work meets an explicit bar.",
    "",
    "When a task benefits from iteration to a quality bar (build/fix/refactor/write to a strict spec):",
    `1. Call lykkja_start with the task and strict, measurable success criteria (default pass bar ${config.passThreshold}/${config.scaleMax}).`,
    "2. Each pass: PLAN the single next step, DO the work, then call lykkja_checkpoint with that step, what changed, and an honest 1-" +
      `${config.scaleMax} score for every criterion.`,
    "3. lykkja_checkpoint returns the DECIDE verdict. If ITERATING, fix the weakest criterion first and loop again. If FINAL, stop.",
    "",
    "Score brutally honestly — never inflate to end the loop. For the full protocol, use the pdca-loop skill.",
  ].join("\n");
}

/** Restore the most recent loop state from the session entry log. */
function restoreState(ctx: ExtensionContext): LoopState | null {
  let latest: LoopState | null = null;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
      const data = entry.data as LoopState | undefined;
      if (data && typeof data.task === "string") {
        latest = data;
      }
    }
  }
  return latest;
}

function renderDashboard(state: LoopState): string {
  const s = summarizeLoop(state);
  const lines = [
    `lykkja loop — ${s.status.toUpperCase()}`,
    `  Task:       ${s.task}`,
    `  Pass bar:   ${s.passThreshold}/${s.scaleMax}`,
    `  Passes:     ${s.iterationCount}/${s.maxIterations}`,
  ];
  if (s.latest) {
    lines.push("  Latest scores:");
    for (const score of s.latest.scores) {
      const criterion = state.criteria.find(
        (c) => c.name.toLowerCase() === score.name.toLowerCase(),
      );
      const threshold = criterion ? criterion.threshold : s.passThreshold;
      const mark = score.score >= threshold ? "ok " : "LOW";
      lines.push(
        `    [${mark}] ${score.name}: ${score.score}/${threshold}` +
          (score.weakness ? ` — ${score.weakness}` : ""),
      );
    }
    if (s.weakest) {
      lines.push(`  Fix next:   ${s.weakest}`);
    }
  } else {
    lines.push("  No passes recorded yet — PLAN the first step.");
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let config: LykkjaConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[lykkja] ${e.message}`);
    console.error(
      `[lykkja] Using defaults. Fix ${getConfigPath()} or the LYKKJA_* env vars, then /reload.`,
    );
    config = {
      passThreshold: 8,
      scaleMax: 10,
      maxIterations: 25,
      injectSystemPrompt: true,
      showStatus: true,
    };
  }

  let loop: LoopState | null = null;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!config.showStatus || !ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, loop ? statusLine(loop) : undefined);
  };

  const persist = () => {
    if (loop) pi.appendEntry(STATE_ENTRY_TYPE, loop);
  };

  pi.registerTool(
    defineTool({
      name: "lykkja_start",
      label: "lykkja: Start Loop",
      description:
        "Begin a lykkja Plan-Do-Check-Act self-checking loop. Define the task and strict, measurable success criteria. Use for work that should iterate to an explicit quality bar.",
      promptSnippet:
        "lykkja_start: open a self-checking loop with a task and strict success criteria.",
      promptGuidelines: [
        "Use lykkja_start when a task should be driven to a strict, measurable bar rather than done in one shot.",
        "Write criteria that can be scored honestly: avoid vague goals like 'good code'; prefer 'all tests pass', 'no type errors', 'handles empty input'.",
      ],
      parameters: Type.Object({
        task: Type.String({
          description: "Exactly what should be produced.",
        }),
        criteria: Type.Array(
          Type.Object({
            name: Type.String({
              description: "Short, unique name of the criterion.",
            }),
            threshold: Type.Optional(
              Type.Number({
                description:
                  "Minimum passing score for this criterion. Defaults to the loop pass bar.",
              }),
            ),
          }),
          {
            description:
              "Strict, measurable success criteria. Provide at least one.",
            minItems: 1,
          },
        ),
        passThreshold: Type.Optional(
          Type.Number({
            description:
              "Default minimum passing score (1..scale). Defaults to the configured bar.",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        loop = createLoop({
          task: params.task,
          criteria: params.criteria as CriterionInput[],
          passThreshold: params.passThreshold ?? config.passThreshold,
          scaleMax: config.scaleMax,
          maxIterations: config.maxIterations,
        });
        persist();
        updateStatus(ctx);

        const text =
          `lykkja loop started.\n\n${renderDashboard(loop)}\n\n` +
          `Now run the loop: PLAN the single next step, DO it, then call lykkja_checkpoint ` +
          `with that step, what changed, and an honest 1-${loop.scaleMax} score for every criterion.`;
        return {
          content: [{ type: "text" as const, text }],
          details: summarizeLoop(loop),
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "lykkja_checkpoint",
      label: "lykkja: Checkpoint",
      description:
        "Record one full PLAN/DO/CHECK pass of the active lykkja loop and get the DECIDE verdict. Provide the single step taken, what changed, and an honest score for every criterion. Returns FINAL (stop) or ITERATING (fix the weakest criterion and loop again).",
      promptSnippet:
        "lykkja_checkpoint: score the current pass against the criteria and get the iterate/stop verdict.",
      promptGuidelines: [
        "Call lykkja_checkpoint once per loop pass, after doing the work, scoring every criterion honestly on the 1..scale range.",
        "If the verdict is ITERATING, fix the named weakest criterion first, then loop again. Only stop on FINAL.",
      ],
      parameters: Type.Object({
        plan: Type.String({
          description: "PLAN: the single next step you took this pass.",
        }),
        changes: Type.String({
          description: "DO: a terse summary of what you produced or changed.",
        }),
        scores: Type.Array(
          Type.Object({
            name: Type.String({ description: "Criterion name." }),
            score: Type.Number({
              description: "Honest score on the 1..scale range.",
            }),
            weakness: Type.Optional(
              Type.String({
                description:
                  "What is still weak. Required for any criterion below its threshold.",
              }),
            ),
          }),
          {
            description: "One score per criterion. Score every criterion.",
            minItems: 1,
          },
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (!loop) {
          throw new Error("No active lykkja loop. Call lykkja_start first.");
        }

        const { decision } = recordCheckpoint(loop, {
          plan: params.plan,
          changes: params.changes,
          scores: params.scores,
        });
        persist();
        updateStatus(ctx);

        const text = `${decision.message}\n\n${renderDashboard(loop)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: decision,
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
    loop = restoreState(ctx);
    updateStatus(ctx);
  });

  pi.registerCommand("lykkja", {
    description:
      "lykkja loop dashboard and controls. Args: (none) status, 'reset' clears the loop.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "reset" || arg === "clear") {
        loop = null;
        pi.appendEntry(STATE_ENTRY_TYPE, undefined);
        updateStatus(ctx);
        ctx.ui.notify("lykkja loop cleared.", "info");
        return;
      }
      if (!loop) {
        ctx.ui.notify(
          "No active lykkja loop. Ask the agent to start one, or use the /lykkja-run prompt.",
          "info",
        );
        return;
      }
      ctx.ui.notify(renderDashboard(loop), "info");
    },
  });
}
