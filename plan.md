# Pi-kit efficiency implementation plan

This plan turns the repository review into small, independently reversible
changes. Speed improvements land first; state ownership and package-boundary
redesign wait until the faster execution path is stable.

## Target outcome

For a normal one-task orchestration:

| Metric | Current | Target |
|---|---:|---:|
| Implementation attempts | Up to 2 | 1 by default |
| Auditor agents | 1 per successful attempt | 0 by default |
| Critic agents | 1–2 per attempt | At most 1 when needed |
| Normal child Pi processes | 3 | 1–2 |
| Worst default child Pi processes | 8 | 2 |
| Visible output per task | 50 KiB | 8 KiB |
| Local Spawn registry/polling | Always | None |
| Integration checks | After waves and final | Once at final acceptance |
| PDCA checkpoint turns | One per wave | None by default |
| Retry-feedback growth | Unbounded | At most 6 KiB |
| Eight-task tool details | Potentially hundreds of KiB | Under 32 KiB |

## Phase 1 — truthful verification and a baseline

### Milestone 1: make repository verification truthful

Add real root scripts to `package.json`:

```json
{
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "verify": "npm test"
  }
}
```

Do not add a fake `build` script; the repository currently has no build
artifacts.

Update `README.md`, `orchestrator/README.md`, and
`orchestrator/orchestrator.example.json` to explain that `integrationCheck` is
project-specific and should not normally be installed globally.

Separately remove the invalid global setting from
`~/.pi/agent/extensions/orchestrator/orchestrator.json`:

```json
"integrationCheck": "npm run build"
```

Extend `orchestrator/test.ts` with instrumented fake runners that count child
launches, evidence and critic launches, backend polls, visible bytes, phase
timestamps, and synthetic makespan. Cover:

1. One successful task.
2. Four independent tasks.
3. Crossed implementation/review durations.
4. A two-task serial DAG.
5. An unscorable critic response.
6. A failed first implementation attempt.

Acceptance:

- `npm test` runs all ten workspace test scripts successfully.
- `npm run verify` succeeds.
- No root command reports `Missing script`.
- A smoke orchestration performs no `npm run build`.
- Baseline child counts, visible bytes, and makespan are captured in tests.

Commit: `fix: add truthful root verification and orchestration baseline`

## Phase 2 — fast default execution

### Milestone 2A: change zero-configuration defaults

Change:

- `orchestrator/scheduler.ts`: `DEFAULT_MAX_ATTEMPTS = 1`.
- `orchestrator/config.ts`: disable the default evidence agent; explicit
  `"auditor"` keeps current behavior.
- `fleet/runner.ts`: `DEFAULT_OUTPUT_CAP_BYTES = 8 * 1024`.
- Corresponding fallback objects, examples, tests, and documentation.

Ensure the truncation marker itself fits inside the output byte limit.
Explicit existing configuration remains authoritative.

Acceptance with zero configuration:

- `maxAttempts === 1`.
- `evidenceAgent === undefined`.
- `outputCapBytes === 8192`.
- One successful implementation launches no auditor.
- Output, including its truncation notice, is at most 8192 UTF-8 bytes.
- A reviewed task launches at most an implementer and a critic.
- Explicit legacy values still parse unchanged.

Commit: `perf: make orchestration defaults fast`

### Milestone 2B: execute synchronous agents directly

Add an execution selector to Fleet, Critic, and Orchestrator:

```ts
type ExecutionMode = "local" | "spawn";
```

Default to `local`. Support `FLEET_EXECUTION_MODE`, `CRITIC_EXECUTION_MODE`,
and `ORCHESTRATOR_EXECUTION_MODE`. Explicit `spawn` preserves tmux, exe.dev,
and microsandbox execution.

Refactor `fleet/host.ts` around:

```ts
interface HostRuntime {
  mode: ExecutionMode;
  spawn: SpawnFn;
  cleanup(): Promise<number>;
  spawnConfig?: SpawnConfig;
}
```

In local mode:

- Use the existing direct Node child-process adapter.
- Do not load Spawn backends or probe tmux.
- Do not create Spawn registry entries.
- Do not run stale-job cleanup or poll backend state.

In spawn mode, preserve current behavior. Do not change standalone detached
`spawn_agent` behavior.

For one release, warn when a Spawn backend is configured while synchronous
execution uses the new local default. Do not infer Spawn mode from legacy
`tmux: true` because it currently defaults to true.

Acceptance:

- Local mode launches exactly one OS child per Fleet task.
- Local mode creates zero Spawn jobs, availability probes, registry writes,
  and backend polls.
