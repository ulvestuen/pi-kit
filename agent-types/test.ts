import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type {
  RunId,
  ArtifactRef,
  AgentTask,
  AgentResult,
  BackendCapabilities,
  KillResult,
  RunEvent,
  ToolCallSummary,
} from "./src/types.ts";

// ---------------------------------------------------------------------------
// Round-trip: construct every interface and verify shape
// ---------------------------------------------------------------------------

describe("RunId", () => {
  it("has all required fields", () => {
    const id: RunId = {
      runId: "r-1",
      taskId: "t-1",
      attempt: 1,
      wave: 1,
    };
    assert.strictEqual(id.runId, "r-1");
    assert.strictEqual(id.attempt, 1);
  });
});

describe("ArtifactRef", () => {
  it("accepts every valid type", () => {
    const types: ArtifactRef["type"][] = [
      "path", "branch", "commit", "summary", "patch", "file-list",
    ];
    for (const type of types) {
      const ref: ArtifactRef = { type, id: "x", description: "d" };
      assert.strictEqual(ref.type, type);
    }
  });

  it("allows optional location", () => {
    const ref: ArtifactRef = { type: "path", id: "p", description: "d", location: "/tmp/f" };
    assert.strictEqual(ref.location, "/tmp/f");
  });
});

describe("AgentTask", () => {
  it("constructs with minimal required fields", () => {
    const task: AgentTask = {
      version: 1,
      runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
      role: "implementer",
      prompt: "do the thing",
      inputArtifacts: [],
      parentRuns: [],
      constraints: {},
    };
    assert.strictEqual(task.version, 1);
    assert.strictEqual(task.inputArtifacts.length, 0);
  });

  it("accepts full constraints", () => {
    const task: AgentTask = {
      version: 2,
      runId: { runId: "r", taskId: "t", attempt: 2, wave: 3 },
      role: "critic",
      prompt: "review",
      inputArtifacts: [
        { type: "branch", id: "feat-1", description: "feature branch" },
      ],
      parentRuns: [
        { runId: "r0", taskId: "t0", attempt: 1, wave: 1 },
      ],
      constraints: {
        timeoutMs: 60000,
        outputCapBytes: 10240,
        isolation: "worktree",
        cwd: "/repo",
      },
    };
    assert.strictEqual(task.constraints.timeoutMs, 60000);
    assert.strictEqual(task.inputArtifacts[0].type, "branch");
  });
});

describe("AgentResult", () => {
  it("constructs with ok status and all fields", () => {
    const result: AgentResult = {
      version: 1,
      runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
      status: "ok",
      output: "done",
      outputArtifacts: [{ type: "path", id: "out", description: "output" }],
      toolCalls: [{ tool: "bash", args: { cmd: "ls" }, result: "file.ts" }],
      usage: { promptTokens: 100, completionTokens: 50 },
      durationMs: 5000,
      exitCode: 0,
      truncated: false,
    };
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.toolCalls.length, 1);
  });

  it("allows all four status values", () => {
    const statuses: AgentResult["status"][] = ["ok", "error", "timeout", "aborted"];
    for (const status of statuses) {
      const result: AgentResult = {
        version: 1,
        runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
        status,
        output: "",
        outputArtifacts: [],
        toolCalls: [],
        durationMs: 0,
        exitCode: null,
        truncated: false,
      };
      assert.strictEqual(result.status, status);
    }
  });

  it("allows optional fullTranscriptPath", () => {
    const result: AgentResult = {
      version: 1,
      runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
      status: "ok",
      output: "",
      outputArtifacts: [],
      toolCalls: [],
      durationMs: 100,
      exitCode: 0,
      truncated: true,
      fullTranscriptPath: "/tmp/transcript.jsonl",
    };
    assert.strictEqual(result.fullTranscriptPath, "/tmp/transcript.jsonl");
  });
});

describe("BackendCapabilities", () => {
  it("declares all capability flags", () => {
    const caps: BackendCapabilities = {
      workspaceMount: true,
      cursorOutput: false,
      confirmedKill: false,
      durableLogs: true,
      networkAccess: true,
      hardwareIsolation: false,
    };
    assert.strictEqual(caps.workspaceMount, true);
    assert.strictEqual(caps.hardwareIsolation, false);
  });
});

