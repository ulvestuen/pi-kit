import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_BASE_URL = "https://api.exa.ai";
export const DEFAULT_NUM_RESULTS = 5;
export const DEFAULT_SEARCH_TYPE: ExaSearchType = "auto";
export const DEFAULT_MAX_CHARACTERS = 1000;

/** Search types accepted by the Exa /search endpoint. */
export const SEARCH_TYPES = [
  "auto",
  "neural",
  "keyword",
  "fast",
  "deep",
  "deep-reasoning",
  "instant",
] as const;

export type ExaSearchType = (typeof SEARCH_TYPES)[number];

export interface ExaConfig {
  apiKey: string;
  baseUrl: string;
  numResults: number;
  searchType: ExaSearchType;
  /** Whether to fetch page text contents alongside each result. */
  includeText: boolean;
  /** Cap on characters of page text included per result (0 = uncapped). */
  maxCharacters: number;
  /** Optional default Exa category filter. */
  category?: string;
  /** Resolved config file path, if one was loaded. */
  configPath?: string;
}

interface RawExaConfig {
  apiKey?: string;
  baseUrl?: string;
  numResults?: number | string;
  searchType?: string;
  includeText?: boolean | string;
  maxCharacters?: number | string;
  category?: string;
}

export function getDefaultPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

export function getConfigPath(): string {
  return (
    process.env.EXA_CONFIG_PATH ||
    path.join(getDefaultPiAgentDir(), "extensions", "pi-exa", "exa.json")
  );
}

function warnIfConfigFileIsNotPrivate(configPath: string) {
  try {
    const mode = statSync(configPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(
        `[exa] Warning: config file ${configPath} is readable by group/others. Consider: chmod 600 ${configPath}`,
      );
    }
  } catch {}
}

function loadRawConfigFromJson(configPath: string): RawExaConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  warnIfConfigFileIsNotPrivate(configPath);
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Exa config ${configPath} must contain a JSON object`);
  }
  return raw as RawExaConfig;
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

export function parseSearchType(value: string | undefined): ExaSearchType {
  if (value === undefined || value.trim() === "") return DEFAULT_SEARCH_TYPE;
  const normalized = value.trim().toLowerCase();
  if ((SEARCH_TYPES as readonly string[]).includes(normalized)) {
    return normalized as ExaSearchType;
  }
  throw new Error(
    `searchType must be one of ${SEARCH_TYPES.join(", ")} (got: ${value})`,
  );
}

export function loadConfig(): ExaConfig {
  const configPath = getConfigPath();
  const fileConfig = loadRawConfigFromJson(configPath);
  const config: RawExaConfig = fileConfig ?? {
    apiKey: process.env.EXA_API_KEY,
    baseUrl: process.env.EXA_BASE_URL,
    numResults: process.env.EXA_NUM_RESULTS,
    searchType: process.env.EXA_SEARCH_TYPE,
    includeText: process.env.EXA_INCLUDE_TEXT,
    maxCharacters: process.env.EXA_MAX_CHARACTERS,
    category: process.env.EXA_CATEGORY,
  };

  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      fileConfig
        ? `Missing required field "apiKey" in ${configPath}.`
        : `Missing Exa config. Create ${configPath} with an apiKey (or set EXA_API_KEY / EXA_CONFIG_PATH).`,
    );
  }

  const numResults = Math.round(
    parseNumber(config.numResults, DEFAULT_NUM_RESULTS, "numResults"),
  );
  if (numResults < 1 || numResults > 100) {
    throw new Error(`numResults must be between 1 and 100 (got: ${numResults})`);
  }

  const maxCharacters = Math.round(
    parseNumber(config.maxCharacters, DEFAULT_MAX_CHARACTERS, "maxCharacters"),
  );
  if (maxCharacters < 0) {
    throw new Error(`maxCharacters must be >= 0 (got: ${maxCharacters})`);
  }

  const baseUrl = (config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );

  return {
    apiKey,
    baseUrl,
    numResults,
    searchType: parseSearchType(config.searchType),
    includeText: parseBoolean(config.includeText, true),
    maxCharacters,
    category: config.category?.trim() || undefined,
    configPath: fileConfig ? configPath : undefined,
  };
}
