# fleet — a sub-agent runtime for pi

**fleet** runs N sub-agents through the shared **spawn** tooling, each with its
own context window, role prompt, model, and tool restrictions, while still
returning synchronous per-task results to the caller. It is the
foundational fan-out primitive of the pi-kit multi-agent stack (see
[`docs/multi-agent-orchestration.md`](../docs/multi-agent-orchestration.md)),
and is useful entirely on its own: any session gains a `fleet_run` tool for
delegating independent tasks in parallel.

For a deep dive into the internals — module layout, agent discovery, the
concurrency pool, the child-process contract, isolation, cancellation, and
spawn backend execution, with diagrams — see
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

Each task is launched via the spawn backend selected by `spawn.json` /
`SPAWN_BACKEND` (`tmux`, `exedev`, or `microsandbox`). The fleet runner still
builds the child contract as `pi --mode json --no-session` with the agent's
system prompt, model, thinking level, and tool allowlist, but `fleet/host.ts`
now hands that command to spawn's backend/job machinery and waits for the job
to finish. The captured JSONL stream is parsed for the final assistant
message, which becomes the model-visible result (capped at `outputCapBytes`);
the full transcript is written to a scratch file referenced in the result
details.

- **Concurrency**: FIFO queue with `maxConcurrent` slots (default 4); batch
  size is capped at `maxBatch` (default 8).
- **Worktree isolation**: with `isolation: "worktree"` the runner creates a
  git worktree on a fresh task branch under a scratch directory and runs the
  child there; the branch and worktree path are reported in the result.
  Merging branches back is *not* the runner's job — the calling session (or
  the orchestrator) does that after review.
- **Timeouts and cancellation**: each task has a timeout (default 10
  minutes); aborts ask the spawn adapter/backend to kill and stamp the running
  job before returning `timeout` or `aborted`.
- **Restart safety**: dispatched batches are recorded in the session entry
  log; on session start, stale internal spawn jobs for interrupted synchronous
  batches are killed/stamped and stale "running" batches are marked aborted.
- **Spawn backend**: sub-agent children use spawn tooling. With the default
  `tmux` backend, every sub-agent runs in a shared tmux session. With
  `exedev` or `microsandbox`, the job runs in that backend and fleet polls it
  until completion. Helper commands such as `git worktree add` remain local
  synchronous helper processes because they are not sub-agent children.

## Watching sub-agents in tmux

With the default spawn `tmux` backend, every dispatched sub-agent runs in its
own window of one tmux session (default `pi-agents`, shared with the critic
and orchestrator extensions so a single attach shows all delegated work):

```bash
tmux attach -t pi-agents
```

Windows are named after the task (`1-implementer`, `2-scout`, …) and show
each agent's messages and tool calls as they happen, ending with an exit
status line. Spawn tmux windows stay open after a task finishes so you can review what
happened; the historical `tmuxCloseWindows` mirror option does not clean up
spawn-runner windows.

The tmux window is now the spawn runner for the sub-agent. Fleet still owns the
synchronous result contract: it polls the spawn job, parses the JSONL output,
records timeouts, and kills/stamps the spawn job when cancelled. If the tmux
backend is selected but tmux is missing, dispatch reports a backend
availability error; choose `SPAWN_BACKEND=microsandbox` or `exedev` for a
non-tmux runner.

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
| `tmux`               | `true`   | Historical live-window flag. When spawn's `tmux` backend is selected, tmux is the runner even if this is false. |
| `tmuxSession`        | `"pi-agents"` | tmux session passed to the spawn tmux backend. |
| `tmuxCloseWindows`   | `false`  | Historical mirror option; spawn tmux jobs remain inspectable after exit. |

Environment overrides (used when no JSON config exists): `FLEET_CONFIG_PATH`,
`FLEET_MAX_CONCURRENT`, `FLEET_MAX_BATCH`, `FLEET_DEFAULT_TIMEOUT_MS`,
`FLEET_OUTPUT_CAP_BYTES`, `FLEET_PI_BINARY`, `FLEET_INJECT_SYSTEM_PROMPT`,
`FLEET_TMUX`, `FLEET_TMUX_SESSION`, `FLEET_TMUX_CLOSE_WINDOWS`.

Backend selection and remote/sandbox details come from the spawn extension's
configuration (`~/.pi/agent/extensions/spawn/spawn.json` or `SPAWN_*`; see
[`spawn/README.md`](../spawn/README.md)). For `exedev`, synchronous fleet jobs
`cd` to the runner cwd on the VM; use it only when the repo/worktree exists at
that remote path, or prefer `tmux`/`microsandbox` for local-repo work.

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
- `tmux.ts` — legacy pure tmux mirror utilities retained for formatting/tests.
- `host.ts` — host wiring: agent discovery, transcript saver, worktree roots, and the spawn-tooling adapter used by fleet/critic/orchestrator.
- `agents/` — kit-shipped default agent definitions.
- `config.ts` — configuration loading.
- `test.ts` — unit tests.

## Standalone use of the pure core

Other pi-kit extensions (`critic`, `orchestrator`) import `registry.ts`,
`runner.ts`, `tmux.ts`, and `host.ts` directly via workspace-relative paths —
never `index.ts`. Because `host.ts` now delegates sub-agent children through
the spawn tooling, a standalone copy must also keep the `spawn/` folder
alongside it or vendor the relevant spawn adapter/backend files.
