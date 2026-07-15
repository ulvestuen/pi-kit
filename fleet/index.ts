import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { getConfigPath, loadConfig, type FleetConfig } from "./config.ts";
import {
  createFullOutputSaver,
  cleanupHostSpawnJobs,
  createHostSpawn,
  createWorktreeRoot,
  discoverAgents,
  isTmuxAvailable,
  loadHostSpawnConfig,
} from "./host.ts";
import { DEFAULT_TMUX_SESSION } from "./tmux.ts";
import type { AgentDefinition } from "./registry.ts";
import { runTasks, type TaskResult, type TaskSpec } from "./runner.ts";
import type { RunId, ArtifactRef } from "@pi-kit/agent-types";

const STATE_ENTRY_TYPE = "fleet-state";

/** Persisted record of one dispatched batch. */
interface FleetStateEntry {
  batchId: string;
  status: "running" | "done" | "aborted";
  startedAt: number;
  tasks: { agent: string; task: string; status?: string }[];
}

function buildSystemPrompt(
  config: FleetConfig,
  spawnBackend: string,
  tmuxLive: boolean,
): string {
  return [
    "You have the fleet sub-agent runtime for delegating work.",
    `The fleet_run tool dispatches tasks to sub-agents through the spawn runtime backend "${spawnBackend}"; a batch of tasks runs concurrently and returns results in this tool call.`,
    `Use it to fan out independent, well-scoped tasks — exploration (scout), implementation (implementer), or review (critic) — up to ${config.maxConcurrent} at a time.`,
    "Give each task a complete, self-contained brief: sub-agents share none of your context. Do not delegate trivial single-step work.",
    ...(tmuxLive
      ? [
          `Every sub-agent runs in a live tmux window in session "${config.tmuxSession}"; the user can watch with \`tmux attach -t ${config.tmuxSession}\`.`,
        ]
      : []),
    "Run /fleet to list the available agents.",
  ].join("\n");
}

