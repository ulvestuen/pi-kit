import type { ArtifactRef } from "@pi-kit/agent-types";
import type { ReviewResult } from "../critic/review.ts";
import type { TaskResult } from "../fleet/runner.ts";
import type { CheckResult } from "./checks.ts";

export interface VerificationEvidence {
  agent: string;
  status: TaskResult["status"];
  output: string;
}

export type PipelinePhase = "check" | "evidence" | "review" | "commit";

export interface PipelinePhaseEvent {
  phase: PipelinePhase;
  edge: "start" | "end";
  timestamp: number;
  status?: string;
}

export interface TaskPipelineOutcome {
  taskId: string;
  attempt: number;
  implementation: TaskResult;
  checks: CheckResult[];
  evidence?: VerificationEvidence;
  review?: ReviewResult;
  artifacts: ArtifactRef[];
  phaseEvents?: PipelinePhaseEvent[];
  terminal: "done" | "retry" | "failed" | "aborted";
}

export interface PipelinePhases {
  implement(): Promise<TaskResult>;
  checks(result: TaskResult): Promise<CheckResult[]>;
  evidence?(result: TaskResult): Promise<VerificationEvidence>;
  review?(
    result: TaskResult,
    checks: CheckResult[],
    evidence?: VerificationEvidence,
  ): Promise<ReviewResult>;
  commit?(result: TaskResult): Promise<ArtifactRef[]>;
  aborted?(): boolean;
}

interface BarrierWork {
  taskId: string;
  attempt: number;
  phases: PipelinePhases;
}

function phaseRecorder(events: PipelinePhaseEvent[]) {
  return async function runPhase<T>(
    phase: PipelinePhase,
    action: () => Promise<T>,
    status: (result: T) => string,
  ): Promise<T> {
    events.push({ phase, edge: "start", timestamp: Date.now() });
    try {
      const result = await action();
      events.push({
        phase,
        edge: "end",
        timestamp: Date.now(),
        status: status(result),
      });
      return result;
    } catch (error) {
      events.push({
        phase,
        edge: "end",
        timestamp: Date.now(),
        status: "error",
      });
      throw error;
    }
  };
}

function phaseFailure(
  base: Omit<TaskPipelineOutcome, "terminal">,
  phase: PipelinePhase,
  error: unknown,
  aborted: boolean,
): TaskPipelineOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...base,
    implementation: {
      ...base.implementation,
      status: aborted ? "aborted" : "error",
      output: aborted ? "task aborted" : `${phase} phase failed: ${message}`,
    },
    terminal: aborted ? "aborted" : "retry",
  };
}

export async function runTaskPipeline(
  taskId: string,
  attempt: number,
  phases: PipelinePhases,
): Promise<TaskPipelineOutcome> {
  const phaseEvents: PipelinePhaseEvent[] = [];
  const runPhase = phaseRecorder(phaseEvents);
  const implementation = await phases.implement();
  const base = {
    taskId,
    attempt,
    implementation,
    checks: [] as CheckResult[],
    artifacts: [] as ArtifactRef[],
    phaseEvents,
  };

  if (implementation.status === "aborted") {
    return { ...base, terminal: "aborted" };
  }
  if (implementation.status !== "ok") {
    return { ...base, terminal: "retry" };
  }

  let checks: CheckResult[];
  try {
    checks = await runPhase(
      "check",
      () => phases.checks(implementation),
      results => (results.every(check => check.passed) ? "passed" : "failed"),
    );
  } catch (error) {
    return phaseFailure(base, "check", error, phases.aborted?.() ?? false);
  }
  if (phases.aborted?.()) {
    return { ...base, checks, terminal: "aborted" };
  }
  if (checks.some(check => !check.passed)) {
    return { ...base, checks, terminal: "retry" };
  }

  let evidence: VerificationEvidence | undefined;
  try {
    evidence = phases.evidence
      ? await runPhase(
          "evidence",
          () => phases.evidence!(implementation),
          result => result.status,
        )
      : undefined;
  } catch (error) {
    return phaseFailure(
      { ...base, checks },
      "evidence",
      error,
      phases.aborted?.() ?? false,
    );
  }
  if (phases.aborted?.()) {
    return { ...base, checks, evidence, terminal: "aborted" };
  }

  let review: ReviewResult | undefined;
  try {
    review = phases.review
      ? await runPhase(
          "review",
          () => phases.review!(implementation, checks, evidence),
          result => (result.passed ? "passed" : "failed"),
        )
      : undefined;
  } catch (error) {
    return phaseFailure(
      { ...base, checks, evidence },
      "review",
      error,
      phases.aborted?.() ?? false,
    );
  }
  if (phases.aborted?.()) {
    return { ...base, checks, evidence, review, terminal: "aborted" };
  }
  if (review && !review.passed) {
    return { ...base, checks, evidence, review, terminal: "retry" };
  }

  try {
    const artifacts = phases.commit
      ? await runPhase(
          "commit",
          () => phases.commit!(implementation),
          () => "passed",
        )
      : [];
    return {
      ...base,
      checks,
      evidence,
      review,
      artifacts,
      terminal: "done",
    };
  } catch (error: any) {
    return {
      ...base,
      implementation: {
        ...implementation,
        status: "error",
        output: `commit failed: ${error?.message ?? error}`,
      },
      checks,
      evidence,
      review,
      terminal: "retry",
    };
  }
}

