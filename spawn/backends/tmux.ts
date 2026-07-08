/**
 * tmux backend — the local default: each job runs *inside* its own tmux
 * window, detached from the pi session.
 *
 * Unlike fleet's tmux mirror (a visualization of a child the runner owns),
 * here tmux *is* the runner: the window executes the job's run script,
 * which tees pi's text output into the job log and writes the exit code to
 * the done marker. The window survives pi restarts, shows live output, and
 * stays around after the job ends (remain-on-exit) for inspection.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { sanitizeTmuxName, shellQuote } from "../../fleet/tmux.ts";
import { buildPiShellCommand, buildShellCommand } from "../agent-command.ts";
import type { SpawnConfig } from "../config.ts";
import type {
  ExecFn,
  LaunchRequest,
  SpawnBackend,
  SpawnJob,
} from "../jobs.ts";
import {
  localJobDir,
  readLogTail,
  refreshFromLocalMarkers,
} from "./local.ts";

/**
 * The run script a job's tmux window executes. The exit-code capture rides
 * inside the braces so `$?` is pi's status, not tee's; output is teed so
 * the window shows it live while the log captures it for spawn_output.
 */
export function buildTmuxRunScript(options: {
  jobName: string;
  cwd: string;
  piCommand: string;
  logPath: string;
  donePath: string;
}): string {
  const { jobName, cwd, piCommand, logPath, donePath } = options;
  return [
    "#!/bin/sh",
    `# pi-spawn job ${jobName}: runs one detached sub-agent in this window.`,
    `cd ${shellQuote(cwd)} || { echo 127 > ${shellQuote(donePath)}; exit 127; }`,
    `{ ${piCommand}; echo $? > ${shellQuote(donePath)}; } 2>&1 | tee ${shellQuote(logPath)}`,
    "",
  ].join("\n");
}

export function createTmuxBackend(
  exec: ExecFn,
  config: SpawnConfig,
): SpawnBackend {
  // Serialize window creation so parallel launches cannot race the initial
  // has-session/new-session pair (same discipline as fleet's mirror).
  let setupChain: Promise<unknown> = Promise.resolve();

  const paneAlive = async (windowId: string): Promise<boolean> => {
    const probe = await exec("tmux", [
      "list-panes",
      "-t",
      windowId,
      "-F",
      "#{pane_dead}",
    ]);
    if (probe.exitCode !== 0) return false;
    return probe.stdout
      .split("\n")
      .some((line) => line.trim() === "0");
  };

  const openWindow = async (
    windowName: string,
    command: string,
  ): Promise<string> => {
    const probe = await exec("tmux", [
      "has-session",
      "-t",
      config.tmuxSession,
    ]);
    const create =
      probe.exitCode === 0
        ? ["new-window", "-d", "-t", `${config.tmuxSession}:`]
        : ["new-session", "-d", "-s", config.tmuxSession];
    const made = await exec("tmux", [
      ...create,
      "-n",
      windowName,
      "-P",
      "-F",
      "#{window_id}",
      command,
    ]);
    if (made.exitCode !== 0) {
      throw new Error(
        `could not open tmux window "${windowName}": ${made.stderr.trim() || made.stdout.trim() || "unknown error"}`,
      );
    }
    const windowId = made.stdout.trim();
    if (!windowId) {
      throw new Error(`tmux did not report a window id for "${windowName}"`);
    }
    // Keep the window (with its scrollback) around after the job exits.
    await exec("tmux", [
      "set-option",
      "-w",
      "-t",
      windowId,
      "remain-on-exit",
      "on",
    ]);
    return windowId;
  };

  return {
    name: "tmux",

    async available() {
      const probe = await exec("tmux", ["-V"]);
      return probe.exitCode === 0
        ? undefined
        : "tmux is not installed (the tmux backend runs each job in a tmux window)";
    },

    async launch(request: LaunchRequest): Promise<SpawnJob> {
      const now = Date.now();
      const job: SpawnJob = {
        name: request.jobName,
        backend: "tmux",
        agent: request.agent.name,
        task: request.task,
        cwd: request.cwd,
        status: "running",
        createdAt: now,
        updatedAt: now,
      };
      const jobDir = localJobDir(job, config);
      mkdirSync(jobDir, { recursive: true });
      job.logPath = path.join(jobDir, "job.log");
      job.donePath = path.join(jobDir, "done");
      const runScript = path.join(jobDir, "run.sh");
      writeFileSync(
        runScript,
        buildTmuxRunScript({
          jobName: job.name,
          cwd: request.cwd,
          piCommand: request.command
            ? buildShellCommand(request.command, request.args ?? [])
            : buildPiShellCommand(
                config.piBinary,
                request.agent,
                request.task,
              ),
          logPath: job.logPath,
          donePath: job.donePath,
        }),
        "utf8",
      );
      chmodSync(runScript, 0o755);

      const setup = setupChain.then(() =>
        openWindow(
          sanitizeTmuxName(job.name),
          `sh ${shellQuote(runScript)}`,
        ),
      );
      setupChain = setup.catch(() => undefined);
      job.tmuxWindowId = await setup;
      return job;
    },

    async refresh(job: SpawnJob): Promise<boolean> {
      return refreshFromLocalMarkers(job, () =>
        job.tmuxWindowId ? paneAlive(job.tmuxWindowId) : false,
      );
    },

    async output(job: SpawnJob, maxBytes: number): Promise<string> {
      return readLogTail(job.logPath, maxBytes);
    },

    async kill(job: SpawnJob): Promise<void> {
      if (job.tmuxWindowId) {
        await exec("tmux", ["kill-window", "-t", job.tmuxWindowId]);
      }
    },
  };
}
