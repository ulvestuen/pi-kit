import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  getAgent,
  mergeRegistries,
  parseAgentDefinition,
  type AgentDefinition,
} from "./registry.ts";
import {
  buildPiArgs,
  buildTaskPrompt,
  buildWorktreeArgs,
  capOutput,
  parsePiJsonOutput,
  runTasks,
  worktreeBranchName,
  type SpawnFn,
  type SpawnRequest,
  type TaskResult,
  type TaskSpec,
} from "./runner.ts";
import type { RunId, ArtifactRef } from "@pi-kit/agent-types";
import {
  buildTailCommand,
  createLineSplitter,
  createTmuxMirrorSpawn,
  formatPiEventLine,
  sanitizeTmuxName,
  type TmuxEffects,
} from "./tmux.ts";

const VALID_AGENT = `---
name: implementer
description: Implements one task.
model: claude-sonnet-5
thinkingLevel: medium
tools: read, bash, edit, write
---
You implement exactly one task.`;

function def(name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `${name} prompt`,
    source: `${name}.md`,
    ...overrides,
  };
}

function registryOf(...defs: AgentDefinition[]) {
  return mergeRegistries(defs);
}

/** Assistant message_end event line as emitted by pi --mode json. */
function assistantLine(text: string, stopReason = "stop"): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason,
      content: [{ type: "text", text }],
    },
  });
}

/** Spawn fake that resolves each pi call with a canned assistant reply. */
function okSpawn(
  reply = "done",
  onCall?: (req: SpawnRequest) => void,
): SpawnFn {
  return async (req) => {
    onCall?.(req);
    return { exitCode: 0, stdout: `${assistantLine(reply)}\n`, stderr: "" };
  };
}

describe("parseAgentDefinition", () => {
  it("parses a full definition", () => {
    const d = parseAgentDefinition("a.md", VALID_AGENT);
    assert.strictEqual(d.name, "implementer");
    assert.strictEqual(d.description, "Implements one task.");
    assert.strictEqual(d.model, "claude-sonnet-5");
    assert.strictEqual(d.thinkingLevel, "medium");
    assert.deepStrictEqual(d.tools, ["read", "bash", "edit", "write"]);
    assert.strictEqual(d.systemPrompt, "You implement exactly one task.");
    assert.strictEqual(d.source, "a.md");
  });

  it("leaves optional fields undefined", () => {
    const d = parseAgentDefinition(
      "a.md",
      "---\nname: x\ndescription: d\n---\nbody",
    );
    assert.strictEqual(d.model, undefined);
    assert.strictEqual(d.thinkingLevel, undefined);
    assert.strictEqual(d.tools, undefined);
  });

  it("strips quotes and inline comments from values", () => {
    const d = parseAgentDefinition(
      "a.md",
      '---\nname: "x"\ndescription: d\nmodel: gpt-5  # optional\n---\nbody',
    );
    assert.strictEqual(d.name, "x");
    assert.strictEqual(d.model, "gpt-5");
  });

  it("rejects a missing frontmatter block", () => {
    assert.throws(
      () => parseAgentDefinition("a.md", "no frontmatter"),
      /must start with/,
    );
  });

  it("rejects unterminated frontmatter", () => {
    assert.throws(
      () => parseAgentDefinition("a.md", "---\nname: x\n"),
      /unterminated/,
    );
  });

  it("rejects a missing name", () => {
    assert.throws(
      () => parseAgentDefinition("a.md", "---\ndescription: d\n---\nbody"),
      /"name" is required/,
    );
  });

  it("rejects invalid agent names", () => {
    assert.throws(
      () =>
        parseAgentDefinition(
          "a.md",
          "---\nname: bad name\ndescription: d\n---\nbody",
        ),
      /alphanumeric/,
    );
  });

  it("rejects a missing description", () => {
    assert.throws(
      () => parseAgentDefinition("a.md", "---\nname: x\n---\nbody"),
      /"description" is required/,
    );
  });

  it("rejects an empty body", () => {
    assert.throws(
      () => parseAgentDefinition("a.md", "---\nname: x\ndescription: d\n---\n"),
      /system prompt/,
    );
  });

  it("rejects an invalid thinkingLevel", () => {
    assert.throws(
      () =>
        parseAgentDefinition(
          "a.md",
          "---\nname: x\ndescription: d\nthinkingLevel: turbo\n---\nbody",
        ),
      /thinkingLevel/,
    );
  });

  it("rejects an empty tools list", () => {
    assert.throws(
      () =>
        parseAgentDefinition(
          "a.md",
          "---\nname: x\ndescription: d\ntools: ,\n---\nbody",
        ),
      /at least one tool/,
    );
  });
});

