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

## Run in a temporary Herdr tab

Before launching a sub-agent, check whether the caller is inside Herdr:

```sh
test "${HERDR_ENV:-}" = 1
```

When this succeeds, run **each** sub-agent in its own temporary tab instead of
in the caller's pane:

1. Run `herdr tab` and `herdr pane` first; the installed CLI is authoritative.
2. Create an unfocused tab in the caller's workspace and preserve the requested
   cwd:

   ```sh
   herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <cwd> --label "subagent: <role>" --no-focus
   ```

3. Parse `.result.tab.tab_id` and `.result.root_pane.pane_id` from the JSON
   response. Never infer IDs.
4. Start the runner in that root pane with `herdr pane run <pane-id> <command>`.
   This is an ordinary command, so do not use `herdr agent start`. Redirect its
   output and exit status to unique files in a temporary directory so the
   caller can wait for completion and recover the exact final answer.
5. After reading the result, close only the created tab with
   `herdr tab close <tab-id>` and remove the temporary files. Do this on
   success, failure, and timeout; keep the user's focus in the calling tab
   throughout.

For fan-out, create one tab per sub-agent and wait for them in parallel. When
`HERDR_ENV` is not `1`, invoke the runner directly as shown above.

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
