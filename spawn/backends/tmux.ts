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

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { sanitizeTmuxName, shellQuote } from "../../fleet/tmux.ts";
import {
  buildEnvExports,
  buildJsonEventLogFilter,
  buildLogCompactionCommands,
  buildPiShellCommand,
  buildShellCommand,
} from "../agent-command.ts";
import type { SpawnConfig } from "../config.ts";
import type {
  ExecFn,
  LaunchRequest,
  SpawnBackend,
  SpawnJob,
} from "../jobs.ts";
import type { BackendCapabilities, KillResult } from "@pi-kit/agent-types";
import {
  compactLocalLog,
  localJobDir,
  readErrTail,
  readLogTail,
  refreshFromLocalMarkers,
} from "./local.ts";

/**
 * The run script a job's tmux window executes. The exit-code capture rides
 * inside the braces so `$?` is pi's status, not tee's; output is teed so
 * the window shows it live while the log captures it for spawn_output.
 *
 * Two ordering rules make the report-back reliable:
 *  - stderr goes to its own err file, never into the pipe, so it cannot
 *    interleave with (and corrupt) the JSONL stream fleet parses;
 *  - the exit code is staged in a temp file and only published as the done
 *    marker *after* the pipeline — tee included — has finished, so anyone
 *    who sees the marker sees the complete log.
 */
export function buildTmuxRunScript(options: {
  jobName: string;
  cwd: string;
  piCommand: string;
  logPath: string;
  donePath: string;
  errPath: string;
  /** Export lines forwarding API keys: the window inherits the tmux
   * server's environment, not the launching pi session's. */
  envExports?: string[];
  compactJsonEvents?: boolean;
  maxLogBytes?: number;
}): string {
  const { jobName, cwd, piCommand, logPath, donePath, errPath } = options;
  const exitPath = `${donePath}.exit`;
  const cdFailed = shellQuote(`[pi-spawn] could not cd to ${cwd}`);
  return [
    "#!/bin/sh",
    `# pi-spawn job ${jobName}: runs one detached sub-agent in this window.`,
    ...(options.envExports ?? []),
    `cd ${shellQuote(cwd)} || { echo ${cdFailed} > ${shellQuote(errPath)}; echo 127 > ${shellQuote(donePath)}; exit 127; }`,
    `{ ${piCommand}; echo $? > ${shellQuote(exitPath)}; } 2> ${shellQuote(errPath)}${buildJsonEventLogFilter(options.compactJsonEvents ?? false)} | tee ${shellQuote(logPath)}`,
    ...buildLogCompactionCommands(logPath, options.maxLogBytes ?? 0),
    `mv ${shellQuote(exitPath)} ${shellQuote(donePath)}`,
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
        outputMode: request.compactJsonEvents ? "json-events" : "text",
      };
      const jobDir = localJobDir(job, config);
      mkdirSync(jobDir, { recursive: true });
      job.logPath = path.join(jobDir, "job.log");
      job.donePath = path.join(jobDir, "done");
      job.errPath = path.join(jobDir, "err.log");
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
          errPath: job.errPath,
          envExports: config.tmuxForwardEnv
            ? buildEnvExports(config.envPassthrough, process.env)
            : [],
          compactJsonEvents: request.compactJsonEvents,
          maxLogBytes: config.maxJobLogBytes,
        }),
        "utf8",
      );
      // The script may carry forwarded API keys; keep it owner-only.
      chmodSync(runScript, 0o700);

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

    async errorOutput(job: SpawnJob, maxBytes: number): Promise<string> {
      return readErrTail(job.errPath, maxBytes);
    },

    async compactLog(job: SpawnJob, maxBytes: number): Promise<void> {
      compactLocalLog(job.logPath, maxBytes);
    },

    async removeArtifacts(job: SpawnJob): Promise<void> {
      if (job.tmuxWindowId) {
        // Finished windows use remain-on-exit; remove them with their logs.
        await exec("tmux", ["kill-window", "-t", job.tmuxWindowId]);
      }
      rmSync(localJobDir(job, config), { recursive: true, force: true });
    },

    async kill(job: SpawnJob): Promise<KillResult> {
      // Backend KillResult contract (called by killAndStamp, cleanupSpawnToolingJobs, spawn_kill):
      //
      //  - stopped=true:  process confirmed dead (pane_alive was false before kill-window,
      //    or kill-window succeeded).  Caller stamps "killed" immediately.
      //  - alreadyComplete=true, stopped=false:  process was already dead before the kill
      //    attempt (pane_dead on first probe, or race between alive check and kill-window).
      //    Caller refreshes from done marker to discover the real terminal status.
      //  - stopped=false, no alreadyComplete:  kill-window failed and re-probe shows the
      //    pane is still alive.  This is "warned / unconfirmed" — the caller tries to
      //    refresh from done markers and marks "lost" if still nonterminal.
      //  - stopped=false, no alreadyComplete, no window id:  no tmuxWindowId on the job.
      //    Same warned/unconfirmed path in the caller.
      if (job.tmuxWindowId) {
        const alive = await paneAlive(job.tmuxWindowId);
        if (!alive) {
          return { stopped: false, alreadyComplete: true, message: "pane already dead" };
        }
        const killResult = await exec("tmux", ["kill-window", "-t", job.tmuxWindowId]);
        if (killResult.exitCode !== 0) {
          // Race: the pane may have died between the alive check and
          // kill-window; re-probe to distinguish a real failure from a
          // benign race.
          const aliveAfter = await paneAlive(job.tmuxWindowId);
          if (!aliveAfter) {
            return { stopped: false, alreadyComplete: true, message: "pane died during kill" };
          }
          return { stopped: false, message: killResult.stderr.trim() || "kill-window failed" };
        }
        return { stopped: true };
      }
      return { stopped: false, message: "no tmux window id" };
    },

    async capabilities(): Promise<BackendCapabilities> {
      return {
        workspaceMount: true,
        cursorOutput: false,
        confirmedKill: true,
        durableLogs: true,
        networkAccess: true,
        hardwareIsolation: false,
      };
    },
  };
}
