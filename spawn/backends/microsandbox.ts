/**
 * microsandbox backend — jobs run inside a local microVM (hardware
 * isolation) instead of directly on this machine.
 *
 * The job directory is volume-mounted into the guest at /job, so the run
 * script, log, and done marker are the *same files* on both sides: the
 * guest writes them, the host reads them with the shared local helpers.
 * The `msb run` process itself is started detached on the host and is the
 * job's runner; its pid is the aliveness probe (no msb calls needed).
 *
 * The guest needs `pi`: the default `node` image gets it via a one-time
 * `npm install -g` in the run script when missing. API keys are forwarded
 * as export lines inside the run script (a 0700 host file), never on the
 * msb command line.
 *
 * CLI contract per https://docs.microsandbox.dev/cli/overview:
 * `msb run --name X -v host:/guest IMAGE -- CMD`, `msb stop|rm --force X`.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  buildEnvExports,
  buildPiShellCommand,
  buildShellCommand,
} from "../agent-command.ts";
import type { SpawnConfig } from "../config.ts";
import {
  isTerminal,
  type DetachEffects,
  type ExecFn,
  type LaunchRequest,
  type SpawnBackend,
  type SpawnJob,
} from "../jobs.ts";
import type { BackendCapabilities, KillResult } from "@pi-kit/agent-types";
import {
  localJobDir,
  readErrTail,
  readLogTail,
  refreshFromLocalMarkers,
} from "./local.ts";

/** Where the job directory appears inside the guest. */
export const GUEST_JOB_DIR = "/job";
/** Where the job's cwd appears inside the guest when mounted. */
export const GUEST_WORKSPACE_DIR = "/workspace";

export function sandboxNameFor(jobName: string): string {
  return `pi-spawn-${jobName}`;
}

/**
 * The run script executed inside the guest. Paths are guest paths (the
 * mounted /job), so the done marker and log land in the host job dir.
 *
 * Like the tmux script: stderr goes to its own err file so it never
 * pollutes the parsed output stream, guard-rail failures explain
 * themselves in that err file before writing the done marker, and the
 * exit code is staged and only published as the done marker after the
 * log is fully written — the marker's appearance means the log is
 * complete on the host side of the mount too.
 */
export function buildGuestRunScript(options: {
  jobName: string;
  piCommand: string;
  envExports: string[];
  mountCwd: boolean;
}): string {
  const done = `${GUEST_JOB_DIR}/done`;
  const exit = `${GUEST_JOB_DIR}/done.exit`;
  const err = `${GUEST_JOB_DIR}/err.log`;
  const cdTarget = options.mountCwd ? GUEST_WORKSPACE_DIR : `"\${HOME:-/root}"`;
  return [
    "#!/bin/sh",
    `# pi-spawn job ${options.jobName}: one detached sub-agent in this microVM.`,
    ...options.envExports,
    `command -v pi > /dev/null 2>&1 || npm install -g @mariozechner/pi-coding-agent > ${GUEST_JOB_DIR}/setup.log 2>&1 || { echo '[pi-spawn] could not install pi in the sandbox; see setup.log in the job directory' > ${err}; echo 126 > ${done}; exit 126; }`,
    `cd ${cdTarget} || { echo "[pi-spawn] could not cd to ${options.mountCwd ? GUEST_WORKSPACE_DIR : "\\$HOME"} in the sandbox" > ${err}; echo 127 > ${done}; exit 127; }`,
    `{ ${options.piCommand}; echo $? > ${exit}; } > ${GUEST_JOB_DIR}/job.log 2> ${err}`,
    `mv ${exit} ${done}`,
    "",
  ].join("\n");
}

/** argv for the detached `msb run` that hosts one job. */
export function buildMsbRunArgs(
  config: SpawnConfig,
  jobName: string,
  jobDir: string,
  cwd: string,
): string[] {
  const args = [
    "run",
    "--no-tty",
    "--name",
    sandboxNameFor(jobName),
    "-v",
    `${jobDir}:${GUEST_JOB_DIR}`,
  ];
  if (config.msbMountCwd) {
    const mountMode = config.sandboxReadonlyWorkspace ? ":ro" : "";
    args.push("-v", `${cwd}:${GUEST_WORKSPACE_DIR}${mountMode}`);
  }
  if (config.msbCpus !== undefined) {
    args.push("--cpus", String(config.msbCpus));
  }
  if (config.msbMemory) args.push("--memory", config.msbMemory);
  args.push(config.msbImage, "--", "sh", `${GUEST_JOB_DIR}/run.sh`);
  return args;
}

