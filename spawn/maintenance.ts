import type { SpawnConfig } from "./config.ts";
import {
  isTerminal,
  type SpawnBackend,
  type SpawnBackendName,
  type SpawnJob,
} from "./jobs.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MaintenanceResult {
  jobs: SpawnJob[];
  removed: string[];
  compacted: string[];
  errors: string[];
}

/**
 * Select terminal jobs eligible for age/count pruning. Running jobs are never
 * returned. Age is measured from updatedAt, which records the last terminal
 * status transition; count retention keeps the newest terminal jobs.
 */
export function selectJobsForPruning(
  jobs: SpawnJob[],
  config: Pick<SpawnConfig, "retentionDays" | "maxRetainedJobs">,
  now = Date.now(),
): SpawnJob[] {
  const terminal = jobs.filter((job) => isTerminal(job.status));
  const selected = new Set<string>();

  if (config.retentionDays > 0) {
    const cutoff = now - config.retentionDays * DAY_MS;
    for (const job of terminal) {
      if (job.updatedAt < cutoff) selected.add(job.name);
    }
  }

  if (config.maxRetainedJobs > 0) {
    const newest = terminal
      .filter((job) => !selected.has(job.name))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const job of newest.slice(config.maxRetainedJobs)) {
      selected.add(job.name);
    }
  }

  return terminal
    .filter((job) => selected.has(job.name))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Enforce durable-log compaction and terminal-job retention. Artifact deletion
 * is attempted before a registry record is removed; failures leave the record
 * intact for a later retry. Running jobs are neither compacted nor pruned.
 */
export async function maintainSpawnJobs(options: {
  jobs: SpawnJob[];
  config: Pick<
    SpawnConfig,
    "retentionDays" | "maxRetainedJobs" | "maxJobLogBytes"
  >;
  backends: Record<SpawnBackendName, SpawnBackend>;
  now?: number;
  onError?: (message: string) => void;
}): Promise<MaintenanceResult> {
  const remove = selectJobsForPruning(
    options.jobs,
    options.config,
    options.now ?? Date.now(),
  );
  const removed = new Set<string>();
  const compacted: string[] = [];
  const errors: string[] = [];

  const reportError = (message: string) => {
    errors.push(message);
    options.onError?.(message);
  };

  for (const job of remove) {
    try {
      await options.backends[job.backend].removeArtifacts(job);
      removed.add(job.name);
    } catch (e: any) {
      reportError(
        `could not prune job ${job.name}: ${e?.message ?? String(e)}`,
      );
    }
  }

  if (options.config.maxJobLogBytes > 0) {
    for (const job of options.jobs) {
      if (!isTerminal(job.status) || removed.has(job.name)) continue;
      try {
        await options.backends[job.backend].compactLog(
          job,
          options.config.maxJobLogBytes,
        );
        compacted.push(job.name);
      } catch (e: any) {
        reportError(
          `could not compact job ${job.name}: ${e?.message ?? String(e)}`,
        );
      }
    }
  }

  return {
    jobs: options.jobs.filter((job) => !removed.has(job.name)),
    removed: [...removed],
    compacted,
    errors,
  };
}
