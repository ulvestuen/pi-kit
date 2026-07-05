---
name: plan-decomposition
description: Split a goal into small, independently verifiable, parallelizable tasks with strict per-task acceptance criteria, tracked as a planner task DAG. Use when creating a plan with plan_create, when a goal spans multiple work items, or when deciding what can safely run in parallel.
---

# Decomposing a goal into a task DAG

A planner plan is only as good as its decomposition. Bad plans have tasks that
overlap, depend on everything, or cannot be checked when "done". This skill is
about turning a goal into tasks that are small, independently verifiable, and
safe to run in parallel — then registering them with `plan_create`.

## What makes a good task

A good task is:

- **Independently verifiable** — it has its own acceptance criteria that can be
  scored without finishing the rest of the plan. If a task can only be judged
  "once everything else is done", it is not a task; it is the goal.
- **Self-contained** — the `description` is a complete brief: what to build or
  change, which files or areas are in scope, constraints, and how to check it.
  Whoever executes the task (you, or a sub-agent with fresh context) should
  need nothing else.
- **Chunky, not tiny** — prefer few substantial tasks over many trivial ones.
  Every task costs coordination (dispatch, review, status upkeep); a task that
  takes less effort than its own bookkeeping should be folded into a neighbor.
- **Disjoint in scope** — two tasks that may run in parallel must not edit the
  same files. If scopes overlap, add a dependency or merge the tasks.

## Dependencies: only real ordering constraints

`dependsOn` exists for *hard* prerequisites: task B consumes an artifact or
interface task A produces. Do not add dependencies for soft preferences like
"it would be tidier to do A first" — every false edge serializes work that
could have run in parallel. A wide, shallow DAG beats a long chain.

The planner resolves readiness mechanically: a task with all dependencies done
becomes `ready`; everything reachable from a `failed` task stays blocked. Check
`/plan` for the ready set and the critical path — the longest chain is the
lower bound on plan latency, so break it up where you can.

## Per-task acceptance criteria

Every task needs strict, scoreable criteria — the same shape lykkja loops use,
so a critic or a checkpoint can score them directly. Follow the
`success-criteria` skill for how to write them (observable, specific,
falsifiable, independent); do not restate it here. Task-level notes:

- Criteria belong to the *task*, not the goal. "All plan tasks done" is a goal
  criterion; "parser rejects malformed input with a clear error" is a task
  criterion.
- 2-4 criteria per task is usually right; a task needing more is usually two
  tasks.
- Raise thresholds (9-10) for must-not-regress properties; the default bar
  is fine for ordinary quality.

## Ids and briefs

- Ids are short slugs (`parser-core`, `cli-flags`, `docs`), unique within the
  plan; dependencies reference them exactly.
- Titles are one line; the `description` carries the full brief. When a task is
  re-dispatched after a failed review, feedback gets appended to the brief —
  so write it as the single source of truth for the task.
- Name an `agent` only when the task needs a specific role (e.g. a scout or
  reviewer); omit it for ordinary implementation work.

## Registering and maintaining the plan

1. Call `plan_create` with the goal and the task list. It validates the DAG —
   duplicate ids, dangling or cyclic dependencies, and missing criteria are
   rejected outright.
2. Keep the plan live with `plan_update`: mark tasks `running` when started,
   `review`/`done`/`failed` as they finish, and append follow-up tasks the
   moment they surface instead of silently widening an existing task's scope.
3. `/plan` shows the dashboard: per-task status, the ready set, failed
   blockers, and the critical path.

## Anti-patterns

- **The mega-task** — one task that is the whole goal. Decompose until each
  task is independently verifiable.
- **Confetti** — twenty five-minute tasks. Coordination will cost more than
  the work; merge them.
- **The false chain** — every task depends on the previous one out of habit.
  Ask for each edge: does this task truly consume the other's output?
- **Shared hotspots** — parallel tasks that all edit the same file. Serialize
  them with a dependency or restructure the split.
- **Unscoreable bars** — "code is clean", "works well". Use the
  `success-criteria` skill to make every bar checkable.

## Related

- `success-criteria` — how to write strict, measurable criteria.
- `pdca-loop` — drive an individual task (or the whole goal) to its bar with a
  lykkja self-checking loop.
- `/plan` — live dashboard; `plan_create` / `plan_update` — the tools.
