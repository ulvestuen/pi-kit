# Agent-native fleet runtime audit

**Scope and authority.** This focused audit covers the current `fleet/` runtime,
its public pi contract, configuration, README, tests, host wiring, and only the
adjacent spawn/critic/orchestrator code needed to establish integration
boundaries. It does not choose or implement a replacement architecture. Source
is authoritative where documentation differs. An “agent-native structured
handoff” here means a versioned, typed task/result/event exchange with stable run
identity, explicit artifacts/workspace provenance, and resumable lifecycle—not a
prompt plus reparsed process output.

## 1. Runtime and public contract map

```text
fleet_run (fleet/index.ts)
  -> discover markdown AgentDefinitions (fleet/host.ts + registry.ts)
  -> runTasks: validate + per-call FIFO pool (fleet/runner.ts)
     -> optional local `git worktree add` (unlabeled SpawnRequest)
     -> labeled `pi --mode json --no-session ...` SpawnRequest
        -> fleet/host.ts createHostSpawn
        -> spawn/runner-adapter.ts
        -> configured tmux | exedev | microsandbox SpawnBackend
     <- complete stdout/stderr
  <- parse final assistant JSONL event, cap text, return ordered TaskResults
```

The package has three relevant surfaces:

1. **Pi extension surface:** `fleet/index.ts` registers `fleet_run`, `/fleet`,
   prompt injection, session recovery, progress updates, custom session entries,
   and `fleet:*` events (`fleet/index.ts:97-298`).
2. **Pure reusable core:** registry parsing/merging and `runTasks` use injected
   effects and import neither pi nor `node:child_process`
   (`fleet/registry.ts:1-8`; `fleet/runner.ts:1-7,81-116,470-499`).
3. **Host/spawn bridge:** `fleet/host.ts` supplies filesystem/process effects and
   imports spawn config, backend factory, and synchronous adapter
   (`fleet/host.ts:11-39,243-302`). The boundary is source-relative rather than a
   declared library API: fleet imports spawn internals, while spawn imports fleet
   registry/tmux helpers (`spawn/runner-adapter.ts:14-20`; `spawn/config.ts:4`;
   `spawn/index.ts:7-8`). Package manifests expose extension entry points but no
   library exports (`fleet/package.json:1-18`; `spawn/package.json:1-18`).

### Public `fleet_run` contract

| Surface | Current contract | Exact source |
|---|---|---|
| Input | `{tasks: [{agent: string, task: string, isolation?: "none" | "worktree", timeoutMs?: number}]}`, at least one item. The engine also supports `TaskSpec.cwd`, but the tool schema does not expose it. | `fleet/index.ts:97-147`; `fleet/runner.ts:18-30` |
| Validation | Non-empty batch and brief, known agent, batch cap, and a worktree root when requested; invalid setup rejects the whole call before dispatch. | `fleet/runner.ts:231-288`; `fleet/index.ts:161-197` |
| Progress | `onUpdate` returns indexed `queued/running/<status>` text and `{batchId,statuses}` details after runner events. | `fleet/index.ts:159-190` |
| Result | Text summary plus `details: {batchId, results}`. Results remain in request order. | `fleet/index.ts:199-223`; `fleet/runner.ts:464-499` |
| Per-task result | `agent`, `status` (`ok|error|timeout|aborted`), `output`, `truncated`, `durationMs`, optional `exitCode`, transcript path, branch, and worktree path. Successful final-assistant text is capped; runner-generated error/timeout/abort prose is not. | `fleet/runner.ts:32-48,355-365,380-429` |
| Command | `/fleet` freshly lists discovered definitions, warnings, limits/backend/tmux state, and the process-local active batch. | `fleet/index.ts:257-298` |
| Prompt | Optional delegation guidance says briefs must be self-contained, advertises per-call capacity, and assigns branch merging to the caller. | `fleet/index.ts:31-47,105-109,250-255` |

Configuration defaults are concurrency 4, batch 8, ten-minute task timeout,
50 KiB model-visible output, `pi`, prompt injection enabled, and shared
`pi-agents` tmux settings (`fleet/runner.ts:12-16`; `fleet/config.ts:108-158`).
A present JSON file is the entire fleet source; `FLEET_*` variables are read only
when that file is absent (`fleet/config.ts:52-57,84-106`). Invalid extension
configuration logs and falls back to hard-coded defaults (`fleet/index.ts:62-85`).
The example and README enumerate the same knobs
(`fleet/fleet.example.json:1-11`; `fleet/README.md:118-144`).