describe("KillResult", () => {
  it("reports stopped", () => {
    const kr: KillResult = { stopped: true };
    assert.strictEqual(kr.stopped, true);
  });

  it("reports alreadyComplete", () => {
    const kr: KillResult = { stopped: true, alreadyComplete: true, message: "done" };
    assert.strictEqual(kr.alreadyComplete, true);
  });

  it("reports not stopped", () => {
    const kr: KillResult = { stopped: false, message: "cannot reach backend" };
    assert.strictEqual(kr.stopped, false);
  });

  it("all optional fields are truly optional (no-arg construction)", () => {
    const kr: KillResult = { stopped: true };
    assert.strictEqual(kr.alreadyComplete, undefined);
    assert.strictEqual(kr.message, undefined);
  });
});

describe("RunEvent", () => {
  it("carries runId and typed payload", () => {
    const event: RunEvent = {
      timestamp: 1234,
      runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
      type: "task_end",
      payload: { status: "ok" },
    };
    assert.strictEqual(event.type, "task_end");
    assert.strictEqual(event.runId.runId, "r");
  });

  it("distinguishes critic review events from task execution events", () => {
    const event: RunEvent = {
      timestamp: 1235,
      runId: { runId: "review-r", taskId: "t", attempt: 1, wave: 1 },
      type: "review_end",
      payload: { passed: true },
    };
    assert.strictEqual(event.type, "review_end");
  });
});

describe("ToolCallSummary", () => {
  it("stores tool call info", () => {
    const tc: ToolCallSummary = {
      tool: "edit",
      args: { path: "/f.ts", replacement: "new" },
      result: "edited",
    };
    assert.strictEqual(tc.tool, "edit");
  });
});

// ---------------------------------------------------------------------------
// Schema versioning and migration
// ---------------------------------------------------------------------------

describe("schema versioning", () => {
  it("AgentTask version field distinguishes schema revisions", () => {
    const v1: AgentTask = {
      version: 1,
      runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
      role: "worker",
      prompt: "p",
      inputArtifacts: [],
      parentRuns: [],
      constraints: {},
    };
    assert.strictEqual(v1.version, 1);
    // Simulating a v2 consumer: it just reads whatever is there
    const loaded: AgentTask = v1 as AgentTask;
    assert.ok(loaded.version >= 1);
  });

  it("v0 data (no version field) is handled by downstream as version undefined", () => {
    // Legacy callers never set version — the field is simply absent.
    const legacyData: Record<string, unknown> = {
      runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
      role: "worker",
      prompt: "p",
      inputArtifacts: [],
      parentRuns: [],
      constraints: {},
    };
    // Downstream code can detect v0 by checking version === undefined
    assert.strictEqual((legacyData as unknown as AgentTask).version, undefined);
  });

  it("AgentResult version field distinguishes schema revisions", () => {
    const v1: AgentResult = {
      version: 1,
      runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
      status: "ok",
      output: "",
      outputArtifacts: [],
      toolCalls: [],
      durationMs: 0,
      exitCode: null,
      truncated: false,
    };
    assert.strictEqual(v1.version, 1);
    // v2 appends new optional fields; old consumers just see undefined
    const loaded = v1 as AgentResult;
    assert.ok(loaded.version >= 1);
  });
});

// ---------------------------------------------------------------------------
// Structured handoff: full artifact dependency chain
// ---------------------------------------------------------------------------

describe("structured artifact handoff", () => {
  it("AgentTask carries inputArtifacts from prerequisite tasks", () => {
    const parentArtifacts: ArtifactRef[] = [
      { type: "branch", id: "feat-a", description: "Prerequisite feature branch", location: "fleet/task-1-100" },
      { type: "summary", id: "review-summary", description: "Critic review summary" },
    ];
    const runId: RunId = { runId: "r-2", taskId: "t-2", attempt: 1, wave: 2 };
    const parentRun: RunId = { runId: "r-1", taskId: "t-1", attempt: 1, wave: 1 };

    const task: AgentTask = {
      version: 1,
      runId,
      role: "implementer",
      prompt: "Continue work based on prerequisites",
      inputArtifacts: parentArtifacts,
      parentRuns: [parentRun],
      constraints: { isolation: "worktree", cwd: "/repo" },
    };

    assert.strictEqual(task.inputArtifacts.length, 2);
    assert.strictEqual(task.inputArtifacts[0].type, "branch");
    assert.strictEqual(task.inputArtifacts[0].location, "fleet/task-1-100");
    assert.strictEqual(task.parentRuns.length, 1);
    assert.strictEqual(task.parentRuns[0].runId, "r-1");
  });

  it("AgentResult records output artifacts and tool calls", () => {
    const result: AgentResult = {
      version: 1,
      runId: { runId: "r-3", taskId: "t-3", attempt: 2, wave: 1 },
      status: "ok",
      output: "Changes complete.",
      outputArtifacts: [
        { type: "branch", id: "feat-b", description: "Completed feature branch" },
        { type: "patch", id: "patch-1", description: "diff of changes", location: "/tmp/patch.patch" },
      ],
      toolCalls: [
        { tool: "bash", args: { cmd: "git add -A" }, result: "" },
        { tool: "bash", args: { cmd: "git commit -m \"done\"" }, result: "[feat-b abc123] done" },
      ],
      usage: { promptTokens: 2500, completionTokens: 800 },
      durationMs: 12000,
      exitCode: 0,
      truncated: false,
    };

    assert.strictEqual(result.outputArtifacts.length, 2);
    assert.strictEqual(result.outputArtifacts[1].type, "patch");
    assert.strictEqual(result.toolCalls.length, 2);
    assert.strictEqual(result.toolCalls[0].tool, "bash");
    assert.strictEqual(result.usage?.promptTokens, 2500);
  });

  it("AgentResult without usage has usage undefined", () => {
    const result: AgentResult = {
      version: 1,
      runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
      status: "ok",
      output: "done",
      outputArtifacts: [],
      toolCalls: [],
      durationMs: 100,
      exitCode: 0,
      truncated: false,
    };
    assert.strictEqual(result.usage, undefined);
  });
});

