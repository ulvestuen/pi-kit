import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { discoverAgents } from "../fleet/host.ts";
import { getAgent } from "../fleet/registry.ts";
import {
  defaultConfig,
  getConfigPath,
  loadConfig,
  type SpawnConfig,
} from "./config.ts";
import { createBackends } from "./host.ts";
import {
  isTerminal,
  loadJobs,
  saveJobs,
  uniqueJobName,
  SPAWN_BACKEND_NAMES,
  type SpawnBackend,
  type SpawnBackendName,
  type SpawnJob,
} from "./jobs.ts";

function buildSystemPrompt(config: SpawnConfig): string {
  return [
    "You have the spawn runtime for launching detached sub-agents.",
    "The spawn_agent tool starts one sub-agent (a child pi process) as a background job that outlives this conversation turn, on one of three backends:",
    '- "tmux": runs locally in a live tmux window (the user can watch with `tmux attach -t ' +
      config.tmuxSession +
      "`).",
    '- "exedev": runs on an exe.dev cloud VM, off this machine entirely.',
    '- "microsandbox": runs in a locally hosted microVM with hardware isolation.',
    `The default backend is "${config.backend}". Use exedev or microsandbox as alternatives to tmux when a job should not run directly on this machine.`,
    "Jobs are fire-and-forget: check on them later with spawn_jobs (status), spawn_output (log tail), and spawn_kill (stop). Give each job a complete, self-contained brief — it shares none of your context, and cloud/sandbox jobs do not see this working tree unless the backend mounts it.",
    "Run /spawn to list backends and jobs.",
  ].join("\n");
}

