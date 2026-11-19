// Antigravity model catalog: maps ACP `session/new` model & thought-level options
// into Pi `Model` descriptors with accurate thinking-level maps and context limits.

import type { Api, Model, ModelThinkingLevel, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "antigravity";
export const API_ID = "antigravity-acp";
export const BASE_URL = "process://antigravity-acp";

export const ACP_THOUGHT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type AcpThoughtLevel = (typeof ACP_THOUGHT_LEVELS)[number];

export interface AcpConfigOptionChoice {
  value: string;
  name?: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: AcpConfigOptionChoice[];
}

export interface AcpAvailableModel {
  modelId: string;
  name?: string;
}

export interface AcpSessionInitMetadata {
  models?: {
    availableModels?: AcpAvailableModel[];
    currentModelId?: string;
  };
  configOptions?: AcpConfigOption[];
  _meta?: {
    antigravity?: {
      tier?: {
        id?: string;
        name?: string;
        upgradeUri?: string;
      };
    };
  };
}

export interface DiscoveredAntigravityModel {
  id: string;
  name: string;
  thoughtLevels: AcpThoughtLevel[];
  defaultThoughtLevel?: AcpThoughtLevel;
  imageInput: boolean;
  contextWindow?: number;
}

const KNOWN_LEVEL_SET = new Set<string>(ACP_THOUGHT_LEVELS);

function isAcpThoughtLevel(value: string): value is AcpThoughtLevel {
  return KNOWN_LEVEL_SET.has(value);
}

/**
 * Derive per-model supported thought levels from `models.availableModels`
 * (which lists concrete IDs like `gemini-4-neon-xhigh`, `claude-opus-5-5-high`,
 * `gpt-oss-120b-medium`) combined with `configOptions[id="thought_level"]`.
 */
function inferThoughtLevels(
  baseId: string,
  availableModels: readonly AcpAvailableModel[],
  globalThoughtLevels: readonly AcpThoughtLevel[],
): AcpThoughtLevel[] {
  const found = new Set<AcpThoughtLevel>();

  // Match `<baseId>-<level>` entries in availableModels.
  const prefix = `${baseId}-`;
  for (const entry of availableModels) {
    if (entry.modelId.startsWith(prefix)) {
      const suffix = entry.modelId.slice(prefix.length);
      if (isAcpThoughtLevel(suffix)) found.add(suffix);
    }
  }

  // Some models bake a single tier into their base ID (e.g. `gpt-oss-120b-medium`).
  if (found.size === 0) {
    const tail = baseId.slice(baseId.lastIndexOf("-") + 1);
    if (isAcpThoughtLevel(tail)) found.add(tail);
  }

  if (found.size > 0) {
    return ACP_THOUGHT_LEVELS.filter((level) => found.has(level));
  }

  // Models with no variant suffixes (e.g. orchestrators) fall back to standard levels.
  if (globalThoughtLevels.length > 0) {
    return [...globalThoughtLevels];
  }
  return ["low", "medium", "high"];
}

function defaultContextWindow(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.startsWith("gemini-")) return 1_048_576;
  if (id.startsWith("claude-")) return 200_000;
  if (id.startsWith("gpt-oss")) return 131_072;
  return 200_000;
}

function defaultMaxTokens(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.startsWith("gemini-")) return 65_536;
  if (id.startsWith("claude-")) return 64_000;
  return 32_768;
}

export function buildThinkingLevelMap(supported: readonly AcpThoughtLevel[]): ThinkingLevelMap {
  const set = new Set<string>(supported);
  return {
    off: null,
    minimal: null,
    low: set.has("low") ? "low" : null,
    medium: set.has("medium") ? "medium" : null,
    high: set.has("high") ? "high" : null,
    xhigh: set.has("xhigh") ? "xhigh" : null,
    max: null,
  };
}

/**
 * Resolve a Pi `ThinkingLevel` (or undefined) to the closest supported ACP `thought_level`
 * for the selected model. Returns undefined if the model has no configurable thought levels.
 */