describe("mergeRegistries", () => {
  it("later layers win on name collision, case-insensitively", () => {
    const kit = [def("scout", { source: "kit/scout.md" })];
    const user = [def("Scout", { source: "user/scout.md" })];
    const registry = mergeRegistries(kit, user);
    assert.strictEqual(registry.size, 1);
    assert.strictEqual(getAgent(registry, "scout")!.source, "user/scout.md");
  });

  it("keeps non-colliding agents from all layers", () => {
    const registry = mergeRegistries([def("a")], [def("b")], [def("c")]);
    assert.strictEqual(registry.size, 3);
  });

  it("getAgent matches case-insensitively with trimming", () => {
    const registry = registryOf(def("Scout"));
    assert.ok(getAgent(registry, " scout "));
  });
});

describe("buildPiArgs", () => {
  it("builds the full non-interactive contract", () => {
    const d = parseAgentDefinition("a.md", VALID_AGENT);
    const args = buildPiArgs(d, { agent: "implementer", task: "do the thing" });
    assert.deepStrictEqual(args, [
      "--mode",
      "json",
      "--no-session",
      "--system-prompt",
      "You implement exactly one task.",
      "--model",
      "claude-sonnet-5",
      "--thinking",
      "medium",
      "--tools",
      "read,bash,edit,write",
      "do the thing",
    ]);
  });

  it("omits optional flags when the definition has none", () => {
    const args = buildPiArgs(def("x"), { agent: "x", task: "t" });
    assert.deepStrictEqual(args, [
      "--mode",
      "json",
      "--no-session",
      "--system-prompt",
      "x prompt",
      "t",
    ]);
  });

  it("appends artifacts and parent run IDs to the child brief", () => {
    const prompt = buildTaskPrompt({
      agent: "x",
      task: "implement the parser",
      inputArtifacts: [
        {
          type: "branch",
          id: "feature/parser",
          description: "parser implementation",
          location: "fleet/parser-1",
        },
      ],
      parentRunIds: ["parser-w1-a1"],
    });
    assert.match(prompt, /^implement the parser/);
    assert.match(prompt, /Input artifacts:/);
    assert.match(prompt, /branch: parser implementation at fleet\/parser-1/);
    assert.match(prompt, /Parent run IDs: parser-w1-a1/);
  });
});

describe("parsePiJsonOutput", () => {
  it("extracts the last assistant message text", () => {
    const stdout = [
      '{"type":"agent_start"}',
      assistantLine("first"),
      assistantLine("final answer"),
      "not json",
    ].join("\n");
    assert.deepStrictEqual(parsePiJsonOutput(stdout), {
      text: "final answer",
    });
  });

  it("reports error stop reasons", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "boom",
        content: [],
      },
    });
    assert.strictEqual(parsePiJsonOutput(line).errorMessage, "boom");
  });

  it("reports missing assistant output", () => {
    assert.match(
      parsePiJsonOutput("garbage\n{}").errorMessage!,
      /no assistant message/,
    );
  });
});

describe("capOutput", () => {
  it("passes short output through untouched", () => {
    assert.deepStrictEqual(capOutput("hello", 100), {
      output: "hello",
      truncated: false,
    });
  });

  it("truncates at the byte budget with a marker", () => {
    const { output, truncated } = capOutput("a".repeat(100), 10);
    assert.strictEqual(truncated, true);
    assert.ok(output.startsWith("a".repeat(10)));
    assert.match(output, /truncated at 10 bytes/);
  });

  it("counts multi-byte characters by UTF-8 size", () => {
    // "é" is 2 bytes in UTF-8, so 5 of them blow a 9-byte budget.
    const { truncated } = capOutput("é".repeat(5), 9);
    assert.strictEqual(truncated, true);
    assert.strictEqual(capOutput("é".repeat(4), 9).truncated, false);
  });
});

