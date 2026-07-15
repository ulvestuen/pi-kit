# Focused agent-native audit: orchestrator runtime

## Scope and conclusion

This audit covers the runtime implemented by `orchestrator/index.ts` and
`orchestrator/scheduler.ts`, checked against its config, tests, README, example
config, and orchestration skill. Direct planner, fleet, and critic contracts are
cited only where the orchestrator depends on them.

The runtime is a **deterministic one-wave executor inside a model-driven outer
protocol**, not a durable autonomous orchestrator. Code selects ready tasks,
runs one batch, gates successful executions through a critic, and applies a
bounded retry policy. The parent model still creates the loop and plan, turns
wave evidence into goal scores, calls the next tool, repairs blocked plans,
merges branches, and performs final verification
([`orchestrator/index.ts:60-75`](../orchestrator/index.ts#L60-L75),
[`orchestrator/index.ts:460-484`](../orchestrator/index.ts#L460-L484)).

## 1. Control flow and task lifecycle

### Run entry and ownership

`/orchestrate <goal>` checks for `lykkja_start`, `lykkja_checkpoint`,
`plan_create`, and `plan_update`, resets `{stopped, wave}`, and injects a user
message telling the parent model to invoke those tools and `orchestrate_step`
([`orchestrator/index.ts:44-75`](../orchestrator/index.ts#L44-L75),
[`orchestrator/index.ts:549-560`](../orchestrator/index.ts#L549-L560)). It does
not itself create or associate the lykkja loop and plan. It also does not
preflight the discovered critic agent, spawn backend, git/worktree support, or
rubric-scale compatibility; the critic-agent failure occurs during review
([`orchestrator/index.ts:172-175`](../orchestrator/index.ts#L172-L175),
[`orchestrator/index.ts:321-325`](../orchestrator/index.ts#L321-L325)).

### One `orchestrate_step` wave

1. Reject a persisted stop, then read the latest `planner-state` entry; absence
   of a plan throws ([`orchestrator/index.ts:189-207`](../orchestrator/index.ts#L189-L207)).
2. Discover agents and call pure `nextActions(plan, policy)`
   ([`orchestrator/index.ts:209-211`](../orchestrator/index.ts#L209-L211)).
3. If nonterminal, increment and persist the wave number **before** dispatch,
   emit `orchestrator:wave_start`, mark every selected task `running` (which
   increments its attempt count), and publish the whole plan through
   `planner:set_plan` ([`orchestrator/index.ts:254-267`](../orchestrator/index.ts#L254-L267),
   [`planner/plan.ts:211-240`](../planner/plan.ts#L211-L240)).
4. Build one fleet `TaskSpec` per selected task, using the task's named agent or
   orchestrator `defaultAgent`, one global isolation mode, task timeout, and
   output cap. `runTasks` receives results in input order; the orchestrator
   correlates them by array index and folds each into the plan
   ([`orchestrator/index.ts:275-311`](../orchestrator/index.ts#L275-L311),
   [`fleet/runner.ts:464-499`](../fleet/runner.ts#L464-L499)).
5. Re-query **all** plan tasks in `review` after implementation. This includes
   old review tasks, not only successful results from this wave; the
   `decision.reviews` field is not used by the wiring
   ([`orchestrator/scheduler.ts:61-77`](../orchestrator/scheduler.ts#L61-L77),
   [`orchestrator/index.ts:314-317`](../orchestrator/index.ts#L314-L317)).
6. Run critic children concurrently. Unscorable reviews get one critic-only
   rerun, then every verdict is folded and the whole plan is republished
   ([`orchestrator/index.ts:350-397`](../orchestrator/index.ts#L350-L397)).
7. Emit `wave_end` and return a transient human report plus structured
   `details.results`, `details.reviews`, and plan summary. The report asks the
   parent model to checkpoint and invoke the next step
   ([`orchestrator/index.ts:399-484`](../orchestrator/index.ts#L399-L484)).

The scheduler is deterministic in plan-array order. `readySet` admits only
`pending|ready` tasks whose dependencies are all `done`; `nextActions` slices
that set to `maxConcurrent - running`
([`planner/plan.ts:202-208`](../planner/plan.ts#L202-L208),
[`orchestrator/scheduler.ts:53-77`](../orchestrator/scheduler.ts#L53-L77)). A
persisted or manually assigned `running` task consumes capacity even though the
orchestrator has no job/lease with which to prove it is active.

### State transitions

```text
pending|ready --dispatch; attempts += 1--> running
running --TaskResult ok---------------> review
running --error|timeout|aborted--------> ready (attempts below cap) | failed
review  --critic pass-----------------> done
review  --critic fail-----------------> ready (attempts below cap) | failed
```

`TaskResult.status === "ok"` means only that the child process produced a
successful final assistant message; it does not prove criteria, tests, a diff,
or a commit. Therefore `ok -> review`, never directly `done`
([`fleet/runner.ts:34-48`](../fleet/runner.ts#L34-L48),
[`orchestrator/scheduler.ts:85-116`](../orchestrator/scheduler.ts#L85-L116)).
Only `review.passed` reaches `done`
([`orchestrator/scheduler.ts:124-159`](../orchestrator/scheduler.ts#L124-L159)).
This critic gate is the strongest lifecycle invariant.

The plan model does not enforce legal transition edges: `setTaskStatus` accepts
any known target status, and public `plan_update` exposes it. A parent model can
bypass the critic by setting a task directly to `done`
([`planner/plan.ts:215-240`](../planner/plan.ts#L215-L240),
[`planner/index.ts:170-229`](../planner/index.ts#L170-L229)).

### Terminal states

- **Stopped:** `state.stopped` makes the next tool call return without dispatch;
  `/orchestrate stop` does not cancel a wave already in progress
  ([`orchestrator/index.ts:189-200`](../orchestrator/index.ts#L189-L200),
  [`orchestrator/index.ts:539-546`](../orchestrator/index.ts#L539-L546)).
- **Complete:** every task is `done`; the tool asks the parent to merge, run
  end-to-end verification, and checkpoint. It has no durable branch list to
  supply here ([`orchestrator/scheduler.ts:66-75`](../orchestrator/scheduler.ts#L66-L75),
  [`orchestrator/index.ts:213-229`](../orchestrator/index.ts#L213-L229)).
- **Blocked:** not all tasks are done and there is no dispatchable, review, or
  running task. The report names failed tasks and blocked descendants, then asks
  the model to checkpoint and repair the plan
  ([`orchestrator/scheduler.ts:66-77`](../orchestrator/scheduler.ts#L66-L77),
  [`orchestrator/index.ts:232-251`](../orchestrator/index.ts#L232-L251)).
- **Running:** every other scheduler decision. This is not a persisted run phase;
  it is recomputed per call.

The suggested blocked-plan repair is incomplete. `plan_update` can append tasks
but cannot rewire `dependsOn`; a dependent still requires the original failed
id to become `done`. Appending a repair task alone therefore cannot unblock the
existing chain ([`planner/plan.ts:243-301`](../planner/plan.ts#L243-L301),
[`orchestrator/index.ts:243-246`](../orchestrator/index.ts#L243-L246)).

## 2. Briefs, dependency handoff, and review evidence

### Implementer brief

`buildTaskBrief` sends exactly: overall goal, task id/title, the current
(accumulated) description, criteria with thresholds on a 10-point scale, and a
scope/report instruction ([`orchestrator/index.ts:78-95`](../orchestrator/index.ts#L78-L95)).
It omits:

- `dependsOn` and the identities/statuses of prerequisites;
- prerequisite reports, outputs, review scores, artifacts, commits, or paths;
- the rest of the plan and sibling constraints;
- run, wave, and attempt identifiers;
- base revision, expected branch, changed-file contract, or required commit;
- prior attempt artifacts beyond text appended to `description`.

This is the explicit dependent-task propagation gap: the scheduler uses
`dependsOn` only as a boolean gate, while the downstream brief contains no
information produced by those dependencies
([`planner/plan.ts:37-50`](../planner/plan.ts#L37-L50),
[`planner/plan.ts:202-208`](../planner/plan.ts#L202-L208),
[`orchestrator/index.ts:78-95`](../orchestrator/index.ts#L78-L95)). A task that
needs an earlier task's API, generated artifact, branch, or design decision must
rediscover it from the current tree or fail; in worktree mode it may not even
see that tree state.

### `TaskResult` handling and durability

Fleet returns status, capped final assistant output, optional full-transcript
path, truncation, timing/exit data, and optional branch/worktree path
([`fleet/runner.ts:34-48`](../fleet/runner.ts#L34-L48)). Orchestrator keeps these
only in per-call `resultsById` and the returned tool details
([`orchestrator/index.ts:275-310`](../orchestrator/index.ts#L275-L310),
[`orchestrator/index.ts:474-483`](../orchestrator/index.ts#L474-L483)). No result,
transcript pointer, branch, artifact, or attempt record is stored in `PlanTask`
or `OrchestratorState`.

For non-`ok` results, the scheduler appends `Attempt N <status>: <output>` to
`description`; all other result metadata is discarded
([`orchestrator/scheduler.ts:102-116`](../orchestrator/scheduler.ts#L102-L116)).
For `ok`, even the report is not persisted. This makes task descriptions the
only retry memory and leaves accepted work without durable acceptance evidence.
The accumulated feedback also means `description` grows without bound through
repeated retry cycles.

### Critic subject and evidence boundary

For a same-call result, the review subject contains task id/title, the final
implementer report, and branch/current-tree wording. Context contains the goal
and accumulated task description; the request carries the exact task criteria,
and critic cwd is the result worktree when present

For a same-call result, the review subject contains task id/title, the final
implementer report, and branch/current-tree wording. Context contains the goal
and accumulated task description; the request carries the exact task criteria,
and critic cwd is the result worktree when present
([`orchestrator/index.ts:98-114`](../orchestrator/index.ts#L98-L114),
[`orchestrator/index.ts:332-347`](../orchestrator/index.ts#L332-L347)).

It does **not** provide the full transcript path, explicit diff/base commit,
changed-file list, command/test output artifact, dependency outputs, or an
attempt identifier. The shipped critic agent has only read/grep/find/ls and
cannot run verification commands
([`fleet/agents/critic.md:1-15`](../fleet/agents/critic.md#L1-L15)); a discovered
override could change that tool set. With the shipped definition, executable
acceptance criteria depend on readable repository evidence or an implementer
claim the critic is instructed not to trust.

If a task was already in `review` at call start, `resultsById` has no result for
it: the subject says no report is available and the cwd falls back to the parent
working tree. This loses both evidence and the correct isolated tree after a
restart/interruption ([`orchestrator/index.ts:98-113`](../orchestrator/index.ts#L98-L113),
[`orchestrator/index.ts:333-346`](../orchestrator/index.ts#L333-L346)).

The critic parser usefully fails closed: every rubric criterion must be scored,
scores are clamped, and pass requires all thresholds
([`critic/review.ts:151-227`](../critic/review.ts#L151-L227)). On pass, however,
scores and raw review remain transient. On failure, only prioritized weakness
strings are appended to the next brief
([`orchestrator/scheduler.ts:141-159`](../orchestrator/scheduler.ts#L141-L159)).

## 3. Retry semantics

Execution and quality failures share one `maxAttempts` budget (default `2`). An
attempt increments at dispatch, not at result/review; a failed execution or
failed review requeues only while `attempts < maxAttempts`
([`orchestrator/scheduler.ts:22-29`](../orchestrator/scheduler.ts#L22-L29),
[`planner/plan.ts:211-240`](../planner/plan.ts#L211-L240),
[`orchestrator/scheduler.ts:102-116`](../orchestrator/scheduler.ts#L102-L116),
[`orchestrator/scheduler.ts:141-159`](../orchestrator/scheduler.ts#L141-L159)).

An unscorable critic result is automatically rerun once without another
implementation attempt. If the rerun is still unscorable, the first failed
review is applied and can consume the already-used implementation attempt
([`orchestrator/index.ts:379-395`](../orchestrator/index.ts#L379-L395)). There is
no failure taxonomy, backoff, resumable attempt, job reconciliation, or
per-attempt agent selection. Infrastructure failure, missing evidence, code
failure, and critic-format failure ultimately use the same task budget.

In shared-tree mode a retry sees prior edits but no ownership record. In
worktree mode every redispatch creates a fresh branch from the parent cwd; the
prior failed worktree is not resumed, and its branch/path is not propagated in
the feedback ([`fleet/runner.ts:341-368`](../fleet/runner.ts#L341-L368)).

## 4. Persistence, restart, and self-prompting

Orchestrator persists only `{stopped, wave}` as append-only session entries and
restores the latest value on `session_start`
([`orchestrator/index.ts:55-58`](../orchestrator/index.ts#L55-L58),
[`orchestrator/index.ts:149-153`](../orchestrator/index.ts#L149-L153),
[`orchestrator/index.ts:489-499`](../orchestrator/index.ts#L489-L499)). The plan
is separately persisted as whole `planner-state` snapshots through the event
bus; planner resets restored `running` tasks to `ready`
([`planner/index.ts:117-130`](../planner/index.ts#L117-L130),
[`planner/index.ts:261-268`](../planner/index.ts#L261-L268),
[`planner/index.ts:277-290`](../planner/index.ts#L277-L290)). Orchestrator also
cleans up prefixed spawn jobs, but because it invokes fleet core directly it
does not create fleet's persisted batch records
([`orchestrator/index.ts:277-305`](../orchestrator/index.ts#L277-L305),
[`orchestrator/index.ts:489-490`](../orchestrator/index.ts#L489-L490)).

Missing durable state includes run/plan/loop identity, current phase and next
action, in-flight job/attempt ids, results and transcripts, reviews, branches,
commits, merge status, and goal-level evidence. Persistence boundaries are
coarse: wave state is written, then all tasks are published as running, then
all implementation results are published, then all reviews are published. A
crash between boundaries cannot reconcile completed child work.

Consequently restart is **redispatch recovery, not idempotent resume**. Attempts
already incremented remain consumed, side effects can repeat, review tasks can
be inspected in the wrong cwd, and branches/results can be orphaned. This
qualifies the stronger README/skill claim of idempotence
([`orchestrator/README.md:52-58`](../orchestrator/README.md#L52-L58),
[`orchestrator/skills/orchestration/SKILL.md:58-67`](../orchestrator/skills/orchestration/SKILL.md#L58-L67)).

“Self-prompting” is also advisory, not runtime continuation. The initial slash
command uses `sendUserMessage`, but subsequent `AUTOMATED NEXT STEP` blocks are
plain tool-result text. No hook calls `lykkja_checkpoint`, invokes another wave,
or resumes after session start
([`orchestrator/index.ts:460-471`](../orchestrator/index.ts#L460-L471),
[`orchestrator/index.ts:489-499`](../orchestrator/index.ts#L489-L499),
[`orchestrator/index.ts:558-560`](../orchestrator/index.ts#L558-L560)). The parent
model can skip, mis-score, or stop between phases. Goal-level scores are assigned
by that same model from transient critic evidence; task critic scores are not
deterministically mapped to lykkja criteria.

## 5. Worktree and merge behavior

Implemented behavior stops at isolation and same-call review:

1. Fleet creates a new branch/worktree and returns both paths
   ([`fleet/runner.ts:137-145`](../fleet/runner.ts#L137-L145),
   [`fleet/runner.ts:341-368`](../fleet/runner.ts#L341-L368)).
2. The implementer runs there, but neither runner nor brief requires a commit
   ([`fleet/runner.ts:370-429`](../fleet/runner.ts#L370-L429),
   [`orchestrator/index.ts:78-95`](../orchestrator/index.ts#L78-L95)).
3. The same-call critic is pointed at that worktree
   ([`orchestrator/index.ts:332-347`](../orchestrator/index.ts#L332-L347)).
4. A passing review immediately marks the task `done`
   ([`orchestrator/scheduler.ts:141-143`](../orchestrator/scheduler.ts#L141-L143)).
5. Only passed branches from the **current call's** result map are printed as a
   merge reminder ([`orchestrator/index.ts:450-457`](../orchestrator/index.ts#L450-L457)).

No code commits, merges, orders merges, detects/resolves conflicts, records an
integrated revision, or removes worktrees. The skill assigns those operations
to the parent model and says a merge conflict should enter the retry path, but
there is no merge-failure transition: the task is already `done`
([`orchestrator/skills/orchestration/SKILL.md:48-56`](../orchestrator/skills/orchestration/SKILL.md#L48-L56)).
Uncommitted work cannot be integrated by merging the branch at all.

The critical DAG defect is `review pass -> done -> dependent ready` **before
merge**. The next dependent worktree is created from parent cwd/HEAD, not from
the prerequisite branch, so it cannot consume the prerequisite's isolated work.
The normal wave prompt postpones merging until `FINAL`; the terminal-complete
message then has no stored branch inventory
([`planner/plan.ts:202-208`](../planner/plan.ts#L202-L208),
[`orchestrator/index.ts:465-471`](../orchestrator/index.ts#L465-L471),
[`orchestrator/index.ts:213-229`](../orchestrator/index.ts#L213-L229)). Worktree
mode is therefore incompatible with ordinary dependent implementation tasks
unless the parent manually commits and merges every passed prerequisite between
waves, contrary to the documented protocol.

## 6. Agent-native barriers and invariants to preserve

### Barriers, highest impact first

1. **Prose owns the outer state machine:** plan/loop creation, checkpointing,
   continuation, repair, final verification, and merge are model conventions.
2. **No durable run/attempt/evidence model:** accepted results and reviews cannot
   be reconstructed or reconciled after context loss.
3. **No dependency output contract:** DAG edges gate scheduling but propagate no
   artifacts, summaries, commits, or typed inputs.
4. **Acceptance precedes integration:** `done` unlocks dependents before an
   isolated branch is committed or merged.
5. **Review evidence is underspecified:** no diff, test artifact, transcript, or
   dependency evidence, and the critic cannot execute checks.
6. **Plan mutation bypasses lifecycle rules:** public status updates can forge
   completion; whole-plan event writes have no revision/CAS protection.
7. **Blocked repair cannot rewire the DAG:** adding follow-ups does not satisfy a
   failed dependency.
8. **Goal quality remains self-scored:** critic verdicts gate tasks but not the
   outer lykkja result.

### Preserved invariants for a replacement

- Keep pure, deterministic ready-set/capacity/terminal computation and bounded
  concurrency ([`orchestrator/scheduler.ts:53-77`](../orchestrator/scheduler.ts#L53-L77)).
- Keep stable task ids, validated DAG dependencies, per-task criteria and
  thresholds, and deterministic plan order.
- Keep execution success distinct from acceptance: every successful writer must
  pass an independent, fresh-context, read-only review before accepted
  completion ([`orchestrator/scheduler.ts:85-159`](../orchestrator/scheduler.ts#L85-L159)).
- Keep fail-closed complete-rubric parsing and actionable weakest-first feedback
  ([`critic/review.ts:194-227`](../critic/review.ts#L194-L227)).
- Keep bounded retries, explicit `ok|error|timeout|aborted` outcomes, output caps,
  cancellation, and access to full transcripts.
- Keep failed prerequisites blocking dependents; add explicit reviewed versus
  integrated states rather than weakening the gate.
- Preserve current public surfaces or provide adapters: `orchestrate_step`,
  `/orchestrate <goal>|status|stop`, planner/lykkja tool composition,
  `planner:set_plan`, and `none|worktree` isolation.

## 7. Configuration and compatibility constraints

Config defaults are four concurrent tasks, two attempts, shared-tree isolation,
10/5-minute task/review timeouts, 50 KiB visible output, `implementer`, `pi`, and
tmux settings. Values come from a JSON file when present, otherwise
`ORCHESTRATOR_*` environment values; numeric/isolation/minimum validations are
in `loadConfig` ([`orchestrator/config.ts:19-55`](../orchestrator/config.ts#L19-L55),
[`orchestrator/config.ts:63-126`](../orchestrator/config.ts#L63-L126),
[`orchestrator/config.ts:129-197`](../orchestrator/config.ts#L129-L197),
[`orchestrator/orchestrator.example.json:1-14`](../orchestrator/orchestrator.example.json#L1-L14)).
Invalid config causes `index.ts` to log and use hard-coded defaults rather than
abort ([`orchestrator/index.ts:116-138`](../orchestrator/index.ts#L116-L138)).

Important compatibility constraints:

- Orchestrator imports sibling source contracts directly; a standalone package
  requires lykkja, fleet, planner, critic, and spawn alongside it, as the README
  notes ([`orchestrator/index.ts:7-37`](../orchestrator/index.ts#L7-L37),
  [`orchestrator/README.md:64-95`](../orchestrator/README.md#L64-L95)).
- It does not call `fleet_run` or `critic_review`; it reuses their cores and
  requires a discovered agent named `critic`. Public extension config/fallbacks
  can therefore diverge from orchestration behavior
  ([`orchestrator/index.ts:209-210`](../orchestrator/index.ts#L209-L210),
  [`orchestrator/index.ts:297-305`](../orchestrator/index.ts#L297-L305),
  [`orchestrator/index.ts:321-330`](../orchestrator/index.ts#L321-L330)).
- Task briefs and critic parsing hard-code `DEFAULT_SCALE_MAX` (10), while plan
  criteria can have planner-configured thresholds. A planner scale above 10 can
  create an impossible orchestrator rubric
  ([`orchestrator/index.ts:25`](../orchestrator/index.ts#L25),
  [`orchestrator/index.ts:275-276`](../orchestrator/index.ts#L275-L276),
  [`orchestrator/index.ts:335-340`](../orchestrator/index.ts#L335-L340)).
- Result-to-task correlation depends on fleet preserving input order; changing
  runner ordering would silently attach outcomes to wrong task ids
  ([`orchestrator/index.ts:306-310`](../orchestrator/index.ts#L306-L310),
  [`fleet/runner.ts:464-499`](../fleet/runner.ts#L464-L499)).
- `isolation` is run-wide in orchestrator config, unlike fleet's per-task field;
  migrations must preserve current default `none` and explicitly define mixed
  isolation behavior ([`orchestrator/config.ts:19-29`](../orchestrator/config.ts#L19-L29),
  [`orchestrator/index.ts:291-303`](../orchestrator/index.ts#L291-L303)).
- The package manifest exposes exactly one extension and one skill directory and
  pins the Pi API packages at `^0.71.0`
  ([`orchestrator/package.json:1-19`](../orchestrator/package.json#L1-L19)).

## 8. Tests, demonstrated guarantees, and gaps

`npm test --workspace orchestrator` runs only `tsx --test test.ts`
([`orchestrator/package.json:6-8`](../orchestrator/package.json#L6-L8)). The tests
demonstrate:

- ready-set ordering, free-capacity subtraction, review discovery, complete and
  blocked decisions, and invalid-policy rejection
  ([`orchestrator/test.ts:72-134`](../orchestrator/test.ts#L72-L134));
- `TaskResult` success/failure transitions, attempt cap, and textual execution
  feedback ([`orchestrator/test.ts:136-174`](../orchestrator/test.ts#L136-L174));
- critic pass/fail transitions, weakness propagation, attempt cap, and invalid
  review state ([`orchestrator/test.ts:176-221`](../orchestrator/test.ts#L176-L221));
- a five-task **in-memory simulation** with fake runner/critic, one execution
  timeout, one failed review, retries, and a lykkja `FINAL`, plus a blocked
  simulation ([`orchestrator/test.ts:223-343`](../orchestrator/test.ts#L223-L343)).

The README accurately calls the scheduler tests pure, but “end-to-end” means
pure-function simulation, not extension/runtime integration
([`orchestrator/README.md:127-137`](../orchestrator/README.md#L127-L137)). There
are no tests for:

- `index.ts` tool/command registration, event-bus handoff, progress/report
  details, self-prompt following, or actual lykkja/planner composition;
- config loading/fallback/environment precedence or missing dependency/agent
  behavior;
- real fleet/spawn children, cancellation at phase boundaries, output evidence,
  critic parse rerun wiring, or partial process failure;
- session persistence, restart/crash boundaries, stale result reconciliation,
  or automatic continuation;
- worktree commits, dependent-task visibility, restored-review cwd, retries,
  branch merge order/conflicts, or cleanup;
- dependency result propagation, goal-score derivation, illegal status bypass,
  blocked-plan repair, or scoring-scale mismatch.

These gaps explain why README/skill statements that the run “never stalls,”
restart is “idempotent,” and reviewed branches are merged serially should be
read as intended operating protocol, not tested runtime guarantees
([`orchestrator/README.md:47-62`](../orchestrator/README.md#L47-L62),
[`orchestrator/skills/orchestration/SKILL.md:42-67`](../orchestrator/skills/orchestration/SKILL.md#L42-L67)).
