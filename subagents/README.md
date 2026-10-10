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

Ask Pi to delegate a task. The tool includes its own delegation guidance.
`subagents/` can be installed on its own as a local Pi package.

The tool describes each role and its allowed tools directly from the bundled
role definitions. Work directly by default; delegate a bounded independent
task or a useful fresh-context review, not a mandatory sequence of roles.
Provide the goal, scope, paths, decisions, acceptance checks, and required
evidence. A critic cannot run git or tests: supply a readable diff for change
reviews and use an auditor when command-backed verification is needed.

The `subagent` tool accepts `tasks: [{ role, task, cwd?, model? }]`,
`concurrency` (default 2, max 4), and `timeout` (seconds per child, default
600, max 3600). Batches contain 1–8 tasks. `model` is `provider/model-id`;
omitting it inherits the active parent's model. Relative `cwd` values are
resolved from the parent's working directory.

The panel shows queued/running/completed/failed/cancelled/timed-out states,
elapsed time, tool calls, token usage, and current activity. When a batch
settles, the live panel disappears and its status remains in the tool result
and footer. Expand tool results with Pi's normal tool-expansion shortcut to
read task briefs, captured transcripts, and answers, including while running.
Token counts/cost in result details describe the children; they are not
automatically added to the parent's provider usage.

| Command | Action |
| --- | --- |
| `/subagents` | Show the latest batch status |
| `/subagents watch [id]` | Open the latest batch's live transcript viewer, optionally selecting child 1–8 |
| `/subagents cancel` | Cancel active children and queued tasks |
| `/subagents clear` | Dismiss the latest panel and viewer; existing tool results remain |

The viewer streams each child's provider-exposed thinking, assistant text,
tool arguments as they are generated, and tool output as it becomes available.
Tool cards distinguish preparing, running, completed, and failed calls. Use
**1–8**, **←/→**, or **Tab/Shift+Tab** to switch children; **↑/↓**, **PgUp/PgDn**,
and **Home** to scroll; **End** to resume following new output. **Esc** closes
the viewer without cancelling work. Scrolling up freezes the displayed
transcript so retention limits cannot shift the text you are reading; **End**
or switching children loads the latest snapshot and resumes following.
Short terminals use compact tabs and controls to leave room for the transcript.
Commands work while the parent is waiting for children, and the latest batch
stays inspectable after it settles.

Thinking is only visible when the chosen provider/model emits it at the
inherited thinking level; the extension cannot reveal hidden reasoning.
Tools that emit no partial output show their result when they finish.
Updates are throttled to roughly 100ms per child. Each transcript retains the
latest 40 entries and the last 8,192 characters of each text/argument/output
field, with explicit omission markers. Final answers retain their existing
limits. Images and provider thinking signatures are not copied into transcripts.
Captured text can contain sensitive task/tool data: it is included in tool
result details and may be saved with the parent session. Terminal control
sequences are stripped for display; this is not secret redaction.

Parent cancellation and session shutdown/reload also abort children and
dispose their sessions. Individual failures do not discard successful sibling
answers or their captured progress. In non-TUI modes, transcripts are available
in structured tool updates/results at `details.results[].transcript`; the
interactive viewer is TUI-only. The parent's model-facing result still contains
only final answers/status, not the live transcripts.
A `completed` status means the child returned, not that its acceptance checks
passed. Inspect the changes and evidence before accepting work; after a failure
or cancellation, inspect partial edits before retrying.

## Isolation and tradeoffs

Each child has a fresh in-memory conversation, appended role prompt and tool
allowlist, and separate settings/resources and model runtime. Authentication
and provider requests delegate to the parent's public model registry at request
time, preserving CLI key overrides, OAuth refresh, custom providers, headers,
and endpoint configuration without copying credentials into child storage.
The active model and thinking level are inherited unless a task overrides the
model. Virtual/router models require an explicit physical `provider/model-id`:
Pi's extension facade does not expose their routing definitions to child SDK
runtimes.

Pi's normal prompt assembly remains intact: the default base (or an applicable
configured `SYSTEM.md`), configured `APPEND_SYSTEM.md`, and discovered global
and repository context files remain available. Role instructions and the
no-nesting rule are appended instead of replacing that baseline. A trusted
project's prompt file takes precedence over the matching global file; Pi does
not combine both files of the same name.

Children inherit the parent's project-trust decision only for the same
resolved working-directory path. Another `cwd`, including a worktree or
subdirectory, does not inherit that trust: its `.pi/SYSTEM.md` and
`.pi/APPEND_SYSTEM.md` are not loaded. Global prompt files and ancestor/cwd
`AGENTS.md`/`CLAUDE.md` context still load; context-file discovery is not
trust-gated. This does not sandbox shell commands or file reads.

The parent's assembled prompt, conversation history, extensions, skills, and
prompt templates are not copied. Supply any task-specific skill instructions
or readable references explicitly. No project-local executable agent
definitions are discovered.

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
