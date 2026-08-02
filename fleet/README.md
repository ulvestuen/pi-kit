# fleet — a direct local sub-agent runtime for pi

**fleet** runs batches of child `pi` processes, each with its own context,
role prompt, model, and tool restrictions. Results return synchronously to the
calling session. Fleet is the fan-out primitive reused by Critic and
Orchestrator, and it is also useful on its own.

For implementation details, see
[`docs/fleet-architecture.md`](../docs/fleet-architecture.md).

## What you get

| Kind | Name | Purpose |
| --- | --- | --- |
| Tool | `fleet_run` | Run one or more sub-agent tasks with bounded concurrency. |
| Command | `/fleet` | List discovered agents and current pool status. |
| Agents | `agents/*.md` | Shipped roles: `auditor`, `critic`, `implementer`, `planner`, and `scout`. |

## Execution model

There is one execution path: Fleet starts an ordinary local child `pi`
process for each task. Critic and Orchestrator use the same adapter. There is
no placement or runner selector.

The child command uses `pi --mode json --no-session` plus the selected agent's
system prompt, model, thinking level, and tool allowlist. Children receive
`--no-extensions --no-skills` by default so they cannot recursively invoke the
parent's orchestration stack. Set `inheritChildResources: true` only for a
custom agent that intentionally needs those resources.

Fleet parses the child's JSON event stream and returns the final assistant
message. The visible result is capped at `outputCapBytes`; the complete JSONL
transcript is saved to a temporary file referenced by `fullOutputPath`.

### Concurrency

`maxConcurrent` limits active children (default 4), while `maxBatch` limits one
request (default 8). Results remain in input order even when tasks complete in
a different order.

### Cancellation and timeouts

Each task has a timeout (default 10 minutes) and also observes the parent tool
call's abort signal. Cancellation sends `SIGTERM` to the child and escalates to
`SIGKILL` after a short grace period. Queued tasks abort without starting.

### Worktree isolation

Set `isolation: "worktree"` when parallel writers might touch the same files.
Fleet creates a dedicated git branch and worktree, runs the child there, and
returns `branch` and `worktreePath`. Fleet does not merge branches; the caller
or Orchestrator performs reviewed merges.

## Agent definitions

Agents are Markdown files with frontmatter and a system-prompt body:

```markdown
---
name: implementer
description: Implements one scoped task with tests.
model: openai-codex/gpt-5.6-sol
thinkingLevel: high
tools: read, bash, edit, write
---
You implement exactly one task.
```

Discovery order is:

1. `fleet/agents/*.md`
2. `~/.pi/agent/agents/*.md`
3. `<project>/.pi/agents/*.md`

Later locations override earlier definitions with the same name.

## Tool input

```ts
fleet_run({
  tasks: [{
    agent: "implementer",
    task: "Self-contained brief and acceptance criteria",
    isolation: "worktree", // optional
    timeoutMs: 600000,      // optional
    inheritChildResources: false,
  }],
});
```

Additional structured fields (`runId`, `inputArtifacts`, `parentRunIds`, and
`parentBranch`) support Orchestrator handoffs.

## Configuration

Fleet works with zero configuration. Optional JSON configuration lives at
`~/.pi/agent/extensions/fleet/fleet.json`; see `fleet.example.json`.

| Field | Default | Meaning |
| --- | ---: | --- |
| `maxConcurrent` | `4` | Maximum active child processes. |
| `maxBatch` | `8` | Maximum tasks in one call. |
| `defaultTimeoutMs` | `600000` | Default per-task timeout. |
| `outputCapBytes` | `8192` | Visible result byte cap, including the truncation marker. |
| `piBinary` | `"pi"` | Child executable. |
| `injectSystemPrompt` | `true` | Advertise Fleet in the parent system prompt. |

Environment fallbacks, used when no JSON file exists:

- `FLEET_CONFIG_PATH`
- `FLEET_MAX_CONCURRENT`
- `FLEET_MAX_BATCH`
- `FLEET_DEFAULT_TIMEOUT_MS`
- `FLEET_OUTPUT_CAP_BYTES`
- `FLEET_PI_BINARY`
- `FLEET_INJECT_SYSTEM_PROMPT`

## Installation

```bash
pi install https://github.com/ulvestuen/pi-kit
```

For a source checkout:

```bash
pi -e /absolute/path/to/pi-kit/fleet/index.ts
```

## Verification

```bash
npm test --workspace pi-fleet
```

Tests use injected process functions for the pure runner and real short-lived
local processes for the host adapter's output and cancellation contract.

## Files

- `index.ts` — `fleet_run`, `/fleet`, progress, and session batch state.
- `config.ts` — Fleet configuration.
- `host.ts` — direct process adapter, discovery, transcripts, and worktree roots.
- `runner.ts` — pure concurrency, timeout, output, and isolation engine.
- `registry.ts` — agent definition parsing and merging.
- `agents/` — shipped role definitions.
- `test.ts` — runtime and contract tests.
