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
    "3. lykkja_checkpoint returns the ACT verdict and an explicit next-step prompt. Follow that prompt immediately: iterate on the weakest criterion, finalize on FINAL, or report failure on STOPPED.",
    "4. Do not wait for the user between PDCA phases unless the user explicitly asked for a pause; the tool output prompts the next phase.",
    "",
    "Score brutally honestly — never inflate to end the loop. For the full protocol, use the pdca-loop skill.",
  ].join("\n");
}

/** Marker that signals a cleared/reset loop — distinct from a valid LoopState. */
interface TombstoneEntry {
  tombstone: true;
}

function isTombstone(data: unknown): data is TombstoneEntry {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as any).tombstone === true
  );
}

/** Restore the most recent loop state from the session entry log.
 * When a tombstone (reset marker) is encountered, all prior entries
 * are invalidated — the loop was explicitly cleared. */
function restoreState(ctx: ExtensionContext): LoopState | null {
  let latest: LoopState | null = null;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
      const data = entry.data as LoopState | TombstoneEntry | undefined;
      if (isTombstone(data)) {
        // Reset marker — discard everything seen so far
        latest = null;
      } else if (data && typeof data.task === "string") {
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

function renderAutomationPrompt(state: LoopState): string {
  const s = summarizeLoop(state);
  const criteria = state.criteria
    .map((c) => `- ${c.name} (threshold ${c.threshold}/${state.scaleMax})`)
    .join("\n");

  if (s.status === "final") {
    return [
      "AUTOMATED ACT PROMPT:",
      "The latest checkpoint is FINAL. Do not keep iterating.",
      "1. State `FINAL`.",
      "2. Summarize what was produced and the evidence that every criterion passed.",
      "3. Mention any assumptions or follow-up risks without weakening the result.",
    ].join("\n");
  }

  if (s.status === "stopped") {
    return [
      "AUTOMATED STOP PROMPT:",
      "The loop hit its safety limit. Do not claim success.",
      "1. Report which criteria still fail and why.",
      "2. Summarize the best partial result and what would be needed next.",
    ].join("\n");
  }

  if (!s.latest) {
    return [
      "AUTOMATED PLAN→DO→CHECK PROMPT:",
      "Start pass 1 now, without asking for another prompt.",
      "PLAN: Choose exactly one next step that best advances the task.",
      "DO: Execute that step using the available tools.",
      "CHECK: Gather concrete evidence and score every criterion honestly:",
      criteria,
      "ACT: Call lykkja_checkpoint with the PLAN, DO summary, and all scores."
    ].join("\n");
  }

  return [
    "AUTOMATED ACT→PLAN→DO→CHECK PROMPT:",
    `The verdict is ITERATING. Start pass ${s.iterationCount + 1} now, without asking for another prompt.`,
    `PLAN: Fix the weakest failing criterion first: ${s.weakest}. Choose one next step only.`,
    "DO: Execute that step using the available tools.",
    "CHECK: Re-gather evidence and score every criterion honestly:",
    criteria,
    "ACT: Call lykkja_checkpoint again. Continue until the tool returns FINAL or STOPPED."
  ].join("\n");
}

/** Prompt sent by `/lykkja <task>` — open and run a loop end to end. */
function buildRunPrompt(task: string): string {
  return [
    "Run a **lykkja self-checking loop** on the following task until it meets the bar.",
    "",
    "TASK:",
    task,
    "",
    "Follow the `pdca-loop` skill. Concretely:",
    "",
    "1. Restate the task in one precise sentence. If it is ambiguous, make a sensible assumption, state it, and proceed — do not stop to ask.",
    "2. Define strict, measurable success criteria (use the `success-criteria` skill). Then call `lykkja_start` with the task and those criteria.",
    "3. Follow the AUTOMATED prompt returned by `lykkja_start` and every later `lykkja_checkpoint` result. Do not wait for another user message between PLAN, DO, CHECK, and ACT.",
    "4. Each pass, score every criterion honestly against real evidence (use the `honest-verification` skill). On ITERATING, immediately fix the weakest criterion named. Only stop when the tool returns FINAL — or, on STOPPED, report honestly which criteria still fail and why; do not claim success.",
    "",
    "Do not ask me questions mid-loop. Make sensible assumptions, note them, and keep going until FINAL.",
  ].join("\n");
}

/** Prompt sent by `/lykkja plan <task>` — PLAN only, then pause for review. */
function buildPlanPrompt(task: string): string {
  return [
    "Run only the **PLAN** step of a lykkja loop. I want to review the criteria before any work starts.",
    "",
    "TASK:",
    task,
    "",
    "Do only the planning, not the work:",
    "",
    "1. State exactly what should be produced, in one precise sentence.",
    "2. Surface the key assumptions and constraints. Where something is ambiguous, choose a sensible default and note it rather than asking.",
    "3. Define **3-6 strict, measurable success criteria** following the `success-criteria` skill. For each, give a one-line reason it is checkable and a threshold (default 8/10; raise for must-not-regress properties).",
    "4. Call `lykkja_start` with the task and criteria so the loop is opened, then STOP.",
    "",
    "I am explicitly requesting planning only: do NOT follow the AUTOMATED prompt in the `lykkja_start` result. Wait — I will send `/lykkja go` when I want the loop to run.",
  ].join("\n");
}

/** Prompt sent by `/lykkja go` — continue the active loop from its current state. */
function buildGoPrompt(state: LoopState): string {
  return [
    "Continue the active lykkja loop now.",
    "",
    renderDashboard(state),
    "",
    "Score against real evidence, following the `honest-verification` skill — run the tests, the type-checker, the edge case; do not score from memory, and do not inflate a score to end the loop.",
    "",
    renderAutomationPrompt(state),
  ].join("\n");
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
        "After lykkja_start returns, follow its AUTOMATED PLAN→DO→CHECK PROMPT immediately unless the user explicitly requested planning only.",
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
          renderAutomationPrompt(loop);
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
        "Record one full PLAN/DO/CHECK pass of the active lykkja loop and get the ACT verdict. Provide the single step taken, what changed, and an honest score for every criterion. Returns FINAL (stop) or ITERATING (fix the weakest criterion and loop again).",
      promptSnippet:
        "lykkja_checkpoint: score the current pass against the criteria and get the ACT verdict/prompt.",
      promptGuidelines: [
        "Call lykkja_checkpoint once per loop pass, after doing the work, scoring every criterion honestly on the 1..scale range.",
        "Follow the AUTOMATED prompt in the tool result: ITERATING means immediately start the next pass on the weakest criterion; FINAL means finalize; STOPPED means report failure honestly.",
        "Do not wait for an extra user prompt between PDCA phases unless the user explicitly requested a pause.",
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

        const text = `${decision.message}\n\n${renderDashboard(loop)}\n\n${renderAutomationPrompt(loop)}`;
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
      "lykkja loop. Args: <task> run a loop, 'plan <task>' plan only, 'go' continue the loop, (none) dashboard, 'reset' clear.",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        { value: "plan ", label: "plan <task> — define criteria only, pause for review" },
        { value: "go", label: "go — continue the active loop" },
        { value: "reset", label: "reset — clear the loop" },
      ];
      const matches = subcommands.filter((s) => s.value.startsWith(prefix.toLowerCase()));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim();
      const firstWord = raw.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      const rest = raw.slice(firstWord.length).trim();

      // Bare /lykkja — dashboard (or usage help when no loop exists).
      if (!raw || ((firstWord === "status" || firstWord === "dashboard") && !rest)) {
        if (!loop) {
          ctx.ui.notify(
            [
              "No active lykkja loop.",
              "  /lykkja <task>       run a self-checking loop end to end",
              "  /lykkja plan <task>  define criteria only, pause for review",
              "  /lykkja go           continue the active loop",
              "  /lykkja reset        clear the loop",
            ].join("\n"),
            "info",
          );
          return;
        }
        ctx.ui.notify(renderDashboard(loop), "info");
        return;
      }

      if ((firstWord === "reset" || firstWord === "clear") && !rest) {
        loop = null;
        pi.appendEntry(STATE_ENTRY_TYPE, { tombstone: true } as unknown as LoopState);
        updateStatus(ctx);
        ctx.ui.notify("lykkja loop cleared.", "info");
        return;
      }

      // /lykkja go — nudge the agent to run the next PDCA pass of the active loop.
      if ((firstWord === "go" || firstWord === "continue" || firstWord === "resume") && !rest) {
        if (!loop) {
          ctx.ui.notify(
            "No active lykkja loop to continue. Start one with /lykkja <task>.",
            "info",
          );
          return;
        }
        pi.sendUserMessage(buildGoPrompt(loop));
        return;
      }

      // /lykkja plan <task> — PLAN only: open the loop, then pause for review.
      if (firstWord === "plan" && rest) {
        pi.sendUserMessage(buildPlanPrompt(rest));
        return;
      }

      // /lykkja <task> — open and run a loop end to end.
      pi.sendUserMessage(buildRunPrompt(raw));
    },
  });
}
