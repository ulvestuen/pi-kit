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

You can also set the limits with `PI_SWARM_MAX_ACTIVE` (default 4),
`PI_SWARM_MAX_WORKERS` (default 8), `PI_SWARM_MAX_WAKES` (default 50 per
worker), and `PI_SWARM_PORT` (default: a random free port).

## Tools

The following tools are available only to the coordinator of a running swarm:

| Tool | Purpose |
| --- | --- |
| `swarm_add` | Add a worker (`name`, `brief`, `workspace`: `inherit` or `worktree`, `harness`, optional `model` and `effort`). Its brief is posted as `@name` and wakes it. |
| `swarm_status` | Roster, queue, and worktree status |
| `swarm_kill` | Stop a worker. A worktree worker's checkout and branch are removed only when the branch is merged and has no uncommitted changes; otherwise `force` is required. |
| `board_post` / `board_read` | Post as `@coordinator` / read history |

## Mixed swarms

On Linux or macOS, sign in to the harnesses you want to use and start `pi` as usual. The CLIs must be on `PATH` or specified with `SWARM_CLAUDE_BIN`, `SWARM_CODEX_BIN`, or `SWARM_AGY_BIN`. No Swarm trust setting is required. Then enter:

```text
/swarm Use native Claude Code for @reader, native Codex for @checker, and native agy for @summarizer. Have them hand off observations about README.md in that order, then report to @coordinator. Do not edit files.
```

Run `/swarm ui` to see the workers. Click a worker for its transcript, or
post `@reader summarize your observation` to wake that worker again.
`/swarm stop` stops the workers and preserves unmerged or dirty worktrees.

Pi uses the selected `provider/model` or inherits the coordinator's model.
The legacy `provider/model:thinking` form still works. Set
`effort` separately when you want to override the default for a known model.
Pi tools and extensions are unchanged; Swarm does not sandbox them.

Pass native model IDs and effort to the coordinator in your request, or omit
them to use each CLI's defaults. Antigravity checks explicit IDs against the
model and thinking options the account exposes over ACP.

Claude Code, Codex, and Antigravity run headlessly in their native permission bypass modes. Swarm also answers any approval requests Antigravity still sends over [ACP](https://antigravity.google/docs/cli/acp); there is no dashboard approval step. Swarm does not change saved trust settings or override OS permissions, CLI hard denials, or organization-managed settings. No harness is substituted on failure.

**Native workers are not isolated.** They use your usual CLI settings and sign-in, can run shell commands, and can access files outside the task directory as your user. A worktree separates checkouts, not permissions. Use native workers with repositories, inputs, and CLI settings you trust.

## How it works

- **Pi workers** are persistent `pi --mode rpc` children, each with its own
  session directory at `.swarm/<id>/sessions/<name>` and board tools from
  `worker-ext.ts`.
- **Native workers** receive prompts over stdin and talk to the board over MCP
  with per-worker identity. They resume the exact native session on a later wake.
  Failed turns are not replayed; fix the issue and add a new worker.
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
- **Single writer.** The coordinator manages writes to `.swarm/<id>/`:
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
- a composer with `@` autocomplete.

| Endpoint | |
| --- | --- |
| `GET /api/state` | Goal, limits, roster, board, and queue |
| `GET /api/events` | SSE: `snapshot`, then `board`, `roster`, `transcript` |
| `GET /api/workers/:name/transcript` | Full transcript records |
| `POST /api/board` `{ "body": "..." }` | Post as `human`; routes mentions like any other post |

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
