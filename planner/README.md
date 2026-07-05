# planner — plans as data for pi

**planner** (pi-planner) turns "make a plan" from prose into a queryable
artifact for the [pi coding agent](https://pi.dev): a validated **task DAG**
with per-task acceptance criteria. Scheduling and progress tracking become
mechanical — the ready set, blockers, and the critical path are computed, not
narrated.

It is the planning layer of pi-kit's
[multi-agent orchestration design](../docs/multi-agent-orchestration.md)
(Phase 2), but it is deliberately useful on its own: any session gets a
structured, persistent plan the model maintains via tools.

## What you get

| Kind          | Name                  | What it does                                                                 |
| ------------- | --------------------- | ---------------------------------------------------------------------------- |
| **Extension** | `index.ts`            | The `plan_create` and `plan_update` tools, the `/plan` dashboard command, persisted plan state, a status-bar line, `planner:*` events, and a short system-prompt injection. |
| **Skill**     | `plan-decomposition`  | How to split a goal into small, independently verifiable, parallelizable tasks with strict per-task criteria. |
| **Engine**    | `plan.ts`             | Pure plan model — reusable by other extensions (the orchestrator's scheduler imports it directly). |

## The plan model

A plan is a **goal** plus a set of **tasks**. Each task has:

- `id` — short slug, unique within the plan (e.g. `parser-core`);
- `title` and `description` — the one-liner and the full brief handed to
  whoever executes the task;
- `dependsOn` — ids of tasks that must be `done` first (validated: no dangling
  references, no cycles);
- `agent` — optional fleet agent name (defaults to `implementer`);
- `criteria` — strict acceptance criteria in
  [lykkja](../lykkja/README.md)'s exact shape (`name` + `threshold`), so every
  task's bar is, by construction, something lykkja and a critic can score;
- `status` and `attempts`.

Task lifecycle:

```
pending ──▶ ready ──▶ running ──▶ review ──▶ done
   ▲          ▲                      │
   └──(deps)──┘                      ▼
                                   failed
```

- `pending → ready` happens automatically when all dependencies are `done`
  (and drops back if they stop being done).
- A task cannot be set `ready` or `running` while a dependency is unmet.
- Every transition into `running` counts one attempt.
- Everything downstream of a `failed` task stays blocked until the plan is
  repaired (edit the task, or mark it `ready` again to retry).

## Tools the agent can call

- **`plan_create`** — create a plan from a goal and a task list. Validates the
  DAG: duplicate ids, dangling or cyclic dependencies, and missing criteria are
  rejected. Refuses to clobber an incomplete plan unless `replace: true`.
- **`plan_update`** — maintain the plan: `setStatus` records lifecycle
  transitions, `addTasks` appends follow-up tasks (the combined graph is
  re-validated), `editTasks` refines briefs, agents, dependencies, or criteria.
  A validation error leaves the plan untouched.

Plan state is persisted to the session (via the agent's entry log), so it
survives `/reload` and resumes with the session. On restart, any `running`
tasks reset to `ready` — in-flight sub-agent work does not survive the parent
process, so it is simply re-dispatched.

## The `/plan` command

- **`/plan`** — the live dashboard: per-task status, dependencies, agents,
  attempts, the ready set, failed blockers and the tasks they block, and the
  critical path (longest dependency chain).
- **`/plan reset`** — clear the plan. (`clear` is an alias.)

There is no `/plan <goal>` — decomposition is the model's job. Ask for a plan
in plain language; the `plan-decomposition` skill guides the split and the
agent registers it with `plan_create`.

## Events

For extensions that want to observe planning without depending on it, planner
emits on the shared `pi.events` bus:

- `planner:plan_created` — `{ goal, tasks: string[] }`
- `planner:task_status` — `{ id, from, to, attempts }`

## Installation

planner lives in the `planner/` subfolder of the
[pi-kit](https://github.com/ulvestuen/pi-kit) repository, which carries a
`pi-package` manifest exposing it.

### Option 1: install as a pi package from GitHub (recommended)

```bash
pi install https://github.com/ulvestuen/pi-kit
```

pi clones the repo, runs `npm install`, and registers the planner extension
and skill automatically.

### Option 2: quick test with `--extension`

```bash
git clone https://github.com/ulvestuen/pi-kit.git
pi -e /absolute/path/to/pi-kit/planner/index.ts \
   --skills /absolute/path/to/pi-kit/planner/skills
```

### Option 3: copy into a pi resource location

```bash
git clone https://github.com/ulvestuen/pi-kit.git
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
cp -R pi-kit/planner ~/.pi/agent/extensions/planner
cp -R pi-kit/lykkja ~/.pi/agent/extensions/lykkja   # planner imports lykkja/loop.ts
cp -R pi-kit/planner/skills/* ~/.pi/agent/skills/
```

Then start pi (or run `/reload` if it is already running).

**Standalone note.** planner's only cross-package dependency is lykkja's pure,
dependency-free `loop.ts` (the criteria vocabulary), imported
workspace-relative as `../lykkja/loop.ts`. Installing the whole kit (options
1-2) or copying `lykkja/` alongside (option 3) satisfies it; alternatively,
vendor that single file and adjust the import.

## Configuration

planner works with zero configuration. To change defaults, create a JSON
config at `~/.pi/agent/extensions/planner/planner.json`:

```json
{
  "defaultAgent": "implementer",
  "defaultThreshold": 8,
  "scaleMax": 10,
  "injectSystemPrompt": true,
  "showStatus": true
}
```

| Field                | Default         | Meaning                                                        |
| -------------------- | --------------- | --------------------------------------------------------------- |
| `defaultAgent`       | `"implementer"` | Fleet agent assigned to tasks that do not name one.             |
| `defaultThreshold`   | `8`             | Default minimum passing score for criteria without a threshold. |
| `scaleMax`           | `10`            | Top of the criteria scoring scale.                              |
| `injectSystemPrompt` | `true`          | Whether to inject the short planner discipline into the system prompt. |
| `showStatus`         | `true`          | Whether to show the live plan status in the footer/status bar.  |

Environment overrides (used when no JSON config exists):
`PLANNER_CONFIG_PATH`, `PLANNER_DEFAULT_AGENT`, `PLANNER_DEFAULT_THRESHOLD`,
`PLANNER_SCALE_MAX`, `PLANNER_INJECT_SYSTEM_PROMPT`, `PLANNER_SHOW_STATUS`.

If the config is invalid, planner logs a warning and falls back to defaults
rather than disabling itself.

## Running tests

From the `planner/` directory:

```bash
npm test
```

This runs the plan-engine unit tests (`test.ts`) with Node's test runner via
`tsx`. The plan logic in `plan.ts` is pure — no pi or Node dependencies — so
it is fully covered in isolation, network- and process-free.

## Files

- `index.ts` — pi extension entry point (tools, the `/plan` command, hooks, state).
- `plan.ts` — pure plan model: DAG validation, ready-set resolution, status transitions, summaries.
- `config.ts` — configuration loading.
- `test.ts` — unit tests for the plan engine.
- `skills/plan-decomposition/` — decomposition skill.
- `planner.example.json` — configuration template.

## Design notes

- **The agent plans; planner keeps the structure honest.** The tools do not
  decompose anything — they validate the DAG, resolve readiness mechanically,
  and keep status/attempt bookkeeping out of the model's prose.
- **Criteria are lykkja-shaped by construction.** Task criteria reuse
  `normalizeCriteria` from lykkja's pure engine, so any task can be scored by
  a lykkja checkpoint or an independent critic without translation.
- **Pure core, thin wiring.** Everything interesting lives in `plan.ts`
  (mirroring `lykkja/loop.ts`); `index.ts` only registers tools, the command,
  persistence, and events. Other extensions import `plan.ts` directly and are
  never coupled to this extension's runtime.
- **Failure is visible, not silent.** Failed tasks are listed as blockers,
  everything downstream stays blocked, and the status line says `stalled`
  when the DAG cannot advance — plan repair is an explicit act.
