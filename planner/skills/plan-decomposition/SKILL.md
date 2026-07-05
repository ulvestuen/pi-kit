---
name: plan-decomposition
description: Split a goal into a task DAG of small, independently verifiable, parallelizable tasks with strict per-task acceptance criteria, for the planner extension's plan_create tool. Use when a goal needs multiple work items — especially before dispatching sub-agents or orchestrating a multi-agent run.
---

# Plan decomposition

A plan is data, not prose: a DAG of tasks, each with an id, a self-contained
brief, dependencies, an agent, and acceptance criteria. `plan_create` validates
the DAG (unique ids, no dangling dependencies, no cycles) and persists it;
`plan_update` keeps it truthful as work proceeds.

## How to decompose

1. **State the goal precisely.** One sentence. Everything in the plan must
   serve it.
2. **Cut along verifiability, not activity.** A good task produces something
   whose acceptance criteria can be scored from evidence ("the parser rejects
   malformed input, covered by tests"), not a phase of effort ("work on the
   parser").
3. **Prefer few, chunky tasks over many tiny ones.** Every task costs a full
   sub-agent conversation. If two items always pass or fail together, they are
   one task. Three to eight tasks is the usual sweet spot.
4. **Minimize dependencies.** Only add `dependsOn` when the task genuinely
   cannot start earlier. False ordering serializes what could have run in
   parallel.
5. **Give parallel writers disjoint file scopes.** Tasks that may run
   concurrently without worktree isolation must not touch the same files —
   name the file scope in each brief. If overlap is unavoidable, either add a
   dependency or mark the work for worktree isolation.
6. **Write self-contained briefs.** The sub-agent executing a task shares
   none of your context. The description must carry everything: what to do,
   relevant paths, constraints, conventions to follow, and how to verify.
7. **Attach strict criteria to every task.** Follow the `success-criteria`
   skill (from lykkja): measurable, evidence-scoreable, with thresholds.
   These same criteria are later handed to an independent critic — write them
   so a reviewer who did not do the work can score them.

## Choosing agents

- `scout` — read-only exploration or analysis feeding later tasks.
- `implementer` — the default for tasks that change things.
- `critic` — do not assign directly; reviews are dispatched by the
  orchestrator or `critic_review` against each task's criteria.

## Worked example

Goal: "Add CSV export to the invoices page."

```
t1  scout        Map the invoices page data flow and list the files involved.
                 criteria: names the component, data source, and test files with paths
t2  implementer  Implement CSV serialization util with escaping (depends: t1)
                 criteria: handles quoting/commas/newlines; unit tests cover empty and unicode rows
t3  implementer  Wire an Export button + download flow (depends: t1)
                 criteria: button renders behind existing filters; e2e test downloads a file
t4  implementer  Integrate util + button, end-to-end test (depends: t2, t3)
                 criteria: exported file matches filtered view; all tests pass
```

t2 and t3 run in parallel with disjoint file scopes; t4 is the only join.

## Keeping the plan honest

- `running` when dispatched, `review` when awaiting verification, `done` only
  when criteria verifiably pass, `failed` when abandoned.
- New scope discovered mid-run becomes an appended follow-up task
  (`plan_update.addTasks`), not a silent widening of an existing brief.

## Related

- `success-criteria` — how to write strict, measurable criteria (lykkja).
- `/plan` — live dashboard; `/plan reset` clears the plan.
