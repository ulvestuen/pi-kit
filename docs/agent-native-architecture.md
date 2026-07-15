# Agent-native architecture decision

**Audit baseline:** `feature/agent-native-orchestration` at `a84eb7c` (2026-07-11).
**Status:** Decided — implement incrementally (4 phases, each independently mergable).

## 1. Defining agent-native development

A system is agent-native when every agent run is a **first-class typed object**
with stable identity, a documented lifecycle, structured input/output contracts,
and backend-independent execution — not an opaque prompt/stdout exchange.

| Property | Current | Agent-native target |
|---|---|---|
| Run identity | Disconnected batch/task/job/plan ids | Single `RunId {runId, taskId, attempt, wave}` across all layers |
| Input contract | Plain brief string | `AgentTask {version, role, prompt, inputArtifacts, parentRuns}` |
| Output contract | Reparsed JSONL capped to text | `AgentResult {status, output, outputArtifacts, toolCalls, usage}` |
| Dependency handoff | Boolean DAG gates; downstream re-discovers state | `ArtifactRef[]` injected into downstream briefs |
| Lifecycle edges | Model convention + planner allows any transition | Code-enforced transition checks with warning on override |
| Backend contract | Closed `SpawnBackend` union, capabilities implicit | `BackendCapabilities` declared at registration |
| Persistence | Unversioned snapshot entries, no replay | Schema-versioned entries, optional append-only run log |
| Observability | Ad-hoc text events, no durable identity | Every event carries `RunId` + typed payload |

## 2. Alternatives compared

### A. Typed Envelope Protocol (TEP)
Wrap current JSONL in typed envelopes. **Pro:** minimal change. **Con:** does not
solve the highest-impact gaps (durability, handoff, cancellation, recovery).

### B. Agent Runtime Abstraction (ARA)
New `@pi-kit/agent-runtime` package with `RuntimeAdapter` interface every backend
implements. **Pro:** cleanest package boundary. **Con:** major refactor across 4
packages; risk of breaking existing spawn contract before any user benefit.

### C. Event-Sourced Run Model (ESRM)
Replace synchronous fleet/spawn with durable event log. **Pro:** idempotent
recovery, full audit trail. **Con:** most work, longest time to value; overkill
before simpler gaps are closed.

### D. Structured Handoff on existing transport (SHOT) — SELECTED
Add types package, propagate run identity, define artifact handoff through DAG
edges, harden lifecycle enforcement, declare backend capabilities on existing
`SpawnBackend`. Each step independently mergable. All existing tests pass at
every step.

The audits identify ~20 barriers; SHOT addresses the 9 highest-impact ones in its
first two phases. It preserves every audit-identified invariant.

## 3. Versioned types / APIs

### New package `@pi-kit/agent-types` (no deps, ESM, strict)

```
interface RunId {
  runId: string;      // stable across whole orchestration
  taskId: string;     // planner task id
  attempt: number;    // 1-based dispatch
  wave: number;
}

interface ArtifactRef {
  type: "path"|"branch"|"commit"|"summary"|"patch"|"file-list";
  id: string;
  description: string;
  location?: string;
}

interface AgentTask {
  version: number;       // starts at 1
  runId: RunId;
  role: string;
  prompt: string;
  inputArtifacts: ArtifactRef[];
  parentRuns: RunId[];
  constraints: { timeoutMs?, outputCapBytes?, isolation?, cwd? };
}

interface AgentResult {
  version: number;
  runId: RunId;
  status: "ok"|"error"|"timeout"|"aborted";
  output: string;
  outputArtifacts: ArtifactRef[];
  toolCalls: { tool: string; args: unknown; result: string }[];
  usage?: { promptTokens?: number; completionTokens?: number };
  durationMs: number;
  exitCode: number|null;
  fullTranscriptPath?: string;
  truncated: boolean;
}

interface BackendCapabilities {        // on SpawnBackend
  workspaceMount: boolean;             // mounts host cwd at guest path
  cursorOutput: boolean;               // supports offset-based output
  confirmedKill: boolean;              // kill() confirms stop
  durableLogs: boolean;                // logs survive runner exit
  networkAccess: boolean;
  hardwareIsolation: boolean;
}
```

