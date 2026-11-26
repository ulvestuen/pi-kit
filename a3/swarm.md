---
title: Add /swarm multi-agent orchestration with a shared board and local web UI
status: open
owner: idar
updated: 2026-11-26
---

## Background

The user wants one Pi session to coordinate several named workers on a goal:
the coordinator splits the goal into tracks, workers collaborate through a
shared append-only message board using `@mentions`, idle workers cost no
tokens, and a small local web page shows the roster, the board, and each
worker's transcript, and lets the human post.

## Current condition

- pi-kit has two extensions (`threema/`, `extensions/pair/`); neither runs
  child agents. The pair skills run separate `pi` processes in Herdr/Rex panes.
- Pi 1.1.0+ has no in-process sub-session API for extensions. It does have
  `pi --mode rpc` (JSONL `prompt`/`abort`, events incl. `agent_settled`) —
  `docs/rpc.md`, `docs/json.md`. The `subagent` example spawns `pi` processes
  the same way (`examples/extensions/subagent/index.ts:292`).
- Extension docs: start sockets/processes lazily, close them in an idempotent
  `session_shutdown` (`docs/extensions.md`, "Long-lived resources").
- `agent_end` is not idle; `agent_settled` is (`docs/extensions.md`).

## Goal

- [x] `/swarm <goal>` activates the coordinator tools (`swarm_add`,
  `swarm_status`, `swarm_kill`, `board_post`, `board_read`) and prints a
  `127.0.0.1` UI URL; `/swarm ui` shows/opens it.
- [x] `swarm_add` posts the brief as `@name`, spawns a fresh-context worker
  (`inherit` or `worktree`), and `swarm_kill` cleans merged worktrees and
  refuses unmerged ones without `force`.
- [x] `.swarm/<id>/board.jsonl`, `roster.json`, `workers/<name>.jsonl` are
  written by one serialized writer; concurrent posts never corrupt them.
- [x] Mention routing: waiting/stopped members wake with all unread messages;
  working members get them queued for their next turn; concurrency is capped.
- [x] Web UI: SSE live feed, roster with badges, transcript drawer, composer
  with `@` autocomplete; `POST /api/board` uses the same router.
- [x] `/swarm stop` stops workers, closes the server, reports unmerged
  worktrees.
- [x] `npm test` and `git diff --check` pass.

## Root cause analysis

New feature; no defect. The design constraint: workers must be isolated (own
cwd for worktrees, crash isolation) and inspectable, so each worker is a
`pi --mode rpc` child; the coordinator process is the only writer of swarm
state, which removes cross-process locking.

## Countermeasures

### C1: Coordinator-owned store, router, RPC worker driver, and local server
- Addresses: concurrency, wakeups, isolation, visibility
- Prediction: unit tests with a fake `pi` RPC script and a temp git repo show
  correct wake/queue/cap behavior, intact JSONL under concurrent appends,
  worktree lifecycle, and an HTTP API that rejects foreign Host/Origin/tokens.
- Check: `npm test -w extensions/swarm`; manual run of the UI against a demo
  swarm.
- Result: confirmed. `npm test -w extensions/swarm` passes 24/24 (5 repeat
  runs, 0 failures). The tests cover: 200 concurrent appends giving dense ids
  and intact lines; queue-while-working with delivery after settle; the
  cap/FIFO drain; restarting a crashed worker with `--continue`; the wake
  limit; U+2028 framing; worktree refuse/merge/remove in a temp repo; and
  Host/Origin/token rejection plus SSE. An end-to-end test with fake RPC
  workers runs builder → @verifier → @coordinator. Checks against real Pi
  1.6.1 in RPC mode: the coordinator tools turn on only after `/swarm` and
  off after `/swarm stop`; the `<swarm>` section is in the prompt; a human
  POST woke the coordinator; it went from `working` to `waiting` on
  `agent_settled`; the server closed on stop; `.swarm/` stayed out of
  `git status`. A real `pi --mode rpc` worker loads only `board_post` and
  `board_read` and stops in about 20 ms. Headless Chrome (CDP) checks: the
  roster badges, markdown/code rendering, the `@ve` → `@verifier`
  autocomplete, an Enter-to-post that woke the verifier, an escaped
  `<script>` (0 script nodes in the feed), and the live transcript drawer
  (11 records).

## Implementation plan

- [x] store.ts (mutex, board append, atomic roster)
- [x] router.ts (mentions, wake/queue, cap, loop guard)
- [x] driver.ts (RPC child, LF framing, transcript)
- [x] worktree.ts
- [x] server.ts + ui.html
- [x] worker-ext.ts + index.ts wiring, package.json, README
- [x] tests, full `npm test`, manual UI check

## Follow-up

- Predicted vs observed: as predicted. Two defects were found and fixed
  during the check:
  - System crash notices mentioned the crashed worker, which made it respawn
    in a loop. System posts now wake only `@coordinator`.
  - A `handled` prompt disposition never settles a worker, so the driver now
    settles it directly.
- Shipped in 3663c54 on main. CI passed on ubuntu, macOS, and Windows:
  https://github.com/ulvestuen/pi-kit/actions/runs/45907911869
- Not verified: a full swarm with real model calls (no paid runs were made).
- Deferred: `/swarm resume <id>` after Pi restarts.
