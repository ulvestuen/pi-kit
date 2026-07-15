---
name: orchestration
description: Run a multi-agent orchestration — plan a goal as a task DAG, dispatch waves of fleet sub-agents with orchestrate_step, gate every task behind an independent critic review, and drive the whole run inside the pdca extension's PDCA loop until the goal-level bar is met. Use for goals big enough to fan out across parallel sub-agents; triggered by /orchestrate.
---

# Orchestration

An orchestration run composes four extensions, each owning one concern:

- **pdca** — the goal-level stopping rule: the run *is* one pdca loop.
- **planner** — the plan as data: a task DAG with per-task criteria.
- **fleet** — execution: waves of concurrent sub-agent child processes.
- **critic** — judgment: fresh-context review of every completed task.

You own none of the hard control flow — `orchestrate_step` computes waves,
retries, and terminal states deterministically. You own the judgment:
decomposition, checkpoint scoring, and plan repair.

## The run protocol

1. **Open the goal loop.** Derive strict goal-level criteria (see
   `success-criteria`): typically `all plan tasks done`,
   `end-to-end verification passes`, plus goal-specific bars. Call
   `pdca_start`. Ignore its single-agent automated prompt — the wave cycle
   below is the loop body.
2. **Plan.** Decompose the goal with `plan_create` following
   `plan-decomposition`: self-contained briefs, minimal dependencies, strict
   per-task criteria, disjoint file scopes for parallel writers, and a
   `covers` tag on each task naming the exact goal-level criteria it helps
   satisfy — a goal criterion nothing covers is a decomposition gap.
3. **Plan review gate.** Before dispatching anything, verify the design the
   way completed tasks are verified: call `critic_advise` (when available)
   with the plan as the subject — goal, task DAG with dependencies and file
   scopes, per-task criteria — and the goal-level criteria as context. Act
   on the prioritized concerns with `plan_update` until no remaining concern
   would change the decomposition. Design-level defects are caught at the
   design level, not waves later.
4. **Dispatch a wave.** Call `orchestrate_step`. It dispatches the ready set
   in parallel, has the evidence agent (default `auditor`) independently
   re-run each completed task's verification commands, then reviews each
   task with the critic **against that task's own criteria** — weighing the
   executed evidence over the implementer's claims — re-queues failures with
   the critic's weaknesses appended to the brief (up to the attempt cap),
   and reports everything, including per-goal-criterion coverage.
5. **Integration gate.** When tasks landed this wave and an
   `integrationCheck` command is configured, merge the passed branches
   (below) and call `orchestrate_verify`. A clean merge is not integration
   testing — only the gate's observed command output is. A failed gate is
   CHECK evidence and a plan-repair trigger, exactly like a failed review.
6. **Checkpoint.** Follow the wave report's AUTOMATED NEXT STEP: call
   `pdca_checkpoint`, scoring the goal-level criteria from the critic
   verdicts, the integration-gate verdict, and the coverage report. The
   critic's verdicts are the CHECK — never your own optimism. Then act on
   the verdict:
   - **ITERATING** → next wave (`orchestrate_step` again). If tasks failed,
     repair the plan first with `plan_update`: append follow-up tasks
     targeting the weakest criterion, or descope explicitly.
   - **FINAL** → merge any remaining task branches (below), summarize.
   - **STOPPED** → the safety cap: report honestly which criteria still fail
     and the per-task state; claim nothing.

Forward motion is self-prompting: every tool result carries the next step.
Do not wait for the user between waves, and do not implement plan tasks
yourself — sub-agents do the work.

## Worktree merges (parallel writers)

With `isolation: "worktree"` each task lands on its own branch; the critic
reviews inside the worktree. Only branches that **passed review** get merged
— serially, in DAG order, by you. Resolve trivial conflicts yourself;
dispatch a dedicated fleet task for messy ones. A merge conflict is a review
failure: record the conflict as the weakness and let the retry path handle
it. For small runs the default `isolation: "none"` with disjoint file scopes
is simpler and preferred.

## Failure semantics worth knowing

- Task timeout/crash → failed attempt → automatic retry up to the cap, then
  the task is `failed` and its dependents are held back (`blocked`).
- Unparseable critic output → one automatic re-run, then a failed review.
- The critic always wins over a sub-agent's self-report.
- A restart resets `running` tasks to `ready`; the next `orchestrate_step`
  resumes idempotently.
- `/orchestrate stop` halts before the next wave; nothing is silently
  discarded.

## Related

- `plan-decomposition` (planner) — task sizing, criteria, file scopes.
- `success-criteria`, `pdca-loop`, `honest-verification` (pdca).
- `advisory-review` (critic) — reviews outside orchestration.
- `/orchestrate <goal>` starts a run; `status` and `stop` manage it; `/plan`
  shows the live DAG.
