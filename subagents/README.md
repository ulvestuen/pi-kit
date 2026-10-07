# Pi subagents

A standalone Pi extension: no Herdr, terminal tabs, shell launcher, or `pi`
child processes. It uses the supported `createAgentSession()` SDK on Pi
**1.1.0+** (`@earendil-works` packages; peer range `^1.1.0`, Node.js 22.19+).

```text
                        ┌─ scout / planner / critic ─ read-only tools
parent ─ subagent tool ─┤
                        └─ implementer / auditor ─ scoped coding / shell
                                  │
                   typed events → progress widget + tool results
```

## Enable and use

Installing pi-kit enables this extension through the root package manifest.
To try it directly from a checkout:

```sh
npm ci
pi -e ./subagents/index.ts
```

Ask Pi to delegate a task, or load `/skill:subagents` for the role workflow.
The extension also works without the skill; its tool includes delegation
guidance. `subagents/` can be installed on its own as a local Pi package.

The `subagent` tool accepts `tasks: [{ role, task, cwd?, model? }]`,
`concurrency` (default 2, max 4), and `timeout` (seconds per child, default
600, max 3600). Batches contain 1–8 tasks. `model` is `provider/model-id`;
omitting it inherits the active parent's model. Relative `cwd` values are
resolved from the parent's working directory.

The panel shows queued/running/completed/failed/cancelled/timed-out states,
elapsed time, tool calls, token usage, and current activity. When a batch
settles, the live panel disappears and its status remains in the tool result
and footer. Expand tool results with Pi's normal tool-expansion shortcut to
read task briefs and answers. Token counts/cost in result details describe
the children; they are not automatically added to the parent's provider usage.

| Command | Action |
| --- | --- |
| `/subagents` | Show the latest batch status |
| `/subagents cancel` | Cancel active children and queued tasks |
| `/subagents clear` | Dismiss the latest progress panel |

Parent cancellation and session shutdown/reload also abort children and
dispose their sessions. Individual failures do not discard successful sibling
answers. Progress is available as structured tool updates in non-TUI modes.

## Isolation and tradeoffs

Each child has a fresh in-memory conversation, explicit role prompt and tool
allowlist, and separate settings/resources and model runtime. Authentication
and provider requests delegate to the parent's public model registry at request
time, preserving CLI key overrides, OAuth refresh, custom providers, headers,
and endpoint configuration without copying credentials into child storage.
The active model and thinking level are inherited unless a task overrides the
model. Virtual/router models require an explicit physical `provider/model-id`:
Pi's extension facade does not expose their routing definitions to child SDK
runtimes.
Repository `AGENTS.md`/`CLAUDE.md` instructions remain available; parent
conversation history, extensions, skills, and prompt templates do not.
No project-local executable agent definitions are discovered.

SDK sessions avoid subprocess startup and JSONL parsing, and provide typed
events and cancellation. They **are not security or crash-isolation boundaries**:
children share the host process, filesystem permissions, and provider limits.
Cancellation is cooperative, not a process-level hard kill. Serialize
overlapping edits or supply existing separate worktrees via `cwd`. The
auditor can run bash, so its non-mutating policy is a prompt rule, not enforced
OS isolation. Children are instructed not to delegate; no subagent tool or
extension is loaded into them.

See Pi's [SDK documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/sdk.md)
and [extension documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md).
This targets the 1.x SDK, not the old `@mariozechner` 0.x APIs. The lockfile and
tests use the complete 1.1.0 release set; later 1.x versions need re-verification.

## Verification

```sh
npm test                    # all repository suites
npm run typecheck -w subagents
```
