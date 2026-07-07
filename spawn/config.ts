import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_TMUX_SESSION } from "../fleet/tmux.ts";
import {
  SPAWN_BACKEND_NAMES,
  type SpawnBackendName,
} from "./jobs.ts";

export const DEFAULT_BACKEND: SpawnBackendName = "tmux";
export const DEFAULT_EXEDEV_VM = "pi-spawn";
export const DEFAULT_EXEDEV_DOMAIN = "exe.xyz";
export const DEFAULT_MSB_IMAGE = "node";
export const DEFAULT_OUTPUT_TAIL_BYTES = 16 * 1024;
/** API-key variables forwarded into sandboxed/remote jobs when enabled. */
export const DEFAULT_ENV_PASSTHROUGH = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
];

/**
 * spawn configuration. All fields are optional with sensible defaults, so
 * the extension works with zero configuration when tmux is installed.
 */
export interface SpawnConfig {
  /** Default backend for spawn_agent: "tmux", "exedev", or "microsandbox". */
  backend: SpawnBackendName;
  /** Root directory for job dirs (run script, log, done marker, registry). */
  logDir: string;
  /** The pi binary the job's run script invokes. */
  piBinary: string;
  /** Default byte cap for spawn_output log tails. */
  outputTailBytes: number;
  /** Whether to inject the short spawn note into the system prompt. */
  injectSystemPrompt: boolean;
  /** Environment variable names forwarded when a backend forwards env. */
  envPassthrough: string[];
  /** ssh binary used by the exedev backend. */
  sshBinary: string;
  /** tmux session that collects job windows (shared kit default). */
  tmuxSession: string;
  /** exe.dev VM that hosts exedev jobs; created on demand. */
  exedevVm: string;
  /** Domain suffix of VM SSH destinations. */
  exedevDomain: string;
  /** Create the exe.dev VM when it does not exist yet. */
  exedevAutoCreate: boolean;
  /** Forward envPassthrough variables into exe.dev run scripts. */
  exedevForwardEnv: boolean;
  /** msb binary used by the microsandbox backend. */
  msbBinary: string;
  /** Guest image; must ship node/npm so pi can be installed. */
  msbImage: string;
  /** Mount the job's cwd at /workspace inside the sandbox. */
  msbMountCwd: boolean;
  /** Forward envPassthrough variables into the sandbox (as msb -e vars). */
  msbForwardEnv: boolean;
  /** Remove the job's sandbox once the job reaches a terminal state. */
  msbRemoveSandbox: boolean;
  /** Optional sandbox vCPU count. */
  msbCpus?: number;
  /** Optional sandbox memory limit, e.g. "2G". */
  msbMemory?: string;
  /** Resolved config file path, if one was loaded. */
  configPath?: string;
}

interface RawSpawnConfig {
  backend?: string;
  logDir?: string;
  piBinary?: string;
  outputTailBytes?: number | string;
  injectSystemPrompt?: boolean | string;
  envPassthrough?: string[] | string;
  sshBinary?: string;
  tmuxSession?: string;
  exedevVm?: string;
  exedevDomain?: string;
  exedevAutoCreate?: boolean | string;
  exedevForwardEnv?: boolean | string;
  msbBinary?: string;
  msbImage?: string;
  msbMountCwd?: boolean | string;
  msbForwardEnv?: boolean | string;
  msbRemoveSandbox?: boolean | string;
  msbCpus?: number | string;
  msbMemory?: string;
}

function getDefaultPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

export function getConfigPath(): string {
  return (
    process.env.SPAWN_CONFIG_PATH ||
    path.join(getDefaultPiAgentDir(), "extensions", "spawn", "spawn.json")
  );
}

