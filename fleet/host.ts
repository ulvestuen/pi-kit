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
import { sanitizeTmuxName, type TmuxEffects, type TmuxSettings } from "./tmux.ts";
import {
  defaultConfig as defaultSpawnConfig,
  loadConfig as loadSpawnConfig,
  type SpawnConfig,
} from "../spawn/config.ts";
import { createBackends } from "../spawn/host.ts";
import {
  cleanupSpawnToolingJobs,
  createSpawnToolingSpawn,
} from "../spawn/runner-adapter.ts";

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

function loadSpawnDefaults(tag: string): SpawnConfig {
  try {
    return loadSpawnConfig();
  } catch (e: any) {
    console.error(`[${tag}] ${e?.message ?? e}`);
    console.error(`[${tag}] Using spawn defaults. Fix spawn config or SPAWN_* env vars, then /reload.`);
    return defaultSpawnConfig();
  }
}

/** Resolve the spawn-tooling configuration used by fleet/critic/orchestrator. */
export function loadHostSpawnConfig(
  settings: HostSpawnSettings,
  tag: string,
): SpawnConfig {
  const spawnConfig = loadSpawnDefaults(tag);
  // Keep the historical fleet/orchestrator/critic tmux-session knob useful for
  // the spawn tmux backend; other spawn-specific backend fields still come from
  // spawn.json / SPAWN_*.
  spawnConfig.tmuxSession = settings.tmuxSession || spawnConfig.tmuxSession;
  if (settings.piBinary) spawnConfig.piBinary = settings.piBinary;

  if (!settings.tmux && spawnConfig.backend === "tmux") {
    console.error(
      `[${tag}] tmux=false no longer disables sub-agent windows when SPAWN_BACKEND=tmux; the spawn tmux backend is the runner. Set SPAWN_BACKEND=microsandbox or exedev to avoid local tmux windows.`,
    );
  }
  if (spawnConfig.backend === "tmux" && !isTmuxAvailable()) {
    console.error(
      `[${tag}] SPAWN_BACKEND=tmux but tmux is not installed; sub-agent dispatch will report a backend availability error`,
    );
  }
  return spawnConfig;
}

/**
 * Resolve the spawn function an extension should hand the runner.
 *
 * Labeled pi sub-agent children now run through the spawn tooling backend
 * registry (tmux/exe.dev/microsandbox). Unlabeled helper commands such as
 * `git worktree add` still use the local node adapter because they are not
 * sub-agent children and need synchronous local side effects.
 */
export async function cleanupHostSpawnJobs(
  spawnConfig: SpawnConfig,
  tag: string,
): Promise<number> {
  return cleanupSpawnToolingJobs({
    config: spawnConfig,
    backends: createBackends(spawnConfig),
    jobNamePrefix: tag,
    onRegistryError: (message) => console.error(`[${tag}] ${message}`),
    onError: (message) => console.error(`[${tag}] ${message}`),
  });
}

export function createHostSpawn(
  settings: HostSpawnSettings,
  tag: string,
  resolvedConfig?: SpawnConfig,
): SpawnFn {
  const spawnConfig = resolvedConfig ?? loadHostSpawnConfig(settings, tag);

  return createSpawnToolingSpawn({
    config: spawnConfig,
    backends: createBackends(spawnConfig),
    fallback: nodeSpawn,
    jobNamePrefix: tag,
    onRegistryError: (message) => console.error(`[${tag}] ${message}`),
  });
}