describe("worktree helpers", () => {
  it("builds git worktree add args", () => {
    assert.deepStrictEqual(buildWorktreeArgs("fleet/task-1-5", "/tmp/wt"), [
      "worktree",
      "add",
      "-b",
      "fleet/task-1-5",
      "/tmp/wt",
    ]);
  });

  it("derives unique branch names from index and time", () => {
    assert.strictEqual(worktreeBranchName(0, 42), "fleet/task-1-42");
  });
});

describe("runTasks", () => {
  const registry = registryOf(def("worker"));

  it("returns results in task order", async () => {
    const results = await runTasks(
      registry,
      [
        { agent: "worker", task: "one" },
        { agent: "worker", task: "two" },
      ],
      { spawn: okSpawn("reply"), cwd: "/repo" },
    );
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => r.status === "ok"));
    assert.ok(results.every((r) => r.output === "reply"));
    assert.ok(results.every((r) => r.exitCode === 0));
  });

  it("rejects unknown agents with the known list", async () => {
    await assert.rejects(
      runTasks(registry, [{ agent: "nope", task: "t" }], {
        spawn: okSpawn(),
        cwd: "/repo",
      }),
      /Unknown agent "nope".*worker/,
    );
  });

  it("rejects batches over the cap", async () => {
    const tasks: TaskSpec[] = Array.from({ length: 3 }, () => ({
      agent: "worker",
      task: "t",
    }));
    await assert.rejects(
      runTasks(registry, tasks, { spawn: okSpawn(), cwd: "/repo", maxBatch: 2 }),
      /exceeds the maximum of 2/,
    );
  });

  it("rejects empty task text", async () => {
    await assert.rejects(
      runTasks(registry, [{ agent: "worker", task: "  " }], {
        spawn: okSpawn(),
        cwd: "/repo",
      }),
      /non-empty task text/,
    );
  });

  it("observes the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    const spawn: SpawnFn = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return { exitCode: 0, stdout: assistantLine("ok"), stderr: "" };
    };
    const tasks: TaskSpec[] = Array.from({ length: 6 }, (_, i) => ({
      agent: "worker",
      task: `t${i}`,
    }));
    await runTasks(registry, tasks, {
      spawn,
      cwd: "/repo",
      maxConcurrent: 2,
      maxBatch: 8,
    });
    assert.strictEqual(peak, 2);
  });

  it("times out slow tasks", async () => {
    const spawn: SpawnFn = (req) =>
      new Promise((resolve) => {
        req.signal.addEventListener("abort", () =>
          resolve({ exitCode: null, stdout: "", stderr: "" }),
        );
      });
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "slow", timeoutMs: 20 }],
      { spawn, cwd: "/repo" },
    );
    assert.strictEqual(result.status, "timeout");
    assert.match(result.output, /timed out after 20 ms/);
  });

  it("marks running tasks aborted on external abort", async () => {
    const controller = new AbortController();
    const spawn: SpawnFn = (req) =>
      new Promise((resolve) => {
        req.signal.addEventListener("abort", () =>
          resolve({ exitCode: null, stdout: "", stderr: "" }),
        );
        setTimeout(() => controller.abort(), 5);
      });
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t" }],
      { spawn, cwd: "/repo", signal: controller.signal },
    );
    assert.strictEqual(result.status, "aborted");
  });

  it("aborts queued tasks immediately once the signal fires", async () => {
    const controller = new AbortController();
    let calls = 0;
    const spawn: SpawnFn = async (req) => {
      calls++;
      controller.abort();
      return new Promise((resolve) => {
        const finish = () => resolve({ exitCode: null, stdout: "", stderr: "" });
        // The external abort has already propagated to the task signal by
        // the time this executor runs — honor it like the real adapter does.
        if (req.signal.aborted) return finish();
        req.signal.addEventListener("abort", finish);
      });
    };
    const results = await runTasks(
      registry,
      [
        { agent: "worker", task: "a" },
        { agent: "worker", task: "b" },
        { agent: "worker", task: "c" },
      ],
      { spawn, cwd: "/repo", maxConcurrent: 1, signal: controller.signal },
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(results[0].status, "aborted");
    assert.strictEqual(results[1].status, "aborted");
    assert.strictEqual(results[1].output, "task aborted before start");
    assert.strictEqual(results[2].status, "aborted");
  });

  it("caps model-visible output and saves the full transcript", async () => {
    const saved: string[] = [];
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t" }],
      {
        spawn: okSpawn("x".repeat(5000)),
        cwd: "/repo",
        outputCapBytes: 1024,
        saveFullOutput: (index, _spec, content) => {
          saved.push(content);
          return `/scratch/task-${index}.jsonl`;
        },
      },
    );
    assert.strictEqual(result.truncated, true);
    assert.ok(result.output.length < 5000);
    assert.strictEqual(result.fullOutputPath, "/scratch/task-0.jsonl");
    assert.match(saved[0], /message_end/);
  });

  it("reports child failures as error results", async () => {
    const spawn: SpawnFn = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "kaboom",
    });
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t" }],
      { spawn, cwd: "/repo" },
    );
    assert.strictEqual(result.status, "error");
    assert.match(result.output, /kaboom|no assistant message/);
    assert.strictEqual(result.exitCode, 1);
  });

  it("reports spawn exceptions as error results", async () => {
    const spawn: SpawnFn = async () => {
      throw new Error("ENOENT: pi not found");
    };
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t" }],
      { spawn, cwd: "/repo" },
    );
    assert.strictEqual(result.status, "error");
    assert.match(result.output, /ENOENT/);
  });

  it("emits task_start, task_update, and task_end events", async () => {
    const events: string[] = [];
    const spawn: SpawnFn = async (req) => {
      req.onOutput?.("chunk");
      return { exitCode: 0, stdout: assistantLine("ok"), stderr: "" };
    };
    await runTasks(registry, [{ agent: "worker", task: "t" }], {
      spawn,
      cwd: "/repo",
      onEvent: (e) => events.push(e.type),
    });
    assert.deepStrictEqual(events, ["task_start", "task_update", "task_end"]);
  });

  it("requires a worktreeRoot for worktree isolation", async () => {
    await assert.rejects(
      runTasks(
        registry,
        [{ agent: "worker", task: "t", isolation: "worktree" }],
        { spawn: okSpawn(), cwd: "/repo" },
      ),
      /worktreeRoot/,
    );
  });

  it("creates a worktree, runs the child inside it, and reports the branch", async () => {
    const calls: SpawnRequest[] = [];
    const spawn: SpawnFn = async (req) => {
      calls.push(req);
      return { exitCode: 0, stdout: assistantLine("done"), stderr: "" };
    };
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t", isolation: "worktree" }],
      {
        spawn,
        cwd: "/repo",
        worktreeRoot: "/scratch/wt",
        now: () => 7,
      },
    );
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].command, "git");
    assert.deepStrictEqual(calls[0].args, [
      "worktree",
      "add",
      "-b",
      "fleet/task-1-7",
      "/scratch/wt/fleet-task-1-7",
    ]);
    assert.strictEqual(calls[0].cwd, "/repo");
    assert.strictEqual(calls[1].cwd, "/scratch/wt/fleet-task-1-7");
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.branch, "fleet/task-1-7");
    assert.strictEqual(result.worktreePath, "/scratch/wt/fleet-task-1-7");
  });

  it("fails the task when worktree creation fails", async () => {
    const spawn: SpawnFn = async (req) => {
      if (req.command === "git") {
        return { exitCode: 128, stdout: "", stderr: "fatal: not a git repo" };
      }
      return { exitCode: 0, stdout: assistantLine("done"), stderr: "" };
    };
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t", isolation: "worktree" }],
      { spawn, cwd: "/repo", worktreeRoot: "/scratch/wt" },
    );
    assert.strictEqual(result.status, "error");
    assert.match(result.output, /not a git repo/);
  });
});

