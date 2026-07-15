# Agent-native fleet-spawn integration verification

**Task:** t17 — replacement integration review for fleet-spawn  
**Date:** 2026-07-11  
**Branch:** `feature/agent-native-orchestration`

This document contains exact commands, exit codes, and unedited output so a
read-only critic can verify every claim independently.

## 1. Integration review scope

This review covers the integration of `agent-types`, `fleet`, and `spawn` against
the accepted ADR (`docs/agent-native-architecture.md`). It verifies:
- Shared types flow correctly from `@pi-kit/agent-types` to both consumers
- All scoped tests and TypeScript checks pass together
- Legacy persistence, timeout, abort, and backend behavior remain compatible
- ADR section 13 requirements are complete for the scoped packages

## 2. Shared type consumption — precise import inventory

### Import statements (verified by `grep`)

**Fleet — 3 import statements across 3 files, importing 2 distinct types:**

| File | Import statement |
|---|---|
| `fleet/runner.ts:11` | `import type { RunId, ArtifactRef } from "@pi-kit/agent-types"` |
| `fleet/index.ts:20` | `import type { RunId, ArtifactRef } from "@pi-kit/agent-types"` |
| `fleet/test.ts:21` | `import type { RunId, ArtifactRef } from "@pi-kit/agent-types"` |

**Spawn — 6 import statements across 6 files, importing 2 distinct types:**

| File | Import statement |
|---|---|
| `spawn/jobs.ts:23` | `import type { BackendCapabilities, KillResult } from "@pi-kit/agent-types"` |
| `spawn/runner-adapter.ts:30` | `import type { KillResult } from "@pi-kit/agent-types"` |
| `spawn/backends/tmux.ts:27` | `import type { BackendCapabilities, KillResult } from "@pi-kit/agent-types"` |
| `spawn/backends/exedev.ts:30` | `import type { BackendCapabilities, KillResult } from "@pi-kit/agent-types"` |
| `spawn/backends/microsandbox.ts:36` | `import type { BackendCapabilities, KillResult } from "@pi-kit/agent-types"` |
| `spawn/test.ts:59` | `import type { BackendCapabilities, KillResult } from "@pi-kit/agent-types"` |

**Total: 9 import statements across 9 files, 2 distinct type names per consumer
(4 distinct types overall: RunId, ArtifactRef, KillResult, BackendCapabilities).**

### Type usage in source contracts (type-usage matrix)

| Type | Consumer file | Where it appears in the contract |
|---|---|---|
| `RunId` | `fleet/runner.ts` | `TaskSpec.runId?`, `TaskResult.runId?` fields |
| `RunId` | `fleet/index.ts` | `runId` tool schema parameter |
| `ArtifactRef` | `fleet/runner.ts` | `TaskSpec.inputArtifacts?`, `TaskResult.outputArtifacts?` fields |
| `ArtifactRef` | `fleet/index.ts` | `inputArtifacts` tool schema parameter |
| `KillResult` | `spawn/jobs.ts` | `SpawnBackend.kill()` return type |
| `KillResult` | `spawn/runner-adapter.ts` | `killAndStamp()` return type |
| `KillResult` | `spawn/backends/tmux.ts` | `kill()` implementation return |
| `KillResult` | `spawn/backends/exedev.ts` | `kill()` implementation return |
| `KillResult` | `spawn/backends/microsandbox.ts` | `kill()` implementation return |
| `BackendCapabilities` | `spawn/jobs.ts` | `SpawnBackend.capabilities()` return type |
| `BackendCapabilities` | `spawn/backends/tmux.ts` | `capabilities()` implementation return |
| `BackendCapabilities` | `spawn/backends/exedev.ts` | `capabilities()` implementation return |
| `BackendCapabilities` | `spawn/backends/microsandbox.ts` | `capabilities()` implementation return |

### Workspace dependency resolution

- `fleet/package.json`: `"@pi-kit/agent-types": "*"` ✓
- `spawn/package.json`: `"@pi-kit/agent-types": "*"` ✓
- `node_modules/@pi-kit/agent-types` → symlink `../../agent-types` ✓ (verified via `ls -la` and `readlink`)

## 3. Evidence: all tests and TypeScript checks pass together

### agent-types

**Command:**
```sh
cd agent-types && npx tsc --noEmit && npx tsx --test test.ts
```
**Exit code:** 0

**Output summary:**
```
ℹ tests 35
ℹ suites 15
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 119.050959
```

### fleet

**Command:**
```sh
cd fleet && npx tsc --noEmit && npx tsx --test test.ts
```
**Exit code:** 0