**Evolution rules:** Every interface has `version`. New fields append. Old fields
never removed; deprecated fields marked with `@deprecated` + removal version.
`TaskResult` gains optional `runId`, `outputArtifacts`, `toolCalls`, `usage`.
Old consumers see these as `undefined`. The current fleet runner only populates
`runId`; the other three fields are reserved until structured child-result
parsing is implemented.

### Existing API additions

| Surface | Additive change |
|---|---|
| `fleet_run` task spec | Optional `runId`, `inputArtifacts`, `parentRunIds`, `parentBranch` |
| `fleet_run` result (`TaskResult`) | Optional `runId`, `outputArtifacts`, `toolCalls`, `usage` |
| `orchestrate_step` details | `details.runLog: RunEvent[]` carrying `RunId` per event |
| `PlanTask` | New field `artifacts: ArtifactRef[]` (default `[]`) |
| `spawn_agent` | Respects `AbortSignal` (cancels before/during launch) |
| `SpawnBackend` new methods | `capabilities(): BackendCapabilities`, `kill()` returns `KillResult` |
| `ReviewRequest` | Optional `artifacts: ArtifactRef[]` for evidence context |

## 4. Lifecycle transitions

States remain `pending|ready|running|review|done|failed`. Code enforces:

```
pending → ready      (dependencies all done; scheduler)
ready   → running    (dispatch; attempt++)
running → review     (TaskResult.status === "ok")
running → ready      (error/timeout/aborted, attempts < max)
running → failed     (error/timeout/aborted, attempts >= max)
review  → done       (critic passed; artifacts recorded)
review  → ready      (critic failed, attempts < max)
review  → failed     (critic failed, attempts >= max)
```

**At the planner level** (`setTaskStatus`): add a **soft policy check** that logs
a warning on illegal transitions (`running→done`, `done→*`, `failed→ready`).
Does not throw — manual overrides remain possible. The orchestrator's scheduler
(`applyTaskResult`/`applyReview`) already enforces correct transitions.

**Attempt counting** is already correct: increments only on `→ running`
(`planner/plan.ts:229-231`).

## 5. Structured result/artifact dependency handoffs

After a task passes review, its artifacts are recorded in `PlanTask.artifacts`.
The orchestrator's `buildTaskBrief` collects `done` dependency artifacts:

```
function buildHandoffSection(plan, task): string {
  const deps = task.dependsOn.map(id => getTask(plan, id))
    .filter(t => t?.status === "done" && t.artifacts.length > 0);
  if (deps.length === 0) return "";
  const lines = ["", "Prerequisite artifacts:"];
  for (const dep of deps) {
    lines.push(`  [${dep.id}] ${dep.title}:`);
    for (const art of dep.artifacts)
      lines.push(`    - ${art.type}: ${art.description} at ${art.location ?? "(in-tree)"}`);
  }
  return lines.join("\n");
}
```

**Worktree mode fix:** The current bug — dependent worktree created from parent
HEAD, not from prerequisite branch — is fixed by:
1. After a passing review in worktree mode, orchestrator commits implementer
   changes before marking `done`.
2. `buildTaskBrief` identifies the selected prerequisite branch and explicitly
   warns that other prerequisite branches are not merged into the worktree.
3. `TaskSpec.parentBranch` → fleet runner builds
   `git worktree add -b <branch> <path> <parent-branch>`.

Worktrees have one fork point. When multiple done dependencies expose branch
artifacts, the first branch in `dependsOn` order is selected; the remaining
branches are references that must be merged separately.

## 6. Backend-neutral completion

### BackendCapabilities

Default declarations (returned by new `capabilities()` method):

| Backend | workspaceMount | cursorOutput | confirmedKill | durableLogs | network | isolation |
|---|---|---|---|---|---|---|
| tmux | true (host path) | false | true | true | true | false |
| exedev | false | false | true | true (VM) | true | false |
| microsandbox | true (r/w) | false | true | true | configurable | true |

### Kill confirmation protocol

`SpawnBackend.kill()` returns `KillResult { stopped, alreadyComplete, message? }`.
Caller stamps `killed` only when `stopped`; skips stamp when `alreadyComplete`.
`killed` status means confirmed stopped, not best-effort requested.

### Hard promise deadline

The spawn adapter checks its hard deadline in the poll loop. On expiry it calls
the backend kill protocol and stamps the registry from the returned
`KillResult`; there is no separate post-kill wait loop.

## 7. Context boundaries

An agent run receives: task brief, input artifacts (`ArtifactRef[]`), worktree
or shared cwd, run identity. It does **not** receive the full plan DAG, sibling
results, parent session context, or peer conversation history.

