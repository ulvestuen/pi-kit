/**
 * fleet host helpers — the Node-dependent wiring shared by the fleet, critic,
 * and orchestrator extensions' index.ts files.
 *
 * This is deliberately separate from the pure engine (registry.ts, runner.ts):
 * the engine takes injected effects; this module provides the real ones —
 * a child-process spawn adapter, the agent-definition file walk, and a
 * transcript saver.
 */

import { spawn as nodeChildSpawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeRegistries,
  parseAgentDefinition,
  type AgentDefinition,
} from "./registry.ts";
import type { SpawnFn, TaskSpec } from "./runner.ts";
import type { ExecutionMode } from "@pi-kit/agent-types";
import { sanitizeTmuxName, type TmuxEffects, type TmuxSettings } from "./tmux.ts";
const KILL_GRACE_MS = 3000;

/**
 * Local helper-process adapter used for unlabeled runner commands such as
 * `git worktree add` and for short tmux probes. Labeled sub-agent children use
 * the spawn-tooling adapter returned by createHostSpawn().
 */
export const nodeSpawn: SpawnFn = (request) =>
  new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "" });
      return;
    }

    const child = nodeChildSpawn(request.command, request.args, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      request.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      request.onOutput?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ exitCode: code, stdout, stderr });
    });
  });

/** Directory of the kit-shipped agent definitions (fleet/agents). */
export function kitAgentsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
}

function piAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  );
}

/** User-level agent definitions: ~/.pi/agent/agents. */
export function userAgentsDir(): string {
  return path.join(piAgentDir(), "agents");
}

/** Project-level agent definitions: <cwd>/.pi/agents. */
export function projectAgentsDir(cwd: string): string {
  return path.join(cwd, ".pi", "agents");
}

/** Parse every *.md agent definition in one directory. Invalid files are
 * collected as errors instead of failing the whole layer. */
function loadLayer(
  dir: string,
  errors: string[],
): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  const defs: AgentDefinition[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const file = path.join(dir, entry);
    try {
      defs.push(parseAgentDefinition(file, readFileSync(file, "utf8")));
    } catch (e: any) {
      errors.push(e?.message ?? String(e));
    }
  }
  return defs;
}

export interface DiscoveredRegistry {
  registry: Map<string, AgentDefinition>;
  /** Per-file parse errors encountered during discovery. */
  errors: string[];
}

/**
 * Discover agent definitions from the three standard locations. Later layers
 * win on name collision: kit defaults < user (~/.pi/agent/agents) < project
 * (.pi/agents).
 */
export function discoverAgents(cwd: string): DiscoveredRegistry {
  const errors: string[] = [];
  const registry = mergeRegistries(
    loadLayer(kitAgentsDir(), errors),
    loadLayer(userAgentsDir(), errors),
    loadLayer(projectAgentsDir(cwd), errors),
  );
  return { registry, errors };
}

/**
 * Transcript saver factory: writes each task's full JSONL transcript under a
 * scratch directory and returns the file path.
 */
export function createFullOutputSaver(
  subdir: string,
): (index: number, spec: TaskSpec, content: string) => string {
  return (index, _spec, content) => {
    const dir = path.join(os.tmpdir(), subdir);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `task-${Date.now()}-${index + 1}.jsonl`);
    writeFileSync(file, content, "utf8");
    return file;
  };
}

/** Scratch root for worktree isolation. */
export function createWorktreeRoot(subdir: string): string {
  const dir = path.join(os.tmpdir(), subdir, "worktrees");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Whether a usable tmux binary is on PATH. */
export function isTmuxAvailable(): boolean {
  try {
    return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Real tmux-mirror effects: tmux via the spawn adapter, logs under tmpdir. */
export function createTmuxEffects(subdir: string): TmuxEffects {
  // tmux commands are short-lived and never cancelled from here.
  const neverAborted = new AbortController();
  return {
    tmux: async (args) => {
      try {
        return await nodeSpawn({
          command: "tmux",
          args,
          cwd: os.tmpdir(),
          signal: neverAborted.signal,
        });
      } catch (e: any) {
        return { exitCode: null, stdout: "", stderr: String(e?.message ?? e) };
      }
    },
    createLogFile: (label) => {
      const dir = path.join(os.tmpdir(), subdir, "tmux");
      mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        `${Date.now()}-${sanitizeTmuxName(label)}.log`,
      );
      writeFileSync(file, "", "utf8");
      return file;
    },
    appendToLog: (file, text) => {
      try {
        appendFileSync(file, text, "utf8");
      } catch {
        // Log mirroring is best-effort; the task result stands without it.
      }
    },
  };
}

/** Settings accepted by createHostSpawn. Kept structurally compatible with
 * the fleet/critic/orchestrator configs that already contain TmuxSettings. */
export interface HostSpawnSettings extends TmuxSettings {
  /** Optional override for the pi binary recorded in spawn config; the runner's
   * prebuilt command still wins for sub-agent children. */
  piBinary?: string;
}

export interface HostRuntime {
  mode: ExecutionMode;
  spawn: SpawnFn;
  cleanup(): Promise<number>;
  describe(): Promise<HostSpawnConfig | undefined>;
  spawnConfig?: HostSpawnConfig;
}

/** The small portion of Spawn's configuration Fleet exposes to callers. */
export interface HostSpawnConfig {
  backend: string;
  tmuxSession: string;
  piBinary: string;
  configPath?: string;
}

const localSpawnWarnings = new Set<string>();

export function hasExplicitSpawnConfiguration(): boolean {
  if (process.env.SPAWN_BACKEND?.trim()) return true;
  const configPath =
    process.env.SPAWN_CONFIG_PATH ||
    path.join(
      process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
      "extensions",
      "spawn",
      "spawn.json",
    );
  return existsSync(configPath);
}

/** Select synchronous execution. Local mode does not load/probe/use Spawn. */
export function createHostRuntime(settings: HostSpawnSettings & { executionMode?: ExecutionMode }, tag: string): HostRuntime {
  const mode = settings.executionMode ?? "local";
  if (mode === "local") {
    if (hasExplicitSpawnConfiguration() && !localSpawnWarnings.has(tag)) {
      localSpawnWarnings.add(tag);
      console.warn(
        `[${tag}] Spawn is configured but executionMode is local; the Spawn backend is ignored. Set executionMode to "spawn" to use it.`,
      );
    }
    return {
      mode,
      spawn: nodeSpawn,
      cleanup: async () => 0,
      describe: async () => undefined,
    };
  }
  // Keep the compatibility constructor synchronous while placing the package
  // boundary behind a dynamic import. Merely importing Fleet or constructing a
  // local runtime therefore cannot evaluate any Spawn module.
  let initialized: Promise<HostRuntime> | undefined;
  const initialize = () => initialized ??= createSpawnHostRuntime(settings, tag);
  return {
    mode,
    spawn: async (request) => (await initialize()).spawn(request),
    cleanup: async () => (await initialize()).cleanup(),
    describe: async () => (await initialize()).spawnConfig,
  };
}

/** Explicit initializer for consumers that need Spawn configuration eagerly. */
export async function createSpawnHostRuntime(
  settings: HostSpawnSettings,
  tag: string,
): Promise<HostRuntime> {
  const { createSpawnHostRuntime: initialize } = await import("./spawn-adapter.ts");
  return initialize(settings, tag, nodeSpawn, isTmuxAvailable);
}