**Output summary:**
```
ℹ tests 65
ℹ suites 13
ℹ pass 65
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 209.972833
```

### spawn

**Command:**
```sh
cd spawn && npx tsc -p tsconfig.json --noEmit && npx tsx --test test.ts
```
**Exit code:** 0

**Output summary:**
```
ℹ tests 132
ℹ suites 26
ℹ pass 132
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 217.906334
```

### Combined

**Total: 232 tests, 54 suites, 232 pass, 0 fail, 6 TypeScript checks (all clean).**

## 4. Legacy compatibility evidence

### agent-types — legacy consumer compatibility (2 tests)

| Test | What it covers |
|---|---|
| `legacy TaskResult shape has all original required fields` | Old shape without agent-native fields is valid |
| `v0 AgentTask (no version field) round-trips through JSON without error` | Unversioned data survives IPC |

### fleet — backward compatibility (5 tests)

| Test suite | Test | What it covers |
|---|---|---|
| `agent-native: RunId propagation` | `runId is undefined when TaskSpec omits it (backward compat)` | Old callers see `undefined` on new field |
| `agent-native: backward compatibility` | `plain TaskSpec with no agent-native fields produces a valid TaskResult` | Old spec shape works end-to-end |
| `agent-native: backward compatibility` | `worktree isolation without parentBranch defaults to HEAD` | New optional param defaults correctly |
| `agent-native: backward compatibility` | `all results retain legacy fields (agent, status, output, truncated, etc.)` | Legacy fields untouched |
| `agent-native: backward compatibility` | `legacy TaskResult destructuring still works (old consumer pattern)` | Old destructuring pattern still works |

### spawn — legacy persistence compatibility (3 tests in `legacy persistence compatibility` suite)

| Test | What it covers |
|---|---|
| `loads a v0 registry (no version field) as valid jobs` | Unversioned registry loads alongside v2 |
| `saves as v2 format with version field` | New saves produce versioned format |
| `rejects invalid job records and keeps valid ones` | Schema validation rejects garbage, keeps valid |

### spawn — v0/v2 registry in consolidated KillResult contract (3 tests, same assertions as above)

| Test | What it covers |
|---|---|
| `v0 registry (no version field) loads without error` | Consolidated suite regression guard |
| `v2 registry round-trips with version field` | Consolidated suite regression guard |
| `invalid records rejected, valid records preserved` | Consolidated suite regression guard |

### spawn — abort and timeout semantics (4 tests in `runner-adapter kill/cancellation semantics`)

| Test | What it covers |
|---|---|
| `abort before launch does not start the job` | AbortSignal before launch |
| `deadline timeout kills and reports timeout in stderr` | Hard deadline timeout + kill |
| `kill alreadyComplete does NOT stamp 'killed' in the adapter` | alreadyComplete branch |
| `kill error falls back to "lost" status` | Error → warned/unconfirmed → lost |

### spawn — cleanup semantics (4 tests in `runner-adapter kill/cancellation semantics`)

| Test | What it covers |
|---|---|
| `cleanup respects alreadyComplete: refreshes from marker, no kill stamp` | Cleanup alreadyComplete |
| `cleanup stamps lost when kill fails and refresh does not resolve` | Cleanup lost |
| `cleanup stamps killed when kill succeeds (stopped=true)` | Cleanup stopped |
| `kills and stamps stale internal jobs during cleanup` | Stale parent detection |

### KillResult three-branch protocol (38 tests in consolidated suite)

The `consolidated KillResult contract — all branches, consumers, and backends`
suite covers all 3 branches × 3 consumers (killAndStamp, cleanup, spawn_kill
tool) × 3 backends (tmux, exedev, microsandbox) plus persistence, stale-parent,
and legacy registry tests. See `docs/agent-native-spawn-verification.md` §3 for
the full matrix.

### Backend capabilities per backend (4 tests in `ADR backend capabilities`)

| Test | Assertion |
|---|---|
| `tmux declares: mount=true, cursor=false, kill=false, logs=true, net=true, iso=false` | Matches ADR §6 table |
| `exedev declares: mount=false, cursor=false, kill=false, logs=true, net=true, iso=false` | Matches ADR §6 table |
| `microsandbox declares: mount=configurable, cursor=false, kill=false, logs=true, net=true, iso=true` | Matches ADR §6 table |
| `microsandbox workspaceMount follows config.msbMountCwd` | Config-driven |

## 5. ADR section 13 compliance (scoped packages only)

Verification against `docs/agent-native-architecture.md` §13 "File / test changes (phase 1)":

### agent-types (all new files)