The critic receives: the task's output artifacts, dependency artifacts when
relevant, the worktree or commit to inspect. The critic tool set remains
read-only.

## 8. Persistence / recovery

**Phase 1:** Extend existing session entries with schema version field,
`outputArtifacts` in planner snapshots, `RunId` in spawn job records. All
loaders accept v0 (no version field) or v1 (with version). The lykkja tombstone
bug (reset appends `undefined` which `restoreState` ignores) is fixed.

**Phase 2 (future):** Optional append-only run log under
`<logDir>/run-log/run-<runId>.jsonl` with one typed event per line. Recovery:
scan log for latest `wave_end`, continue from last known plan state. Not
automatic — parent model decides resume vs restart.

**Not changed:** The shared volatile `jobs.json` (still unsafe for concurrent
writers — deferred to structured database). Session entries remain snapshot-based.
Cross-session recovery remains manual re-dispatch.

## 9. Cancellation / timeouts

- **Hard deadline:** Adapter checks elapsed time on each poll and invokes the
  backend kill protocol when the deadline expires.
- **Kill confirmation:** All built-in backends return `stopped: true` only
  after confirming the process/window is gone.
- **Public `spawn_agent`:** Respects `AbortSignal` — aborts before launch without
  launching; during launch, cancels the wait for backend availability.
- **Fleet-level:** Already correct — per-task timeout starts before worktree
  setup, timer aborts task controller, queued tasks become `aborted` without spawn
  (`fleet/runner.ts:290-313,380-499`).

## 10. Trust / security

| Gap | Fix (phase 1-2) |
|---|---|
| `jobs.json` accepts manipulated records | On load: schema-validate every record, reject invalid ones, write `recovered-N.json`. |
| Secrets persisted in `jobs.json` task field | Not yet filtered. Do not put secrets in task briefs; filtering is deferred until it can be enforced at every registry write. |
| Microsandbox mounts host cwd r/w by default | New `sandboxReadonlyWorkspace` config (default false — backward compat; `true` = read-only). |
| API keys exported into tmux scripts | Already `tmuxForwardEnv` controlled; add `envPassthrough` documentation and audit. |
| Registry has no integrity check | Integrity protection is deferred; no inactive HMAC configuration is advertised. |

## 11. Compatibility / migration

**Backward compatibility:** Every change is additive. Old `fleet_run` calls without
new fields produce results with `undefined` on new fields. Old `jobs.json` v1 is
loaded alongside v2. Old session entries (no version field) load as v0. All
existing tests pass without modification.

**Deprecation schedule:**

| Item | Deprecated in | Removal |
|---|---|---|
| `jobs.json` v1 (unversioned) | Phase 1 | Phase 3+ |
| `TaskResult.fullOutputPath` → `fullTranscriptPath` | Phase 1 | Phase 4 |
| `SpawnBackend.kill(): Promise<void>` → `KillResult` | Phase 2 | Phase 4 |
| Planner unrestricted `setTaskStatus` | Phase 1 (soft) | Phase 3 (hard) |

**Migration helper:** `/migrate spawn-jobs` reads v1, converts to v2, writes
`jobs.v2.json`, reports unrecognized records. `/migrate spawn-jobs --activate`
replaces the active registry.

## 12. Observability

- Every event carries `RunId` as a typed field, not just text.
- `/plan` shows `artifacts` list for done tasks.
- `/fleet` shows `runId` alongside jobs.
- `/spawn` shows `capabilities()`.
- New `/run <runId>` (phase 2) shows the run's event log.
- `orchestrate_step` details include `runLog: RunEvent[]` for the wave.

## 13. File / test changes (phase 1)

### New files

- `agent-types/types.ts` — `RunId`, `ArtifactRef`, `AgentTask`, `AgentResult`,
  `BackendCapabilities`, `KillResult`, `ToolCallSummary`
- `agent-types/index.ts` — re-exports
- `agent-types/package.json` — name `@pi-kit/agent-types`, no deps
- `agent-types/tsconfig.json` — ESM, ES2022, strict
- `agent-types/test.ts` — round-trip, version check, migration validation
- `docs/migration-spawn-v2.md` — migration guide for jobs.json v2

### Changed files — fleet