- Cancellation preserves current SIGTERM/SIGKILL behavior.
- Synthetic local launch overhead is under 250 ms or at least 50% below tmux.
- Explicit spawn mode retains all existing adapter and detached-job behavior.

Rollback: set `executionMode: "spawn"`.

Commit: `perf: run synchronous agents directly by default`

## Phase 3 — child isolation

### Milestone 3: isolate implementer resources

Update `fleet/agents/implementer.md` with an explicit allowlist:

```yaml
tools: read, bash, edit, write
```

Remove the task-level PDCA suggestion and tell implementers not to launch
agents, Fleet tasks, orchestration runs, critics, Pi sessions, or PDCA loops.

Update `fleet/runner.ts` so Fleet children receive:

```text
--no-extensions
--no-skills
```

Add `inheritChildResources?: boolean`, default false, for project-defined
agents that intentionally require extensions or skills. Do not apply this to
general-purpose detached Spawn agents yet.

Acceptance:

- Implementer arguments include `--no-extensions`, `--no-skills`, and
  `--tools read,bash,edit,write`.
- The child does not receive Fleet, Orchestrator, PDCA, or Critic tools.
- Implementers can still read, edit, write, and execute tests.
- `inheritChildResources: true` restores previous resource loading.

Commit: `perf: isolate child agents from orchestration resources`

## Phase 4 — bounded retries and compact handoffs

### Milestone 4: make task intent immutable

Extend `planner/plan.ts`:

```ts
interface AttemptFeedback {
  attempt: number;
  source: "execution" | "check" | "review" | "integration";
  status: string;
  summary: string;
  createdAt: number;
}

interface PlanTask {
  description: string;
  attemptFeedback?: AttemptFeedback[];
}
```

Add a pure `appendAttemptFeedback` helper. Retain at most three entries, cap
each summary at 2048 UTF-8 bytes, and cap rendered feedback at 6144 bytes.

Replace description mutation in `applyTaskResult` and `applyReview` with this
helper. Render feedback separately in task briefs. Permit plan review to edit
a description before first dispatch; reject description changes once
`attempts > 0`. Scope changes after dispatch require a follow-up task.

Migration:

- Plans without `attemptFeedback` normalize to an empty list.
- Do not parse or strip old `[Attempt ...]` or `[Review ...]` text.

Acceptance after five synthetic failures:

- The original description is byte-for-byte unchanged.
- At most three feedback entries remain.
- No entry exceeds 2048 bytes; rendered feedback stays under 6144 bytes.
- The latest weakness remains present.
- Retry and terminal behavior are unchanged.
- Legacy plans restore successfully.

Commit: `refactor: separate bounded attempt feedback from task intent`

### Milestone 5A: remove automatic full critic reruns

Remove second full critic invocations from `orchestrator/index.ts` and
`critic/index.ts`. An unscorable review must fail closed, return no scores,
include an actionable weakness, and consume the normal attempt budget.

Optionally retain `retryUnscorableCritic`, default false, for one compatibility
release.

Acceptance:

- An unscorable review launches exactly one critic.
- It remains failed rather than passing silently.
- With two explicitly configured attempts, the maximum reviewed-task child
  count is four rather than eight.

Commit: `perf: stop repeating unscorable critic runs`

### Milestone 5B: compact reports and tool details

Budgets:

- Implementer summary passed downstream: 2048 bytes.
- Auditor evidence passed to a critic: 4096 bytes.
- Command failure tail: 2048 bytes.
- Default `orchestrate_step` details: under 32 KiB.
- Full transcripts remain available via `fullOutputPath`.

Replace full nested tool details with a versioned summary:

```ts
interface OrchestrateStepDetailsV2 {
  schemaVersion: 2;
  taskSummaries: Record<string, {
    status: string;
    durationMs: number;
    attempt: number;
    branch?: string;
    fullOutputPath?: string;
    checkSummary?: string;
    reviewPassed?: boolean;
  }>;
  summary: PlanSummary;
  artifactWarnings: string[];
  runLog: RunEvent[];
}
```

Stop including full task, evidence, and critic responses by default. Pass
criteria, changed files, command/exit summaries, branch/worktree references,
and transcript paths downstream instead of nested full prose. A temporary
`verboseDetails: true` can expose the old shape during migration.

Acceptance for eight oversized task outputs:

- Tool details stay below 32 KiB.
- No full transcript appears twice in a critic prompt.
- Every handoff respects its cap.
- Full transcripts remain discoverable.
- Review and retry behavior are unchanged.
- Model-visible bytes fall by at least 75% from the baseline.

Commit: `perf: compact orchestration handoffs and tool results`

## Phase 5 — deterministic verification

### Milestone 6: add typed command checks

Extend planner contracts:

