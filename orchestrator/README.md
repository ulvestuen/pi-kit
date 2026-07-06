# orchestrator — a thin multi-agent composition layer for pi

**orchestrator** wires the pi-kit multi-agent stack together (see
[`docs/multi-agent-orchestration.md`](../docs/multi-agent-orchestration.md)):
`/orchestrate <goal>` plans the goal as a task DAG (**planner**), dispatches
waves of concurrent sub-agents (**fleet**), gates every completed task behind
an independent reviewer (**critic**), and drives the whole run inside a
lykkja PDCA loop (**lykkja**) until an explicit, measurable bar is met — or
stops honestly at a hard cap.

The orchestrator owns *control flow only*. Planning intelligence lives in the
model plus the planner skill; execution lives in fleet; judgment lives in the
critic; the stopping rule lives in lykkja.

For a deep dive into the internals — the goal loop, wave anatomy, the
scheduler state machine, the critic gate, retries, merges, and failure
recovery, with diagrams — see
[`docs/orchestrator-architecture.md`](../docs/orchestrator-architecture.md).

## What you get

| Kind        | Name               | What it does                                                         |
| ----------- | ------------------ | --------------------------------------------------------------------- |
| **Tool**    | `orchestrate_step` | One dispatch wave: run the ready set through fleet, critic-review completions, apply retries with feedback, report. |
| **Command** | `/orchestrate`     | `<goal>` runs a full orchestration; `status` shows run state; `stop` halts after the current wave. |
| **Skill**   | `orchestration`    | The run protocol: goal loop, waves, checkpoints, plan repair, worktree merges. |

## How a run works

1. **Goal loop** — the model opens a lykkja loop with goal-level criteria.
   The orchestration run *is* that loop; every dispatch wave is one PDCA pass.
2. **Plan** — the model decomposes the goal via `plan_create`
   (`plan-decomposition` skill), assigning each task an agent and criteria.
3. **Wave** — `orchestrate_step` computes `nextActions(plan, policy)`
   (a pure, deterministic scheduler in `scheduler.ts`) and runs the ready set
   through the fleet runner in parallel.
4. **Review** — each completed task is scored by the critic agent against
   *its own* criteria; failures are re-dispatched with the critic's
   weaknesses appended to the brief, up to `maxAttempts`. The critic wins by
   construction; sub-agent self-reports are informational only.
5. **Checkpoint** — after each wave the model calls `lykkja_checkpoint` with
   critic-derived goal scores. `ITERATING` → next wave (or plan repair via
   `plan_update`); `FINAL` → done; `STOPPED` → honest failure report at the
   `maxIterations` runaway guard.

Forward motion is self-prompting: every `orchestrate_step` result ends with
an explicit AUTOMATED NEXT STEP, so a run needs no user turns between waves.

## Failure semantics

| Failure | Behavior |
|---|---|
| Task timeout / crash | Failed attempt → retry up to `maxAttempts`, then task `failed` |
| Partial wave failure | Completed tasks proceed to review; the DAG holds back dependents; `blocked` surfaces the blockers for plan repair |
| Critic output unparseable | One automatic re-run, then a failed review ("unscorable output") |
| Session restart mid-run | fleet marks in-flight batches aborted, planner resets `running` → `ready`; the next `orchestrate_step` resumes idempotently |
| `/orchestrate stop` | The next `orchestrate_step` reports the stop instead of dispatching |

With `isolation: "worktree"`, parallel implementers land on task branches and
the critic reviews inside each worktree; only reviewed-passing branches are
merged back — serially, in DAG order, by the orchestrating session.

## Composition rules

The orchestrator imports only pure cores across packages —
`planner/plan.ts`, `fleet/registry.ts` + `runner.ts`, `critic/review.ts`,
`lykkja/loop.ts` — plus the `fleet/host.ts` spawn/discovery helpers; never
another extension's `index.ts`. Plan updates flow back to the planner
extension via the shared event bus (`planner:set_plan`), and lykkja/planner
tools are composed at the model level. `/orchestrate` checks that the
`lykkja_*` and `plan_*` tools are installed and reports what is missing
instead of failing mid-run.

