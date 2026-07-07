/**
 * spawn host helpers — the Node-dependent effects behind the backends.
 *
 * Backends are written against injected effects (ExecFn, DetachEffects) so
 * tests drive them with fakes; this module provides the real ones plus the
 * backend registry wiring used by index.ts.
 */

import { spawn as nodeChildSpawn } from "node:child_process";
import { createExedevBackend } from "./backends/exedev.ts";
import { createMicrosandboxBackend } from "./backends/microsandbox.ts";
import { createTmuxBackend } from "./backends/tmux.ts";
import type { SpawnConfig } from "./config.ts";
import type {
  DetachEffects,
  ExecFn,
  ExecOutcome,
  SpawnBackend,
  SpawnBackendName,
} from "./jobs.ts";

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * Run a short-lived helper process (tmux/ssh/msb) to completion. Never
 * rejects: every failure mode collapses into an ExecOutcome the backends
 * interpret (exitCode null + stderr message).
 */
export const execCommand: ExecFn = (command, args, options = {}) =>
  new Promise<ExecOutcome>((resolve) => {
    let child: ReturnType<typeof nodeChildSpawn>;
    try {
      child = nodeChildSpawn(command, args, {
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (e: any) {
      resolve({ exitCode: null, stdout: "", stderr: String(e?.message ?? e) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const timer = setTimeout(() => {
      stderr += `\n(timed out after ${timeoutMs} ms)`;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (outcome: ExecOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish({ exitCode: null, stdout, stderr: stderr || String(err) });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, stdout, stderr });
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // A child that exits before reading stdin (e.g. ssh auth failure)
        // raises EPIPE here; the close handler reports the real outcome.
      });
      child.stdin.end(options.stdin);
    }
  });

/** Real detached-process effects for the microsandbox backend. */
export const detachEffects: DetachEffects = {
  spawnDetached(command, args) {
    const child = nodeChildSpawn(command, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    // Report nothing on late errors; the missing done marker plus a dead
    // pid already surface the failure as status "lost".
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`could not start detached process: ${command}`);
    }
    return child.pid;
  },
  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === "EPERM";
    }
  },
  killDetached(pid) {
    // detached:true made the child a group leader; kill the whole group.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  },
};

/** The real backend registry index.ts hands jobs to. */
export function createBackends(
  config: SpawnConfig,
): Record<SpawnBackendName, SpawnBackend> {
  return {
    tmux: createTmuxBackend(execCommand, config),
    exedev: createExedevBackend(execCommand, config),
    microsandbox: createMicrosandboxBackend(
      execCommand,
      detachEffects,
      config,
    ),
  };
}