// ---------------------------------------------------------------------------
// RunId identity across waves
// ---------------------------------------------------------------------------

describe("RunId identity", () => {
  it("RunId is unique across attempts within the same task", () => {
    const first: RunId = { runId: "r-1", taskId: "t-1", attempt: 1, wave: 1 };
    const retry: RunId = { runId: "r-1-t2", taskId: "t-1", attempt: 2, wave: 1 };
    assert.notStrictEqual(first.runId, retry.runId);
    assert.strictEqual(first.taskId, retry.taskId);
    assert.notStrictEqual(first.attempt, retry.attempt);
  });

  it("RunId distinguishes different waves", () => {
    const w1: RunId = { runId: "r-w1", taskId: "t-1", attempt: 1, wave: 1 };
    const w2: RunId = { runId: "r-w2", taskId: "t-2", attempt: 1, wave: 2 };
    assert.strictEqual(w1.wave, 1);
    assert.strictEqual(w2.wave, 2);
  });
});

// ---------------------------------------------------------------------------
// BackendCapabilities: each backend declares its contract
// ---------------------------------------------------------------------------

describe("BackendCapabilities per-backend contracts", () => {
  it("tmux: workspaceMount=true, confirmedKill=true, durableLogs=true", () => {
    const tmux: BackendCapabilities = {
      workspaceMount: true, cursorOutput: false, confirmedKill: true,
      durableLogs: true, networkAccess: true, hardwareIsolation: false,
    };
    assert.strictEqual(tmux.workspaceMount, true);
    assert.strictEqual(tmux.confirmedKill, true);
    assert.strictEqual(tmux.hardwareIsolation, false);
  });

  it("microsandbox: hardwareIsolation=true, workspaceMount=true", () => {
    const ms: BackendCapabilities = {
      workspaceMount: true, cursorOutput: false, confirmedKill: true,
      durableLogs: true, networkAccess: true, hardwareIsolation: true,
    };
    assert.strictEqual(ms.hardwareIsolation, true);
    assert.strictEqual(ms.workspaceMount, true);
  });

  it("exedev: no workspace mount, durable logs in VM", () => {
    const exedev: BackendCapabilities = {
      workspaceMount: false, cursorOutput: false, confirmedKill: true,
      durableLogs: true, networkAccess: true, hardwareIsolation: false,
    };
    assert.strictEqual(exedev.workspaceMount, false);
    assert.strictEqual(exedev.durableLogs, true);
  });
});

// ---------------------------------------------------------------------------
// KillResult protocol details
// ---------------------------------------------------------------------------

describe("KillResult protocol", () => {
  it("stopped + alreadyComplete = finished before kill", () => {
    const kr: KillResult = { stopped: true, alreadyComplete: true, message: "process exited before kill" };
    assert.strictEqual(kr.stopped, true);
    assert.strictEqual(kr.alreadyComplete, true);
  });

  it("stopped without alreadyComplete = killed actively", () => {
    const kr: KillResult = { stopped: true, alreadyComplete: false };
    assert.strictEqual(kr.stopped, true);
    assert.strictEqual(kr.alreadyComplete, false);
  });

  it("not stopped = kill failed", () => {
    const kr: KillResult = { stopped: false, message: "cannot reach process" };
    assert.strictEqual(kr.stopped, false);
    assert.strictEqual(kr.message, "cannot reach process");
  });
});

