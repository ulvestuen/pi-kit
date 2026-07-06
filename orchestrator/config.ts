import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_OUTPUT_CAP_BYTES,
  DEFAULT_PI_BINARY,
  DEFAULT_TIMEOUT_MS,
} from "../fleet/runner.ts";
import { DEFAULT_TMUX_SESSION, type TmuxSettings } from "../fleet/tmux.ts";
import { DEFAULT_MAX_ATTEMPTS } from "./scheduler.ts";

const DEFAULT_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * orchestrator configuration. All fields are optional with sensible
 * defaults, so the extension works with zero configuration.
 */
export interface OrchestratorConfig extends TmuxSettings {
  /** Dispatch-wave width, forwarded to the fleet runner. */
  maxConcurrent: number;
  /** Per-task re-dispatch cap after a failed attempt or review. */
  maxAttempts: number;
  /** Working-tree isolation for implementation tasks. */
  isolation: "none" | "worktree";
  /** Timeout for one implementation task in milliseconds. */
  taskTimeoutMs: number;
  /** Timeout for one critic review in milliseconds. */
  reviewTimeoutMs: number;
  /** Cap on model-visible output per sub-agent task, in bytes. */
  outputCapBytes: number;
  /** Model override for critic reviews; empty = the agent definition's model. */
  criticModel?: string;
  /** Fleet agent assigned to tasks that name none. */
  defaultAgent: string;
  /** The pi binary spawned for sub-agents. */
  piBinary: string;
  /** Resolved config file path, if one was loaded. */
  configPath?: string;
}

interface RawOrchestratorConfig {
  maxConcurrent?: number | string;
  maxAttempts?: number | string;
  isolation?: string;
  taskTimeoutMs?: number | string;
  reviewTimeoutMs?: number | string;
  outputCapBytes?: number | string;
  criticModel?: string;
  defaultAgent?: string;
  piBinary?: string;
  tmux?: boolean | string;
  tmuxSession?: string;
  tmuxCloseWindows?: boolean | string;
}

function getDefaultPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

export function getConfigPath(): string {
  return (
    process.env.ORCHESTRATOR_CONFIG_PATH ||
    path.join(
      getDefaultPiAgentDir(),
      "extensions",
      "orchestrator",
      "orchestrator.json",
    )
  );
}

function parseNumber(
  value: number | string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number (got: ${value})`);
  }
  return parsed;
}

function parseBoolean(
  value: boolean | string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function loadRawConfig(): { raw: RawOrchestratorConfig; configPath?: string } {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `orchestrator config ${configPath} must contain a JSON object`,
      );
    }
    return { raw: parsed as RawOrchestratorConfig, configPath };
  }
  return {
    raw: {
      maxConcurrent: process.env.ORCHESTRATOR_MAX_CONCURRENT,
      maxAttempts: process.env.ORCHESTRATOR_MAX_ATTEMPTS,
      isolation: process.env.ORCHESTRATOR_ISOLATION,
      taskTimeoutMs: process.env.ORCHESTRATOR_TASK_TIMEOUT_MS,
      reviewTimeoutMs: process.env.ORCHESTRATOR_REVIEW_TIMEOUT_MS,
      outputCapBytes: process.env.ORCHESTRATOR_OUTPUT_CAP_BYTES,
      criticModel: process.env.ORCHESTRATOR_CRITIC_MODEL,
      defaultAgent: process.env.ORCHESTRATOR_DEFAULT_AGENT,
      piBinary: process.env.ORCHESTRATOR_PI_BINARY,
      tmux: process.env.ORCHESTRATOR_TMUX,
      tmuxSession: process.env.ORCHESTRATOR_TMUX_SESSION,
      tmuxCloseWindows: process.env.ORCHESTRATOR_TMUX_CLOSE_WINDOWS,
    },
  };
}

export function loadConfig(): OrchestratorConfig {
  const { raw, configPath } = loadRawConfig();

  const maxConcurrent = parseNumber(
    raw.maxConcurrent,
    DEFAULT_MAX_CONCURRENT,
    "maxConcurrent",
  );
  if (maxConcurrent < 1) {
    throw new Error(`maxConcurrent must be at least 1 (got: ${maxConcurrent})`);
  }

  const maxAttempts = parseNumber(
    raw.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
  );
  if (maxAttempts < 1) {
    throw new Error(`maxAttempts must be at least 1 (got: ${maxAttempts})`);
  }

  const isolation = (raw.isolation?.trim() || "none") as "none" | "worktree";
  if (isolation !== "none" && isolation !== "worktree") {
    throw new Error(
      `isolation must be "none" or "worktree" (got: ${raw.isolation})`,
    );
  }

  const taskTimeoutMs = parseNumber(
    raw.taskTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    "taskTimeoutMs",
  );
  const reviewTimeoutMs = parseNumber(
    raw.reviewTimeoutMs,
    DEFAULT_REVIEW_TIMEOUT_MS,
    "reviewTimeoutMs",
  );
  if (taskTimeoutMs < 1000 || reviewTimeoutMs < 1000) {
    throw new Error("timeouts must be at least 1000 ms");
  }

  const outputCapBytes = parseNumber(
    raw.outputCapBytes,
    DEFAULT_OUTPUT_CAP_BYTES,
    "outputCapBytes",
  );
  if (outputCapBytes < 1024) {
    throw new Error(
      `outputCapBytes must be at least 1024 (got: ${outputCapBytes})`,
    );
  }

  return {
    maxConcurrent: Math.round(maxConcurrent),
    maxAttempts: Math.round(maxAttempts),
    isolation,
    taskTimeoutMs: Math.round(taskTimeoutMs),
    reviewTimeoutMs: Math.round(reviewTimeoutMs),
    outputCapBytes: Math.round(outputCapBytes),
    criticModel: raw.criticModel?.trim() || undefined,
    defaultAgent: raw.defaultAgent?.trim() || "implementer",
    piBinary: raw.piBinary?.trim() || DEFAULT_PI_BINARY,
    tmux: parseBoolean(raw.tmux, true),
    tmuxSession: raw.tmuxSession?.trim() || DEFAULT_TMUX_SESSION,
    tmuxCloseWindows: parseBoolean(raw.tmuxCloseWindows, false),
    configPath,
  };
}
