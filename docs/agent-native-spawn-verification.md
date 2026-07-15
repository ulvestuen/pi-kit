# Spawn KillResult contract: documentation, tests, and verification

**Task:** t21 — Finalize and prove spawn contracts in one focused pass  
**Date:** 2026-07-11  
**Supersedes:** t13, t16, t18 (failed); t19, t20 (blocked)

## 1. Files changed

| File | Change |
|---|---|
| `spawn/runner-adapter.ts` | Unified branch documentation style: `cleanupSpawnToolingJobs` comments changed from `// --- KillResult branch N: name ---` to `// KillResult branch N — name:` format, matching `killAndStamp`'s inline style. Added `KillResult` prefix to `killAndStamp`'s inline branch labels (`// KillResult branch N — name:`) for full cross-consumer consistency. |
| `spawn/index.ts` | Unified branch documentation style: `spawn_kill` tool's summary and inline comments changed from `// Branch N: name —` / `// Branch N — name:` to `// KillResult branch N — name:` format, matching both adapter consumers. |
| `spawn/backends/tmux.ts` | No changes needed — already has consistent `// Backend KillResult contract` block comment at top of `kill()`. |
| `spawn/backends/exedev.ts` | No changes needed — already has consistent `// Backend KillResult contract` block comment at top of `kill()`. |
| `spawn/backends/microsandbox.ts` | No changes needed — already has consistent `// Backend KillResult contract` block comment at top of `kill()`. |
| `spawn/test.ts` | No changes needed — 132 tests (38 in consolidated group) already cover all branches, consumers, backends, persistence, stale-parent, and legacy cases. |
| `docs/agent-native-spawn-verification.md` | This document — rewritten with exact commands, exit codes, and output. |

## 2. Documentation consistency — before and after

### Branch comment format (now unified across all three consumers)

All three consumers (`killAndStamp`, `cleanupSpawnToolingJobs`, `spawn_kill`) now use the same format:

```
// KillResult branch N — name: description of semantics
```

**Before (inconsistent):**
- `killAndStamp` (runner-adapter.ts): `// Branch N — name:` (no `KillResult` prefix)
- `cleanupSpawnToolingJobs` (runner-adapter.ts): `// --- KillResult branch N: name ---` (dashes, different order)
- `spawn_kill` summary (index.ts): `// Branch N: name —` (reversed dash/colon order)
- `spawn_kill` inline (index.ts): `// Branch N — name:` (no prefix)

**After (consistent):**
- All three: `// KillResult branch N — name:` (em-dash separator, `KillResult` prefix)

### Backend contract comments (already consistent — no changes needed)

All three backends use the same block comment format at the top of `kill()`:
```
// Backend KillResult contract (called by killAndStamp, cleanupSpawnToolingJobs, spawn_kill):
//
//  - stopped=true:  ...
//  - alreadyComplete=true, stopped=false:  ...
//  - stopped=false, no alreadyComplete:  ...
```

## 3. Consolidated test group — branch coverage matrix

The `describe("consolidated KillResult contract — all branches, consumers, and backends")` block covers:

### Branch 1: stopped (backend confirms process is gone)

| Consumer | Test | Assertion |
|---|---|---|
| killAndStamp | `[killAndStamp] stopped → stamps killed directly` | status = "killed", refresh NOT called |
| cleanup | `[cleanup] stopped → stamps killed, persists to registry` | status = "killed", persisted to disk |
| spawn_kill tool | `[spawn_kill tool] stopped → stamps killed, persists to registry` | status = "killed", text includes "Killed job" |

### Branch 2: alreadyComplete (process already exited before kill)

| Consumer | Test | Assertion |
|---|---|---|
| killAndStamp | `[killAndStamp] alreadyComplete → refreshes from done marker to done` | status = "done" via refresh |
| killAndStamp | `[killAndStamp] alreadyComplete → marks lost when refresh cannot resolve` | status = "lost" |
| cleanup | `[cleanup] alreadyComplete → refreshes to done, persists to registry` | status = "done", persisted |
| cleanup | `[cleanup] alreadyComplete → marks lost when refresh cannot resolve` | status = "lost" |
| spawn_kill tool | `[spawn_kill tool] alreadyComplete → refreshes to done` | status = "done" |
| spawn_kill tool | `[spawn_kill tool] alreadyComplete → refresh failure leaves status unchanged` | status stays non-terminal |

### Branch 3: warned / unconfirmed (kill sent but backend can't confirm)