| File | Change |
|---|---|
| `fleet/runner.ts` | Add `RunId`, `inputArtifacts`, `parentRunIds`, `parentBranch` to `TaskSpec`; structured prerequisite metadata is appended to the child brief. Add `runId` plus reserved `outputArtifacts`, `toolCalls`, `usage` fields to `TaskResult`. `buildWorktreeArgs` accepts optional `parentBranch`. |
| `fleet/index.ts` | Tool schema gains optional `runId`, `inputArtifacts`, `parentRunIds` and passes each through to the runner. |
| `fleet/test.ts` | Tests for `RunId` propagation, `parentBranch` worktree, backward-compatible missing fields. |

### Changed files — spawn

| File | Change |
|---|---|
| `spawn/jobs.ts` | `capabilities()` on `SpawnBackend`. `kill()` returns `KillResult`. Registry v2 format with schema validation. |
| `spawn/backends/tmux.ts` | `capabilities()` (`workspace=true,cursor=false,kill=true,logs=true,net=true,hw=false`). `kill()` confirms the window is stopped. |
| `spawn/backends/exedev.ts` | `capabilities()`. `kill()` adds `kill -0` probe. |
| `spawn/backends/microsandbox.ts` | `capabilities()`. `kill()` adds PID check. `sandboxReadonlyWorkspace` support. |
| `spawn/runner-adapter.ts` | Hard poll-loop deadline and explicit three-branch `KillResult` handling. Propagates `RunId`. |
| `spawn/index.ts` | `spawn_agent` respects `AbortSignal`. Saves v2 registry format. |
| `spawn/config.ts` | Add `sandboxReadonlyWorkspace`. Secret filtering and registry integrity settings remain unadvertised until implemented. |
| `spawn/test.ts` | Test `capabilities()`, `KillResult` shapes, v2 registry load/migrate. |

### Changed files — planner

| File | Change |
|---|---|
| `planner/plan.ts` | `PlanTask.artifacts: ArtifactRef[]`. `updateTask` accepts `artifacts`. `setTaskStatus` adds transition soft-check with console.warn. |
| `planner/index.ts` | `plan_update.edit` schema gains optional `artifacts`. |
| `planner/test.ts` | Test `artifacts` round-trip, transition soft-check. |

### Changed files — orchestrator

| File | Change |
|---|---|
| `orchestrator/index.ts` | `buildTaskBrief` injects `buildHandoffSection`. `applyReview` calls `recordPassingArtifacts`. Review subject includes `artifacts`. Wave/task/review events are appended when they occur and carry `RunId`; details include the truthful `runLog`. |
| `orchestrator/index.ts` | `recordPassingArtifacts` creates `ArtifactRef[]` from result and commits in worktree mode. |
| `orchestrator/test.ts` | Test artifact propagation, parent-branch worktree, `runLog` enrichment. |

### Changed files — critic

| File | Change |
|---|---|
| `critic/index.ts` | `dispatchCritic` optionally receives `RunId` and propagates to fleet. |
| `critic/review.ts` | `ReviewRequest` gains optional `artifacts: ArtifactRef[]`. `buildCriticPrompt` includes artifacts in evidence section. |

### Changed files — lykkja

| File | Change |
|---|---|
| `lykkja/index.ts` | `restoreState`: check `tombstone === true` on the data to properly skip cleared loops (fixes existing bug). |

## 14. Implementation phases

**Phase 1 — Identity and types (smallest risk, highest value, ~3 PRs)**
Create `agent-types/` package. Propagate `RunId` through fleet runner + spawn
adapter. Add `capabilities()` to all backends. Add transition soft-check to
planner. Fix lykkja tombstone. All tests green, no behavior change for users.

**Phase 2 — Artifact handoff (~2 PRs)**
Add `ArtifactRef` to `PlanTask`. Inject dependency artifacts in orchestrator
briefs. Fix parent-branch worktree creation. Enrich critic evidence with
artifacts. Add `KillResult` protocol.

**Phase 3 — Lifecycle and registry (~2 PRs)**
Registry v2 with schema validation. HMAC integrity check (optional). Secrets
filter. Soft-check becomes hard-check (configurable). Deprecation warnings for v1
registry.

**Phase 4 — Observability and hardening (~2 PRs)**
Event enrichment with `RunId` everywhere. Optional append-only run log.
`/run <runId>` command. Public spawn cancellation. Migration helper.
`sandboxReadonlyWorkspace` default change (plan to flip in next major).
