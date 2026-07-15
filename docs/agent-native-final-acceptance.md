# Agent-native final acceptance

**Date:** 2026-07-11 | **Branch:** `feature/agent-native-orchestration`
**ADR:** `docs/agent-native-architecture.md`
**Evidence dir:** `docs/agent-native-evidence/`

All claims below cite raw evidence saved to `docs/agent-native-evidence/` and
verified with `rg -ba`, `rg -n`, `git status --short`, `git diff --name-only HEAD`,
`git diff --stat HEAD`. No source code was modified and no full test suite was rerun.

- Source/test self-identification: `final-source-lines.log` enumerates every cited
  source/test file under a `===== FILE: <relative/path> =====` header followed by
  valid `nl -ba <relative/path>` output (line numbers match `wc -l`).
- Test totals: `final-test-summaries.log` reproduces the seven package `ℹ tests` /
  `ℹ suites` / `ℹ pass` / `ℹ fail` lines under explicit package headers and appends
  verified arithmetic totals.
- Final mechanical validation: `final-evidence-validation.log` (produced by
  `validate-evidence.sh`) proves every concrete `.ts`/`.json` path cited below has an
  exact `===== FILE: <path> =====` header in `final-source-lines.log`, every header is
  followed by tab-delimited `nl -ba` numbered content with no `usage:` error, the seven
  per-package test blocks sum to 358 tests / 83 suites / 358 pass / 0 fail, and `git
  status --short` shows exactly 29 tracked modified files and 13 untracked porcelain
  paths with no scaffolding. Overall verdict: **PASS**.

## 1. Seven disjoint package test counts

Per-package counts are reproduced literally in `final-test-summaries.log`
(final-test-<package>.log `ℹ` summary lines) with verified arithmetic totals.

| # | Package | Tests | Suites | Fail | Evidence log |
|---|---------|------:|-------:|-----:|---|
| 1 | `agent-types` | 35 | 15 | 0 | `final-test-agent-types.log` |
| 2 | `lykkja` | 34 | 6 | 0 | `final-test-lykkja.log` |
| 3 | `fleet` | 65 | 13 | 0 | `final-test-fleet.log` |
| 4 | `planner` | 35 | 9 | 0 | `final-test-planner.log` |
| 5 | `critic` | 20 | 3 | 0 | `final-test-critic.log` |
| 6 | `orchestrator` | 37 | 11 | 0 | `final-test-orchestrator.log` |
| 7 | `spawn` | 132 | 26 | 0 | `final-test-spawn.log` |
| | **Total** | **358** | **83** | **0** | |

Seven disjoint counts sum to **358** once. The 358 / 83 / 358 / 0 totals are
reproduced and re-summed in `final-test-summaries.log` (`===== TOTALS =====`).

**Orchestrator 33→37:** Four handoff-related tests were added beyond the
prior 33-test baseline:

1. `"recordPassingArtifacts calls worktreeCommit when provided with a branch"` — `orchestrator/test.ts:488`
2. `"recordPassingArtifacts does not call worktreeCommit when no branch"` — `orchestrator/test.ts:516`
3. `"recordPassingArtifacts swallows commit errors without blocking plan"` — `orchestrator/test.ts:528`
4. `"buildHandoffSection formats multiple prerequisite artifacts"` — `orchestrator/test.ts:827`

## 2. TypeScript and module resolution

All seven packages compile clean (tsc --noEmit exit 0). ESM and CJS imports
resolve. Raw output: `final-tsc-all.log`, `final-module-resolution.log`.

## 3. Git inventory

**29 tracked modified files** (from `git diff --name-only HEAD`, recorded in `final-git-diff-names.log`):
`README.md`, `critic/index.ts`, `critic/package.json`, `critic/review.ts`,
`critic/test.ts`, `fleet/index.ts`, `fleet/package.json`, `fleet/runner.ts`,
`fleet/test.ts`, `lykkja/index.ts`, `orchestrator/index.ts`,
`orchestrator/package.json`, `orchestrator/scheduler.ts`, `orchestrator/test.ts`,
`package-lock.json`, `package.json`, `planner/index.ts`, `planner/package.json`,
`planner/plan.ts`, `planner/test.ts`, `spawn/backends/exedev.ts`,
`spawn/backends/microsandbox.ts`, `spawn/backends/tmux.ts`, `spawn/config.ts`,
`spawn/index.ts`, `spawn/jobs.ts`, `spawn/package.json`,
`spawn/runner-adapter.ts`, `spawn/test.ts`.

**13 untracked paths** (from `git status --short` `??`, recorded in `final-git-status.log`):
`agent-types/`, `docs/agent-native-architecture.md`,
`docs/agent-native-consolidated-verification.md`,
`docs/agent-native-control-audit.md`, `docs/agent-native-evidence/`,
`docs/agent-native-final-acceptance.md`, `docs/agent-native-fleet-audit.md`,
`docs/agent-native-fleet-verification.md`,
`docs/agent-native-integration-verification.md`,
`docs/agent-native-orchestrator-audit.md`, `docs/agent-native-spawn-audit.md`,
`docs/agent-native-spawn-verification.md`, `orchestrator/handoff.ts`.