export function resolveAcpThoughtLevel(
  model: Model<Api>,
  requested?: ThinkingLevel | ModelThinkingLevel,
): AcpThoughtLevel | undefined {
  const map = model.thinkingLevelMap;
  const supported = ACP_THOUGHT_LEVELS.filter((lvl) => (map ? map[lvl] !== null && map[lvl] !== undefined : true));
  if (supported.length === 0) return undefined;

  if (!requested || requested === "off") {
    if (supported.includes("medium")) return "medium";
    return supported[0];
  }

  if (requested === "minimal") return supported[0];
  if (requested === "max") return supported[supported.length - 1];

  if (isAcpThoughtLevel(requested) && supported.includes(requested)) {
    return requested;
  }

  // Clamp to nearest supported level (prefer stepping down from xhigh -> high, up from low -> medium).
  const order: AcpThoughtLevel[] = ["low", "medium", "high", "xhigh"];
  const idx = order.indexOf(requested as AcpThoughtLevel);
  if (idx !== -1) {
    for (let i = idx; i >= 0; i--) {
      if (supported.includes(order[i])) return order[i];
    }
    for (let i = idx + 1; i < order.length; i++) {
      if (supported.includes(order[i])) return order[i];
    }
  }
  return supported[0];
}

/** Parse ACP `session/new` metadata into clean base model descriptors. */
export function parseDiscoveredModels(
  session: AcpSessionInitMetadata,
  imageInput = true,
): DiscoveredAntigravityModel[] {
  const configOptions = session.configOptions ?? [];
  const availableModels = session.models?.availableModels ?? [];
  const modelOption = configOptions.find((opt) => opt.id === "model" || opt.category === "model");
  const thoughtOption = configOptions.find((opt) => opt.id === "thought_level" || opt.category === "thought_level");

  const globalThoughtLevels = (thoughtOption?.options ?? [])
    .map((opt) => opt.value)
    .filter(isAcpThoughtLevel);

  const defaultThought =
    thoughtOption?.currentValue && isAcpThoughtLevel(thoughtOption.currentValue)
      ? thoughtOption.currentValue
      : undefined;

  if (modelOption?.options && modelOption.options.length > 0) {
    const seen = new Set<string>();
    const models: DiscoveredAntigravityModel[] = [];
    for (const choice of modelOption.options) {
      if (!choice.value || seen.has(choice.value)) continue;
      seen.add(choice.value);
      const thoughtLevels = inferThoughtLevels(choice.value, availableModels, globalThoughtLevels);
      models.push({
        id: choice.value,
        name: choice.name?.trim() || choice.value,
        thoughtLevels,
        defaultThoughtLevel: defaultThought && thoughtLevels.includes(defaultThought) ? defaultThought : thoughtLevels[0],
        imageInput,
      });
    }
    return models;
  }

  // Fallback when configOptions.model is absent: collapse `-low/-medium/-high/-xhigh` variants.
  const grouped = new Map<string, { name: string; levels: Set<AcpThoughtLevel> }>();
  for (const entry of availableModels) {
    const match = /^(.*)-(low|medium|high|xhigh)$/.exec(entry.modelId);
    const baseId = match ? match[1] : entry.modelId;
    const level = match ? (match[2] as AcpThoughtLevel) : undefined;
    let bucket = grouped.get(baseId);
    if (!bucket) {
      const cleanName = (entry.name ?? baseId).replace(/\s*\((Low|Medium|High|XHigh|Extra)\)\s*$/i, "").trim() || baseId;
      bucket = { name: cleanName, levels: new Set() };
      grouped.set(baseId, bucket);
    }
    if (level) bucket.levels.add(level);
  }

  return [...grouped.entries()].map(([id, info]): DiscoveredAntigravityModel => {
    const thoughtLevels: AcpThoughtLevel[] =
      info.levels.size > 0
        ? ACP_THOUGHT_LEVELS.filter((lvl) => info.levels.has(lvl))
        : globalThoughtLevels.length > 0
          ? [...globalThoughtLevels]
          : ["low", "medium", "high"];
    const defaultThoughtLevel: AcpThoughtLevel | undefined = thoughtLevels.includes("medium")
      ? "medium"
      : thoughtLevels[0];
    return {
      id,
      name: info.name,
      thoughtLevels,
      defaultThoughtLevel,
      imageInput,
    };
  });
}

export function modelFromDiscovery(entry: DiscoveredAntigravityModel): Model<Api> {
  return {
    type: "chat",
    id: entry.id,
    name: entry.name,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: entry.thoughtLevels.length > 0,
    thinkingLevelMap: buildThinkingLevelMap(entry.thoughtLevels),
    input: entry.imageInput ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? defaultContextWindow(entry.id),
    maxTokens: defaultMaxTokens(entry.id),
  };
}