## 2. Agent discovery and child execution

### Discovery

Definitions are flat frontmatter plus a markdown system-prompt body. Required
fields are name and description; optional fields are model, thinking level, and
comma-separated tool allowlist (`fleet/registry.ts:22-37,49-157`). Lookup is
trimmed and case-insensitive. Layers merge in this precedence:

1. kit `fleet/agents/*.md`;
2. user `$PI_CODING_AGENT_DIR/agents` or `~/.pi/agent/agents`;
3. project `<cwd>/.pi/agents`.

Later definitions replace earlier same-name definitions. Files are sorted within
each layer; invalid files become warnings rather than invalidating discovery
(`fleet/host.ts:94-153`; `fleet/registry.ts:160-181`). Discovery runs on every
`fleet_run` and `/fleet` call (`fleet/index.ts:141,260`). The tree ships five
roles—`auditor`, `critic`, `implementer`, `planner`, `scout`—although the README
still says four and omits `auditor` (`fleet/agents/*.md`;
`fleet/README.md:18-23`).

### Execution, concurrency, and cancellation

`runTasks` creates `min(maxConcurrent, task count)` workers sharing a FIFO
`next++` index. Every result is written to its original index, so completion
order cannot reorder the return (`fleet/runner.ts:464-499`). The limit is local
to one invocation: simultaneous fleet, critic, or orchestrator calls have
independent pools. Likewise `activeBatch` is one process-local slot; overlapping
`fleet_run` calls can overwrite/clear each other's `/fleet` display state
(`fleet/index.ts:93-95,149-157,207-208`). There is no global scheduler or
capacity lease.

One task timeout starts before worktree setup and aborts a task-local controller;
the external tool signal is linked to it (`fleet/runner.ts:290-313`). Running
children receive that signal; queued tasks become `aborted` without spawning
(`fleet/runner.ts:380-393,448-469,481-490`). This is cooperative: if an injected
spawn/backend operation ignores abort and never settles, the promise is not
hard-bounded. Task-local spawn exceptions become `error` results and do not stop
siblings (`fleet/runner.ts:396-445`).

The child argv is fixed as `pi --mode json --no-session --system-prompt <body>`
plus optional model/thinking/tools and the task string
(`fleet/runner.ts:118-135`). `--no-session` deliberately prevents child-session
persistence. Omitted model/tools flags defer to the new child pi process's own
configuration; the README phrase “defaults to parent's” is not implemented by
capturing parent settings (`fleet/README.md:26-35`;
`fleet/runner.ts:125-134`).

### Result parsing, capping, transcripts, and events

Fleet scans newline-delimited stdout, ignores malformed/non-JSON lines, and uses
only the last assistant `message_end`. It concatenates text blocks; no assistant
message or an `error`/`aborted` stop reason is an error
(`fleet/runner.ts:147-194,396-415`). Tool calls, intermediate messages, token
usage, model metadata, and artifacts are discarded as structured data.

Only successful final text is capped by UTF-8 bytes, with an explicit truncation
marker (`fleet/runner.ts:196-214,418-429`). Complete raw stdout is saved
best-effort under `$TMPDIR/<consumer>/task-<timestamp>-<index>.jsonl`; failure to
save does not alter the result (`fleet/host.ts:156-170`;
`fleet/runner.ts:315-338`). The transcript is temporary, unversioned, and linked
only by a path in that returned result.

The pure runner emits `task_start`, raw-stdout `task_update`, and `task_end` with
`index` and `agent` (`fleet/runner.ts:50-53,298-303,337-338,370-378`). Fleet
re-emits them as `fleet:task_start|task_update|task_end`; `task_start` carries the
full task-brief string as a text payload, but event payloads have no batch/run/job
id, attempt, sequence, or durable cursor
(`fleet/index.ts:175-190`). The ordinary tool update displays status only, not
raw chunks. Orchestrator independently re-emits the same names when it invokes
the runner (`orchestrator/index.ts:297-305`).

## 3. Worktrees and the boundary to spawn