function ageText(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 6) / 10}h`;
}

function jobLine(job: SpawnJob, now: number): string {
  const status =
    job.status.toUpperCase() +
    (job.exitCode !== undefined ? ` (exit ${job.exitCode})` : "");
  const brief =
    job.task.length > 70 ? `${job.task.slice(0, 70)}...` : job.task;
  return `${job.name} — ${job.agent} on ${job.backend} — ${status} — started ${ageText(job.createdAt, now)} ago — ${brief}`;
}

function watchHint(job: SpawnJob, config: SpawnConfig): string {
  switch (job.backend) {
    case "tmux":
      return `Live window: tmux attach -t ${config.tmuxSession} (window "${job.name}"). Poll with spawn_jobs; read output with spawn_output.`;
    case "exedev":
      return `Runs on exe.dev VM "${job.vmName}" (ssh ${job.sshDest}). Poll with spawn_jobs; read output with spawn_output.`;
    case "microsandbox":
      return `Runs in microsandbox "${job.sandboxName}". Poll with spawn_jobs; read output with spawn_output.`;
  }
}

export default function (pi: ExtensionAPI) {
  let config: SpawnConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    console.error(`[spawn] ${e.message}`);
    console.error(
      `[spawn] Using defaults. Fix ${getConfigPath()} or the SPAWN_* env vars, then /reload.`,
    );
    config = defaultConfig();
  }

  const backends = createBackends(config);
  const warn = (message: string) => console.error(`[spawn] ${message}`);

  /** Load, mutate, persist: every tool works on the durable registry. */
  const withJobs = async <T>(
    fn: (jobs: SpawnJob[]) => Promise<{ result: T; dirty: boolean }>,
  ): Promise<T> => {
    const jobs = loadJobs(config.logDir, warn);
    const { result, dirty } = await fn(jobs);
    if (dirty) saveJobs(config.logDir, jobs);
    return result;
  };

  /** Refresh one non-terminal job; per-job errors degrade to a warning. */
  const refreshJob = async (job: SpawnJob): Promise<boolean> => {
    if (isTerminal(job.status)) return false;
    try {
      return await backends[job.backend].refresh(job);
    } catch (e: any) {
      warn(`could not refresh job ${job.name}: ${e?.message ?? e}`);
      return false;
    }
  };

  pi.registerTool(
    defineTool({
      name: "spawn_agent",
      label: "spawn: Launch Detached Sub-Agent",
      description:
        "Launch one sub-agent (a child pi process) as a detached background job that keeps running after this tool returns — in a local tmux window, on an exe.dev cloud VM, or inside a local microsandbox microVM. The task brief must be fully self-contained. Returns the job name; check progress later with spawn_jobs and spawn_output.",
      promptSnippet:
        "spawn_agent: launch a detached sub-agent job on tmux, exe.dev, or microsandbox.",
      promptGuidelines: [
        "Use spawn_agent for long-running or fire-and-forget work; use fleet_run instead when you need the results in this turn.",
        "Pick the backend deliberately: tmux runs on this machine, exedev on a cloud VM (no access to this working tree), microsandbox in an isolated local microVM.",
        "Poll spawn_jobs and read spawn_output later in the conversation; jobs survive pi restarts.",
      ],
      parameters: Type.Object({
        agent: Type.String({
          description:
            'Agent registry name, e.g. "scout", "implementer", "critic" (see /spawn or /fleet).',
        }),
        task: Type.String({
          description:
            "Self-contained task brief: what to do, acceptance criteria, relevant paths or repos. Cloud and sandbox jobs cannot see this session's context.",
        }),
        backend: Type.Optional(
          Type.Union(
            [
              Type.Literal("tmux"),
              Type.Literal("exedev"),
              Type.Literal("microsandbox"),
            ],
            {
              description: `Where the job runs. Default: "${config.backend}" (from config).`,
            },
          ),
        ),
        name: Type.Optional(
          Type.String({
            description:
              "Base name for the job (a unique suffix is appended). Defaults to the agent name.",
          }),
        ),
        cwd: Type.Optional(
          Type.String({
            description:
              "Working directory for the job. Used directly by tmux, mounted at /workspace by microsandbox, ignored by exedev (remote jobs start in the VM's $HOME).",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { registry, errors } = discoverAgents(ctx.cwd);
        const def = getAgent(registry, params.agent);
        if (!def) {
          const known = [...registry.values()]
            .map((d) => d.name)
            .sort()
            .join(", ");
          throw new Error(
            `Unknown agent "${params.agent}". Known agents: ${known || "(none)"}`,
          );
        }

        // Abort before launch: do not start the job if already cancelled.
        if (signal?.aborted) {
          throw new Error("spawn_agent aborted before launch");
        }

        const backendName: SpawnBackendName = params.backend ?? config.backend;
        const backend: SpawnBackend = backends[backendName];
        const unavailable = await backend.available();
        if (unavailable) {
          throw new Error(
            `Backend "${backendName}" is not usable here: ${unavailable}`,
          );
        }

        const job = await withJobs(async (jobs) => {
          const jobName = uniqueJobName(
            params.name?.trim() || def.name,
            (candidate) => jobs.some((j) => j.name === candidate),
            Date.now(),
          );
          const launched = await backend.launch({
            jobName,
            agent: def,
            task: params.task,
            cwd: params.cwd ?? ctx.cwd,
          });
          jobs.push(launched);
          return { result: launched, dirty: true };
        });

        const text = [
          `Launched detached job "${job.name}" (${job.agent} on ${job.backend}).`,
          watchHint(job, config),
          ...(errors.length > 0
            ? [`Agent definition warnings:\n${errors.join("\n")}`]
            : []),
        ].join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { job },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "spawn_jobs",
      label: "spawn: List Jobs",
      description:
        "List detached sub-agent jobs with refreshed statuses (running/done/failed/killed/lost and exit codes). Optionally filter to one job by name.",
      promptSnippet:
        "spawn_jobs: refresh and list detached sub-agent jobs.",
      parameters: Type.Object({
        name: Type.Optional(
          Type.String({ description: "Only this job, by exact name." }),
        ),
      }),
      async execute(_id, params) {
        return withJobs(async (jobs) => {
          const selected = params.name
            ? jobs.filter((j) => j.name === params.name)
            : jobs;
          if (params.name && selected.length === 0) {
            throw new Error(`No job named "${params.name}".`);
          }
          let dirty = false;
          for (const job of selected) {
            if (await refreshJob(job)) dirty = true;
          }
          const now = Date.now();
          const text =
            selected.length === 0
              ? "No spawn jobs recorded."
              : selected
                  .slice()
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((j) => jobLine(j, now))
                  .join("\n");
          return {
            result: {
              content: [{ type: "text" as const, text }],
              details: { jobs: selected },
            },
            dirty,
          };
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "spawn_output",
      label: "spawn: Read Job Output",
      description:
        "Read the tail of a detached job's log (the sub-agent's plain-text output) along with its refreshed status. Works while the job runs and after it finishes.",
      promptSnippet: "spawn_output: read a detached job's log tail.",
      parameters: Type.Object({
        name: Type.String({ description: "Job name (see spawn_jobs)." }),
        maxBytes: Type.Optional(
          Type.Number({
            description: `Tail size in bytes. Default ${config.outputTailBytes}.`,
          }),
        ),
      }),
      async execute(_id, params) {
        return withJobs(async (jobs) => {
          const job = jobs.find((j) => j.name === params.name);
          if (!job) throw new Error(`No job named "${params.name}".`);
          const dirty = await refreshJob(job);
          const maxBytes = Math.min(
            Math.max(Math.round(params.maxBytes ?? config.outputTailBytes), 256),
            512 * 1024,
          );
          const output = await backends[job.backend].output(job, maxBytes);
          const sections = [jobLine(job, Date.now()), "", output];
          // A job that did not end cleanly explains itself through its
          // captured stderr; surface it next to the log tail.
          if (isTerminal(job.status) && job.status !== "done") {
            let err = "";
            try {
              err = (
                await backends[job.backend].errorOutput(job, maxBytes)
              ).trim();
            } catch {
              // Best-effort; the log tail alone still stands.
            }
            if (err) sections.push("", "--- captured stderr ---", err);
          }
          const text = sections.join("\n");
          return {
            result: {
              content: [{ type: "text" as const, text }],
              details: { job },
            },
            dirty,
          };
        });
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "spawn_kill",
      label: "spawn: Kill Job",
      description:
        "Stop a running detached job (SIGTERM to its runner; the tmux window, VM, or job files stay for inspection). Jobs that already finished are reported as-is.",
      promptSnippet: "spawn_kill: stop a running detached job.",
      parameters: Type.Object({
        name: Type.String({ description: "Job name (see spawn_jobs)." }),
      }),
      async execute(_id, params) {
        return withJobs(async (jobs) => {
          const job = jobs.find((j) => j.name === params.name);
          if (!job) throw new Error(`No job named "${params.name}".`);
          let dirty = await refreshJob(job);
          let text: string;
          if (isTerminal(job.status)) {
            text = `Job "${job.name}" already finished: ${jobLine(job, Date.now())}`;
          } else {
            // ADR §9: KillResult determines the outcome.
            // KillResult branch 1 — stopped: backend confirmed the process
            // is gone → stamp killed.
            // KillResult branch 2 — alreadyComplete: process already exited
            // → refresh from marker.
            // KillResult branch 3 — warned/unconfirmed: kill sent but
            // unconfirmed → refresh, mark lost.
            let kr;
            try {
              kr = await backends[job.backend].kill(job);
            } catch (e: any) {
              // KillResult branch 3 (thrown): kill threw an error — surface as explicit
              // error; do not stamp killed or lost so the caller can retry.
              job.updatedAt = Date.now();
              dirty = true;
              text = `Kill failed for job "${job.name}": ${e?.message ?? String(e)}.`;
              return {
                result: {
                  content: [{ type: "text" as const, text }],
                  details: { job },
                },
                dirty,
              };
            }
            if (kr.stopped) {
              // KillResult branch 1 — stopped: backend confirms the process is gone.
              // Stamp killed immediately per ADR §6/§9.
              job.status = "killed";
              job.updatedAt = Date.now();
              dirty = true;
              text = `Killed job "${job.name}".`;
            } else if (kr.alreadyComplete) {
              // KillResult branch 2 — alreadyComplete: refresh from the done marker to
              // discover the real terminal status (done/failed).
              try {
                await backends[job.backend].refresh(job);
              } catch {
                // Best-effort; backend already confirmed completion.
              }
              job.updatedAt = Date.now();
              dirty = true;
              text = `Job "${job.name}" already completed: ${jobLine(job, Date.now())}`;
            } else {
              // KillResult branch 3 — warned / unconfirmed: kill sent but backend could
              // not confirm stop.  Refresh from done markers; if still
              // nonterminal, mark lost so the job never stays "running".
              try {
                await backends[job.backend].refresh(job);
              } catch {
                // Best-effort.
              }
              if (!isTerminal(job.status)) {
                job.status = "lost";
              }
              job.updatedAt = Date.now();
              dirty = true;
              text = `Could not kill job "${job.name}": ${kr.message ?? "unknown error"}.`;
            }
          }
          return {
            result: {
              content: [{ type: "text" as const, text }],
              details: { job },
            },
            dirty,
          };
        });
      },
    }),
  );

  pi.on("before_agent_start", async (event) => {
    if (!config.injectSystemPrompt) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildSystemPrompt(config)}`,
    };
  });

  pi.registerCommand("spawn", {
    description: "List spawn backends and detached sub-agent jobs",
    handler: async (_args, ctx: ExtensionContext) => {
      const lines = [`spawn — default backend: ${config.backend}`];
      for (const name of SPAWN_BACKEND_NAMES) {
        const unavailable = await backends[name].available();
        const caps = unavailable ? null : await backends[name].capabilities();
        const capsText = caps
          ? ` [mount=${caps.workspaceMount}, kill=${caps.confirmedKill}, logs=${caps.durableLogs}, net=${caps.networkAccess}, iso=${caps.hardwareIsolation}]`
          : "";
        lines.push(
          `  ${name}: ${unavailable ? `unavailable — ${unavailable}` : `available${capsText}`}`,
        );
      }
      const jobs = loadJobs(config.logDir, warn);
      let dirty = false;
      for (const job of jobs) {
        if (await refreshJob(job)) dirty = true;
      }
      if (dirty) saveJobs(config.logDir, jobs);
      if (jobs.length === 0) {
        lines.push("  No jobs recorded.");
      } else {
        const now = Date.now();
        lines.push("  Jobs:");
        for (const job of jobs
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)) {
          lines.push(`    ${jobLine(job, now)}`);
        }
      }
      lines.push(`  Job files: ${config.logDir}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
