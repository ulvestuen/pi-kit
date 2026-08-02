/**
 * Agent-native execution and result contracts for pi-kit.
 *
 * These types are the shared vocabulary between Fleet, Planner, Critic,
 * Orchestrator, and their direct child-process runtime. They have zero
 * runtime dependencies — only TypeScript interfaces and literal types — so
 * every package in the workspace can depend on them without circular imports.
 *
 * Versioned wire interfaces evolve by adding optional fields. Obsolete,
 * unversioned subsystem contracts may be removed when that subsystem is
 * retired.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Unique stable identifier for an agent run across all layers. */
export interface RunId {
  /** Stable across the whole orchestration. */
  runId: string;
  /** Planner task id. */
  taskId: string;
  /** 1-based dispatch attempt. */
  attempt: number;
  /** Wave the task belongs to. */
  wave: number;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/** Reference to an artifact that can be handed off between tasks. */
export interface ArtifactRef {
  type: "path" | "branch" | "commit" | "summary" | "patch" | "file-list";
  id: string;
  description: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Task / Result contracts
// ---------------------------------------------------------------------------

/** Structured input contract for an agent execution. */
export interface AgentTask {
  /** Schema version; starts at 1. */
  version: number;
  runId: RunId;
  role: string;
  prompt: string;
  inputArtifacts: ArtifactRef[];
  parentRuns: RunId[];
  constraints: {
    timeoutMs?: number;
    outputCapBytes?: number;
    isolation?: "none" | "worktree";
    cwd?: string;
  };
}

/** Structured result produced by an agent execution. */
export interface AgentResult {
  /** Schema version. */
  version: number;
  runId: RunId;
  status: "ok" | "error" | "timeout" | "aborted";
  output: string;
  outputArtifacts: ArtifactRef[];
  toolCalls: ToolCallSummary[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  durationMs: number;
  exitCode: number | null;
  fullTranscriptPath?: string;
  truncated: boolean;
}

/** Summary of one tool call made during execution. */
export interface ToolCallSummary {
  tool: string;
  args: unknown;
  result: string;
}

// ---------------------------------------------------------------------------
// Run events (observability)
// ---------------------------------------------------------------------------

/** One event in an append-only run log. */
export interface RunEvent {
  timestamp: number;
  runId: RunId;
  type:
    | "wave_start"
    | "task_start"
    | "task_end"
    | "check_start"
    | "check_end"
    | "evidence_start"
    | "evidence_end"
    | "review_start"
    | "review_end"
    | "commit_start"
    | "commit_end"
    | "wave_end";
  payload: unknown;
}