describe("tmux mirror", () => {
  const registry = registryOf(def("worker"));

  it("labels the pi child spawn but not auxiliary git spawns", async () => {
    const calls: SpawnRequest[] = [];
    await runTasks(registry, [{ agent: "worker", task: "t", isolation: "worktree" }], {
      spawn: okSpawn("done", (req) => calls.push(req)),
      cwd: "/repo",
      worktreeRoot: "/scratch/wt",
    });
    assert.strictEqual(calls[0].command, "git");
    assert.strictEqual(calls[0].label, undefined);
    assert.strictEqual(calls[1].label, "1-worker");
  });

  it("sanitizes window names", () => {
    assert.strictEqual(sanitizeTmuxName("1-implementer"), "1-implementer");
    assert.strictEqual(sanitizeTmuxName("a b:c.d/e"), "a-b-c-d-e");
    assert.strictEqual(sanitizeTmuxName("..."), "task");
  });

  it("quotes log paths for the tail command", () => {
    assert.strictEqual(
      buildTailCommand("/tmp/it's.log"),
      "tail -f -n +1 '/tmp/it'\\''s.log'",
    );
  });

  it("splits chunks into lines and flushes the remainder", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((l) => lines.push(l));
    splitter.push("one\ntw");
    splitter.push("o\nthr");
    splitter.flush();
    assert.deepStrictEqual(lines, ["one", "two", "thr"]);
  });

  it("formats assistant messages and tool calls, suppresses noise", () => {
    assert.strictEqual(
      formatPiEventLine(assistantLine("hello")),
      "\n[assistant]\nhello",
    );
    const withTool = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash" }],
      },
    });
    assert.strictEqual(formatPiEventLine(withTool), "\n[assistant]\n→ tool: bash");
    assert.strictEqual(formatPiEventLine("plain text"), "plain text");
    assert.strictEqual(formatPiEventLine(""), null);
    assert.strictEqual(
      formatPiEventLine(JSON.stringify({ type: "message_update" })),
      null,
    );
  });

  /** Fake tmux effects recording calls and in-memory logs. */
  function fakeEffects(behavior: { failCreate?: boolean } = {}) {
    const calls: string[][] = [];
    const logs = new Map<string, string>();
    let sessionExists = false;
    let windowSeq = 0;
    const effects: TmuxEffects = {
      tmux: async (args) => {
        calls.push(args);
        if (args[0] === "has-session") {
          return { exitCode: sessionExists ? 0 : 1, stdout: "", stderr: "" };
        }
        if (args[0] === "new-session" || args[0] === "new-window") {
          if (behavior.failCreate) {
            return { exitCode: 1, stdout: "", stderr: "no server" };
          }
          sessionExists = true;
          return { exitCode: 0, stdout: `@${++windowSeq}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      createLogFile: (label) => {
        const file = `/logs/${label}.log`;
        logs.set(file, "");
        return file;
      },
      appendToLog: (file, text) => {
        logs.set(file, (logs.get(file) ?? "") + text);
      },
    };
    return { effects, calls, logs };
  }

  /** Inner spawn that streams JSONL through onOutput before resolving. */
  const streamingInner: SpawnFn = async (req) => {
    const stdout = `${assistantLine("all done")}\n`;
    req.onOutput?.(stdout);
    return { exitCode: 0, stdout, stderr: "" };
  };

  it("opens a session for the first window and reuses it after", async () => {
    const { effects, calls } = fakeEffects();
    const spawn = createTmuxMirrorSpawn(streamingInner, effects, {
      sessionName: "pi-agents",
    });
    const signal = new AbortController().signal;
    await spawn({ command: "pi", args: [], cwd: "/repo", signal, label: "1-worker" });
    await spawn({ command: "pi", args: [], cwd: "/repo", signal, label: "2-worker" });
    const creates = calls.filter((c) => c[0] === "new-session" || c[0] === "new-window");
    assert.deepStrictEqual(creates.map((c) => c[0]), ["new-session", "new-window"]);
    assert.ok(creates[0].includes("1-worker"));
    assert.ok(creates[1].includes("2-worker"));
    assert.ok(creates[1].includes("pi-agents:"));
  });

  it("mirrors formatted output and a footer into the window's log", async () => {
    const { effects, logs } = fakeEffects();
    const spawn = createTmuxMirrorSpawn(streamingInner, effects, {
      sessionName: "pi-agents",
    });
    await spawn({
      command: "pi",
      args: [],
      cwd: "/repo",
      signal: new AbortController().signal,
      label: "1-worker",
    });
    const log = logs.get("/logs/1-worker.log")!;
    assert.match(log, /\[fleet\] 1-worker/);
    assert.match(log, /\[assistant\]\nall done/);
    assert.match(log, /exited 0/);
  });

  it("still forwards output to the original onOutput", async () => {
    const { effects } = fakeEffects();
    const spawn = createTmuxMirrorSpawn(streamingInner, effects, {
      sessionName: "pi-agents",
    });
    const chunks: string[] = [];
    const outcome = await spawn({
      command: "pi",
      args: [],
      cwd: "/repo",
      signal: new AbortController().signal,
      label: "1-worker",
      onOutput: (c) => chunks.push(c),
    });
    assert.strictEqual(outcome.exitCode, 0);
    assert.strictEqual(chunks.length, 1);
  });

  it("passes unlabeled requests through without touching tmux", async () => {
    const { effects, calls } = fakeEffects();
    const spawn = createTmuxMirrorSpawn(streamingInner, effects, {
      sessionName: "pi-agents",
    });
    await spawn({ command: "git", args: ["status"], cwd: "/repo", signal: new AbortController().signal });
    assert.deepStrictEqual(calls, []);
  });

  it("kills the window by id when closeWindows is set", async () => {
    const { effects, calls } = fakeEffects();
    const spawn = createTmuxMirrorSpawn(streamingInner, effects, {
      sessionName: "pi-agents",
      closeWindows: true,
    });
    await spawn({
      command: "pi",
      args: [],
      cwd: "/repo",
      signal: new AbortController().signal,
      label: "1-worker",
    });
    assert.deepStrictEqual(calls[calls.length - 1], ["kill-window", "-t", "@1"]);
  });

  it("degrades to plain runs after the first tmux failure", async () => {
    const { effects, calls } = fakeEffects({ failCreate: true });
    const errors: string[] = [];
    const spawn = createTmuxMirrorSpawn(streamingInner, effects, {
      sessionName: "pi-agents",
      onError: (m) => errors.push(m),
    });
    const signal = new AbortController().signal;
    const first = await spawn({ command: "pi", args: [], cwd: "/r", signal, label: "1-worker" });
    assert.strictEqual(first.exitCode, 0);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /no server/);
    const callsBefore = calls.length;
    const second = await spawn({ command: "pi", args: [], cwd: "/r", signal, label: "2-worker" });
    assert.strictEqual(second.exitCode, 0);
    assert.strictEqual(calls.length, callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Agent-native contracts: RunId propagation, parentBranch, backward compat
// ---------------------------------------------------------------------------

describe("agent-native: RunId propagation", () => {
  const registry = registryOf(def("worker"));

  it("propagates runId from TaskSpec to TaskResult", async () => {
    const runId: RunId = {
      runId: "r-prop-1",
      taskId: "t-prop-1",
      attempt: 1,
      wave: 1,
    };
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t", runId }],
      { spawn: okSpawn("done"), cwd: "/repo" },
    );
    assert.deepStrictEqual(result.runId, runId);
  });

  it("runId is undefined when TaskSpec omits it (backward compat)", async () => {
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t" }],
      { spawn: okSpawn("ok"), cwd: "/repo" },
    );
    assert.strictEqual(result.runId, undefined);
  });

  it("propagates runId through abort path", async () => {
    const controller = new AbortController();
    const runId: RunId = {
      runId: "r-abort",
      taskId: "t-abort",
      attempt: 1,
      wave: 1,
    };
    const spawn: SpawnFn = async (req) => {
      controller.abort();
      return new Promise((resolve) => {
        const finish = () => resolve({ exitCode: null, stdout: "", stderr: "" });
        if (req.signal.aborted) return finish();
        req.signal.addEventListener("abort", finish);
      });
    };
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t", runId }],
      { spawn, cwd: "/repo", signal: controller.signal },
    );
    assert.deepStrictEqual(result.runId, runId);
    assert.strictEqual(result.status, "aborted");
  });

  it("propagates runId through timeout path", async () => {
    const runId: RunId = {
      runId: "r-timeout",
      taskId: "t-timeout",
      attempt: 1,
      wave: 2,
    };
    const spawn: SpawnFn = (req) =>
      new Promise((resolve) => {
        req.signal.addEventListener("abort", () =>
          resolve({ exitCode: null, stdout: "", stderr: "" }),
        );
      });
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "slow", runId, timeoutMs: 20 }],
      { spawn, cwd: "/repo" },
    );
    assert.deepStrictEqual(result.runId, runId);
    assert.strictEqual(result.status, "timeout");
    assert.match(result.output, /timed out/);
  });

  it("propagates runId through error path (child failure)", async () => {
    const runId: RunId = {
      runId: "r-error",
      taskId: "t-error",
      attempt: 3,
      wave: 1,
    };
    const spawn: SpawnFn = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "kaboom",
    });
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "failing", runId }],
      { spawn, cwd: "/repo" },
    );
    assert.deepStrictEqual(result.runId, runId);
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.exitCode, 1);
  });
});

describe("agent-native: parentBranch worktree", () => {
  const registry = registryOf(def("worker"));

  it("passes parentBranch to buildWorktreeArgs for prerequisite branch handoff", async () => {
    const calls: SpawnRequest[] = [];
    const spawn: SpawnFn = async (req) => {
      calls.push(req);
      return { exitCode: 0, stdout: assistantLine("done"), stderr: "" };
    };
    const runId: RunId = {
      runId: "r-wt",
      taskId: "t-wt",
      attempt: 1,
      wave: 2,
    };
    const [result] = await runTasks(
      registry,
      [{
        agent: "worker",
        task: "continue",
        isolation: "worktree",
        parentBranch: "feat/prerequisite",
        runId,
      }],
      {
        spawn,
        cwd: "/repo",
        worktreeRoot: "/scratch/wt",
        now: () => 100,
      },
    );
    // git worktree add should include the parentBranch argument
    assert.strictEqual(calls[0].command, "git");
    assert.ok(calls[0].args.includes("feat/prerequisite"));
    // The branch should be forked from the parent, not from HEAD
    assert.deepStrictEqual(calls[0].args, [
      "worktree", "add", "-b", "fleet/task-1-100",
      "feat/prerequisite",
      "/scratch/wt/fleet-task-1-100",
    ]);
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.runId, runId);
  });

  it("preserves runId when parentBranch worktree creation fails", async () => {
    const runId: RunId = {
      runId: "r-wt-fail",
      taskId: "t-wt-fail",
      attempt: 1,
      wave: 3,
    };
    const spawn: SpawnFn = async (req) => {
      if (req.command === "git") {
        return { exitCode: 128, stdout: "", stderr: "fatal: not a git repo" };
      }
      return { exitCode: 0, stdout: assistantLine("done"), stderr: "" };
    };
    const [result] = await runTasks(
      registry,
      [{
        agent: "worker",
        task: "t",
        isolation: "worktree",
        parentBranch: "feat/broken",
        runId,
      }],
      { spawn, cwd: "/repo", worktreeRoot: "/scratch/wt" },
    );
    assert.strictEqual(result.status, "error");
    assert.deepStrictEqual(result.runId, runId);
    assert.match(result.output, /not a git repo/);
  });
});

describe("agent-native: inputArtifacts and outputArtifacts", () => {
  const registry = registryOf(def("worker"));

  it("passes inputArtifacts and parentRunIds to the child prompt", async () => {
    const inputArtifacts: ArtifactRef[] = [
      { type: "branch", id: "feat-a", description: "prerequisite" },
      { type: "summary", id: "rev-1", description: "review" },
    ];
    let childPrompt = "";
    const [result] = await runTasks(
      registry,
      [{
        agent: "worker",
        task: "t",
        inputArtifacts,
        parentRunIds: ["parent-1"],
      }],
      {
        spawn: okSpawn("ok", (request) => {
          childPrompt = request.args.at(-1) ?? "";
        }),
        cwd: "/repo",
      },
    );
    assert.strictEqual(result.status, "ok");
    assert.match(childPrompt, /branch: prerequisite at feat-a/);
    assert.match(childPrompt, /summary: review at rev-1/);
    assert.match(childPrompt, /Parent run IDs: parent-1/);
    // Structured result parsing is not implemented yet.
    assert.strictEqual(result.outputArtifacts, undefined);
  });

  it("TaskResult without agent-native fields has them as undefined", async () => {
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t" }],
      { spawn: okSpawn("done"), cwd: "/repo" },
    );
    // Legacy callers don't set agent-native fields; they come back undefined
    assert.strictEqual(result.runId, undefined);
    assert.strictEqual(result.outputArtifacts, undefined);
    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.usage, undefined);
  });
});

describe("agent-native: backward compatibility", () => {
  const registry = registryOf(def("worker"));

  it("plain TaskSpec with no agent-native fields produces a valid TaskResult", async () => {
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "do the thing" }],
      { spawn: okSpawn("result text"), cwd: "/repo" },
    );
    assert.strictEqual(result.agent, "worker");
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.output, "result text");
    assert.strictEqual(result.truncated, false);
    assert.ok(typeof result.durationMs === "number");
    // No agent-native fields should be set
    assert.strictEqual(result.runId, undefined);
    assert.strictEqual(result.outputArtifacts, undefined);
    assert.strictEqual(result.toolCalls, undefined);
    assert.strictEqual(result.usage, undefined);
  });

  it("worktree isolation without parentBranch defaults to HEAD", async () => {
    const calls: SpawnRequest[] = [];
    const spawn: SpawnFn = async (req) => {
      calls.push(req);
      return { exitCode: 0, stdout: assistantLine("done"), stderr: "" };
    };
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t", isolation: "worktree" }],
      {
        spawn,
        cwd: "/repo",
        worktreeRoot: "/scratch/wt",
        now: () => 42,
      },
    );
    // Without parentBranch, git worktree add gets just branch + path (no extra arg)
    assert.deepStrictEqual(calls[0].args, [
      "worktree", "add", "-b", "fleet/task-1-42",
      "/scratch/wt/fleet-task-1-42",
    ]);
    assert.strictEqual(result.status, "ok");
  });

  it("all results retain legacy fields (agent, status, output, truncated, etc.)", async () => {
    const results = await runTasks(
      registry,
      [
        { agent: "worker", task: "t1" },
        { agent: "worker", task: "t2" },
      ],
      { spawn: okSpawn("done"), cwd: "/repo" },
    );
    for (const r of results) {
      assert.strictEqual(typeof r.agent, "string");
      assert.ok(["ok", "error", "timeout", "aborted"].includes(r.status));
      assert.strictEqual(typeof r.output, "string");
      assert.strictEqual(typeof r.truncated, "boolean");
      assert.ok(typeof r.durationMs === "number");
    }
  });

  it("legacy TaskResult destructuring still works (old consumer pattern)", async () => {
    const [result] = await runTasks(
      registry,
      [{ agent: "worker", task: "t" }],
      { spawn: okSpawn("hello"), cwd: "/repo" },
    );
    // Old code pattern: destructure only legacy fields
    const { agent, status, output, truncated, durationMs, exitCode } = result;
    assert.strictEqual(agent, "worker");
    assert.strictEqual(status, "ok");
    assert.strictEqual(output, "hello");
    assert.strictEqual(truncated, false);
    assert.ok(typeof durationMs === "number");
    assert.strictEqual(exitCode, 0);
  });
});

describe("agent-native: buildWorktreeArgs parentBranch", () => {
  it("includes parentBranch when given", () => {
    const args = buildWorktreeArgs("fleet/task-1-42", "/wt/path", "feat/base");
    assert.deepStrictEqual(args, [
      "worktree", "add", "-b", "fleet/task-1-42",
      "feat/base",
      "/wt/path",
    ]);
  });

  it("omits parentBranch when undefined", () => {
    const args = buildWorktreeArgs("fleet/task-1-42", "/wt/path");
    assert.deepStrictEqual(args, [
      "worktree", "add", "-b", "fleet/task-1-42",
      "/wt/path",
    ]);
  });
});
