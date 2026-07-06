# fleet — a sub-agent runtime for pi

**fleet** runs N sub-agents as concurrent child `pi` processes, each with its
own context window, role prompt, model, and tool restrictions. It is the
foundational fan-out primitive of the pi-kit multi-agent stack (see
[`docs/multi-agent-orchestration.md`](../docs/multi-agent-orchestration.md)),
and is useful entirely on its own: any session gains a `fleet_run` tool for
delegating independent tasks in parallel.

For a deep dive into the internals — module layout, agent discovery, the
concurrency pool, the child-process contract, isolation, cancellation, and
the tmux mirror, with diagrams — see
[`docs/fleet-architecture.md`](../docs/fleet-architecture.md).

## What you get

| Kind          | Name        | What it does                                                                 |
| ------------- | ----------- | ---------------------------------------------------------------------------- |
| **Tool**      | `fleet_run` | Dispatch a batch of tasks to sub-agents that run concurrently; per-task results, progress streaming, optional git-worktree isolation. |
| **Command**   | `/fleet`    | List discovered agents (name, description, source) and current pool status. |
| **Agents**    | `agents/*.md` | Kit-shipped defaults: `scout`, `implementer`, `critic`, `planner`.          |

## Agent definitions

Agents are markdown files with YAML frontmatter; the body is the system prompt:

```markdown
---
name: implementer
description: Implements one well-scoped task to completion, tests included.
model: claude-sonnet-5          # optional; defaults to parent's model
thinkingLevel: medium           # optional
tools: read, bash, edit, write  # optional allowlist; omit = parent's tools
---
You implement exactly one task. ...
```

Discovery locations, later wins on name collision:

1. Kit-shipped defaults: `fleet/agents/*.md`
2. User: `~/.pi/agent/agents/*.md`
3. Project: `.pi/agents/*.md`

## How a task runs

Each task spawns `pi --mode json --no-session` with the agent's system prompt,
model, thinking level, and tool allowlist, and the task text as the prompt.
The JSONL event stream is parsed for the final assistant message, which
becomes the model-visible result (capped at `outputCapBytes`); the full
transcript is written to a scratch file referenced in the result details.

- **Concurrency**: FIFO queue with `maxConcurrent` slots (default 4); batch
  size is capped at `maxBatch` (default 8).
- **Worktree isolation**: with `isolation: "worktree"` the runner creates a
  git worktree on a fresh task branch under a scratch directory and runs the
  child there; the branch and worktree path are reported in the result.
  Merging branches back is *not* the runner's job — the calling session (or
  the orchestrator) does that after review.
- **Timeouts and cancellation**: each task has a timeout (default 10
  minutes); aborts kill children with SIGTERM, escalating to SIGKILL.
- **Restart safety**: dispatched batches are recorded in the session entry
  log; children do not survive the parent, so stale "running" batches are
  marked aborted on session start.
- **Live tmux windows**: when tmux is installed (and `tmux` isn't disabled in
  the config), every sub-agent gets its own window in a shared tmux session,
  streaming a human-readable rendering of its progress — see below.

## Watching sub-agents in tmux

Every dispatched sub-agent is mirrored into its own window of one tmux
session (default `pi-agents`, shared with the critic and orchestrator
extensions so a single attach shows all delegated work):

```bash
tmux attach -t pi-agents
```

Windows are named after the task (`1-implementer`, `2-scout`, …) and show
each agent's messages and tool calls as they happen, ending with an exit
status line. Windows stay open after a task finishes so you can review what
happened (set `tmuxCloseWindows: true` to have them cleaned up instead).

The mirror is a pure visualization layer: the runner still owns the child
process, its output parsing, timeouts, and cancellation. If tmux is missing
or a tmux command fails, tasks run exactly as before — just without live
windows — and a note is printed once.

## Installation

fleet lives in the `fleet/` subfolder of the
[pi-kit](https://github.com/ulvestuen/pi-kit) repository.

```bash
pi install https://github.com/ulvestuen/pi-kit
```

or for a quick test:

```bash
git clone https://github.com/ulvestuen/pi-kit.git
pi -e /absolute/path/to/pi-kit/fleet/index.ts
```

## Configuration

fleet works with zero configuration. To change defaults, create
`~/.pi/agent/extensions/fleet/fleet.json` (see `fleet.example.json`):

| Field                | Default  | Meaning                                        |
| -------------------- | -------- | ----------------------------------------------- |
| `maxConcurrent`      | `4`      | Concurrency pool size.                          |
| `maxBatch`           | `8`      | Maximum tasks per `fleet_run` batch.            |
| `defaultTimeoutMs`   | `600000` | Per-task timeout (10 minutes).                  |
| `outputCapBytes`     | `51200`  | Cap on model-visible output per task (50 KB).   |
| `piBinary`           | `"pi"`   | Binary spawned for each sub-agent.              |
| `injectSystemPrompt` | `true`   | Inject the short delegation note into the system prompt. |
| `tmux`               | `true`   | Mirror each sub-agent into a live tmux window.  |
| `tmuxSession`        | `"pi-agents"` | tmux session that collects the agent windows. |
| `tmuxCloseWindows`   | `false`  | Kill each window when its task ends instead of leaving it to inspect. |

Environment overrides (used when no JSON config exists): `FLEET_CONFIG_PATH`,
`FLEET_MAX_CONCURRENT`, `FLEET_MAX_BATCH`, `FLEET_DEFAULT_TIMEOUT_MS`,
`FLEET_OUTPUT_CAP_BYTES`, `FLEET_PI_BINARY`, `FLEET_INJECT_SYSTEM_PROMPT`,
`FLEET_TMUX`, `FLEET_TMUX_SESSION`, `FLEET_TMUX_CLOSE_WINDOWS`.

## Running tests

```bash
npm test
```

Unit tests are network-free and process-free: the runner takes an injected
spawn function, so concurrency, timeouts, output capping, aborts, and
worktree argument construction are all tested with fakes.

## Files

- `index.ts` — pi extension wiring (the `fleet_run` tool, `/fleet`, persistence, system prompt).
- `registry.ts` — pure agent-definition parsing and layered merging.
- `runner.ts` — pure task-execution engine with injected spawn (the reusable module).
- `tmux.ts` — pure tmux mirror: wraps a spawn function so each sub-agent gets a live tmux window (injected effects).
- `host.ts` — the real Node effects: child-process spawn adapter, file-system discovery walk, transcript saver, tmux effects.
- `agents/` — kit-shipped default agent definitions.
- `config.ts` — configuration loading.
- `test.ts` — unit tests.

## Standalone use of the pure core

Other pi-kit extensions (`critic`, `orchestrator`) import `registry.ts`,
`runner.ts`, `tmux.ts`, and `host.ts` directly via workspace-relative paths —
never `index.ts`. A standalone copy of one of those packages must either keep
the `fleet/` folder alongside it or vendor those four files.