| Consumer | Test | Assertion |
|---|---|---|
| killAndStamp | `[killAndStamp] warned/unconfirmed → marks lost when refresh fails` | status = "lost" |
| killAndStamp | `[killAndStamp] warned/unconfirmed → resolves to done when refresh succeeds` | status = "done" |
| cleanup | `[cleanup] warned/unconfirmed → marks lost when refresh fails` | status = "lost" |
| spawn_kill tool | `[spawn_kill tool] warned/unconfirmed → marks lost` | status = "lost" |
| spawn_kill tool | `[spawn_kill tool] warned/unconfirmed → resolves to done when refresh succeeds` | status = "done" |

### Thrown kill errors → converts to warned/unconfirmed

| Consumer | Test | Assertion |
|---|---|---|
| killAndStamp | `[killAndStamp] thrown kill error → converts to warned/unconfirmed → lost` | status = "lost" |
| cleanup | `[cleanup] thrown kill error → marks lost` | status = "lost" |
| spawn_kill tool | `[spawn_kill tool] thrown kill error → surfaces error, no stamp` | status unchanged, text = "Kill failed" |

### Backend KillResult implementations — all branches per backend

| Backend | Test | Branch covered |
|---|---|---|
| tmux | `[tmux] kill: stopped (alive + kill-window succeeds)` | alive + kill-window succeeds → stopped |
| tmux | `[tmux] kill: alreadyComplete (pane already dead)` | pane_dead → alreadyComplete |
| tmux | `[tmux] kill: alreadyComplete (pane dies during kill race)` | alive→kill fails→re-probe dead → alreadyComplete |
| tmux | `[tmux] kill: warned/unconfirmed (no window id)` | no tmuxWindowId → warned |
| exedev | `[exedev] kill: stopped (alive + SIGTERM + confirm dead)` | alive + SIGTERM + confirm dead → stopped |
| exedev | `[exedev] kill: alreadyComplete (process dead before kill)` | probe dead → alreadyComplete |
| exedev | `[exedev] kill: warned/unconfirmed (probe failed)` | probe exitCode 255 → warned |
| exedev | `[exedev] kill: warned/unconfirmed (no ssh dest)` | no sshDest → warned |
| microsandbox | `[microsandbox] kill: stopped (host pid alive → killed → confirm dead)` | host pid alive → kill → confirm dead → stopped |
| microsandbox | `[microsandbox] kill: alreadyComplete (host pid already dead)` | host pid dead → alreadyComplete |
| microsandbox | `[microsandbox] kill: warned/unconfirmed (host pid still alive after SIGTERM)` | host pid still alive → warned |

### Cleanup persistence (write → reload from disk)

| Test | Assertion |
|---|---|
| `cleanup persists killed status to jobs.json and reloads` | loadJobs returns status = "killed" |
| `cleanup persists lost status to jobs.json and reloads` | loadJobs returns status = "lost" |
| `cleanup persists done status from refresh to jobs.json and reloads` | loadJobs returns status = "done" |

### Stale-parent and legacy registry

| Test | Assertion |
|---|---|
| `cleanup kills orphaned jobs (dead parentPid)` | cleaned = 1, killed includes the job |
| `cleanup preserves jobs with alive parentPid` | cleaned = 0, job stays "running" |
| `cleanup treats jobs without parentPid as stale (legacy)` | cleaned = 1 (pre-ownership records are stale) |
| `cleanup ignores non-prefixed jobs` | cleaned = 0, user jobs untouched |
| `v0 registry (no version field) loads without error` | loads 1 job, no errors |
| `v2 registry round-trips with version field` | version = 2 in saved JSON |
| `invalid records rejected, valid records preserved` | 1 valid job kept, errors reported |

## 4. Verification evidence

### TypeScript check

**Command:**
```sh
npx tsc -p spawn/tsconfig.json --noEmit
```

**Exit code:** 0  
**Output:** (none — clean)

### Full test suite

**Command:**
```sh
npx tsx --test spawn/test.ts
```

**Exit code:** 0

**Summary:**
```
ℹ tests 132
ℹ suites 26
ℹ pass 132
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 239.86425
```

