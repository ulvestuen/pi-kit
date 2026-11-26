// /swarm: turn this session into the coordinator of named Pi workers that collaborate on a shared append-only board.
// Workers are `pi --mode rpc` children woken only by @mentions; a 127.0.0.1 web page shows the roster, the board,
// and each worker's transcript, and lets the human post. See a3/swarm.md and README.md.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { piInvocation } from "./driver.ts";
import { COORDINATOR } from "./router.ts";
import { parseSwarmArgs, Swarm } from "./swarm.ts";
import { describeStatus } from "./worktree.ts";
import { formatMessages } from "./worker-ext.ts";

export const SWARM_TOOLS = ["swarm_add", "swarm_status", "swarm_kill", "board_post", "board_read"];

const HELP = [
  "/swarm <goal> [--max-active N] [--max-workers N] [--max-wakes N] [--port N]  start a swarm; this session coordinates",
  "/swarm ui      show and open the local web UI",
  "/swarm status  roster, queue, and worktrees",
  "/swarm stop    stop workers and the web UI; report unmerged worktrees",
].join("\n");

export function coordinatorRules(swarm: Pick<Swarm, "id" | "goal" | "limits">): string {
  return [
    `You are @coordinator of Pi swarm ${swarm.id}. Goal: ${swarm.goal}`,
    "- Split the goal into a few non-overlapping tracks with clear owners and done criteria. Spawn one worker per track with swarm_add; its brief is posted to the board as an @mention and wakes it.",
    '- Use workspace "worktree" for every worker that edits files in parallel with others; use "inherit" (shared checkout) for readers, reviewers, and verifiers.',
    "- Wire collaboration in the briefs: say who hands work to whom (for example builder → @verifier → @coordinator).",
    `- Workers wake only when mentioned and report with @coordinator. After spawning, end your turn: you are woken with unread board messages. Never poll swarm_status in a loop.`,
    "- Merge finished worktree branches yourself (git merge in the main checkout), then swarm_kill the worker to remove its worktree. swarm_kill refuses unmerged work unless force is set; only force when the user agrees to discard it.",
    `- At most ${swarm.limits.maxActive} workers run at once (more wait in a queue), at most ${swarm.limits.maxWorkers} exist at once.`,
    "- Messages from @human are the user's steering; follow them. When the goal is met, summarize the outcome for the user and tell them they can run /swarm stop.",
  ].join("\n");
}

function modelSpec(ctx: ExtensionContext, thinking: string): string | undefined {
  if (!ctx.model) return undefined;
  const base = `${ctx.model.provider}/${ctx.model.id}`;
  return thinking && thinking !== "off" ? `${base}:${thinking}` : base;
}

function text(t: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text: t }], details };
}