For `isolation: "worktree"`, fleet creates
`fleet/task-<1-based-index>-<start-ms>` with
`git worktree add -b <branch> <scratch-path>`, then runs the child in that path
(`fleet/runner.ts:137-145,342-378`). Public fleet allocates
`$TMPDIR/pi-fleet/worktrees` only if any task requests isolation
(`fleet/index.ts:171-174`; `fleet/host.ts:172-177`). The result reports branch and
path, but fleet never commits, merges, removes the worktree, deletes the branch,
or inventories changes; caller-owned merge is explicit
(`fleet/runner.ts:418-427`; `fleet/README.md:57-63`). Default `none` means parallel
writers share the supplied cwd.

The `label` on only the pi child is the routing discriminator. Labeled requests
become internal spawn jobs; unlabeled helper commands such as worktree creation
use local `nodeSpawn` even when the selected agent backend is remote
(`fleet/runner.ts:349-375`; `spawn/runner-adapter.ts:236-270`;
`fleet/host.ts:43-92,268-302`). Consequences:

- tmux uses the host path;
- microsandbox can mount the selected cwd at `/workspace` under spawn policy;
- exe.dev merely tries the same absolute cwd string on the VM—there is no repo or
  worktree transfer (`fleet/README.md:140-144`; `spawn/config.ts:63-68`).

`createHostSpawn` uses one spawn backend selected when the extension loads. It
passes fleet's historical `tmuxSession` and `piBinary` into spawn config; setting
fleet `tmux=false` does not disable a selected tmux runner
(`fleet/host.ts:243-265,289-302`). The separate mirror in `fleet/tmux.ts` is
legacy utility/test surface: production host wiring does not call
`createTmuxMirrorSpawn`; spawn's tmux backend is the actual runner
(`fleet/tmux.ts:137-246`; `fleet/README.md:89-99,156-173`).

For labeled children, `spawn/runner-adapter.ts` checks availability, launches a
backend job with a `pi-fleet-` prefix and parent PID, persists it in spawn's job
registry, polls refresh/output every 250 ms, streams text deltas, and converts a
terminal job back to fleet's complete stdout/stderr promise
(`spawn/runner-adapter.ts:186-233,236-330`; `fleet/index.ts:88-91`). Fleet owns
batching, timeout, parsing, and `TaskResult`; spawn owns placement, detached job
markers/logs, backend status, and kill. The adapter does not return the spawn job
name through `SpawnOutcome`, so fleet cannot persist or expose that child
identity (`fleet/runner.ts:72-79`; `spawn/runner-adapter.ts:257-274,316-322`).

Critic and orchestrator consume fleet internals directly. Critic runs one task
through `runTasks` (`critic/index.ts:82-118`). Orchestrator maps a ready plan wave
to ordered task specs, then runs critic specs, optionally in implementation
worktrees (`orchestrator/index.ts:287-310,314-397`). Planner/DAG barriers and
review gates therefore live above fleet; `fleet_run` itself knows no dependencies
or handoff graph.

## 4. Persistence and recovery

Fleet appends a `fleet-state` entry before dispatch and after completion. The
running entry stores batch id, start time, agent, and brief; live statuses remain
only in memory. The terminal entry adds per-task status, but not outputs,
backend job names, event offsets, or worktree provenance
(`fleet/index.ts:21-29,149-208`). Batch state is `done` unless any task is
`aborted`; `error` and `timeout` alone do not change it to `aborted`
(`fleet/index.ts:199-208`).

On `session_start`, fleet first cleans stale internal `pi-fleet-*` spawn jobs,
then marks the latest recorded running fleet batch aborted
(`fleet/index.ts:228-248`). Spawn cleanup treats a running prefixed job as stale
only when its recorded parent PID is gone (or missing for legacy records); a
live parent's job survives so child/concurrent pi sessions do not kill it. Stale
jobs are killed best-effort and stamped `killed`
(`spawn/runner-adapter.ts:137-180`). This is **abort-on-restart**, not recovery:
fleet cannot reattach, resume polling, reconstruct a result, deduplicate a
retry, or replay events.

The internal job registry itself is spawn-owned `jobs.json`. Writes are atomic
for one writer, but adapter serialization is per adapter instance and there is
no cross-process lock or revision check (`spawn/runner-adapter.ts:201-223`;
`spawn/jobs.ts:197-245`). Fleet session records do not link to those jobs. No
fleet path cleans stale worktrees/transcripts. These boundaries preclude durable
exactly-once result application even though detached backend records survive.

## 5. Barriers to structured, agent-native handoffs

