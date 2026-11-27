# /swarm

`/swarm <goal>` makes the current Pi session the **coordinator** of named
worker agents. They talk on a shared, append-only message board using
`@mentions`, and a small web page on `127.0.0.1` shows everything live and
lets you post as `human`.

```text
coordinator (this session)            .swarm/<id>/board.jsonl   append-only log
 ├─ swarm_add builder  ──brief @builder──▶ builder  (git worktree swarm/<id>/builder)
 ├─ swarm_add verifier ──brief @verifier─▶ verifier (shared checkout)
 │        builder ── "@verifier ready" ──▶ verifier ── "@coordinator verified" ──▶ coordinator
 └─ http://127.0.0.1:<port>/?t=<token>   roster · board · transcripts · composer
```

## Commands

| Command | Effect |
| --- | --- |
| `/swarm <goal> [--max-active N] [--max-workers N] [--max-wakes N] [--port N]` | Start a swarm, print the UI URL, turn on the coordinator tools, and hand the goal to the coordinator |
| `/swarm ui` | Print the UI URL and open it in your browser |
| `/swarm status` | Roster, queued wakes, worktree merge status |
| `/swarm stop` | Stop workers and the web server; remove merged worktrees and report the unmerged ones |
| `/pair <task>` | Implement, audit the actual changes, and correct them |
| `/pair-review [target]` | Independently review and cross-check a pinned Git snapshot |
| `/pair-work <task>` | Plan verification, produce a deliverable, and verify it |

You can also set the limits with `PI_SWARM_MAX_ACTIVE` (default 4),
`PI_SWARM_MAX_WORKERS` (default 8), `PI_SWARM_MAX_WAKES` (default 50 per
worker), and `PI_SWARM_PORT` (default: a random free port).

## Tools

`swarm_workflow` opens browser setup for a pair preset from a normal Pi
prompt. The following tools are available only to the coordinator of a
running free-form swarm:

| Tool | Purpose |
| --- | --- |
| `swarm_add` | Add a worker (`name`, `brief`, `workspace`: `inherit` or `worktree`, `harness`, optional `model` and `effort`). Its brief is posted as `@name` and wakes it. |
| `swarm_status` | Roster, queue, and worktree status |
| `swarm_kill` | Stop a worker. A worktree worker's checkout and branch are removed only when the branch is merged and has no uncommitted changes; otherwise `force` is required. |
| `board_post` / `board_read` | Post as `@coordinator` / read history |

## Mixed swarms

In a trusted Git repository, start Pi and enter:

```text
/swarm Add @checker and @builder with harness pi. Ask builder to read README.md and hand off one observation to @checker on the board. Ask checker to verify it and report to @coordinator. Do not edit files.
```

Run `/swarm ui` to see both workers. Click a worker for its transcript, or
post `@builder summarize your observation` to wake that worker again.
`/swarm stop` stops the workers and preserves unmerged or dirty worktrees.

Pi uses the selected `provider/model` or inherits the coordinator's model in a
free-form swarm. The legacy `provider/model:thinking` form still works. Set
`effort` separately when you want to override the default for a known model.
Free-form Pi tools and extensions are unchanged; Swarm does not sandbox them.