// ---------------------------------------------------------------------------
// JSON round-trip: serialize → parse → verify (IPC/serialization contract)
// ---------------------------------------------------------------------------

describe("JSON round-trip", () => {
  it("AgentTask survives JSON serialize/deserialize with all fields", () => {
    const task: AgentTask = {
      version: 1,
      runId: { runId: "r-json", taskId: "t-json", attempt: 2, wave: 3 },
      role: "implementer",
      prompt: "do something",
      inputArtifacts: [
        { type: "branch", id: "feat", description: "feature", location: "/wt" },
      ],
      parentRuns: [{ runId: "r-p", taskId: "t-p", attempt: 1, wave: 1 }],
      constraints: { timeoutMs: 5000, isolation: "worktree" },
    };
    const roundTripped: AgentTask = JSON.parse(JSON.stringify(task));
    assert.deepStrictEqual(roundTripped, task);
    assert.strictEqual(roundTripped.runId.runId, "r-json");
    assert.strictEqual(roundTripped.inputArtifacts[0].type, "branch");
    assert.strictEqual(roundTripped.constraints.timeoutMs, 5000);
  });

  it("AgentResult survives JSON serialize/deserialize with all fields", () => {
    const result: AgentResult = {
      version: 1,
      runId: { runId: "r-out", taskId: "t-out", attempt: 1, wave: 1 },
      status: "ok",
      output: "done",
      outputArtifacts: [
        { type: "path", id: "file", description: "output file", location: "/tmp/out" },
      ],
      toolCalls: [
        { tool: "bash", args: { cmd: "ls" }, result: "file.ts" },
      ],
      usage: { promptTokens: 100, completionTokens: 50 },
      durationMs: 3000,
      exitCode: 0,
      truncated: false,
      fullTranscriptPath: "/tmp/t.jsonl",
    };
    const roundTripped: AgentResult = JSON.parse(JSON.stringify(result));
    assert.deepStrictEqual(roundTripped, result);
    assert.strictEqual(roundTripped.outputArtifacts[0].location, "/tmp/out");
    assert.strictEqual(roundTripped.toolCalls[0].tool, "bash");
    assert.strictEqual(roundTripped.usage?.promptTokens, 100);
  });

  it("BackendCapabilities survives JSON round-trip", () => {
    const caps: BackendCapabilities = {
      workspaceMount: true,
      cursorOutput: false,
      confirmedKill: true,
      durableLogs: true,
      networkAccess: false,
      hardwareIsolation: true,
    };
    const roundTripped: BackendCapabilities = JSON.parse(JSON.stringify(caps));
    assert.deepStrictEqual(roundTripped, caps);
  });

  it("KillResult survives JSON round-trip with all optional fields", () => {
    const kr: KillResult = { stopped: true, alreadyComplete: true, message: "done" };
    const roundTripped: KillResult = JSON.parse(JSON.stringify(kr));
    assert.deepStrictEqual(roundTripped, kr);
  });
});

// ---------------------------------------------------------------------------
// Legacy consumer compatibility: old code sees only familiar fields
// ---------------------------------------------------------------------------

describe("legacy consumer compatibility", () => {
  it("legacy TaskResult shape has all original required fields", () => {
    // Simulating old code that destructures TaskResult without agent-native fields
    const legacyResult = {
      agent: "worker",
      status: "ok" as const,
      output: "done",
      truncated: false,
      durationMs: 1000,
      exitCode: 0,
      branch: undefined,
      worktreePath: undefined,
      // No runId, outputArtifacts, toolCalls, usage — old consumers don't know them
    };
    assert.strictEqual(legacyResult.agent, "worker");
    assert.strictEqual(legacyResult.status, "ok");
    assert.strictEqual(legacyResult.truncated, false);
    assert.ok(typeof legacyResult.durationMs === "number");
    // New optional fields are simply absent
    assert.strictEqual((legacyResult as any).runId, undefined);
    assert.strictEqual((legacyResult as any).outputArtifacts, undefined);
    assert.strictEqual((legacyResult as any).toolCalls, undefined);
    assert.strictEqual((legacyResult as any).usage, undefined);
  });

  it("v0 AgentTask (no version field) round-trips through JSON without error", () => {
    const v0 = {
      runId: { runId: "r", taskId: "t", attempt: 1, wave: 1 },
      role: "worker",
      prompt: "p",
      inputArtifacts: [],
      parentRuns: [],
      constraints: {},
    };
    const json = JSON.stringify(v0);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.version, undefined);
    assert.strictEqual(parsed.runId.runId, "r");
  });
});