**Diff total:** 29 files changed, +3496 −91 (from `git diff --stat HEAD`).

## 4. ADR §3–§11 traceability

### §3 Versioned types / APIs

| Interface | Source | Test evidence |
|-----------|--------|---------------|
| `RunId` | `agent-types/src/types.ts:20-29` | `"RunId"` suite (2 tests) in `final-test-agent-types.log` |
| `ArtifactRef` | `agent-types/src/types.ts:36-41` | `"ArtifactRef"` suite (2 tests) |
| `AgentTask` | `agent-types/src/types.ts:48-62` | `"AgentTask"` suite (3 tests) |
| `AgentResult` | `agent-types/src/types.ts:65-81` | `"AgentResult"` suite (4 tests) |
| `BackendCapabilities` | `agent-types/src/types.ts:95-108` | `"BackendCapabilities"` suite (2 tests) |
| `KillResult` | `agent-types/src/types.ts:111-118` | `"KillResult"` suite (3 tests) |
| `RunEvent` | `agent-types/src/types.ts:125-130` | `"RunEvent"` suite (2 tests) |
| Schema versioning | `agent-types/src/types.ts:50` (`AgentTask.version`) | `"schema versioning"` (2 tests) |
| JSON round-trip | `agent-types/src/types.ts` | `"JSON round-trip"` (4 tests) |
| Legacy compat | `agent-types/src/types.ts` | `"legacy consumer compatibility"` (2 tests) |

### §4 Lifecycle transitions

| Requirement | Source | Test evidence |
|-------------|--------|---------------|
| `LEGAL_TRANSITIONS` map | `planner/plan.ts:218-225` | `"setTaskStatus transition soft-check"` suite (4 tests) |
| `warnIllegalTransition` | `planner/plan.ts:227-240` | `"warns on illegal transition running → done"`, `"done → ready"`, `"failed → ready"` |
| `setTaskStatus` enforcement | `planner/plan.ts:256-275` | `"does not warn on legal transitions"` |
| Attempt increment | `planner/plan.ts:267` | `"counts dispatches as attempts"` |
| `applyTaskResult` | `orchestrator/scheduler.ts:98-125` | 4 tests: `"sends ok results to review"`, `"re-queues a first failure..."`, `"fails the task at the attempt cap"`, `"rejects unknown task ids"` |
| `applyReview` | `orchestrator/scheduler.ts:132-168` | 4 tests: `"marks passed reviews done"`, `"re-queues failed reviews..."`, `"fails the task when review fails..."`, `"rejects reviews of tasks not awaiting review"` |

### §5 Structured artifact handoffs

| Requirement | Source | Test evidence |
|-------------|--------|---------------|
| `PlanTask.artifacts: ArtifactRef[]` | `planner/plan.ts:53` | `"artifacts survive createPlan → getTask round-trip"`, `"artifacts survive JSON round-trip"`, `"status transitions preserve artifacts"` |
| `buildHandoffSection(plan, task)` | `orchestrator/handoff.ts:23-39` (production) | `"buildHandoffSection returns empty when no dependencies have artifacts"`, `"buildHandoffSection returns empty when dependencies are not done"`, `"buildHandoffSection formats multiple prerequisite artifacts"` |
| `buildTaskBrief` injects handoff | `orchestrator/index.ts:84-104` (calls `buildHandoffSection` at line 88) | `"drives a 2-task DAG to FINAL: legacy task completes, dependent receives artifacts via brief..."` |
| `recordPassingArtifacts(plan, task, result, worktreeCommit?)` | `orchestrator/handoff.ts:65-116` | `"applyReview + recordPassingArtifacts stores artifacts on the done task"`, `"recordPassingArtifacts calls worktreeCommit..."`, `"does not call worktreeCommit when no branch"`, `"swallows commit errors without blocking plan"` |
| `findParentBranch(plan, task)` | `orchestrator/handoff.ts:46-58` | `"finds the branch from a done dependency's artifacts"`, `"returns undefined when no prerequisite has a branch artifact"`, `"returns undefined when dependency is not done"`, `"picks the first done dependency's branch artifact"` |
| Downstream brief sees artifacts | `orchestrator/index.ts:88` (`buildHandoffSection` call) | `"downstream tasks see prerequisite artifacts in handoff section"` |
| Critic receives `artifacts: ArtifactRef[]` | `critic/review.ts:30` (`ReviewRequest.artifacts`), `critic/review.ts:75-79` (evidence section) | Orchestrator `reviewSpec` at `orchestrator/index.ts:363-375` collects dep artifacts and passes to `ReviewRequest` |

### §6 Backend-neutral completion

