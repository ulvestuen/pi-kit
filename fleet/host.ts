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
import {
  createTmuxMirrorSpawn,
  sanitizeTmuxName,
  type TmuxEffects,
  type TmuxSettings,
} from "./tmux.ts";

const KILL_GRACE_MS = 3000;

/**
 * Real spawn adapter for the runner. Kills the child on abort with SIGTERM,
 * escalating to SIGKILL after a grace period.
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

/**
 * Resolve the spawn function an extension should hand the runner: the plain
 * adapter, or — when tmux mirroring is enabled and tmux is installed — the
 * adapter wrapped so every sub-agent gets a live tmux window. Falls back to
 * the plain adapter (with a one-time console note) when tmux is missing;
 * mirror failures at runtime degrade the same way.
 */
export function createHostSpawn(settings: TmuxSettings, tag: string): SpawnFn {
  if (!settings.tmux) return nodeSpawn;
  if (!isTmuxAvailable()) {
    console.error(
      `[${tag}] tmux mirroring is enabled but tmux is not installed; sub-agents run without live windows`,
    );
    return nodeSpawn;
  }
  return createTmuxMirrorSpawn(nodeSpawn, createTmuxEffects(tag), {
    sessionName: settings.tmuxSession,
    closeWindows: settings.tmuxCloseWindows,
    onError: (message) => console.error(`[${tag}] tmux mirror off: ${message}`),
  });
}