Native Claude Code and Codex cannot launch in free-form or structured Swarm.
[Claude Code restricted mode](https://code.claude.com/docs/en/cli-reference#cli-flags)
still loads managed settings; Swarm cannot verify before launch whether they
enable startup hooks or change effective permissions. Swarm also cannot verify
Codex's effective permissions and retained command rules. Neither adapter
falls back to Pi or bypasses managed policy.
Google documents an [`agy` headless interface](https://www.antigravity.google/docs/cli/headless/),
but no installed version was available to verify, so `agy` is not supported.

A worktree separates checkouts, not accounts or permissions. Only run
trusted repositories, local configuration, and workers.

## Pair workflows

Run a slash command or ask in plain language, for example “Pair review the
working tree with Pi and use different models for the lead and peer.”
To specify the exact model IDs in a slash command:

```text
/pair-review working tree -- --lead-model anthropic/claude-sonnet-4-6 --peer-model openai/gpt-5.4
```

The browser prefills your selections. You can change the task or review target,
harness, model, effort, and round limit, then check readiness and select **Start**.
Neither worker launches until both pass validation. **Cancel** stops the setup
or run; it does not undo edits already made. The last started selections are
saved per workflow in `swarm-picks.json` in your Pi agent directory. Slash options
also accept `--<role>-effort` and `--rounds`; use the role names below.

- `/pair`: `implementer` can edit the current checkout; `auditor` gets staged and unstaged diffs and untracked paths, then reads relevant files in the checkout. Tracked binary changes, changed submodules, invalid UTF-8 evidence, and index entries marked `assume-unchanged` or `skip-worktree` stop the audit without a verdict. The run also stops if Git evidence exceeds 64 KiB; use `/pair-review` for a larger snapshot. The default is three audit rounds. The verdict is the last audit verdict, before the final correction.
- `/pair-review`: `lead` and `peer` use read-only tools scoped to the same copied snapshot. Target defaults to `working tree` (staged, unstaged, and non-ignored untracked files), or name a local revision or range such as `main...HEAD`. Fetch PR refs first; PR numbers and URLs are not Git targets. Only regular files are supported. Capture checks for drift, but is not atomic; pause other edits or select a revision. First reports stay private until both complete, followed by cross-checking (one round by default) and a consolidated verdict.
- `/pair-work`: `verifier` plans checks before `doer` starts. The verifier reads the actual deliverable and gives a verdict; reaching the round limit (three by default) without acceptance is not success. This workflow also works outside Git.

Choose Pi for runnable pair roles and select a model and effort per role.
Pair roles can read files and list directories only inside their assigned
workspace; writers can also edit and create regular files there. Those tools
refuse links and Git metadata. Pair roles do not get shell or unrestricted
recursive search tools. These are tool restrictions, not filesystem isolation
between workers sharing an account.
Structured turns have a one-hour deadline and do not resume native sessions
or use the mention board; Swarm hands each phase its validated inputs.
Run state and reports are stored in the run's
temporary directory, not in the source checkout. `/swarm ui` reopens the view
while Pi is running; a browser reload restores the run's last state.

The standalone picker and pane launchers have been retired. No terminal
multiplexer is required. The first setup uses compatible legacy picker
selections when no new selections have been saved. If you manually registered
the old picker extension, remove that entry from your Pi configuration; the
pi-kit package registers the Swarm extension and all three commands directly.

## How it works

- **Pi workers** are persistent `pi --mode rpc` children, each with its own
  session directory at `.swarm/<id>/sessions/<name>` and board tools from
  `worker-ext.ts`.
- **Paused native adapters** retain stdin prompt delivery and exact-session
  resume without automatic retry. Swarm does not dispatch them until it can
  verify their headless policy.
- **Workspaces.** `inherit` runs in the main checkout. `worktree` creates a
  `git worktree` at `.swarm/<id>/worktrees/<name>` on the branch
  `swarm/<id>/<name>`. `.swarm/` is added to `.git/info/exclude`.
- **Wakeups cost no tokens while idle.** When a worker's run settles, it
  becomes `waiting`. When a post mentions `@name` or `@all`:
  - A `waiting` member is woken with every board message after its
    `lastSeenMessageId`.
  - A crashed Pi worker becomes `stopped` and can restart with `--continue`
    in its own session directory on a later mention.
  - A `working` member is never interrupted. The mention is remembered and
    delivered as soon as its current run settles.
  - Wakes beyond `--max-active` wait in a FIFO queue.
  - `--max-wakes` stops runaway ping-pong between members.
  - System notices only ever wake `@coordinator`.
- **Single writer.** Only the coordinator process writes `.swarm/<id>/`:
  - Every write to the board, roster, and transcripts goes through one async
    mutex.
  - `roster.json` is replaced atomically (temp file and rename).
  - A lockfile stops a second process from opening the same swarm.
  - Workers post through the coordinator's local API, each with its own token,
    so they can only post under their own name.
- **Transcripts.** `.swarm/<id>/workers/<name>.jsonl` holds each worker's
  wakes, messages, and lifecycle events (plus tool traces for Pi).

## Web UI and API

`ui.html` is one self-contained file (vanilla JS/CSS, no build step). It has:

- a member roster with harness, model, effort, status, and workspace or branch;
- a transcript drawer that opens when you click a member;
- the live board with mention highlighting and markdown/code rendering;
- a composer with `@` autocomplete for free-form swarms;
- setup, readiness, phase and round status, and reports for pair workflows.

| Endpoint | |
| --- | --- |
| `GET /api/state` | Goal, limits, roster, board, queue, and workflow state |
| `GET /api/events` | SSE: `snapshot`, then `board`, `roster`, `transcript`, `workflow` |
| `GET /api/workers/:name/transcript` | Full transcript records |
| `POST /api/board` `{ "body": "..." }` | Post as `human`; routes mentions like any other post |
| `GET` / `POST /api/workflow` | Read workflow state or request check, start, or cancel |

Security:

- The server listens on `127.0.0.1` only.
- Browser requests need the token from the printed URL (`?t=` or the
  `x-swarm-token` header). Worker board requests, including MCP, use a separate
  per-worker token in a request header. The server derives the posting identity
  from the token and does not grant workers browser privileges. This is API
  authentication, not OS-level isolation between workers running as one user.
- Requests whose `Host` is not the bound address are refused, which blocks
  DNS rebinding.
- POSTs with a foreign `Origin` are refused.
- Board text is HTML-escaped before markdown is applied, and the page sets a
  strict CSP.

## Not yet

- Resuming a swarm after Pi restarts. The state on disk is kept for this.