/**
 * Compatibility pipeline for the one-release barrier rollback mode. Every
 * task finishes implementation before the wave proceeds to checks; every
 * passing check/evidence phase finishes before any review starts.
 */
export async function runBarrierPipelines(
  work: readonly BarrierWork[],
): Promise<TaskPipelineOutcome[]> {
  const implementations = await Promise.all(
    work.map(async item => {
      try {
        return await item.phases.implement();
      } catch (error) {
        return {
          agent: "orchestrator",
          status: "error" as const,
          output: `pipeline failed: ${error instanceof Error ? error.message : String(error)}`,
          truncated: false,
          durationMs: 0,
        };
      }
    }),
  );
  const events = work.map(() => [] as PipelinePhaseEvent[]);
  const checks = work.map(() => [] as CheckResult[]);
  const evidence: Array<VerificationEvidence | undefined> = work.map(
    () => undefined,
  );
  const reviews: Array<ReviewResult | undefined> = work.map(() => undefined);
  const artifacts = work.map(() => [] as ArtifactRef[]);

  const eligible = (index: number) =>
    implementations[index].status === "ok" &&
    !work[index].phases.aborted?.();

  await Promise.all(
    work.map(async (item, index) => {
      if (!eligible(index)) return;
      const runPhase = phaseRecorder(events[index]);
      try {
        checks[index] = await runPhase(
          "check",
          () => item.phases.checks(implementations[index]),
          results =>
            results.every(check => check.passed) ? "passed" : "failed",
        );
      } catch (error) {
        implementations[index] = {
          ...implementations[index],
          status: "error",
          output: `check phase failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );

  await Promise.all(
    work.map(async (item, index) => {
      if (
        !eligible(index) ||
        checks[index].some(check => !check.passed) ||
        !item.phases.evidence
      ) {
        return;
      }
      const runPhase = phaseRecorder(events[index]);
      try {
        evidence[index] = await runPhase(
          "evidence",
          () => item.phases.evidence!(implementations[index]),
          result => result.status,
        );
      } catch (error) {
        implementations[index] = {
          ...implementations[index],
          status: "error",
          output: `evidence phase failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );

  await Promise.all(
    work.map(async (item, index) => {
      if (
        !eligible(index) ||
        checks[index].some(check => !check.passed) ||
        !item.phases.review
      ) {
        return;
      }
      const runPhase = phaseRecorder(events[index]);
      try {
        reviews[index] = await runPhase(
          "review",
          () =>
            item.phases.review!(
              implementations[index],
              checks[index],
              evidence[index],
            ),
          result => (result.passed ? "passed" : "failed"),
        );
      } catch (error) {
        implementations[index] = {
          ...implementations[index],
          status: "error",
          output: `review phase failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );

  await Promise.all(
    work.map(async (item, index) => {
      if (
        !eligible(index) ||
        checks[index].some(check => !check.passed) ||
        (reviews[index] && !reviews[index]!.passed) ||
        !item.phases.commit
      ) {
        return;
      }
      const runPhase = phaseRecorder(events[index]);
      try {
        artifacts[index] = await runPhase(
          "commit",
          () => item.phases.commit!(implementations[index]),
          () => "passed",
        );
      } catch (error) {
        implementations[index] = {
          ...implementations[index],
          status: "error",
          output: `commit failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );

  return work.map((item, index) => {
    const implementation = implementations[index];
    const aborted =
      implementation.status === "aborted" || item.phases.aborted?.();
    const passed =
      implementation.status === "ok" &&
      checks[index].every(check => check.passed) &&
      (!reviews[index] || reviews[index]!.passed);
    return {
      taskId: item.taskId,
      attempt: item.attempt,
      implementation,
      checks: checks[index],
      evidence: evidence[index],
      review: reviews[index],
      artifacts: artifacts[index],
      phaseEvents: events[index],
      terminal: aborted ? "aborted" : passed ? "done" : "retry",
    };
  });
}

export async function runBoundedPipelines<T>(
  items: readonly T[],
  maxConcurrent: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(maxConcurrent, items.length) },
    async () => {
      while (cursor < items.length) await run(items[cursor++]);
    },
  );
  await Promise.all(workers);
}
