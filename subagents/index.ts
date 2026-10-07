import { Type } from "@earendil-works/pi-ai";
import { defineTool, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { progressLines, roles, runBatch, type Details } from "./runner.ts";

export default function (pi: ExtensionAPI) {
  const active = new Set<AbortController>();
  const pending = new Set<Promise<Details>>();
  let closing = false;
  let latest: Details | undefined;

  pi.registerTool(defineTool({
    name: "subagent",
    label: "Subagents",
    description: "Delegate 1–8 focused tasks to fresh Pi SDK sessions. Roles: scout, planner, implementer, critic, auditor. Returns final answers and per-task status. No parent conversation, extensions or skills are inherited. Tasks share filesystem permissions; this is not a sandbox.",
    promptSnippet: "subagent: delegate focused work with live progress and role-restricted tools.",
    promptGuidelines: [
      "Give each subagent a self-contained brief with scope, evidence needed, and acceptance criteria; it cannot see this conversation.",
      "Use parallel tasks only for independent work. Serialize edits in the same checkout or use separate worktrees via cwd. Verify returned claims.",
    ],
    exposure: "model-only",
    executionMode: "sequential",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        role: Type.Union(roles.map((role) => Type.Literal(role))),
        task: Type.String({ minLength: 1, description: "Self-contained task brief" }),
        cwd: Type.Optional(Type.String({ description: "Working directory, relative to the parent cwd or absolute" })),
        model: Type.Optional(Type.String({ description: "provider/model-id; defaults to the active parent model" })),
      }), { minItems: 1, maxItems: 8 }),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "Default 2; use 1 for overlapping edits" })),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Seconds per child including setup; default 600" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      active.add(controller);
      let batch: Promise<Details> | undefined;
      try {
        batch = runBatch(params.tasks, {
          parent: {
            cwd: ctx.cwd,
            model: ctx.model,
            modelRegistry: ctx.modelRegistry,
            thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
          },
          concurrency: params.concurrency ?? 2,
          timeoutMs: (params.timeout ?? 600) * 1000,
          signal: controller.signal,
          onUpdate(details) {
            if (closing) return;
            latest = details;
            const lines = progressLines(details);
            if (ctx.mode === "tui") {
              ctx.ui.setWidget("subagents", lines);
              ctx.ui.setStatus("subagents", lines[0]);
            }
            onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details });
          },
        });
        pending.add(batch);
        const details = await batch;
        if (ctx.mode === "tui" && !closing) ctx.ui.setWidget("subagents", undefined);
        const text = details.results.map((r) =>
          `#${r.id} ${r.role} (${r.status})\n${r.answer || r.error || r.activity}`,
        ).join("\n\n");
        const output = truncateHead(text);
        return {
          content: [{ type: "text" as const, text: output.content + (output.truncated ? "\n[Output truncated; use smaller task batches.]" : "") }],
          details,
        };
      } finally {
        signal?.removeEventListener("abort", abort);
        active.delete(controller);
        if (batch) pending.delete(batch);
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `Subagents · ${args.tasks?.length ?? 0} tasks`) +
        theme.fg("muted", ` · concurrency ${args.concurrency ?? 2}`), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (!result.details) return new Text(result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), 0, 0);
      const details = result.details as Details;
      const lines = progressLines(details);
      if (isPartial) return new Text(theme.fg("muted", `${lines[0]} · live progress below`), 0, 0);
      const body = lines.map((line, i) => {
        const status = details.results[i - 1]?.status;
        const color = i === 0 ? "accent" : status === "completed" ? "success" : status === "running" ? "accent" : status === "queued" ? "muted" : "error";
        return theme.fg(color, line);
      }).join("\n");
      const answers = expanded ? details.results.map((r) =>
        `\n#${r.id} ${r.role}: ${r.task}\n${r.answer || r.error || r.activity}`,
      ).join("\n") : "";
      return new Text(body + answers, 0, 0);
    },
  }));

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "subagent") return;
    const details = event.details as Details | undefined;
    if (details?.results.some((r) => r.status !== "completed")) return { isError: true };
  });

  pi.registerCommand("subagents", {
    description: "Subagent status; /subagents cancel or /subagents clear",
    handler: async (args, ctx) => {
      if (args.trim() === "cancel") {
        for (const controller of active) controller.abort();
        ctx.ui.notify("Cancelling active subagents", "info");
      } else if (args.trim() === "clear") {
        latest = undefined;
        if (ctx.mode === "tui") {
          ctx.ui.setWidget("subagents", undefined);
          ctx.ui.setStatus("subagents", undefined);
        }
      } else {
        ctx.ui.notify(latest ? progressLines(latest).join("\n") : "No subagents have run in this session", "info");
      }
    },
  });

  pi.on("session_start", async () => {
    closing = false;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    closing = true;
    for (const controller of active) controller.abort();
    await Promise.allSettled(pending);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget("subagents", undefined);
      ctx.ui.setStatus("subagents", undefined);
    }
    latest = undefined;
  });
}
