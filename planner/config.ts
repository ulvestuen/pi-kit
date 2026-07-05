import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_SCALE_MAX,
} from "../lykkja/loop.ts";

/**
 * planner configuration. All fields are optional with sensible defaults, so
 * the extension works with zero configuration.
 */
export interface PlannerConfig {
  /** Default minimum score a task criterion needs to pass. */
  passThreshold: number;
  /** Top of the scoring scale (scores run 1..scaleMax). */
  scaleMax: number;
  /** Default fleet agent assigned to tasks that name none. */
  defaultAgent: string;
  /** Whether to inject the short planner note into the system prompt. */
  injectSystemPrompt: boolean;
  /** Whether to surface the plan status in the footer/status bar. */
  showStatus: boolean;
  /** Resolved config file path, if one was loaded. */
  configPath?: string;
}

interface RawPlannerConfig {
  passThreshold?: number | string;
  scaleMax?: number | string;
  defaultAgent?: string;
  injectSystemPrompt?: boolean | string;
  showStatus?: boolean | string;
}

function getDefaultPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

export function getConfigPath(): string {
  return (
    process.env.PLANNER_CONFIG_PATH ||
    path.join(getDefaultPiAgentDir(), "extensions", "planner", "planner.json")
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

function loadRawConfig(): { raw: RawPlannerConfig; configPath?: string } {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `planner config ${configPath} must contain a JSON object`,
      );
    }
    return { raw: parsed as RawPlannerConfig, configPath };
  }
  return {
    raw: {
      passThreshold: process.env.PLANNER_PASS_THRESHOLD,
      scaleMax: process.env.PLANNER_SCALE_MAX,
      defaultAgent: process.env.PLANNER_DEFAULT_AGENT,
      injectSystemPrompt: process.env.PLANNER_INJECT_SYSTEM_PROMPT,
      showStatus: process.env.PLANNER_SHOW_STATUS,
    },
  };
}

export function loadConfig(): PlannerConfig {
  const { raw, configPath } = loadRawConfig();

  const scaleMax = parseNumber(raw.scaleMax, DEFAULT_SCALE_MAX, "scaleMax");
  if (scaleMax < 2) {
    throw new Error(`scaleMax must be at least 2 (got: ${scaleMax})`);
  }

  const passThreshold = parseNumber(
    raw.passThreshold,
    DEFAULT_PASS_THRESHOLD,
    "passThreshold",
  );
  if (passThreshold < 1 || passThreshold > scaleMax) {
    throw new Error(
      `passThreshold must be between 1 and ${scaleMax} (got: ${passThreshold})`,
    );
  }

  return {
    passThreshold: Math.round(passThreshold),
    scaleMax: Math.round(scaleMax),
    defaultAgent: raw.defaultAgent?.trim() || "implementer",
    injectSystemPrompt: parseBoolean(raw.injectSystemPrompt, true),
    showStatus: parseBoolean(raw.showStatus, true),
    configPath,
  };
}
