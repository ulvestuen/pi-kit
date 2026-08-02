import type { RunEvent, RunId } from "@pi-kit/agent-types";
import {
  appendAttemptFeedback,
  getTask,
  readySet,
  setTaskStatus,
  type Plan,
} from "../planner/plan.ts";
import type { CheckResult } from "./checks.ts";
import type {
  PipelinePhaseEvent,
  TaskPipelineOutcome,
} from "./pipeline.ts";
import type { OrchestratorRunStateV2, RunStatus } from "./state.ts";

export type RunTerminal =
  | "verified"
  | "tasks_complete_needs_merge"
  | "blocked"
  | "stopped"
  | "budget_exhausted"
  | "running";

export interface PipelineDispatch {
  id: string;
  attempt: number;
  runId: RunId;
}

export interface ControllerEffects {
  pipeline(
    plan: Plan,
    id: string,
    attempt: number,
    runId?: RunId,
  ): Promise<TaskPipelineOutcome>;
  pipelineWave?(
    plan: Plan,
    tasks: PipelineDispatch[],
  ): Promise<TaskPipelineOutcome[]>;
  persist(state: OrchestratorRunStateV2): void | Promise<void>;
  finalChecks?(plan: Plan): Promise<CheckResult[]>;
  branchesIntegrated?(plan: Plan, taskId?: string): Promise<boolean>;
}

export interface ControllerOptions {
  maxConcurrent: number;
  maxAttempts: number;
  maxDispatches?: number;
  pipelineMode?: "barrier" | "per-task";
  currentState?: () => OrchestratorRunStateV2 | null;
  signal?: AbortSignal;
}

interface StartedTask {
  id: string;
  attempt: number;
  runId: RunId;
  startedAt: number;
}

const MAX_RUN_LOG_EVENTS = 128;

function blockedIds(plan: Plan): string[] {
  const blocked = new Set(
    plan.tasks
      .filter(task => task.status.toLowerCase() === "failed")
      .map(task => task.id.toLowerCase()),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of plan.tasks) {
      if (
        !blocked.has(task.id.toLowerCase()) &&
        task.dependsOn.some(dependency => blocked.has(dependency.toLowerCase()))
      ) {
        blocked.add(task.id.toLowerCase());
        changed = true;
      }
    }
  }
  return plan.tasks
    .filter(task => blocked.has(task.id.toLowerCase()))
    .map(task => task.id);
}

function dependencyBranches(plan: Plan, id: string): Set<string> {
  const task = getTask(plan, id)!;
  return new Set(
    task.dependsOn.flatMap(
      dependency =>
        getTask(plan, dependency)?.artifacts
          .filter(artifact => artifact.type === "branch")
          .map(artifact => artifact.location ?? artifact.id) ?? [],
    ),
  );
}

function exceptionOutcome(
  id: string,
  attempt: number,
  error: unknown,
  aborted: boolean,
): TaskPipelineOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    taskId: id,
    attempt,
    implementation: {
      agent: "orchestrator",
      status: aborted ? "aborted" : "error",
      output: aborted ? "task aborted" : `pipeline failed: ${message}`,
      truncated: false,
      durationMs: 0,
    },
    checks: [],
    artifacts: [],
    terminal: aborted ? "aborted" : "retry",
  };
}

function toRunEvents(
  runId: RunId,
  events: readonly PipelinePhaseEvent[] | undefined,
): RunEvent[] {
  return (events ?? []).map(event => ({
    timestamp: event.timestamp,
    runId,
    type: `${event.phase}_${event.edge}` as RunEvent["type"],
    payload: { phase: event.phase, status: event.status },
  }));
}

function eventRunKey(event: RunEvent): string {
  return JSON.stringify([
    event.runId.runId,
    event.runId.taskId,
    event.runId.attempt,
    event.runId.wave,
  ]);
}

function trimRunLog(
  events: RunEvent[],
  maxEvents = MAX_RUN_LOG_EVENTS,
): RunEvent[] {
  const order: string[] = [];
  const groups = new Map<string, RunEvent[]>();
  for (const event of events) {
    const key = eventRunKey(event);
    if (!groups.has(key)) {
      order.push(key);
      groups.set(key, []);
    }
    groups.get(key)!.push(event);
  }

  let total = events.length;
  const retained = new Set(order);
  for (const key of order) {
    if (total <= maxEvents) break;
    const group = groups.get(key)!;
    const starts = group.filter(event => event.type === "task_start").length;
    const ends = group.filter(event => event.type === "task_end").length;
    if (starts === 0 || starts !== ends) continue;
    retained.delete(key);
    total -= group.length;
  }

  return events.filter(event => retained.has(eventRunKey(event)));
}