1. **Prompt/stdout is the protocol.** Input is an opaque brief string plus a role;
   output is reparsed JSONL collapsed to one text string. There is no typed
   context, expected-output schema, message/tool/usage record, diagnostic, or
   child-produced artifact manifest (`fleet/index.ts:110-139`;
   `fleet/runner.ts:118-194`). “Self-contained” is guidance, not validation.
2. **Identity is fragmented.** Batch id, task index, spawn job name, transcript,
   worktree, planner task id, and attempt are not one durable run record. Events
   and `TaskResult` omit backend job/run ids (`fleet/index.ts:21-29`;
   `fleet/runner.ts:34-53`; `spawn/runner-adapter.ts:257-274`).
3. **No handoff/barrier primitive.** Fleet is synchronous fan-out/fan-in only. It
   cannot express dependencies, partial completion consumption, child-to-child
   messages, review gates, retries, or dynamic task creation; planner and
   orchestrator layer these externally (`planner/plan.ts:37-58`;
   `orchestrator/index.ts:78-113,287-397`).
4. **No resumable lifecycle.** The public call blocks until all tasks settle;
   restart cleanup aborts rather than reattaches. There is no durable handle,
   event cursor, acknowledgment, result claim, or idempotency key
   (`fleet/runner.ts:464-499`; `fleet/index.ts:228-248`).
5. **Events are insufficient for orchestration.** Raw chunk events lack batch/run
   identity and sequence; completion is process-local emission, not a durable
   queue. Concurrent emitters are ambiguous (`fleet/runner.ts:50-53`;
   `fleet/index.ts:175-190`).
6. **Workspace output is implicit side effect.** A path/branch is the only
   provenance. There is no base revision, change/commit/patch manifest,
   ownership, cleanup state, merge status, or remote staging contract
   (`fleet/runner.ts:342-368,418-427`).
7. **Capacity and persistence are not shared.** Pools and registry mutation
   chains are per invocation/instance while multiple extensions and processes
   share backends and `jobs.json`; there is no global fairness, lease, or safe
   multi-writer coordination (`fleet/runner.ts:478-499`;
   `spawn/runner-adapter.ts:201-223`).
8. **Backend capabilities are opaque at fleet level.** The public tool cannot
   select placement or require workspace/artifact/cancellation capabilities.
   One configured backend receives every labeled child
   (`fleet/host.ts:243-302`; `spawn/jobs.ts:162-195`).
9. **Structured text can be truncated or flattened.** The cap applies to final
   assistant text without schema-aware validation, and failures become prose;
   consumers cannot distinguish a complete structured payload from a capped one
   without custom handling (`fleet/runner.ts:196-214,396-429`).
10. **No stable package boundary.** Critic, orchestrator, and spawn import fleet
    implementation files directly, and fleet host imports spawn internals. A new
    runtime contract cannot evolve independently without adapters or coordinated
    source changes (`critic/index.ts:4-15`; `orchestrator/index.ts:7-24`;
    `fleet/host.ts:30-39`).

## 6. Invariants and compatibility surface to preserve or migrate explicitly

- **Tool compatibility:** retain/version `fleet_run` name and accepted fields,
  progress details, ordered `details.results`, status vocabulary, and result
  provenance fields (`fleet/index.ts:97-140,175-223`).
- **Agent compatibility:** preserve markdown definitions, validation, case-
  insensitive lookup, kit < user < project precedence, per-file warnings, and
  model/thinking/tool overrides (`fleet/registry.ts:49-181`;
  `fleet/host.ts:115-153`). Shipped role prompts/tool allowlists are policy
  inputs (`fleet/agents/*.md`).
- **Execution compatibility:** isolated child context, `--no-session`, ordered
  fan-in, bounded batch/concurrency, per-task timeout and outer cancellation,
  sibling failure isolation, and final-assistant semantics
  (`fleet/runner.ts:118-135,259-288,290-499`).
- **Output compatibility:** bounded model-visible UTF-8 output, explicit
  truncation, and best-effort access to the complete raw transcript
  (`fleet/runner.ts:196-214,315-338`). A replacement can strengthen durability
  but must migrate `fullOutputPath` behavior deliberately.
- **Workspace safety:** `none` means caller cwd; `worktree` means a distinct
  branch/path that is reported and never silently merged
  (`fleet/runner.ts:342-368,418-427`).
- **Observability:** preserve or version `onUpdate`, `/fleet`, session entries,
  and `fleet:task_start|task_update|task_end` (`fleet/index.ts:175-190,228-298`).
