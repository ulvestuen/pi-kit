# planner — plans as data for pi

**planner** turns "make a plan" from prose into a queryable artifact: a
validated task DAG with per-task acceptance criteria. It is part of the pi-kit
multi-agent stack (see
[`docs/multi-agent-orchestration.md`](../docs/multi-agent-orchestration.md))
but is useful entirely on its own: any session gains a structured, persistent
plan the model maintains via tools.

## What you get

| Kind          | Name                 | What it does                                                       |
| ------------- | -------------------- | ------------------------------------------------------------------ |
| **Tool**      | `plan_create`        | Create a validated task DAG (goal + tasks with ids, briefs, dependencies, agents, criteria). |
| **Tool**      | `plan_update`        | Status changes, task edits, and appended follow-up tasks — with DAG re-validation. |
| **Command**   | `/plan`              | Live dashboard: progress, ready set, blockers; `/plan reset` clears. |
| **Skill**     | `plan-decomposition` | How to split a goal into small, independently verifiable, parallelizable tasks. |

## The plan model

Each task carries:

- `id`, `title`, `description` — the brief is self-contained, because a
  sub-agent executing it shares no context with the planning session;
- `dependsOn` — task ids; `plan_create` validates uniqueness, rejects
  dangling references, self-dependencies, and cycles;
- `agent` — the fleet agent to execute it (default `implementer`);
- `criteria` — acceptance criteria in lykkja's exact `Criterion` shape
  (name + threshold), normalized with lykkja's own `normalizeCriteria`, so
  every task's bar is by construction something lykkja and the critic can
  score;
- `status` — `pending → ready → running → review → done` (or `failed`) — and
  `attempts`, counted per dispatch.

State persists in the session entry log (`planner-state`), survives
`/reload`, and restores with the session; tasks stuck `running` across a
restart reset to `ready`. Progress shows in the status bar.

## Events

For loose composition, planner emits on the shared extension bus:
`planner:plan_created`, `planner:plan_updated`, `planner:task_status` — and
adopts a full plan emitted as `planner:set_plan` (this is how the
orchestrator's scheduler feeds results back).

## Installation

```bash
pi install https://github.com/ulvestuen/pi-kit
```

or for a quick test:

```bash
git clone https://github.com/ulvestuen/pi-kit.git
pi -e /absolute/path/to/pi-kit/planner/index.ts \
   --skills /absolute/path/to/pi-kit/planner/skills
```

Note: `plan.ts` imports lykkja's pure `loop.ts` (criteria shapes) via a
workspace-relative path. A standalone copy of `planner/` must keep the
`lykkja/` folder alongside it or vendor `lykkja/loop.ts`.

## Configuration

planner works with zero configuration. To change defaults, create
`~/.pi/agent/extensions/planner/planner.json` (see `planner.example.json`):

| Field                | Default         | Meaning                                    |
| -------------------- | --------------- | ------------------------------------------- |
| `passThreshold`      | `8`             | Default criterion pass bar.                 |
| `scaleMax`           | `10`            | Top of the scoring scale.                   |
| `defaultAgent`       | `"implementer"` | Agent for tasks that name none.             |
| `injectSystemPrompt` | `true`          | Inject the short planner note into the system prompt. |
| `showStatus`         | `true`          | Show plan progress in the footer/status bar. |

Environment overrides (used when no JSON config exists):
`PLANNER_CONFIG_PATH`, `PLANNER_PASS_THRESHOLD`, `PLANNER_SCALE_MAX`,
`PLANNER_DEFAULT_AGENT`, `PLANNER_INJECT_SYSTEM_PROMPT`,
`PLANNER_SHOW_STATUS`.

## Running tests

```bash
npm test
```

DAG validation (cycles, dangling deps), ready-set computation, status
transitions, and summaries are covered by pure unit tests against `plan.ts`.

## Files

- `index.ts` — pi extension wiring (tools, `/plan`, persistence, events, status bar).
- `plan.ts` — pure plan/DAG engine (the reusable module).
- `config.ts` — configuration loading.
- `test.ts` — unit tests.
- `skills/plan-decomposition/` — decomposition skill.
- `planner.example.json` — configuration template.