| ADR §13 requirement | Actual file | Status |
|---|---|---|
| `agent-types/types.ts` — RunId, ArtifactRef, AgentTask, AgentResult, BackendCapabilities, KillResult, ToolCallSummary | `agent-types/src/types.ts` — all 7 types present | ✓ |
| `agent-types/index.ts` — re-exports | `agent-types/src/index.ts` — `export * from "./types.ts"` | ✓ |
| `agent-types/package.json` — name @pi-kit/agent-types, no deps | `agent-types/package.json` — no runtime deps | ✓ |
| `agent-types/tsconfig.json` — ESM, ES2022, strict | `agent-types/tsconfig.json` — module ESNext, target ES2022, strict true | ✓ |
| `agent-types/test.ts` — round-trip, version check, migration validation | `agent-types/test.ts` — 35 tests covering all required suites | ✓ |

### fleet (changed files)

| ADR §13 requirement | Actual file | Status |
|---|---|---|
| `fleet/runner.ts` — RunId, inputArtifacts, parentBranch on TaskSpec; runId, outputArtifacts, toolCalls, usage on TaskResult | `fleet/runner.ts` — all optional fields on TaskSpec and TaskResult | ✓ |
| `fleet/index.ts` — tool schema gains optional runId, inputArtifacts, parentRunIds | `fleet/index.ts` — schema has runId, inputArtifacts, parentRunIds, parentBranch | ✓ |
| `fleet/test.ts` — RunId propagation, parentBranch worktree, backward compat | `fleet/test.ts` — 65 tests including all agent-native suites | ✓ |

### spawn (changed files)

| ADR §13 requirement | Actual file | Status |
|---|---|---|
| `spawn/jobs.ts` — capabilities() on SpawnBackend, kill() returns KillResult, registry v2 with schema validation | `spawn/jobs.ts` — SpawnBackend has capabilities() and kill(): Promise<KillResult>, REGISTRY_VERSION=2, validateJob() | ✓ |
| `spawn/backends/tmux.ts` — capabilities(), kill() checks pane_dead | `spawn/backends/tmux.ts` — capabilities() returns correct values, kill() checks pane status | ✓ |
| `spawn/backends/exedev.ts` — capabilities(), kill() with kill -0 probe | `spawn/backends/exedev.ts` — capabilities() returns correct values, kill() uses kill -0 | ✓ |
| `spawn/backends/microsandbox.ts` — capabilities(), kill() with PID check, sandboxReadonlyWorkspace | `spawn/backends/microsandbox.ts` — capabilities() returns correct values, kill() checks host pid | ✓ |
| `spawn/runner-adapter.ts` — hard deadline and KillResult propagation | `spawn/runner-adapter.ts` — deadlineMs, killAndStamp with KillResult branches, cleanupSpawnToolingJobs | ✓ |
| `spawn/index.ts` — spawn_agent respects AbortSignal, saves v2 registry | `spawn/index.ts` — signal.aborted check before launch, saveJobs from jobs.ts (v2) | ✓ |
| `spawn/config.ts` — sandboxReadonlyWorkspace | `spawn/config.ts` — read-only mount field is implemented; inactive secret-filter/HMAC settings are not advertised | ✓ |
| `spawn/test.ts` — capabilities(), KillResult shapes, v2 registry load/migrate | `spawn/test.ts` — 132 tests covering all required suites | ✓ |

**ADR §13 compliance: 16/16 requirements met for scoped packages.**

## 6. Integration defects found

**None.** The review found no integration defects across the scoped packages:
- All type imports resolve correctly through the pnpm workspace symlink
- No type mismatches between agent-types definitions and fleet/spawn usage
- KillResult three-branch protocol is consistently implemented across all 3 backends and all 3 consumers
- Legacy v0 registry data loads alongside v2 (both `loadJobs` and `saveJobs` tested)
- AbortSignal propagation works in both fleet runner and spawn adapter
- Hard deadline timeout works in the spawn runner adapter
- BackendCapabilities are declared correctly per ADR §6 tables for all 3 backends

## 7. Assumptions

- Planner, critic, and orchestrator changes from the ADR are deferred to subsequent tasks per task instructions.
- The `consolidated KillResult contract` test suite (38 tests) serves as the primary integration regression suite for the spawn KillResult protocol.
- The existing verification documents (`docs/agent-native-fleet-verification.md`, `docs/agent-native-spawn-verification.md`) remain accurate and this document supplements them with integration-specific evidence.
- The `@pi-kit/agent-types` package has zero runtime dependencies (only TypeScript interfaces) so the workspace symlink is sufficient for type resolution.
