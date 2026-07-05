import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_BATCH,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_OUTPUT_CAP_BYTES,
  DEFAULT_PI_BINARY,
  DEFAULT_TIMEOUT_MS,
} from "./runner.ts";

/**
 * fleet configuration. All fields are optional with sensible defaults, so the
 * extension works with zero configuration.
 */
export interface FleetConfig {
  /** Concurrency pool size for sub-agent tasks. */
  maxConcurrent: number;
  /** Maximum tasks accepted in one fleet_run batch. */
  maxBatch: number;
  /** Default per-task timeout in milliseconds. */
  defaultTimeoutMs: number;
  /** Cap on model-visible output per task, in bytes. */
  outputCapBytes: number;
  /** The pi binary spawned for each sub-agent. */
  piBinary: string;
  /** Whether to inject the short delegation note into the system prompt. */
  injectSystemPrompt: boolean;
  /** Resolved config file path, if one was loaded. */
  configPath?: string;
}

interface RawFleetConfig {
  maxConcurrent?: number | string;
  maxBatch?: number | string;
  defaultTimeoutMs?: number | string;
  outputCapBytes?: number | string;
  piBinary?: string;
  injectSystemPrompt?: boolean | string;
}

function getDefaultPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

export function getConfigPath(): string {
  return (
    process.env.FLEET_CONFIG_PATH ||
    path.join(getDefaultPiAgentDir(), "extensions", "fleet", "fleet.json")
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

function loadRawConfig(): { raw: RawFleetConfig; configPath?: string } {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`fleet config ${configPath} must contain a JSON object`);
    }
    return { raw: parsed as RawFleetConfig, configPath };
  }
  return {
    raw: {
      maxConcurrent: process.env.FLEET_MAX_CONCURRENT,
      maxBatch: process.env.FLEET_MAX_BATCH,
      defaultTimeoutMs: process.env.FLEET_DEFAULT_TIMEOUT_MS,
      outputCapBytes: process.env.FLEET_OUTPUT_CAP_BYTES,
      piBinary: process.env.FLEET_PI_BINARY,
      injectSystemPrompt: process.env.FLEET_INJECT_SYSTEM_PROMPT,
    },
  };
}

export function loadConfig(): FleetConfig {
  const { raw, configPath } = loadRawConfig();

  const maxConcurrent = parseNumber(
    raw.maxConcurrent,
    DEFAULT_MAX_CONCURRENT,
    "maxConcurrent",
  );
  if (maxConcurrent < 1) {
    throw new Error(`maxConcurrent must be at least 1 (got: ${maxConcurrent})`);
  }

  const maxBatch = parseNumber(raw.maxBatch, DEFAULT_MAX_BATCH, "maxBatch");
  if (maxBatch < 1) {
    throw new Error(`maxBatch must be at least 1 (got: ${maxBatch})`);
  }

  const defaultTimeoutMs = parseNumber(
    raw.defaultTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    "defaultTimeoutMs",
  );
  if (defaultTimeoutMs < 1000) {
    throw new Error(
      `defaultTimeoutMs must be at least 1000 (got: ${defaultTimeoutMs})`,
    );
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
    maxBatch: Math.round(maxBatch),
    defaultTimeoutMs: Math.round(defaultTimeoutMs),
    outputCapBytes: Math.round(outputCapBytes),
    piBinary: raw.piBinary?.trim() || DEFAULT_PI_BINARY,
    injectSystemPrompt: parseBoolean(raw.injectSystemPrompt, true),
    configPath,
  };
}
