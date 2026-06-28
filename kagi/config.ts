import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_BASE_URL = "https://kagi.com/api/v1";
export const DEFAULT_LIMIT = 10;
export const DEFAULT_INCLUDE_RELATED = false;

export interface KagiConfig {
  apiKey: string;
  baseUrl: string;
  /** Default number of search results to return. */
  limit: number;
  /** Whether to include Kagi's "related searches" suggestions in the output. */
  includeRelated: boolean;
  /** Resolved config file path, if one was loaded. */
  configPath?: string;
}

interface RawKagiConfig {
  apiKey?: string;
  baseUrl?: string;
  limit?: number | string;
  includeRelated?: boolean | string;
}

export function getDefaultPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

export function getConfigPath(): string {
  return (
    process.env.KAGI_CONFIG_PATH ||
    path.join(getDefaultPiAgentDir(), "extensions", "pi-kagi", "kagi.json")
  );
}

function warnIfConfigFileIsNotPrivate(configPath: string) {
  try {
    const mode = statSync(configPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(
        `[kagi] Warning: config file ${configPath} is readable by group/others. Consider: chmod 600 ${configPath}`,
      );
    }
  } catch {}
}

function loadRawConfigFromJson(configPath: string): RawKagiConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  warnIfConfigFileIsNotPrivate(configPath);
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Kagi config ${configPath} must contain a JSON object`);
  }
  return raw as RawKagiConfig;
}

export function parseNumber(
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

export function parseBoolean(
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

export function loadConfig(): KagiConfig {
  const configPath = getConfigPath();
  const fileConfig = loadRawConfigFromJson(configPath);
  const config: RawKagiConfig = fileConfig ?? {
    apiKey: process.env.KAGI_API_KEY,
    baseUrl: process.env.KAGI_BASE_URL,
    limit: process.env.KAGI_LIMIT,
    includeRelated: process.env.KAGI_INCLUDE_RELATED,
  };

  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      fileConfig
        ? `Missing required field "apiKey" in ${configPath}.`
        : `Missing Kagi config. Create ${configPath} with an apiKey (or set KAGI_API_KEY / KAGI_CONFIG_PATH).`,
    );
  }

  const limit = Math.round(parseNumber(config.limit, DEFAULT_LIMIT, "limit"));
  if (limit < 1 || limit > 100) {
    throw new Error(`limit must be between 1 and 100 (got: ${limit})`);
  }

  const baseUrl = (config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );

  return {
    apiKey,
    baseUrl,
    limit,
    includeRelated: parseBoolean(config.includeRelated, DEFAULT_INCLUDE_RELATED),
    configPath: fileConfig ? configPath : undefined,
  };
}