```ts
interface CommandCheck {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

interface PlanTask {
  checks?: CommandCheck[];
}

interface Plan {
  finalChecks?: CommandCheck[];
}
```

Use explicit executables and argument arrays, not implicit `sh -c`. Validate
unique IDs, non-empty commands, bounded counts/timeouts, and that `cwd` stays
inside the repository or task worktree. Checks become immutable once execution
starts.

Add `orchestrator/checks.ts`:

```ts
interface CheckResult {
  id: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}
```

Run task checks locally after implementation and before optional semantic
review. Run each check once per attempt, stop at the first required failure by
default, cap output at 2048 bytes, and convert failure to bounded feedback. Do
not launch an auditor to interpret exit codes.

`Plan.finalChecks` replace global integration commands. For one release, use
legacy `integrationCheck` only when the plan has no final checks, emit a
deprecation warning, and run it once at final acceptance rather than per wave.

Acceptance:

- Each declared check runs exactly once per attempt.
- Exit 0 passes; nonzero, timeout, abort, and spawn errors fail deterministically.
- Commands and arguments are not wrapped in an implicit shell.
- Absolute and `../` cwd escapes are rejected.
- No auditor runs for deterministic checks.
- Final checks run at most once.
- Plans without checks remain compatible.

Commits:

1. `feat: add typed task and final verification checks`
2. `feat: execute plan checks directly in orchestrator`

## Phase 6 — remove whole-wave barriers

### Milestone 7A: extract pipeline logic without behavior changes

Move execution helpers from `orchestrator/index.ts` into focused modules such
as `orchestrator/pipeline.ts`, `orchestrator/checks.ts`, and
`orchestrator/report.ts`. Preserve existing barrier ordering in this commit.

Acceptance:

- Baseline event ordering, task transitions, and child counts are unchanged.
- Existing orchestrator tests pass without changed behavioral expectations.

Commit: `refactor: extract orchestration task pipeline`

### Milestone 7B: bounded per-task pipelines

Define:

```ts
interface TaskPipelineOutcome {
  taskId: string;
  attempt: number;
  implementation: TaskResult;
  checks: CheckResult[];
  evidence?: VerificationEvidence;
  review?: ReviewResult;
  artifacts: ArtifactRef[];
  terminal: "done" | "retry" | "failed" | "aborted";
}
```

Each pipeline runs serially:

```text
implement → checks → optional auditor → optional critic
          → commit/artifacts → done | retry | failed
```

Apply `maxConcurrent` to whole active pipelines. Pipelines return typed
outcomes; a central reducer applies each outcome to the latest plan, persists
it, recalculates readiness, and starts newly ready work. Async closures must
never write captured stale plan snapshots.

For worktrees, mark a task done only after checks/review, commit, and artifact
recording all succeed. A failed commit must not unlock dependents.

Add `reviewMode: "critic" | "none"`, initially defaulting to `critic`. Keep
`pipelineMode: "barrier" | "per-task"` for one release as a rollback switch,
defaulting to `per-task`.

Acceptance:

- A fast task enters review before the slowest implementation finishes.
- Synthetic makespan is no more than 60% of the barrier baseline.
- At most `maxConcurrent` pipelines are active.
- Dependents start only after every dependency is done.
- One failed task does not delay unrelated completed pipelines.
- Cancellation leaves undispatched work resumable.
- Retry feedback is current and bounded.
- Worktree and non-worktree paths pass.
- Events retain one start/end pair per phase.

Commit: `perf: pipeline orchestration tasks without wave barriers`

## Phase 7 — deterministic outer control

### Milestone 8: make PDCA optional during orchestration

Keep standalone `/pdca`, `pdca_start`, `pdca_checkpoint`, persistence, and
skills unchanged. Remove PDCA only as an Orchestrator requirement.

Change required tools to:

```ts
const REQUIRED_TOOLS = ["plan_create", "plan_update"];
```

Add `orchestrate_run`, which repeatedly schedules bounded pipelines until all
tasks and final checks pass, the DAG blocks, the user stops, cancellation
occurs, or a run budget is exhausted.

```ts
type RunTerminal =
  | "verified"
  | "tasks_complete_needs_merge"
  | "blocked"
  | "stopped"
  | "budget_exhausted";
```

Keep `orchestrate_step` for manual control and debugging. `/orchestrate` should
create/revise a plan, optionally review it, call `orchestrate_run`, and report
the structured result. It should not request numerical PDCA scores after every
wave.

Add `planReview: boolean`, default false, so merely installing Critic does not
force a plan-review call. Retain `controlMode: "deterministic" | "pdca"` for
one release, default deterministic.

Acceptance for a scripted five-task DAG:

- Deterministic mode makes zero PDCA tool calls.
- PDCA tools are not required at startup.
- No parent checkpoint turn occurs per wave.
- One `orchestrate_run` reaches a terminal state after planning unless blocked.
- Final checks run exactly once.
- Blocked output identifies failed and transitively blocked tasks.
- Standalone PDCA tests remain unchanged.
- Reviewed mode launches at most two children per successful task.
- `reviewMode: "none"` launches one child plus local checks.

Commits:

1. `feat: add deterministic orchestration run controller`
2. `perf: make PDCA orchestration control optional`

## Phase 8 — deferred architecture cleanup

### Milestone 9: break the Fleet–Spawn dependency cycle

Create a small shared runtime package containing only `AgentDefinition`, agent
registry/discovery contracts, `SpawnRequest`, `SpawnOutcome`, `SpawnFn`, and
genuinely shared command utilities.

Target dependency direction:

```text
agent-runtime → Fleet → Orchestrator
      └───────→ Spawn
```

Spawn must not import Fleet. Fleet may temporarily re-export moved symbols for
source compatibility. This is a mechanical refactor only; do not change
runtime behavior in the same pull request.

Acceptance:

- No import from `spawn/**` targets `../fleet/**`.
- Fleet and Spawn tests remain unchanged behaviorally.
- Detached registry JSON and child argv remain compatible.
- CI enforces the dependency direction.

### Milestone 10: make Orchestrator run state authoritative

After the pipeline contracts are stable, introduce:

```ts
interface OrchestratorRunStateV2 {
  schemaVersion: 2;
  runId: string;
  status: "planning" | "running" | "blocked" | "stopped" | "complete";
  plan: Plan;
  activePipelines: Record<string, RunId>;
  taskOutcomes: Record<string, CompactTaskOutcome>;
  finalChecks: CheckResult[];
  runLog: RunEvent[];
  createdAt: number;
  updatedAt: number;
}
```

Orchestrator becomes the sole owner of orchestration lifecycle state. Planner
remains the plan-building UI, a standalone planner when no orchestration is
active, and a read-only projection during a run. Replace `planner:set_plan`
whole-state replacement with typed commands and observational events. Move
restart recovery from Planner to Orchestrator.

Migration for one release:

1. Read V2 state when present.
2. Otherwise import the latest legacy Planner state.
3. Normalize missing checks and feedback.
4. Persist V2 state.
5. Continue emitting a Planner projection.
6. Do not delete old session entries.

Acceptance:

- One authoritative state snapshot is persisted per transition.
- Restart does not duplicate task attempts.
- Planner and Orchestrator dashboards show identical counts.
- Legacy Planner sessions restore.
- Standalone Planner works without Orchestrator.
- `planner:set_plan` is removed after compatibility support expires.

## Recommended pull-request sequence

| PR | Scope | Risk |
|---:|---|---|
| 1 | Root verification and baseline counters | Low |
| 2 | Fast defaults | Low |
| 3 | Direct local execution mode | Medium |
| 4 | Child tool/resource isolation | Low |
| 5 | Immutable descriptions and bounded feedback | Medium |
| 6 | Remove critic rerun | Low |
| 7 | Compact handoffs and details | Medium |
| 8 | Typed command checks | Medium |
| 9 | Extract pipeline without behavior change | Low |
| 10 | Per-task concurrent pipelines | High |
| 11 | Deterministic run controller | High |
| 12 | Optional PDCA control | Medium |
| 13 | Fleet/Spawn dependency correction | Medium |
| 14 | Authoritative Orchestrator state | High |

The first four PRs deliver the largest immediate wall-clock improvement. PRs
1–8 establish bounded and measurable behavior. PRs 9–12 remove structural
latency. PRs 13–14 are maintainability work and must not delay speed gains.

## Changes that must remain separate

1. Establish truthful verification and a baseline before runtime changes.
2. Split default-value changes from process-lifecycle changes.
3. Stabilize immutable task intent before concurrent pipelines.
4. Split critic rerun removal from prompt compaction.
5. Land check schemas/execution before changing scheduling order.
6. Verify per-task pipelines before removing PDCA control.
7. Do not combine behavior changes with package movement or state migration.

## Explicit deferrals

- Do not delete detached Spawn backends.
- Do not optimize tmux/exe.dev polling until detached-workload measurements
  justify it.
- Do not auto-merge arbitrary parallel branches.
- Do not replace Planner DAG validation or bounded Fleet concurrency.
- Do not remove standalone PDCA.
- Do not heuristically clean legacy task descriptions.
- Do not treat tool allowlists as a security sandbox while agents retain bash.
- Do not add a generalized profile abstraction until concrete configuration
  fields stabilize.