function summarizeResult(index: number, spec: TaskSpec, r: TaskResult): string {
  const header = `[${index + 1}] ${r.agent} — ${r.status.toUpperCase()} in ${Math.round(r.durationMs / 1000)}s`;
  const lines = [header];
  if (r.branch) lines.push(`    branch: ${r.branch} (worktree: ${r.worktreePath})`);
  if (r.truncated && r.fullOutputPath) {
    lines.push(`    output truncated; full transcript: ${r.fullOutputPath}`);
  }
  const body = r.output.trim();
  if (body) lines.push(body);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let config: FleetConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[fleet] ${e.message}`);
    console.error(
      `[fleet] Using defaults. Fix ${getConfigPath()} or the FLEET_* env vars, then /reload.`,
    );
    config = loadDefaults();
  }

  function loadDefaults(): FleetConfig {
    return {
      maxConcurrent: 4,
      maxBatch: 8,
      defaultTimeoutMs: 10 * 60 * 1000,
      outputCapBytes: 50 * 1024,
      piBinary: "pi",
      injectSystemPrompt: true,
      tmux: true,
      tmuxSession: DEFAULT_TMUX_SESSION,
      tmuxCloseWindows: false,
    };
  }

  const spawnConfig = loadHostSpawnConfig(config, "pi-fleet");
  /** Whether sub-agents actually get live tmux windows on this host. */
  const tmuxLive = spawnConfig.backend === "tmux" && isTmuxAvailable();
  const spawn = createHostSpawn(config, "pi-fleet", spawnConfig);

  /** In-flight batch info for /fleet pool status. */
  let activeBatch: FleetStateEntry | null = null;
  let batchCounter = 0;

  pi.registerTool(
    defineTool({
      name: "fleet_run",
      label: "fleet: Run Sub-Agents",
      description:
        "Dispatch one or more tasks to sub-agents that run concurrently through the configured spawn backend, each with its own isolated context window. Each task names an agent from the registry (see /fleet) and carries a self-contained brief. Returns per-task results. Use worktree isolation when parallel tasks write to the same repository.",
      promptSnippet:
        "fleet_run: dispatch tasks to concurrent sub-agents, each in its own context window.",
      promptGuidelines: [
        "Use fleet_run to fan out independent, well-scoped tasks to sub-agents; give each task a complete brief since sub-agents share none of your context.",
        "Pick the agent by role: scout for read-only exploration, implementer for changes, critic for independent review.",
        'Set isolation: "worktree" when parallel tasks may write to the same files; merging branches back is your job afterwards.',
      ],
      parameters: Type.Object({
        tasks: Type.Array(
          Type.Object({
            agent: Type.String({
              description:
                'Agent registry name, e.g. "scout", "implementer", "critic".',
            }),
            task: Type.String({
              description:
                "Self-contained task brief: what to do, acceptance criteria, relevant paths.",
            }),
            isolation: Type.Optional(
              Type.Union([Type.Literal("none"), Type.Literal("worktree")], {
                description:
                  'Working-tree isolation. "worktree" runs the task on its own git branch in a scratch worktree. Default "none".',
              }),
            ),
            timeoutMs: Type.Optional(
              Type.Number({
                description: "Per-task timeout override in milliseconds.",
              }),
            ),
            runId: Type.Optional(
              Type.Object(
                {
                  runId: Type.String(),
                  taskId: Type.String(),
                  attempt: Type.Number(),
                  wave: Type.Number(),
                },
                { description: "Stable run identity across the orchestration (agent-native contract)." },
              ),
            ),
            inputArtifacts: Type.Optional(
              Type.Array(
                Type.Object({
                  type: Type.Union([
                    Type.Literal("path"),
                    Type.Literal("branch"),
                    Type.Literal("commit"),
                    Type.Literal("summary"),
                    Type.Literal("patch"),
                    Type.Literal("file-list"),
                  ]),
                  id: Type.String(),
                  description: Type.String(),
                  location: Type.Optional(Type.String()),
                }),
                { description: "Artifacts available as input to this task." },
              ),
            ),
            parentRunIds: Type.Optional(
              Type.Array(Type.String(), {
                description: "Run IDs of parent tasks (agent-native contract).",
              }),
            ),
            parentBranch: Type.Optional(
              Type.String({
                description:
                  "Branch to create worktrees from instead of HEAD (for prerequisite branch handoff).",
              }),
            ),
          }),
          {
            description:
              "Tasks to run concurrently. A single-element array is the single-task case.",
            minItems: 1,
          },
        ),
      }),
      async execute(_id, params, signal, onUpdate, ctx) {
        const { registry, errors } = discoverAgents(ctx.cwd);
        const specs: TaskSpec[] = params.tasks.map((t) => ({
          agent: t.agent,
          task: t.task,
          isolation: t.isolation,
          timeoutMs: t.timeoutMs,
          runId: t.runId,
          inputArtifacts: t.inputArtifacts,
          parentBranch: t.parentBranch,
        }));

        const batchId = `batch-${Date.now()}-${++batchCounter}`;
        const entry: FleetStateEntry = {
          batchId,
          status: "running",
          startedAt: Date.now(),
          tasks: specs.map((s) => ({ agent: s.agent, task: s.task })),
        };
        activeBatch = entry;
        pi.appendEntry(STATE_ENTRY_TYPE, entry);

        const statuses: string[] = specs.map(() => "queued");
        let results: TaskResult[];
        try {
          results = await runTasks(registry, specs, {
            spawn,
            cwd: ctx.cwd,
            piBinary: config.piBinary,
            maxConcurrent: config.maxConcurrent,
            maxBatch: config.maxBatch,
            defaultTimeoutMs: config.defaultTimeoutMs,
            outputCapBytes: config.outputCapBytes,
            signal,
            saveFullOutput: createFullOutputSaver("pi-fleet"),
            worktreeRoot: specs.some((s) => s.isolation === "worktree")
              ? createWorktreeRoot("pi-fleet")
              : undefined,
            onEvent: (e) => {
              pi.events.emit(`fleet:${e.type}`, e);
              if (e.type === "task_start") statuses[e.index] = "running";
              if (e.type === "task_end") statuses[e.index] = e.result.status;
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: statuses
                      .map((s, i) => `[${i + 1}] ${specs[i].agent}: ${s}`)
                      .join("\n"),
                  },
                ],
                details: { batchId, statuses: [...statuses] },
              });
            },
          });
        } catch (e) {
          entry.status = "aborted";
          activeBatch = null;
          pi.appendEntry(STATE_ENTRY_TYPE, entry);
          throw e;
        }

        entry.status = results.some((r) => r.status === "aborted")
          ? "aborted"
          : "done";
        entry.tasks = results.map((r, i) => ({
          agent: r.agent,
          task: specs[i].task,
          status: r.status,
        }));
        activeBatch = null;
        pi.appendEntry(STATE_ENTRY_TYPE, entry);

        const okCount = results.filter((r) => r.status === "ok").length;
        const text = [
          `fleet batch ${batchId}: ${okCount}/${results.length} tasks ok.`,
          ...(errors.length > 0
            ? [`Agent definition warnings:\n${errors.join("\n")}`]
            : []),
          "",
          ...results.map((r, i) => summarizeResult(i, specs[i], r)),
        ].join("\n");

        return {
          content: [{ type: "text" as const, text }],
          details: { batchId, results },
        };
      },
    }),
  );

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    await cleanupHostSpawnJobs(spawnConfig, "pi-fleet");
    // Internal synchronous spawn jobs from an interrupted parent are killed
    // above; mark any batch still recorded as "running" as aborted.
    let latest: FleetStateEntry | null = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as FleetStateEntry | undefined;
        if (data && typeof data.batchId === "string") latest = data;
      }
    }
    if (latest && latest.status === "running") {
      latest.status = "aborted";
      latest.tasks = latest.tasks.map((t) => ({
        ...t,
        status: t.status ?? "aborted",
      }));
      pi.appendEntry(STATE_ENTRY_TYPE, latest);
    }
    activeBatch = null;
  });

  pi.on("before_agent_start", async (event) => {
    if (!config.injectSystemPrompt) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config, spawnConfig.backend, tmuxLive)}`,
    };
  });

  pi.registerCommand("fleet", {
    description: "List discovered fleet agents and current pool status",
    handler: async (_args, ctx) => {
      const { registry, errors } = discoverAgents(ctx.cwd);
      const agents = [...registry.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );

      const lines = [`fleet — ${agents.length} agent(s) discovered`];
      for (const def of agents) {
        lines.push(`  ${def.name} — ${def.description}`);
        lines.push(
          `      source: ${def.source}` +
            (def.model ? ` | model: ${def.model}` : "") +
            (def.tools ? ` | tools: ${def.tools.join(", ")}` : ""),
        );
      }
      if (errors.length > 0) {
        lines.push("  Definition errors:");
        for (const err of errors) lines.push(`    ${err}`);
      }
      lines.push(
        `  Pool: max ${config.maxConcurrent} concurrent, batch cap ${config.maxBatch}, timeout ${Math.round(config.defaultTimeoutMs / 1000)}s`,
      );
      lines.push(`  spawn: backend ${spawnConfig.backend} (config: ${spawnConfig.configPath ?? "defaults / environment variables"})`);
      lines.push(
        tmuxLive
          ? `  tmux: sub-agent runner windows in session "${spawnConfig.tmuxSession}" — attach with: tmux attach -t ${spawnConfig.tmuxSession}`
          : spawnConfig.backend === "tmux"
            ? "  tmux: spawn backend selected but tmux is not installed"
            : "  tmux: not used by the selected spawn backend",
      );
      if (activeBatch) {
        lines.push(
          `  Active batch ${activeBatch.batchId}: ${activeBatch.tasks.length} task(s) in flight`,
        );
      } else {
        lines.push("  No batch in flight.");
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

export type { AgentDefinition };
