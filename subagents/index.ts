import { Type } from "@earendil-works/pi-ai";
import { defineTool, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadRole, progressLines, roles, runBatch, type Details } from "./runner.ts";
import { agentTranscript, SubagentView } from "./view.ts";

export default async function (pi: ExtensionAPI) {
  const definitions = await Promise.all(roles.map(loadRole));
  const active = new Set<AbortController>();
  const pending = new Set<Promise<Details>>();
  const viewers = new Set<(details: Details | undefined) => void>();
  let closing = false;
  let latest: Details | undefined;

  pi.registerTool(defineTool({
    name: "subagent",
    label: "Subagents",
    description: [
      "Delegate 1–8 focused tasks to fresh Pi SDK sessions. Returns final answers and per-task status. Children load applicable user/repository instructions, but do not inherit this conversation, extensions or skills. Tasks share filesystem permissions; this is not a sandbox.",
      ...definitions.map((role) => `${role.role}: ${role.description} Tools: ${role.tools.join(", ")}.`),
    ].join("\n"),
    promptSnippet: "subagent: delegate focused work with live progress and role-restricted tools.",
    promptGuidelines: [
      "Work directly by default. Use subagent for a bounded independent task or useful fresh-context review, not a mandatory role pipeline; do not launch shell-based agents.",
      "Give each subagent a self-contained brief with the goal, scope, paths, settled decisions, acceptance checks, and required evidence. Supply any needed skill instructions or readable references explicitly.",
      "Use parallel tasks only for independent work. Serialize overlapping edits or use separate worktrees via cwd. A critic cannot run git or tests; provide a readable diff for change reviews and use an auditor for command-backed checks.",
      "A completed status only means the child returned. Inspect changes and verify claims before accepting the work. After failure, cancellation, or timeout, inspect partial changes before retrying.",
    ],
    exposure: "model-only",
    executionMode: "sequential",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        role: Type.Union(roles.map((role) => Type.Literal(role))),
        task: Type.String({ minLength: 1, description: "Self-contained task brief" }),
        cwd: Type.Optional(Type.String({ description: "Working directory, relative to the parent cwd or absolute. A different directory does not inherit project trust for .pi prompt files." })),
        model: Type.Optional(Type.String({ description: "provider/model-id; defaults to the active parent model. Required when the parent uses a virtual/router model." })),
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
            projectTrusted: ctx.isProjectTrusted(),
          },
          concurrency: params.concurrency ?? 2,
          timeoutMs: (params.timeout ?? 600) * 1000,
          signal: controller.signal,
          onUpdate(details) {
            if (closing) return;
            latest = details;
            for (const viewer of viewers) viewer(details);
            const lines = progressLines(details);
            if (ctx.mode === "tui") {
              ctx.ui.setWidget("subagents", [...lines, "/subagents watch [id] · inspect live thinking and tools"]);
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
      if (isPartial && !expanded) return new Text(theme.fg("muted", `${lines[0]} · live progress below · /subagents watch`), 0, 0);
      const body = lines.map((line, i) => {
        const status = details.results[i - 1]?.status;
        const color = i === 0 ? "accent" : status === "completed" ? "success" : status === "running" ? "accent" : status === "queued" ? "muted" : "error";
        return theme.fg(color, line);
      }).join("\n");
      const answers = expanded ? details.results.map((r) =>
        `\n\n#${r.id} ${r.role}\n${agentTranscript(r)}`,
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
    description: "Subagent status; watch [id] for live transcripts, cancel, or clear",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (/^watch(?:\s|$)/.test(input)) {
        const match = input.match(/^watch(?:\s+([1-8]))?$/);
        if (!match) {
          ctx.ui.notify("Usage: /subagents watch [1–8]", "warning");
          return;
        }
        if (!latest) {
          ctx.ui.notify("No subagents have run in this session", "info");
          return;
        }
        const selected = match[1] ? Number(match[1]) - 1 : 0;
        if (!latest.results[selected]) {
          ctx.ui.notify(`No subagent #${selected + 1} in the latest batch`, "warning");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Live viewer requires TUI mode; transcripts are in tool update/result details.results[].transcript", "info");
          return;
        }
        let listener: ((details: Details | undefined) => void) | undefined;
        try {
          await ctx.ui.custom<void>((tui, theme, _keys, done) => {
            const view = new SubagentView(latest!, selected, theme,
              () => Math.floor(tui.terminal.rows * 0.9), () => tui.requestRender(), () => done());
            listener = (details) => details ? view.update(details) : done();
            viewers.add(listener);
            return view;
          }, { overlay: true, overlayOptions: { width: "96%", maxHeight: "90%" } });
        } finally {
          if (listener) viewers.delete(listener);
        }
      } else if (input === "cancel") {
        for (const controller of active) controller.abort();
        ctx.ui.notify("Cancelling active subagents", "info");
      } else if (input === "clear") {
        latest = undefined;
        for (const viewer of viewers) viewer(undefined);
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
    for (const viewer of viewers) viewer(undefined);
    for (const controller of active) controller.abort();
    await Promise.allSettled(pending);
    if (ctx.mode === "tui") {
      ctx.ui.setWidget("subagents", undefined);
      ctx.ui.setStatus("subagents", undefined);
    }
    latest = undefined;
  });
}