- **Spawn boundary:** labeled sub-agent commands use configured spawn placement;
  unlabeled local helpers retain local side effects; cancellation must not report
  an unconfirmed child success (`fleet/host.ts:268-302`;
  `spawn/runner-adapter.ts:236-330`).
- **Recovery safety:** stale cleanup must not kill a job whose parent process is
  still alive, and legacy jobs lacking `parentPid` need an explicit migration
  (`spawn/runner-adapter.ts:137-180`).
- **Pure-core testability:** retain injected spawn/time/filesystem/backend effects
  so network/process-free tests remain possible (`fleet/runner.ts:81-116`;
  `spawn/host.ts:1-6`).
- **Config migration:** current defaults, JSON-vs-environment precedence,
  historical tmux fields, source-relative consumers, and spawn `jobs.json`
  records are compatibility/deprecation obligations, not necessarily desirable
  architecture (`fleet/config.ts:84-158`; `fleet/host.ts:243-265`;
  `spawn/jobs.ts:197-245`).

## 7. Test, worktree, recovery, and compatibility evidence

### Covered

`fleet/test.ts` uses injected fakes and covers:

- definition validation, layered/case-insensitive merge and lookup
  (`fleet/test.ts:75-193`);
- exact child argv, tolerant final-message parsing, UTF-8 capping, and worktree
  helper naming (`fleet/test.ts:195-299`);
- ordered results, validation, pool limit, timeout, running/queued abort,
  transcript save, child/spawn failure isolation, and all three runner events
  (`fleet/test.ts:301-499`);
- required root, successful worktree cwd/branch reporting, and creation failure
  (`fleet/test.ts:500-558`);
- labeled-child versus unlabeled-git behavior and legacy tmux mirror behavior
  (`fleet/test.ts:560-751`).

The spawn boundary suite covers labeled backend launch/job persistence, parent
PID, stderr propagation, unlabeled fallback, stale cleanup that preserves a live
parent, and abort kill/stamp (`spawn/test.ts:848-1081`). On 2026-07-11,
`npm test --workspace fleet` passed 50/50 and
`npm test --workspace spawn` passed 49/49; scripts are `tsx --test test.ts`
(`fleet/package.json:6-8`; `spawn/package.json:6-8`).

### Important gaps

- No test instantiates `fleet/index.ts`; the TypeBox schema, hooks, session-entry
  recovery, prompt injection, `/fleet`, `onUpdate`, and event-bus wiring are
  unverified at extension level.
- Fleet discovery against real kit/user/project directories, fleet config
  loading/fallback, real `nodeSpawn`, and `createHostSpawn` are not exercised by
  `fleet/test.ts`.
- Runner and spawn adapter are tested separately; no test dispatches
  `fleet_run -> createHostSpawn -> real/fake SpawnBackend -> tool result` end to
  end, and no real pi JSONL compatibility test exists.
- Recovery tests validate spawn stale-job cleanup, not fleet's session-start
  mutation or reattachment (which does not exist). There is no restart,
  cross-session, malformed-registry, PID-reuse, or stale-but-already-completed
  integration test.
- Worktree tests assert command construction and selected cwd only. They do not
  create a real repository, test dirty/untracked bases, concurrent branch-name
  collisions, remote path mismatch, commits/artifacts, merge, cleanup, or stale
  pruning.
- No test races independent pools/adapters/processes against global capacity or
  spawn `jobs.json`, nor checks event ambiguity, transcript filename collision,
  growing-output polling, or structured-output truncation.
- Critic/orchestrator tests exercise their parsing/scheduler cores, not a real
  planner-to-fleet-to-review handoff (`critic/test.ts:32-214`;
  `orchestrator/test.ts:72-343`).

## Conclusion

Fleet is a well-factored, synchronously composable process runner with useful
compatibility guarantees: layered role discovery, deterministic ordered fan-in,
bounded execution, explicit worktree provenance, backend placement through
spawn, cancellation, and fake-driven tests. It is not itself an agent-native
handoff runtime. The protocol remains an opaque brief and shell argv, reparsed
JSONL, transient text events, disconnected identities, unmanaged workspace side
effects, and abort-on-restart state. A replacement should preserve the listed
public/runtime invariants while introducing typed versioned handoffs, stable run
identity, durable events/results, explicit artifacts/workspace capabilities,
and resumable ownership at the fleet–spawn boundary.
