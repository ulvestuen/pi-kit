---
name: subagents
description: Delegate focused work to isolated pi sub-agents run as child processes — explore code (scout), decompose goals into tasks (planner), implement one scoped task (implementer), review work against criteria (critic), or verify claims with command evidence (auditor). Use when a task benefits from fresh context, an independent perspective, or parallel fan-out.
---

# Sub-agents

Delegate a focused piece of work to a fresh `pi` child process with a role
prompt and a restricted tool set. Each sub-agent starts with no context beyond
its role and the task text you give it, so write self-contained briefs.

## Roles

| Role | What it does | Tools |
| --- | --- | --- |
| `scout` | Read-only exploration; answers one question about a codebase with `path:line` evidence | read, grep, find, ls |
| `planner` | Decomposes a goal into small tasks with dependencies and acceptance criteria | read, grep, find, ls |
| `implementer` | Implements exactly one well-scoped task, verifies it, and reports evidence | read, bash, edit, write |
| `critic` | Independent reviewer; scores work honestly against an explicit rubric | read, grep, find, ls |
| `auditor` | Verification with shell access; answers with exact command output as evidence | read, bash, grep, find, ls |

The full role prompts live in `{baseDir}/roles/*.md`. Read one before use if
you need to know exactly how that role behaves, or add new role files there.

## Running a sub-agent

```sh
node {baseDir}/run-subagent.mjs --role scout "Where is retry logic implemented in this repo? Cite files and lines."
```

Options: `--model <m>`, `--cwd <dir>`, `--tools a,b,c` (override the role's
tools), `--timeout <seconds>` (default 600), `--inherit` (let the child load
extensions/skills; off by default), or `--system-prompt "<text>"` instead of
`--role` for an ad-hoc role. Set `PI_BINARY` if `pi` is not on `PATH`.

The script prints the child's final answer to stdout and exits non-zero on
failure or timeout.

## Patterns

- **Fan-out**: run several sub-agents in parallel by launching multiple
  commands in the background and collecting their outputs.
- **Plan → implement → review**: ask `planner` for a task list, run an
  `implementer` per task (sequentially, or in parallel when tasks touch
  disjoint files), then have `critic` score the result and `auditor` verify
  the claims. Iterate on whatever the critic flags.
- **Isolation**: for risky parallel edits, run each implementer in its own
  `git worktree` (create it yourself, pass it via `--cwd`, merge afterwards).

## Rules

- Give each sub-agent one focused task with everything it needs in the brief:
  goal, relevant file paths, acceptance criteria, and required output format.
- Don't delegate trivial work — a sub-agent costs a full model run.
- Treat sub-agent claims as unverified until you (or an auditor) check them.