export async function driveController(
  initial: OrchestratorRunStateV2,
  options: ControllerOptions,
  effects: ControllerEffects,
  runFinal = false,
) {
  if (options.maxConcurrent > MAX_RUN_LOG_EVENTS) {
    throw new Error(
      `maxConcurrent cannot exceed ${MAX_RUN_LOG_EVENTS} while active run events are retained`,
    );
  }
  if (options.pipelineMode === "barrier" && !effects.pipelineWave) {
    throw new Error("barrier pipeline mode requires pipelineWave");
  }

  let state = initial;
  let dispatches = 0;
  let dispatchSequence = Math.max(
    0,
    ...state.runLog.map(event => event.runId.wave),
    ...Object.values(state.activePipelines).map(runId => runId.wave),
  );
  const mergeBlocked = new Set<string>();
  const active = new Map<string, Promise<void>>();

  const save = async (
    plan: Plan,
    status: RunStatus = state.status,
    patch: Partial<OrchestratorRunStateV2> = {},
  ) => {
    state = { ...state, ...patch, status, plan, updatedAt: Date.now() };
    await effects.persist(state);
  };

  const begin = async (id: string): Promise<StartedTask | undefined> => {
    let plan = state.plan;
    const prior = getTask(plan, id)!;
    if (prior.attempts >= options.maxAttempts) return undefined;
    if (prior.status === "pending") plan = setTaskStatus(plan, id, "ready");
    plan = setTaskStatus(plan, id, "running");

    const attempt = getTask(plan, id)!.attempts;
    const runId = {
      runId: state.runId,
      taskId: id,
      attempt,
      wave: ++dispatchSequence,
    };
    const startEvent: RunEvent = {
      timestamp: Date.now(),
      type: "task_start",
      runId,
      payload: { taskId: id, attempt },
    };
    await save(plan, "running", {
      activePipelines: { ...state.activePipelines, [id]: runId },
      runLog: trimRunLog([...state.runLog, startEvent]),
    });
    return { id, attempt, runId, startedAt: Date.now() };
  };

  const finish = async (
    started: StartedTask,
    outcome: TaskPipelineOutcome,
  ): Promise<void> => {
    let plan = state.plan;
    const nextActive = { ...state.activePipelines };
    delete nextActive[started.id];

    const aborted = outcome.terminal === "aborted";
    if (aborted) {
      plan = setTaskStatus(plan, started.id, "ready");
      plan = {
        ...plan,
        tasks: plan.tasks.map(task =>
          task.id.toLowerCase() === started.id.toLowerCase()
            ? { ...task, attempts: Math.max(0, task.attempts - 1) }
            : task,
        ),
      };
    } else if (outcome.terminal === "done") {
      plan = {
        ...plan,
        tasks: plan.tasks.map(task =>
          task.id.toLowerCase() === started.id.toLowerCase()
            ? { ...task, artifacts: [...task.artifacts, ...outcome.artifacts] }
            : task,
        ),
      };
      plan = setTaskStatus(
        setTaskStatus(plan, started.id, "review"),
        started.id,
        "done",
      );
    } else {
      const feedback =
        outcome.review?.weaknesses.join("\n") ||
        outcome.checks.find(check => !check.passed)?.outputTail ||
        outcome.implementation.output ||
        outcome.terminal;
      plan = {
        ...plan,
        tasks: plan.tasks.map(task =>
          task.id.toLowerCase() === started.id.toLowerCase()
            ? {
                ...task,
                attemptFeedback: appendAttemptFeedback(task.attemptFeedback, {
                  attempt: started.attempt,
                  source: outcome.review
                    ? "review"
                    : outcome.checks.length
                      ? "check"
                      : "execution",
                  status: outcome.terminal,
                  summary: feedback,
                  createdAt: Date.now(),
                }),
              }
            : task,
        ),
      };
      plan = setTaskStatus(
        plan,
        started.id,
        started.attempt < options.maxAttempts ? "ready" : "failed",
      );
    }

    const durationMs = Date.now() - started.startedAt;
    const checkSummary = outcome.checks
      .map(check => `${check.id}:${check.passed ? "passed" : "failed"}`)
      .join(", ");
    const endEvent: RunEvent = {
      timestamp: Date.now(),
      type: "task_end",
      runId: started.runId,
      payload: {
        taskId: started.id,
        attempt: started.attempt,
        status: outcome.terminal,
        durationMs,
      },
    };
    await save(plan, aborted ? "stopped" : state.status, {
      activePipelines: nextActive,
      taskOutcomes: {
        ...state.taskOutcomes,
        [started.id]: {
          status: outcome.terminal,
          durationMs,
          attempt: started.attempt,
          branch: outcome.implementation.branch,
          fullOutputPath: outcome.implementation.fullOutputPath,
          checkSummary,
          reviewPassed: outcome.review?.passed,
        },
      },
      runLog: trimRunLog([
        ...state.runLog,
        ...toRunEvents(started.runId, outcome.phaseEvents),
        endEvent,
      ]),
    });
  };

  const executeStarted = async (started: StartedTask): Promise<void> => {
    let outcome: TaskPipelineOutcome;
    try {
      outcome = await effects.pipeline(
        state.plan,
        started.id,
        started.attempt,
        started.runId,
      );
    } catch (error) {
      outcome = exceptionOutcome(
        started.id,
        started.attempt,
        error,
        options.signal?.aborted ?? false,
      );
    }
    await finish(started, outcome);
  };

  const readyToDispatch = async (): Promise<string[]> => {
    const dispatchable: string[] = [];
    mergeBlocked.clear();
    for (const task of readySet(state.plan)) {
      if (active.has(task.id) || task.attempts >= options.maxAttempts) continue;
      if (
        dependencyBranches(state.plan, task.id).size > 1 &&
        !(await effects.branchesIntegrated?.(state.plan, task.id))
      ) {
        mergeBlocked.add(task.id);
        continue;
      }
      dispatchable.push(task.id);
    }
    return dispatchable;
  };

  let hasUnblockedReady = false;

  while (state.status !== "stopped" && !options.signal?.aborted) {
    const capacity = options.maxConcurrent - active.size;
    const budget = (options.maxDispatches ?? Infinity) - dispatches;
    const dispatchable = await readyToDispatch();
    hasUnblockedReady = dispatchable.length > 0;
    if (options.signal?.aborted) break;
    const currentState = options.currentState?.();
    if (
      currentState &&
      currentState !== state &&
      currentState.runId === state.runId &&
      currentState.status === "planning" &&
      Object.keys(currentState.activePipelines).length === 0 &&
      currentState.plan.tasks.every(task => task.attempts === 0)
    ) {
      state = currentState;
      continue;
    }
    const ready = dispatchable.slice(
      0,
      Math.max(0, Math.min(capacity, budget)),
    );

    if (options.pipelineMode === "barrier" && ready.length) {
      const started = (
        await Promise.all(ready.map(id => begin(id)))
      ).filter((task): task is StartedTask => task !== undefined);
      dispatches += started.length;
      let outcomes: TaskPipelineOutcome[];
      try {
        outcomes = await effects.pipelineWave!(
          state.plan,
          started.map(task => ({
            id: task.id,
            attempt: task.attempt,
            runId: task.runId,
          })),
        );
      } catch (error) {
        outcomes = started.map(task =>
          exceptionOutcome(
            task.id,
            task.attempt,
            error,
            options.signal?.aborted ?? false,
          ),
        );
      }
      for (let index = 0; index < started.length; index++) {
        await finish(started[index], outcomes[index]);
      }
      continue;
    }

    for (const id of ready) {
      const started = await begin(id);
      if (!started) continue;
      dispatches++;
      const promise = executeStarted(started).finally(() => active.delete(id));
      active.set(id, promise);
    }

    if (!active.size) break;
    await Promise.race(active.values());
  }

  if (options.signal?.aborted) {
    await save(state.plan, "stopped");
    await Promise.all(active.values());
    return {
      state,
      terminal: "stopped" as const,
      failedAndBlocked: blockedIds(state.plan),
    };
  }

  await Promise.all(active.values());
  if (state.status === "stopped") {
    return {
      state,
      terminal: "stopped" as const,
      failedAndBlocked: blockedIds(state.plan),
    };
  }

  const failed = blockedIds(state.plan);
  if (failed.length) {
    await save(state.plan, "blocked");
    return { state, terminal: "blocked" as const, failedAndBlocked: failed };
  }
  if (mergeBlocked.size && !hasUnblockedReady) {
    return {
      state,
      terminal: "tasks_complete_needs_merge" as const,
      failedAndBlocked: [],
    };
  }
  if (!state.plan.tasks.every(task => task.status === "done")) {
    const exhausted = dispatches >= (options.maxDispatches ?? Infinity);
    return {
      state,
      terminal: exhausted
        ? ("budget_exhausted" as const)
        : ("running" as const),
      failedAndBlocked: failed,
    };
  }

  const hasBranches = state.plan.tasks.some(task =>
    task.artifacts.some(artifact => artifact.type === "branch"),
  );
  if (hasBranches && !(await effects.branchesIntegrated?.(state.plan))) {
    return {
      state,
      terminal: "tasks_complete_needs_merge" as const,
      failedAndBlocked: failed,
    };
  }
  if (!runFinal) {
    return { state, terminal: "running" as const, failedAndBlocked: failed };
  }

  if (
    state.finalChecksStatus === "not_started" &&
    effects.finalChecks &&
    !options.signal?.aborted
  ) {
    await save(state.plan, "running", { finalChecksStatus: "running" });
    const checks = await effects.finalChecks(state.plan);
    if (options.signal?.aborted) {
      await save(state.plan, "stopped", {
        finalChecksStatus: "not_started",
      });
      return { state, terminal: "stopped" as const, failedAndBlocked: failed };
    }
    const passed = checks.every(check => check.passed);
    await save(state.plan, passed ? "complete" : "blocked", {
      finalChecks: checks,
      finalChecksStatus: passed ? "passed" : "failed",
    });
  }

  return {
    state,
    terminal: state.status === "complete" ? ("verified" as const) : ("blocked" as const),
    failedAndBlocked: failed,
  };
}