export default function swarmExtension(pi: ExtensionAPI) {
  // Workers load the user's extensions too; their board tools come from worker-ext.ts, and they cannot nest swarms.
  if (process.env.PI_SWARM_ROLE === "worker") return;

  let swarm: Swarm | null = null;
  let statusCtx: ExtensionContext | null = null;
  let offStatus: (() => void) | null = null;

  const need = (): Swarm => {
    if (!swarm) throw new Error("No swarm is running. Start one with /swarm <goal>.");
    return swarm;
  };

  const setTools = (on: boolean) => {
    const active = new Set(pi.getActiveTools());
    for (const name of SWARM_TOOLS) on ? active.add(name) : active.delete(name);
    pi.setActiveTools([...active]);
  };

  const footer = () => {
    if (!swarm || !statusCtx) return;
    const counts = new Map<string, number>();
    for (const m of swarm.liveMembers()) counts.set(m.state, (counts.get(m.state) ?? 0) + 1);
    const parts = [...counts].map(([state, n]) => `${n} ${state}`);
    try {
      statusCtx.ui.setStatus("swarm", `swarm ${parts.join(" · ") || "no workers"}`);
    } catch {
      /* the context can be gone after a session replacement */
    }
  };

  const teardown = async (cleanup: boolean): Promise<string | null> => {
    const current = swarm;
    if (!current) return null;
    swarm = null;
    offStatus?.();
    offStatus = null;
    try {
      statusCtx?.ui.setStatus("swarm", undefined);
    } catch {}
    statusCtx = null;
    setTools(false);
    const report = await current.stop(cleanup);
    return Swarm.describeStop(report, current.store.dir);
  };

  const openUrl = async (url: string) => {
    const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    await pi.exec(cmd as string, args as string[], { timeout: 5_000 }).catch(() => undefined);
  };

  pi.on("session_start", async () => {
    // Nothing survives a reload: keep the tools off until /swarm runs.
    if (!swarm) setTools(false);
  });

  pi.on("session_shutdown", async () => {
    await teardown(false);
  });

  pi.on("before_agent_start", async (event) => {
    if (swarm) event.systemPromptOptions.sections.swarm = coordinatorRules(swarm);
    else delete event.systemPromptOptions.sections.swarm;
  });

  pi.on("agent_start", async () => {
    await swarm?.router.working(COORDINATOR);
  });

  pi.on("agent_settled", async () => {
    await swarm?.router.settled(COORDINATOR);
  });

  pi.registerCommand("swarm", {
    description: "Coordinate named Pi workers on a shared @mention board with a local web UI (/swarm <goal> | ui | status | stop)",
    getArgumentCompletions: (prefix: string) => {
      const items = ["ui", "status", "stop"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      let command: ReturnType<typeof parseSwarmArgs>;
      try {
        command = parseSwarmArgs(args);
      } catch (error: any) {
        ctx.ui.notify(`${error.message}\n\n${HELP}`, "error");
        return;
      }
      if (command.action === "help") {
        ctx.ui.notify(swarm ? `Swarm ${swarm.id} running: ${swarm.url}\n\n${HELP}` : HELP, "info");
        return;
      }
      if (command.action === "ui") {
        if (!swarm) return ctx.ui.notify("No swarm is running.", "warning");
        ctx.ui.notify(`Swarm UI: ${swarm.url}`, "info");
        if (ctx.mode === "tui") await openUrl(swarm.url);
        return;
      }
      if (command.action === "status") {
        if (!swarm) return ctx.ui.notify("No swarm is running.", "warning");
        const s = await swarm.status();
        const lines = [`Swarm ${s.id} — ${s.goal}`, `UI: ${s.url}`, `State: ${s.dir}`, ...s.members.map((m) => `  @${m.name.padEnd(14)} ${m.state.padEnd(8)} ${m.workspace}${m.branch ? ` ${m.branch}` : ""}${m.model ? `  ${m.model}` : ""}`)];
        if (s.queued.length) lines.push(`Queued wakes: ${s.queued.map((n) => "@" + n).join(", ")}`);
        for (const w of s.worktrees) lines.push(`  ${describeStatus(w)}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (command.action === "stop") {
        const summary = await teardown(true);
        ctx.ui.notify(summary ?? "No swarm is running.", summary ? "info" : "warning");
        return;
      }
      if (command.action !== "start") return;
      if (swarm) {
        ctx.ui.notify(`Swarm ${swarm.id} is already running (${swarm.url}). /swarm stop first.`, "warning");
        return;
      }
      try {
        swarm = await Swarm.start({
          goal: command.goal,
          cwd: ctx.cwd,
          pi: piInvocation(),
          port: command.port,
          ...command.limits,
          coordinatorModel: modelSpec(ctx, pi.getThinkingLevel()),
          coordinator: {
            deliver: async (body) => {
              pi.sendMessage({ customType: "swarm-board", content: body, display: true }, { triggerTurn: true, deliverAs: "followUp" });
            },
            stop: async () => undefined,
          },
        });
      } catch (error: any) {
        ctx.ui.notify(`Could not start the swarm: ${error.message}`, "error");
        return;
      }
      statusCtx = ctx;
      offStatus = swarm.onEvent((event) => event.type === "roster" && footer());
      footer();
      setTools(true);
      ctx.ui.notify(`Swarm ${swarm.id} started.\nUI: ${swarm.url}\nState: ${swarm.store.dir}`, "info");
      const body = [
        `Coordinate a swarm for this goal. Split it into non-overlapping tracks, spawn named workers with swarm_add (brief, workspace), then end your turn; workers report back on the board with @coordinator.`,
        "",
        `Goal: ${command.goal}`,
      ].join("\n");
      if (ctx.isIdle()) pi.sendUserMessage(body);
      else pi.sendUserMessage(body, { deliverAs: "followUp" });
    },
  });

  pi.registerTool({
    name: "swarm_add",
    label: "Swarm add",
    description:
      'Spawn a named swarm worker with a fresh context and post its brief to the board as an @mention, which wakes it. workspace "inherit" shares the main checkout (readers, verifiers); "worktree" gives it an isolated git worktree and branch (parallel editors).',
    promptSnippet: "Spawn a named swarm worker and post its brief to the board",
    promptGuidelines: [
      "Use swarm_add once per non-overlapping track; give every worker that edits files in parallel workspace \"worktree\".",
      "After swarm_add calls, end the turn instead of polling swarm_status; workers wake the coordinator with @coordinator.",
    ],
    defaultActive: false,
    parameters: Type.Object({
      name: Type.String({ description: "Short lowercase handle, e.g. builder, verifier, docs" }),
      brief: Type.String({ description: "The assignment: scope, files it owns, done criteria, and whom to @mention when done" }),
      workspace: Type.Optional(StringEnum(["inherit", "worktree"] as const, { description: "inherit (default) = shared main checkout; worktree = isolated git worktree + branch" })),
      model: Type.Optional(Type.String({ description: "provider/model[:thinking]; defaults to the coordinator's model" })),
    }),
    async execute(_id, params) {
      const { member, brief } = await need().add(params);
      const where = member.workspace === "worktree" ? `worktree ${member.cwd} on ${member.branch}` : "the shared checkout";
      return text(`Spawned @${member.name} (${member.state}) in ${where}. Brief posted as #${brief.id}.`, { member, brief });
    },
  });

  pi.registerTool({
    name: "swarm_status",
    label: "Swarm status",
    description: "Show the swarm roster (state, workspace, branch, model), queued wakes, and each worktree's merge status.",
    promptSnippet: "Show swarm roster, queue, and worktree merge status",
    defaultActive: false,
    parameters: Type.Object({}),
    async execute() {
      const s = await need().status();
      const lines = [
        `Swarm ${s.id}: ${s.goal}`,
        ...s.members.map((m) => `@${m.name}: ${m.state}, ${m.workspace}${m.branch ? ` (${m.branch})` : ""}, last seen #${m.lastSeenMessageId}, wakes ${m.wakes}`),
        `Queued: ${s.queued.map((n) => "@" + n).join(", ") || "none"}. Latest message #${s.lastMessageId}.`,
        ...s.worktrees.map(describeStatus),
      ];
      return text(lines.join("\n"), s);
    },
  });

  pi.registerTool({
    name: "swarm_kill",
    label: "Swarm kill",
    description: "Stop a swarm worker for good. For a worktree worker, also removes its worktree and branch when the branch is merged and clean; refuses otherwise unless force is true (force discards unmerged work).",
    promptSnippet: "Stop a swarm worker and clean up its merged worktree",
    promptGuidelines: ["Use swarm_kill force only when the user agreed to discard that worker's unmerged work."],
    defaultActive: false,
    parameters: Type.Object({
      name: Type.String({ description: "Worker name" }),
      force: Type.Optional(Type.Boolean({ description: "Remove the worktree and branch even with unmerged or uncommitted work" })),
    }),
    async execute(_id, params) {
      const result = await need().kill(params.name.toLowerCase(), params.force ?? false);
      if (!result.worktree) return text(`@${params.name} is killed.`, result);
      const msg = result.removed
        ? `@${params.name} is killed; removed ${result.worktree.path} and branch ${result.worktree.branch}.`
        : `@${params.name} is killed, but its worktree was kept: ${describeStatus(result.worktree)}. Merge it, or call swarm_kill with force to discard.`;
      return text(msg, result);
    },
  });

  pi.registerTool({
    name: "board_post",
    label: "Board post",
    description: "Post to the swarm board as @coordinator. @name mentions (or @all) wake those members with every board message they have not seen.",
    promptSnippet: "Post to the swarm board as coordinator; @mentions wake members",
    defaultActive: false,
    parameters: Type.Object({
      body: Type.String({ description: "Markdown message with @name mentions for whoever should act" }),
      kind: Type.Optional(StringEnum(["message", "brief", "result", "question"] as const)),
    }),
    async execute(_id, params) {
      const m = await need().post(COORDINATOR, params.body, params.kind ?? "message");
      return text(`Posted #${m.id}${m.mentions.length ? ` mentioning ${m.mentions.map((x) => "@" + x).join(", ")}` : " (no mentions: nobody is woken)"}.`, m);
    },
  });

  pi.registerTool({
    name: "board_read",
    label: "Board read",
    description: "Read swarm board messages (newest first limit) and the roster. Unread messages arrive automatically when the coordinator is woken.",
    promptSnippet: "Read swarm board history",
    defaultActive: false,
    parameters: Type.Object({
      since: Type.Optional(Type.Integer({ minimum: 0 })),
      from: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_id, params) {
      const data = need().read(COORDINATOR, params);
      return text(formatMessages(data.messages), data);
    },
  });
}