| Requirement | Source | Test evidence |
|-------------|--------|---------------|
| `BackendCapabilities` per backend | `spawn/config.ts` + `spawn/backends/*.ts` | `"tmux declares: mount=true..."`, `"exedev declares..."`, `"microsandbox declares..."` |
| `KillResult { stopped, alreadyComplete }` | `agent-types/src/types.ts:111-118` | `"tmux kill returns alreadyComplete..."`, `"tmux kill returns stopped..."`, etc. — per-backend kill contract tests |
| Kill confirmation protocol | `spawn/runner-adapter.ts:290-326` (`killAndStamp` 3 branches) | `"consolidated KillResult contract — all branches, consumers, and backends"` (16 tests) |

### §7 Context boundaries

Agent receives brief + input artifacts + worktree/cwd + run identity.
Does not receive plan DAG, sibling results, or parent session context.
Source: `orchestrator/index.ts:84-104` (`buildTaskBrief`), `orchestrator/index.ts:309-323`
(TaskSpec construction — only `agent`, `task`, `isolation`, `timeoutMs`,
`parentBranch`, `runId` fields).

### §8 Persistence / recovery

| Requirement | Source | Test evidence |
|-------------|--------|---------------|
| v0/v1 registry compat | `spawn/jobs.ts` | `"legacy persistence compatibility"` suite (3 tests): `"loads a v0 registry..."`, `"saves as v2 format..."`, `"rejects invalid job records..."` |
| RunId in session entries | `orchestrator/index.ts:317-322` | `"RunId is carried through TaskSpec to TaskResult"` |

### §9 Cancellation / timeouts

| Requirement | Source | Test evidence |
|-------------|--------|---------------|
| Hard deadline `Promise.race` | `spawn/runner-adapter.ts` | `"deadline timeout kills and reports timeout in stderr"` |
| Abort before launch | `spawn/runner-adapter.ts` | `"abort before launch does not start the job"` |
| Fleet abort signal | `fleet/runner.ts` | `"marks running tasks aborted on external abort"`, `"aborts queued tasks immediately once the signal fires"`, `"times out slow tasks"` |

### §10 Trust / security

| Requirement | Source | Test evidence |
|-------------|--------|---------------|
| Schema-validate records on load | `spawn/jobs.ts` | `"rejects invalid job records and keeps valid ones"` |
| Sandbox workspace configurable | `spawn/config.ts` | `"microsandbox workspaceMount follows config.msbMountCwd"` |

### §11 Compatibility / migration

All changes additive. Old `fleet_run` calls without new fields produce
`undefined` on new fields. Old `jobs.json` v1 loads alongside v2.

| Evidence | Test name |
|----------|-----------|
| Legacy TaskResult destructuring | `"legacy TaskResult destructuring still works (old consumer pattern)"` |
| Plain TaskSpec backward compat | `"plain TaskSpec with no agent-native fields produces a valid TaskResult"` |
| RunId undefined when omitted | `"runId is undefined when TaskSpec omits it (backward compat)"` |
| v0 registry loads | `"loads a v0 registry (no version field) as valid jobs"` |
| All legacy fields retained | `"all results retain legacy fields (agent, status, output, truncated, etc.)"` |

## 5. Production call-site inventory

| Call site | Source location |
|-----------|----------------|
| `buildTaskBrief` → `buildHandoffSection` | `orchestrator/index.ts:88` |
| `applyReview` (from scheduler) | `orchestrator/index.ts:430` |
| `recordPassingArtifacts` on passing review | `orchestrator/index.ts:453` |
| `findParentBranch` for worktree isolation | `orchestrator/index.ts:314-316` |
| `nextActions` dispatch decision | `orchestrator/index.ts:228` |
| `setPlanTaskRunning` per dispatched task | `orchestrator/index.ts:283` |
| `applyTaskResult` per fleet result | `orchestrator/index.ts:336` |
| `buildCriticPrompt` for review | `orchestrator/index.ts:380` |
| `parseCriticOutput` for verdict | `orchestrator/index.ts:401` |
| `buildWorktreeArgs(branch, path, parentBranch?)` | `fleet/runner.ts:159-161` |

## 6. Public details shape

`orchestrate_step` returns (source `orchestrator/index.ts:536-559`):

```
details: {
  wave, terminal, dispatched, results, reviews, summary,
  runLog: [{ timestamp, type, runId, payload }, ...]
}
```

`runLog` entries carry `RunId { runId, taskId, attempt, wave }`.
They are appended as execution happens and use distinct `task_start`,
`task_end`, `review_start`, and `review_end` event types between the wave
boundaries.
`details.stopped` returned for early-stop path (`orchestrator/index.ts:216`).
`details.terminal` with `summary` for complete/blocked (`orchestrator/index.ts:246,268`).

## 7. Scheduler exported functions

All in `orchestrator/scheduler.ts`:

| Function | Line | Purpose |
|----------|------|---------|
| `nextActions(plan, policy)` | 55 | Pure dispatch decision |
| `setPlanTaskRunning(plan, id)` | 83 | Mark task dispatched (pending→ready→running) |
| `applyTaskResult(plan, id, result, policy)` | 98 | Fold fleet result into plan |
| `applyReview(plan, id, review, policy)` | 132 | Fold critic verdict into plan |

Default: `DEFAULT_MAX_ATTEMPTS = 2` (line 22).
