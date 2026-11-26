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

Only the coordinator has these, and only while a swarm runs:

| Tool | Purpose |
| --- | --- |
| `swarm_add` | Spawn a worker (`name`, `brief`, `workspace`: `inherit` or `worktree`, optional `model`). Its brief is posted as `@name` and wakes it. |
| `swarm_status` | Roster, queue, and worktree status |
| `swarm_kill` | Stop a worker. A worktree worker's checkout and branch are removed only when the branch is merged and has no uncommitted changes; otherwise `force` is required. |
| `board_post` / `board_read` | Post as `@coordinator` / read history |

Workers get their own `board_post` and `board_read` from `worker-ext.ts`.

## How it works

- **Workers** are long-lived `pi --mode rpc` child processes, one per worker:
  - Each starts with a fresh context.
  - Each gets worker rules (`--append-system-prompt`) and its own session in
    `.swarm/<id>/sessions/<name>`.
  - They use the coordinator's model unless `model` is given.
- **Workspaces.** `inherit` runs in the main checkout. `worktree` creates a
  `git worktree` at `.swarm/<id>/worktrees/<name>` on the branch
  `swarm/<id>/<name>`. `.swarm/` is added to `.git/info/exclude`.
- **Wakeups cost no tokens while idle.** When a worker's run settles, it
  becomes `waiting`. When a post mentions `@name` or `@all`:
  - A `waiting` member is woken with every board message after its
    `lastSeenMessageId`.
  - A `stopped` member (crashed or stopped) is restarted with `--continue`
    and woken the same way.
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
  wakes, messages, tool calls, results, and settle events.

## Web UI and API

`ui.html` is one self-contained file (vanilla JS/CSS, no build step). It has:

- a member roster with status badges, model, and workspace or branch;
- a transcript drawer that opens when you click a member;
- the live board with mention highlighting and markdown/code rendering;
- a composer with `@` autocomplete.

| Endpoint | |
| --- | --- |
| `GET /api/state` | Goal, limits, roster, board, queue |
| `GET /api/events` | SSE: `snapshot`, then `board`, `roster`, `transcript` |
| `GET /api/workers/:name/transcript` | Full transcript records |
| `POST /api/board` `{ "body": "..." }` | Post as `human`; routes mentions like any other post |

Security:

- The server listens on `127.0.0.1` only.
- Every request needs the token from the printed URL (`?t=` or the
  `x-swarm-token` header).
- Requests whose `Host` is not the bound address are refused, which blocks
  DNS rebinding.
- POSTs with a foreign `Origin` are refused.
- Board text is HTML-escaped before markdown is applied, and the page sets a
  strict CSP.

## Not yet

- Resuming a swarm after Pi restarts. The state on disk is kept for this.
- Workers run with your normal extensions and tools, without a sandbox. Only
  start swarms in repositories you trust.
