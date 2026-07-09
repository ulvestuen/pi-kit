/**
 * Helpers shared by the backends whose logs and done markers live on the
 * local filesystem (tmux directly, microsandbox through a volume mount).
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import * as path from "node:path";
import type { SpawnConfig } from "../config.ts";
import { resolveStatus, type SpawnJob } from "../jobs.ts";

/** The local directory holding a job's run script, log, and markers. */
export function localJobDir(job: SpawnJob, config: SpawnConfig): string {
  return path.join(config.logDir, job.name);
}

/** Read the done marker; a missing or still-empty file reads as undefined. */
export function readDoneMarker(
  donePath: string | undefined,
): string | undefined {
  if (!donePath || !existsSync(donePath)) return undefined;
  const content = readFileSync(donePath, "utf8");
  return content.trim() === "" ? undefined : content;
}

/**
 * Refresh a job from its local done marker plus a runner-aliveness probe.
 * Returns true when the status or exit code changed.
 */
export async function refreshFromLocalMarkers(
  job: SpawnJob,
  runnerAlive: () => Promise<boolean> | boolean,
): Promise<boolean> {
  let doneContent = readDoneMarker(job.donePath);
  const alive = doneContent === undefined ? await runnerAlive() : false;
  if (doneContent === undefined && !alive) {
    // The runner may have published the marker and exited between the two
    // probes; re-read before concluding "lost", which is terminal.
    doneContent = readDoneMarker(job.donePath);
  }
  const { status, exitCode } = resolveStatus(doneContent, alive);
  if (status === job.status && exitCode === job.exitCode) return false;
  job.status = status;
  job.exitCode = exitCode;
  job.updatedAt = Date.now();
  return true;
}

/**
 * Read up to maxBytes from the end of a job's stderr file. Unlike the log
 * tail there is no placeholder: a missing or empty file reads as "".
 */
export function readErrTail(
  errPath: string | undefined,
  maxBytes: number,
): string {
  if (!errPath || !existsSync(errPath)) return "";
  const tail = readLogTail(errPath, maxBytes);
  return tail === "(no output yet)" ? "" : tail;
}

/** Read up to maxBytes from the end of a local log file. */
export function readLogTail(
  logPath: string | undefined,
  maxBytes: number,
): string {
  if (!logPath || !existsSync(logPath)) {
    return "(no output yet)";
  }
  const size = statSync(logPath).size;
  const cap = Number.isFinite(maxBytes)
    ? Math.max(1, Math.floor(maxBytes))
    : size;
  const start = Math.max(0, size - cap);
  const length = size - start;
  if (length === 0) return "(no output yet)";
  const fd = openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, bytesRead);
    return start > 0 ? `...(truncated)...\n${text}` : text;
  } finally {
    closeSync(fd);
  }
}
