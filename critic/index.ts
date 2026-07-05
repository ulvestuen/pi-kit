import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import {
  createFullOutputSaver,
  discoverAgents,
  nodeSpawn,
} from "../fleet/host.ts";
import type { AgentDefinition } from "../fleet/registry.ts";
import { runTasks } from "../fleet/runner.ts";
import { normalizeCriteria, type CriterionInput } from "../lykkja/loop.ts";
import { getConfigPath, loadConfig, type CriticConfig } from "./config.ts";
import {
  buildAdvisePrompt,
  buildCriticPrompt,
  parseCriticOutput,
  type ReviewRequest,
  type ReviewResult,
} from "./review.ts";

/**
 * Fallback critic agent used when no "critic" definition is discovered
 * (e.g. a standalone install without the fleet agents directory).
 */
const FALLBACK_CRITIC: AgentDefinition = {
  name: "critic",
  description:
    "Independent read-only reviewer — scores work against explicit criteria.",
  systemPrompt: [
    "You are an independent critic with fresh context. Inspect with your read-only tools, verify claims against the actual files, and score honestly — you have no stake in the work passing.",
    "Grade inflation defeats your purpose. When in doubt, score lower and say why.",
    "Follow the output format requested in the task exactly.",
  ].join("\n"),
  tools: ["read", "grep", "find", "ls"],
  source: "(built-in fallback)",
};

function renderReview(review: ReviewResult, scaleMax: number): string {
  const lines = [
    `Critic verdict: ${review.passed ? "PASSED" : "FAILED"}`,
  ];
  if (review.scores.length > 0) {
    lines.push("Scores:");
    for (const s of review.scores) {
      lines.push(
        `  ${s.name}: ${s.score}/${scaleMax}` +
          (s.weakness ? ` — ${s.weakness}` : ""),
      );
    }
  }
  if (review.weaknesses.length > 0) {
    lines.push("Weaknesses (fix in this order):");
    for (const w of review.weaknesses) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let config: CriticConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[critic] ${e.message}`);
    console.error(
      `[critic] Using defaults. Fix ${getConfigPath()} or the CRITIC_* env vars, then /reload.`,
    );
    config = {
      scaleMax: 10,
      passThreshold: 8,
      timeoutMs: 5 * 60 * 1000,
      piBinary: "pi",
    };
  }

  /** Resolve the critic agent definition, applying the config model override. */
  function criticAgent(cwd: string): AgentDefinition {
    const { registry } = discoverAgents(cwd);
    const discovered = registry.get("critic");
    const base = discovered ?? FALLBACK_CRITIC;
    return config.model ? { ...base, model: config.model } : base;
  }

  /** Run one prompt through the critic agent and return its final message. */
  async function dispatchCritic(
    cwd: string,
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<{ output: string; status: string }> {
    const def = criticAgent(cwd);
    const registry = new Map([[def.name.toLowerCase(), def]]);
    const [result] = await runTasks(
      registry,
      [{ agent: def.name, task: prompt, timeoutMs: config.timeoutMs }],
      {
        spawn: nodeSpawn,
        cwd,
        piBinary: config.piBinary,
        maxConcurrent: 1,
        signal,
        saveFullOutput: createFullOutputSaver("pi-critic"),
      },
    );
    return { output: result.output, status: result.status };
  }

  pi.registerTool(
    defineTool({
      name: "critic_review",
      label: "critic: Independent Review",
      description:
        "Score work against explicit criteria using an independent critic agent with fresh context (a read-only child pi process). Provide the subject (diff, file list, artifact, or task result), optional context, and the rubric. Returns lykkja-shaped criterion scores, a pass/fail verdict, and prioritized weaknesses — usable directly as the CHECK step of a lykkja loop.",
      promptSnippet:
        "critic_review: have an independent read-only critic score work against explicit criteria.",
      promptGuidelines: [
        "Use critic_review instead of grading your own work when the result matters: the critic has fresh context and no stake in the work passing.",
        "Hand the critic enough to verify independently: what changed, where it lives, and how each criterion can be checked.",
        "The critic's scores win over self-assessment; feed them into lykkja_checkpoint when a loop is active.",
      ],
      parameters: Type.Object({
        subject: Type.String({
          description:
            "What to review: a diff summary, file list, artifact, or task result — with paths the critic can inspect.",
        }),
        context: Type.Optional(
          Type.String({
            description: "Task brief and constraints the work was done under.",
          }),
        ),
        criteria: Type.Array(
          Type.Object({
            name: Type.String({ description: "Criterion name." }),
            threshold: Type.Optional(
              Type.Number({
                description:
                  "Minimum passing score. Defaults to the configured bar.",
              }),
            ),
          }),
          { description: "The rubric to score against.", minItems: 1 },
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const request: ReviewRequest = {
          subject: params.subject,
          context: params.context,
          criteria: normalizeCriteria(
            params.criteria as CriterionInput[],
            config.passThreshold,
            config.scaleMax,
          ),
          scaleMax: config.scaleMax,
        };
        const prompt = buildCriticPrompt(request);

        let run = await dispatchCritic(ctx.cwd, prompt, signal);
        if (run.status !== "ok") {
          throw new Error(`critic run ${run.status}: ${run.output}`);
        }
        let review = parseCriticOutput(run.output, request);

        // One automatic re-run before an unscorable review counts.
        if (!review.passed && review.scores.length === 0) {
          run = await dispatchCritic(ctx.cwd, prompt, signal);
          if (run.status === "ok") {
            const retry = parseCriticOutput(run.output, request);
            if (retry.scores.length > 0) review = retry;
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: renderReview(review, config.scaleMax),
            },
          ],
          details: review,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "critic_advise",
      label: "critic: Design Advice",
      description:
        "Get pre-implementation design feedback on a plan or approach from an independent advisor agent with fresh context (a read-only child pi process). Returns a prioritized list of concerns and concrete improvements rather than scores. Use before committing to a design.",
      promptSnippet:
        "critic_advise: get independent, prioritized design feedback on a plan before implementing it.",
      promptGuidelines: [
        "Use critic_advise before implementing a non-trivial plan; act on the prioritized concerns or note why not.",
      ],
      parameters: Type.Object({
        subject: Type.String({
          description: "The plan, approach, or design to critique.",
        }),
        context: Type.Optional(
          Type.String({
            description:
              "Goal, constraints, and repository areas the plan touches.",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const prompt = buildAdvisePrompt({
          subject: params.subject,
          context: params.context,
        });
        const run = await dispatchCritic(ctx.cwd, prompt, signal);
        if (run.status !== "ok") {
          throw new Error(`critic run ${run.status}: ${run.output}`);
        }
        return {
          content: [{ type: "text" as const, text: run.output }],
          details: { status: run.status },
        };
      },
    }),
  );

  pi.registerCommand("critic", {
    description: "Critic status: agent definition, model, and scale in use",
    handler: async (_args, ctx) => {
      const def = criticAgent(ctx.cwd);
      const lines = [
        "critic — independent reviewer",
        `  Agent:      ${def.name} (${def.source})`,
        `  Model:      ${def.model ?? "(parent's model)"}`,
        `  Tools:      ${def.tools?.join(", ") ?? "(parent's tools)"}`,
        `  Scale:      1..${config.scaleMax}, default threshold ${config.passThreshold}`,
        `  Timeout:    ${Math.round(config.timeoutMs / 1000)}s`,
        `  Config:     ${config.configPath ?? "defaults / environment variables"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
