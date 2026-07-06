import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PASS_THRESHOLD } from "../lykkja/loop.ts";
import { DEFAULT_TMUX_SESSION, type TmuxSettings } from "../fleet/tmux.ts";
import { DEFAULT_SCALE_MAX } from "./review.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * critic configuration. All fields are optional with sensible defaults, so
 * the extension works with zero configuration.
 */
export interface CriticConfig extends TmuxSettings {
  /** Model override for critic runs; a strong model here pays for itself. */
  model?: string;
  /** Top of the scoring scale (scores run 1..scaleMax). */
  scaleMax: number;
  /** Default threshold for criteria that carry none. */
  passThreshold: number;
  /** Timeout for one critic run in milliseconds. */
  timeoutMs: number;
  /** The pi binary spawned for critic runs. */
  piBinary: string;
  /** Resolved config file path, if one was loaded. */
  configPath?: string;
}

interface RawCriticConfig {
  model?: string;
  scaleMax?: number | string;
  passThreshold?: number | string;
  timeoutMs?: number | string;
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
    process.env.CRITIC_CONFIG_PATH ||
    path.join(getDefaultPiAgentDir(), "extensions", "critic", "critic.json")
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

function loadRawConfig(): { raw: RawCriticConfig; configPath?: string } {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`critic config ${configPath} must contain a JSON object`);
    }
    return { raw: parsed as RawCriticConfig, configPath };
  }
  return {
    raw: {
      model: process.env.CRITIC_MODEL,
      scaleMax: process.env.CRITIC_SCALE_MAX,
      passThreshold: process.env.CRITIC_PASS_THRESHOLD,
      timeoutMs: process.env.CRITIC_TIMEOUT_MS,
      piBinary: process.env.CRITIC_PI_BINARY,
      tmux: process.env.CRITIC_TMUX,
      tmuxSession: process.env.CRITIC_TMUX_SESSION,
      tmuxCloseWindows: process.env.CRITIC_TMUX_CLOSE_WINDOWS,
    },
  };
}

export function loadConfig(): CriticConfig {
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

  const timeoutMs = parseNumber(raw.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  if (timeoutMs < 1000) {
    throw new Error(`timeoutMs must be at least 1000 (got: ${timeoutMs})`);
  }

  return {
    model: raw.model?.trim() || undefined,
    scaleMax: Math.round(scaleMax),
    passThreshold: Math.round(passThreshold),
    timeoutMs: Math.round(timeoutMs),
    piBinary: raw.piBinary?.trim() || "pi",
    tmux: parseBoolean(raw.tmux, true),
    tmuxSession: raw.tmuxSession?.trim() || DEFAULT_TMUX_SESSION,
    tmuxCloseWindows: parseBoolean(raw.tmuxCloseWindows, false),
    configPath,
  };
}