## Installation

```bash
pi install https://github.com/ulvestuen/pi-kit
```

installs all four extensions plus lykkja. For a quick test with everything
loaded:

```bash
git clone https://github.com/ulvestuen/pi-kit.git
cd pi-kit && npm install
pi -e lykkja/index.ts -e fleet/index.ts -e planner/index.ts \
   -e critic/index.ts -e orchestrator/index.ts \
   --skills lykkja/skills --skills planner/skills \
   --skills critic/skills --skills orchestrator/skills
```

A standalone copy of `orchestrator/` must keep the `lykkja/`, `fleet/`,
`planner/`, and `critic/` folders alongside it (or vendor their pure cores).

## Configuration

orchestrator works with zero configuration. To change defaults, create
`~/.pi/agent/extensions/orchestrator/orchestrator.json` (see
`orchestrator.example.json`):

| Field             | Default         | Meaning                                        |
| ----------------- | --------------- | ----------------------------------------------- |
| `maxConcurrent`   | `4`             | Dispatch-wave width.                            |
| `maxAttempts`     | `2`             | Per-task dispatch cap (failed runs and failed reviews both count). |
| `isolation`       | `"none"`        | `"worktree"` gives each task its own branch/worktree. |
| `taskTimeoutMs`   | `600000`        | Per implementation task.                        |
| `reviewTimeoutMs` | `300000`        | Per critic review.                              |
| `outputCapBytes`  | `51200`         | Model-visible output cap per sub-agent task.    |
| `criticModel`     | *(none)*        | Model override for reviews.                     |
| `defaultAgent`    | `"implementer"` | Agent for plan tasks that name none.            |
| `piBinary`        | `"pi"`          | Binary spawned for sub-agents.                  |
| `tmux`            | `true`          | Mirror every dispatched sub-agent and critic review into live tmux windows (see the fleet README). |
| `tmuxSession`     | `"pi-agents"`   | tmux session that collects the agent windows.   |
| `tmuxCloseWindows`| `false`         | Kill each window when its task ends.            |

Environment overrides (used when no JSON config exists):
`ORCHESTRATOR_CONFIG_PATH`, `ORCHESTRATOR_MAX_CONCURRENT`,
`ORCHESTRATOR_MAX_ATTEMPTS`, `ORCHESTRATOR_ISOLATION`,
`ORCHESTRATOR_TASK_TIMEOUT_MS`, `ORCHESTRATOR_REVIEW_TIMEOUT_MS`,
`ORCHESTRATOR_OUTPUT_CAP_BYTES`, `ORCHESTRATOR_CRITIC_MODEL`,
`ORCHESTRATOR_DEFAULT_AGENT`, `ORCHESTRATOR_PI_BINARY`,
`ORCHESTRATOR_TMUX`, `ORCHESTRATOR_TMUX_SESSION`,
`ORCHESTRATOR_TMUX_CLOSE_WINDOWS`.

## Running tests

```bash
npm test
```

The scheduler state machine (wave composition, retry-with-feedback,
`blocked`/`complete` terminals) and a scripted end-to-end simulation — a fake
runner and fake critic driving a 5-task DAG through timeouts and a failed
review to plan completion and a lykkja `FINAL` — are covered by pure unit
tests.

## Files

- `index.ts` — pi extension wiring (`orchestrate_step`, `/orchestrate`, run state).
- `scheduler.ts` — pure, deterministic scheduler state machine (the reusable module).
- `config.ts` — configuration loading.
- `test.ts` — unit tests including the end-to-end simulation.
- `skills/orchestration/` — the run-protocol skill.
- `orchestrator.example.json` — configuration template.
