import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hexToBytes } from "./lib.ts";

export const DEFAULT_WEBHOOK_PORT = 7633;
const THREEMA_ID_RE = /^[A-Z0-9*]{8}$/;
const HEX_RE = /^[0-9a-fA-F]+$/;

export type ThreemaMode = "e2e" | "basic";

export interface ThreemaConfig {
  apiId: string;
  apiSecret: string;
  privateKey?: Uint8Array;
  recipientId: string;
  webhookPort: number;
  allowedSenders: Set<string>;
  configPath?: string;
  mode: ThreemaMode;
}

interface RawThreemaConfig {
  apiId?: string;
  apiSecret?: string;
  privateKey?: string;
  recipientId?: string;
  webhookPort?: number | string;
  allowedSenders?: string[] | string;
  mode?: string;
}

function normalizeThreemaId(id: string): string {
  return id.trim().toUpperCase();
}

export function assertValidThreemaId(name: string, id: string): string {
  const normalized = normalizeThreemaId(id);
  if (!THREEMA_ID_RE.test(normalized)) {
    throw new Error(`${name} must be an 8-character Threema ID (got: ${id})`);
  }
  return normalized;
}

export function assertValidHex(
  name: string,
  value: string,
  expectedLength?: number,
): string {
  const normalized = value.trim();
  if (expectedLength !== undefined && normalized.length !== expectedLength) {
    throw new Error(`${name} must be ${expectedLength} hex characters long`);
  }
  if (
    normalized.length === 0 ||
    normalized.length % 2 !== 0 ||
    !HEX_RE.test(normalized)
  ) {
    throw new Error(`${name} must be a non-empty even-length hex string`);
  }
  return normalized.toLowerCase();
}

function parseAllowedSenders(
  value: string[] | string | undefined,
  fallbackRecipientId: string,
): Set<string> {
  const source = Array.isArray(value)
    ? value
    : value?.trim()
      ? value.split(",")
      : [fallbackRecipientId];

  const allowedSenders = new Set<string>();
  for (const rawId of source) {
    const normalized = assertValidThreemaId(
      "THREEMA_ALLOWED_SENDERS entry",
      rawId,
    );
    allowedSenders.add(normalized);
  }

  if (allowedSenders.size === 0) {
    throw new Error(
      "THREEMA_ALLOWED_SENDERS must contain at least one Threema ID",
    );
  }

  return allowedSenders;
}

export function getDefaultPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

export function getConfigPath(): string {
  return (
    process.env.THREEMA_CONFIG_PATH ||
    path.join(
      getDefaultPiAgentDir(),
      "extensions",
      "pi-threema",
      "threema.json",
    )
  );
}

function warnIfConfigFileIsNotPrivate(configPath: string) {
  try {
    const mode = statSync(configPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.error(
        `[threema] Warning: config file ${configPath} is readable by group/others. Consider: chmod 600 ${configPath}`,
      );
    }
  } catch {}
}

function loadRawConfigFromJson(
  configPath: string,
): RawThreemaConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  warnIfConfigFileIsNotPrivate(configPath);
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Threema config ${configPath} must contain a JSON object`);
  }
  return raw as RawThreemaConfig;
}

function parseMode(value: string | undefined): ThreemaMode {
  if (value === undefined) return "e2e";
  const normalized = value.trim().toLowerCase();
  if (normalized === "e2e" || normalized === "basic") return normalized;
  throw new Error(`mode must be "e2e" or "basic" (got: ${value})`);
}

export function loadConfig(): ThreemaConfig {
  const configPath = getConfigPath();
  const fileConfig = loadRawConfigFromJson(configPath);
  const config: RawThreemaConfig = fileConfig ?? {
    apiId: process.env.THREEMA_API_ID,
    apiSecret: process.env.THREEMA_API_SECRET,
    privateKey: process.env.THREEMA_PRIVATE_KEY,
    recipientId: process.env.THREEMA_RECIPIENT_ID,
    webhookPort: process.env.THREEMA_WEBHOOK_PORT,
    allowedSenders: process.env.THREEMA_ALLOWED_SENDERS,
    mode: process.env.THREEMA_MODE,
  };

  const { apiId, apiSecret, privateKey: privateKeyHex, recipientId } = config;
  const webhookPortRaw = config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const mode = parseMode(config.mode);

  const baseRequired = !apiId || !apiSecret || !recipientId;
  const e2eMissingKey = mode === "e2e" && !privateKeyHex;
  if (baseRequired || e2eMissingKey) {
    const requiredFields =
      mode === "e2e"
        ? "apiId, apiSecret, privateKey, recipientId"
        : "apiId, apiSecret, recipientId";
    throw new Error(
      fileConfig
        ? `Missing required fields in ${configPath}. Set: ${requiredFields}`
        : `Missing Threema config. Create ${configPath} with ${requiredFields} (or set THREEMA_CONFIG_PATH).`,
    );
  }

  const normalizedApiId = assertValidThreemaId("apiId", apiId);
  const normalizedRecipientId = assertValidThreemaId(
    "recipientId",
    recipientId,
  );

  let privateKey: Uint8Array | undefined;
  if (mode === "e2e") {
    const normalizedPrivateKeyHex = assertValidHex(
      "privateKey",
      privateKeyHex!,
      64,
    );
    privateKey = hexToBytes(normalizedPrivateKeyHex);
    if (privateKey.length !== 32) {
      throw new Error("privateKey must decode to exactly 32 bytes");
    }
  }

  const webhookPort =
    typeof webhookPortRaw === "number"
      ? webhookPortRaw
      : Number.parseInt(String(webhookPortRaw), 10);
  if (!Number.isFinite(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
    throw new Error(
      `webhookPort must be a valid TCP port (got: ${webhookPortRaw})`,
    );
  }

  return {
    apiId: normalizedApiId,
    apiSecret,
    privateKey,
    recipientId: normalizedRecipientId,
    webhookPort,
    allowedSenders: parseAllowedSenders(
      config.allowedSenders,
      normalizedRecipientId,
    ),
    configPath: fileConfig ? configPath : undefined,
    mode,
  };
}