export function createMicrosandboxBackend(
  exec: ExecFn,
  detach: DetachEffects,
  config: SpawnConfig,
): SpawnBackend {
  const removeSandbox = async (job: SpawnJob): Promise<void> => {
    if (!config.msbRemoveSandbox || !job.sandboxName) return;
    await exec(config.msbBinary, ["rm", "--force", job.sandboxName]);
  };

  return {
    name: "microsandbox",

    async available() {
      const probe = await exec(config.msbBinary, ["--version"]);
      return probe.exitCode === 0
        ? undefined
        : `${config.msbBinary} is not installed (get it from https://microsandbox.dev, e.g. \`curl -fsSL https://install.microsandbox.dev | sh\`)`;
    },

    async launch(request: LaunchRequest): Promise<SpawnJob> {
      const now = Date.now();
      const job: SpawnJob = {
        name: request.jobName,
        backend: "microsandbox",
        agent: request.agent.name,
        task: request.task,
        cwd: request.cwd,
        status: "running",
        createdAt: now,
        updatedAt: now,
        sandboxName: sandboxNameFor(request.jobName),
      };
      const jobDir = localJobDir(job, config);
      mkdirSync(jobDir, { recursive: true });
      job.logPath = path.join(jobDir, "job.log");
      job.donePath = path.join(jobDir, "done");
      job.errPath = path.join(jobDir, "err.log");
      const runScript = path.join(jobDir, "run.sh");
      writeFileSync(
        runScript,
        buildGuestRunScript({
          jobName: job.name,
          piCommand: request.command
            ? buildShellCommand(request.command, request.args ?? [])
            : buildPiShellCommand(
                config.piBinary,
                request.agent,
                request.task,
              ),
          envExports: config.msbForwardEnv
            ? buildEnvExports(config.envPassthrough, process.env)
            : [],
          mountCwd: config.msbMountCwd,
        }),
        "utf8",
      );
      chmodSync(runScript, 0o700);

      job.hostPid = detach.spawnDetached(
        config.msbBinary,
        buildMsbRunArgs(config, job.name, jobDir, request.cwd),
      );
      return job;
    },

    async refresh(job: SpawnJob): Promise<boolean> {
      const changed = await refreshFromLocalMarkers(job, () =>
        job.hostPid !== undefined ? detach.isPidAlive(job.hostPid) : false,
      );
      // The named sandbox has no value once the job is over (logs live on
      // the host side of the mount); clean it up on the transition.
      if (changed && isTerminal(job.status)) {
        await removeSandbox(job);
      }
      return changed;
    },

    async output(job: SpawnJob, maxBytes: number): Promise<string> {
      return readLogTail(job.logPath, maxBytes);
    },

    async errorOutput(job: SpawnJob, maxBytes: number): Promise<string> {
      return readErrTail(job.errPath, maxBytes);
    },

    async kill(job: SpawnJob): Promise<KillResult> {
      // Backend KillResult contract (called by killAndStamp, cleanupSpawnToolingJobs, spawn_kill):
      //
      //  - stopped=true:  host runner pid confirmed dead after SIGTERM + msb stop.
      //    Caller stamps "killed" immediately.
      //  - alreadyComplete=true, stopped=false:  host runner pid was already dead before
      //    the kill attempt (isPidAlive returns false on first check).  Caller refreshes
      //    from done marker to discover the real terminal status.
      //  - stopped=false, no alreadyComplete:  SIGTERM was sent and msb stop ran, but
      //    the host process is still alive after re-verification ("unconfirmed").
      //    Caller tries to refresh from done markers and marks "lost" if still nonterminal.
      // Check PID first to detect already-complete jobs.
      if (job.hostPid !== undefined && !detach.isPidAlive(job.hostPid)) {
        await removeSandbox(job);
        return { stopped: false, alreadyComplete: true, message: "host runner already exited" };
      }
      if (job.hostPid !== undefined) detach.killDetached(job.hostPid);
      if (job.sandboxName) {
        await exec(config.msbBinary, ["stop", "--force", job.sandboxName]);
      }
      await removeSandbox(job);
      // Re-verify the host process is actually dead after killing.
      if (job.hostPid !== undefined && detach.isPidAlive(job.hostPid)) {
        return { stopped: false, message: "kill sent but host process still running" };
      }
      return { stopped: true };
    },

    async capabilities(): Promise<BackendCapabilities> {
      return {
        workspaceMount: config.msbMountCwd,
        cursorOutput: false,
        confirmedKill: false,
        durableLogs: true,
        networkAccess: true,
        hardwareIsolation: true,
      };
    },
  };
}