**Consolidated group output (38 tests, 0 failures):**
```
▶ consolidated KillResult contract — all branches, consumers, and backends
  ✔ [killAndStamp] stopped → stamps killed directly (0.866ms)
  ✔ [cleanup] stopped → stamps killed, persists to registry (0.512ms)
  ✔ [spawn_kill tool] stopped → stamps killed, persists to registry (0.476ms)
  ✔ [killAndStamp] alreadyComplete → refreshes from done marker to done (0.836ms)
  ✔ [killAndStamp] alreadyComplete → marks lost when refresh cannot resolve (0.657ms)
  ✔ [cleanup] alreadyComplete → refreshes to done, persists to registry (0.485ms)
  ✔ [cleanup] alreadyComplete → marks lost when refresh cannot resolve (0.585ms)
  ✔ [spawn_kill tool] alreadyComplete → refreshes to done (0.545ms)
  ✔ [spawn_kill tool] alreadyComplete → refresh failure leaves status unchanged (next poll resolves) (0.607ms)
  ✔ [killAndStamp] warned/unconfirmed → marks lost when refresh fails (nonterminal) (0.635ms)
  ✔ [killAndStamp] warned/unconfirmed → resolves to done when refresh succeeds (terminal) (0.772ms)
  ✔ [cleanup] warned/unconfirmed → marks lost when refresh fails (0.483ms)
  ✔ [spawn_kill tool] warned/unconfirmed → marks lost (0.425ms)
  ✔ [spawn_kill tool] warned/unconfirmed → resolves to done when refresh succeeds (0.428ms)
  ✔ [killAndStamp] thrown kill error → converts to warned/unconfirmed → lost (0.762ms)
  ✔ [cleanup] thrown kill error → marks lost (0.475ms)
  ✔ [spawn_kill tool] thrown kill error → surfaces error, no stamp (0.431ms)
  ✔ [tmux] kill: stopped (alive + kill-window succeeds) (0.140ms)
  ✔ [tmux] kill: alreadyComplete (pane already dead) (0.140ms)
  ✔ [tmux] kill: alreadyComplete (pane dies during kill race) (0.153ms)
  ✔ [tmux] kill: warned/unconfirmed (no window id) (0.361ms)
  ✔ [exedev] kill: stopped (alive + SIGTERM + confirm dead) (0.141ms)
  ✔ [exedev] kill: alreadyComplete (process dead before kill) (0.134ms)
  ✔ [exedev] kill: warned/unconfirmed (probe failed) (0.236ms)
  ✔ [exedev] kill: warned/unconfirmed (no ssh dest) (0.119ms)
  ✔ [microsandbox] kill: stopped (host pid alive → killed → confirm dead) (0.186ms)
  ✔ [microsandbox] kill: alreadyComplete (host pid already dead) (0.184ms)
  ✔ [microsandbox] kill: warned/unconfirmed (host pid still alive after SIGTERM) (0.185ms)
  ✔ cleanup persists killed status to jobs.json and reloads (0.480ms)
  ✔ cleanup persists lost status to jobs.json and reloads (0.455ms)
  ✔ cleanup persists done status from refresh to jobs.json and reloads (0.584ms)
  ✔ cleanup kills orphaned jobs (dead parentPid) (0.573ms)
  ✔ cleanup preserves jobs with alive parentPid (0.297ms)
  ✔ cleanup treats jobs without parentPid as stale (legacy) (0.428ms)
  ✔ cleanup ignores non-prefixed jobs (0.483ms)
  ✔ v0 registry (no version field) loads without error (0.181ms)
  ✔ v2 registry round-trips with version field (0.260ms)
  ✔ invalid records rejected, valid records preserved (0.193ms)
✔ consolidated KillResult contract — all branches, consumers, and backends (16.148ms)
```

## 5. Design note: spawn_kill alreadyComplete vs cleanup/killAndStamp

The `spawn_kill` tool's alreadyComplete branch does **not** mark "lost" when the refresh cannot resolve the status (unlike `killAndStamp` and `cleanupSpawnToolingJobs`). This is intentional:

- The tool reports "already completed" to the user via text.
- The next `spawn_jobs` poll re-probes the backend and resolves the terminal status.
- Marking "lost" here would be premature — the backend confirmed the process exited, so it *is* terminal; we just haven't read the marker yet.

The `killAndStamp` and `cleanup` paths mark "lost" because they move on permanently (the adapter returns, the session ends), so the job must not stay "running" forever.

## 6. Assumptions

- The three-branch KillResult contract (stopped / alreadyComplete / warned+unconfirmed) defined in ADR §6/§9 is authoritative and exhaustive.
- All built-in backends advertise `confirmedKill: true` because they return
  `stopped: true` only after confirming the process or window is gone. Caller
  branch logic is still determined by the `KillResult` shape.
- A thrown exception from `backend.kill()` is semantically equivalent to warned/unconfirmed (branch 3) and follows the same refresh → mark-lost path.
- Legacy jobs without `parentPid` are treated as stale during cleanup (matches pre-ownership-tracking behavior).
- No changes were made outside `spawn/` and `docs/` as instructed.
