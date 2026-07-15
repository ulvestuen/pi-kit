import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_SCALE_MAX,
} from "./loop.ts";

/**
 * pdca configuration. All fields are optional and have sensible defaults,
 * so the extension works with zero configuration.
 */
export interface PdcaConfig {
  /** Default minimum score a criterion needs to pass. */
  passThreshold: number;
  /** Top of the scoring scale (scores run 1..scaleMax). */
  scaleMax: number;
  /** Safety cap on the number of loop passes before the loop self-stops. */
  maxIterations: number;
  /** Whether to inject the pdca discipline into the system prompt. */
  injectSystemPrompt: boolean;
  /** Whether to surface the loop status in the footer/status bar. */
  showStatus: boolean;
  /** Resolved config file path, if one was loaded. */
  configPath?: string;
}

interface RawPdcaConfig {
  passThreshold?: number | string;
  scaleMax?: number | string;
  maxIterations?: number | string;
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
    process.env.PDCA_CONFIG_PATH ||
    path.join(getDefaultPiAgentDir(), "extensions", "pdca", "pdca.json")
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

function loadRawConfig(): { raw: RawPdcaConfig; configPath?: string } {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`pdca config ${configPath} must contain a JSON object`);
    }
    return { raw: parsed as RawPdcaConfig, configPath };
  }
  return {
    raw: {
      passThreshold: process.env.PDCA_PASS_THRESHOLD,
      scaleMax: process.env.PDCA_SCALE_MAX,
      maxIterations: process.env.PDCA_MAX_ITERATIONS,
      injectSystemPrompt: process.env.PDCA_INJECT_SYSTEM_PROMPT,
      showStatus: process.env.PDCA_SHOW_STATUS,
    },
  };
}

export function loadConfig(): PdcaConfig {
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

  const maxIterations = parseNumber(
    raw.maxIterations,
    DEFAULT_MAX_ITERATIONS,
    "maxIterations",
  );
  if (maxIterations < 1) {
    throw new Error(`maxIterations must be at least 1 (got: ${maxIterations})`);
  }

  return {
    passThreshold: Math.round(passThreshold),
    scaleMax: Math.round(scaleMax),
    maxIterations: Math.round(maxIterations),
    injectSystemPrompt: parseBoolean(raw.injectSystemPrompt, true),
    showStatus: parseBoolean(raw.showStatus, true),
    configPath,
  };
}