export function getDefaultLogDir(): string {
  return path.join(getDefaultPiAgentDir(), "spawn", "jobs");
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

function parseBackend(value: string | undefined): SpawnBackendName {
  if (value === undefined || value.trim() === "") return DEFAULT_BACKEND;
  const normalized = value.trim().toLowerCase();
  if ((SPAWN_BACKEND_NAMES as string[]).includes(normalized)) {
    return normalized as SpawnBackendName;
  }
  throw new Error(
    `backend must be one of ${SPAWN_BACKEND_NAMES.join(", ")} (got: ${value})`,
  );
}

function parseStringList(
  value: string[] | string | undefined,
  fallback: string[],
): string[] {
  if (value === undefined) return fallback;
  const items = Array.isArray(value) ? value : value.split(",");
  const cleaned = items.map((s) => String(s).trim()).filter((s) => s !== "");
  return cleaned;
}

function loadRawConfig(): { raw: RawSpawnConfig; configPath?: string } {
  const configPath = getConfigPath();
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`spawn config ${configPath} must contain a JSON object`);
    }
    return { raw: parsed as RawSpawnConfig, configPath };
  }
  return {
    raw: {
      backend: process.env.SPAWN_BACKEND,
      logDir: process.env.SPAWN_LOG_DIR,
      piBinary: process.env.SPAWN_PI_BINARY,
      outputTailBytes: process.env.SPAWN_OUTPUT_TAIL_BYTES,
      injectSystemPrompt: process.env.SPAWN_INJECT_SYSTEM_PROMPT,
      envPassthrough: process.env.SPAWN_ENV_PASSTHROUGH,
      sshBinary: process.env.SPAWN_SSH_BINARY,
      tmuxSession: process.env.SPAWN_TMUX_SESSION,
      exedevVm: process.env.SPAWN_EXEDEV_VM,
      exedevDomain: process.env.SPAWN_EXEDEV_DOMAIN,
      exedevAutoCreate: process.env.SPAWN_EXEDEV_AUTO_CREATE,
      exedevForwardEnv: process.env.SPAWN_EXEDEV_FORWARD_ENV,
      msbBinary: process.env.SPAWN_MSB_BINARY,
      msbImage: process.env.SPAWN_MSB_IMAGE,
      msbMountCwd: process.env.SPAWN_MSB_MOUNT_CWD,
      msbForwardEnv: process.env.SPAWN_MSB_FORWARD_ENV,
      msbRemoveSandbox: process.env.SPAWN_MSB_REMOVE_SANDBOX,
      msbCpus: process.env.SPAWN_MSB_CPUS,
      msbMemory: process.env.SPAWN_MSB_MEMORY,
    },
  };
}

export function defaultConfig(): SpawnConfig {
  return {
    backend: DEFAULT_BACKEND,
    logDir: getDefaultLogDir(),
    piBinary: "pi",
    outputTailBytes: DEFAULT_OUTPUT_TAIL_BYTES,
    injectSystemPrompt: true,
    envPassthrough: [...DEFAULT_ENV_PASSTHROUGH],
    sshBinary: "ssh",
    tmuxSession: DEFAULT_TMUX_SESSION,
    exedevVm: DEFAULT_EXEDEV_VM,
    exedevDomain: DEFAULT_EXEDEV_DOMAIN,
    exedevAutoCreate: true,
    exedevForwardEnv: false,
    msbBinary: "msb",
    msbImage: DEFAULT_MSB_IMAGE,
    msbMountCwd: true,
    msbForwardEnv: true,
    msbRemoveSandbox: true,
  };
}

export function loadConfig(): SpawnConfig {
  const { raw, configPath } = loadRawConfig();
  const defaults = defaultConfig();

  const outputTailBytes = parseNumber(
    raw.outputTailBytes,
    DEFAULT_OUTPUT_TAIL_BYTES,
    "outputTailBytes",
  );
  if (outputTailBytes < 256) {
    throw new Error(
      `outputTailBytes must be at least 256 (got: ${outputTailBytes})`,
    );
  }

  const msbCpus =
    raw.msbCpus === undefined || raw.msbCpus === ""
      ? undefined
      : parseNumber(raw.msbCpus, 0, "msbCpus");
  if (msbCpus !== undefined && msbCpus < 1) {
    throw new Error(`msbCpus must be at least 1 (got: ${msbCpus})`);
  }

  return {
    backend: parseBackend(raw.backend),
    logDir: raw.logDir?.trim() || defaults.logDir,
    piBinary: raw.piBinary?.trim() || defaults.piBinary,
    outputTailBytes: Math.round(outputTailBytes),
    injectSystemPrompt: parseBoolean(raw.injectSystemPrompt, true),
    envPassthrough: parseStringList(
      raw.envPassthrough,
      defaults.envPassthrough,
    ),
    sshBinary: raw.sshBinary?.trim() || defaults.sshBinary,
    tmuxSession: raw.tmuxSession?.trim() || defaults.tmuxSession,
    exedevVm: raw.exedevVm?.trim() || defaults.exedevVm,
    exedevDomain: raw.exedevDomain?.trim() || defaults.exedevDomain,
    exedevAutoCreate: parseBoolean(raw.exedevAutoCreate, true),
    exedevForwardEnv: parseBoolean(raw.exedevForwardEnv, false),
    msbBinary: raw.msbBinary?.trim() || defaults.msbBinary,
    msbImage: raw.msbImage?.trim() || defaults.msbImage,
    msbMountCwd: parseBoolean(raw.msbMountCwd, true),
    msbForwardEnv: parseBoolean(raw.msbForwardEnv, true),
    msbRemoveSandbox: parseBoolean(raw.msbRemoveSandbox, true),
    msbCpus: msbCpus === undefined ? undefined : Math.round(msbCpus),
    msbMemory: raw.msbMemory?.trim() || undefined,
    configPath,
  };
}
