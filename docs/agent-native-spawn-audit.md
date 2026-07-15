# Agent-native spawn backend audit

**Scope.** This is a focused audit of `spawn/` source, tests, configuration,
README, and its synchronous runner-adapter integration with fleet, critic, and
orchestrator. Source is authoritative where prose differs. This document audits
the current branch; it does not select or implement a replacement architecture.

**Agent-native yardstick.** A backend-neutral agent runtime would expose a
durable run identity, typed lifecycle/events/results, explicit placement and
workspace capabilities, authenticated or at least validated state, cancellation
with a stated guarantee, and reattachment/recovery. The current abstraction is a
detached process/job abstraction whose completion protocol is mutable markers
and logs (`spawn/jobs.ts:39-80,162-195`).

## 1. Two lifecycles over one backend interface

```text
Public detached path
spawn_agent -> SpawnBackend.launch -> return SpawnJob immediately
                                      |
later spawn_jobs/output/kill --------+-> refresh / output / kill

Internal synchronous path
fleet/critic/orchestrator -> fleet/runner.ts SpawnFn
  -> spawn/runner-adapter.ts -> SpawnBackend.launch
  -> poll refresh + reread output every 250 ms
  -> terminal SpawnOutcome -> fleet parses JSONL -> TaskResult
```

The shared `SpawnBackend` contract is `available`, `launch`, mutable `refresh`,
`output`, `errorOutput`, and best-effort `kill`. Its closed backend-name union is
`tmux | exedev | microsandbox`; backend-specific handles leak into optional
fields on `SpawnJob` (`spawn/jobs.ts:24-30,39-80,177-195`). `createBackends`
binds the real Node helper-process and detach effects to all three implementations
(`spawn/host.ts:22-78,80-131`).

### 1.1 Public detached lifecycle

1. `spawn_agent` rediscovers the shared fleet agent registry, chooses a per-call
   backend or the configured default, checks only `backend.available()`, derives
   a sanitized timestamp-suffixed name, launches, appends the returned record to
   `jobs.json`, and returns without waiting (`spawn/index.ts:153-202`;
   `spawn/jobs.ts:104-128`). Its supplied tool-call `AbortSignal` is ignored; the
   caller cannot cancel a public spawn before launch or while launching.
2. With no prebuilt command in `LaunchRequest`, each backend builds
   `pi -p --no-session --system-prompt ...` in plain-text output mode. Model,
   thinking, and tool overrides come from the agent definition
   (`spawn/agent-command.ts:1-27,29-41`). Public jobs have no timeout or supervising
   parent (`spawn/README.md:35-57`).
3. There is no monitor. A later `spawn_jobs`, `spawn_output`, or `/spawn` call
   reloads the persistent registry and refreshes nonterminal records. Status is
   therefore eventually observed only by explicit polling
   (`spawn/index.ts:85-104,206-302,348-378`). `spawn_output` clamps tails to
   256 bytes through 512 KiB and includes captured stderr only for non-clean
   terminal jobs (`spawn/index.ts:267-299`).
4. `spawn_kill` refreshes once, leaves terminal jobs unchanged, otherwise awaits
   backend kill and then stamps `killed`; this records a requested action, not
   proof that all child processes stopped (`spawn/index.ts:304-339`).

Public durability means the backend runner and registry outlive the launching pi
session. It does **not** mean a result is pushed to a caller, that the job can be
reattached as a typed agent run, or that its effects are idempotent.

### 1.2 Internal synchronous adapter lifecycle

Fleet's pure runner expects a command-level `SpawnFn` promise resolving complete
`{exitCode, stdout, stderr}` and carries an `AbortSignal` plus stdout callback
(`fleet/runner.ts:55-79`). `fleet/host.ts` bridges that contract as follows:

- Labeled requests—the actual pi child—go through `createSpawnToolingSpawn` and
  the configured spawn backend. Unlabeled helpers such as `git worktree add`
  remain local `node:child_process` calls (`fleet/host.ts:43-92,268-302`;
  `fleet/runner.ts:346-378`).
- The runner prebuilds `pi --mode json --no-session ...`; unlike public spawn,
  this output is JSONL that fleet later parses for the last assistant
  `message_end` (`fleet/runner.ts:118-194,370-429`). The adapter forwards this
  exact command/argv to `LaunchRequest`, using a pseudo-agent only as job
  metadata (`spawn/runner-adapter.ts:86-99,236-274`).
- After availability and launch, the adapter records `parentPid`, repeatedly
  calls `refresh`, saves changed state, rereads output, heuristically emits log
  deltas, and resolves only when status is terminal. Poll cadence is 250 ms and
  output is unlimited by default because fleet needs complete JSONL
  (`spawn/runner-adapter.ts:31-60,186-223,257-329`). Failed/lost/killed results add
  a status line and up to 16 KiB of backend stderr
  (`spawn/runner-adapter.ts:105-135,316-322`).
- Fleet starts the per-task timeout before worktree setup, translates timeout or
  outer cancellation to the adapter signal, and awaits the adapter. The timeout
  is cooperative, not a hard promise deadline (`fleet/runner.ts:290-313,341-445`).
  Adapter abort is checked at the next poll iteration; it best-effort kills,
  stamps `killed` in `finally`, captures remaining output, and returns null exit
  (`spawn/runner-adapter.ts:225-233,294-329`). The registered abort listener is a
  no-op, so it does not wake sleep or interrupt an in-flight availability,
  launch, refresh, output, or SSH operation.
- Fleet, critic, and orchestrator construct one adapter with prefixes
  `pi-fleet`, `pi-critic`, and `pi-orchestrator`, respectively
  (`fleet/index.ts:88-91`; `critic/index.ts:82-118`;
  `orchestrator/index.ts:140-142,275-311,350-357`). Each invokes stale-job cleanup
  at `session_start` (`fleet/index.ts:228-230`; `critic/index.ts:117-119`;
  `orchestrator/index.ts:489-490`).

Internal execution is thus physically detached but synchronously waited on. Its
persistent job record is not a resumable promise/result: after parent loss, a new
session cleans up rather than reattaches.

## 2. Backend lifecycle map

All three run scripts preserve one important completion barrier: stdout and
stderr are separate, exit code is staged, and the final `done` marker is
published only after stdout capture has closed. This prevents stderr from
corrupting fleet JSONL and prevents a normal terminal poll from preceding the
complete log (`spawn/backends/tmux.ts:34-68`;
`spawn/backends/exedev.ts:50-87`;
`spawn/backends/microsandbox.ts:52-82`). Setup/cwd guard failures write stderr and
a 126/127 marker directly because no child stdout remains to drain.

| Backend | Availability and launch / process owner | Status, logs, and persistence | Cancellation and retention |
|---|---|---|---|
| **tmux** | `tmux -V` only. Creates `<logDir>/<job>/{run.sh,job.log,err.log,done}`, serializes the initial session/window race, and runs owner-only `run.sh` inside a window. The tmux server/window—not pi—is the runner; `remain-on-exit` preserves natural-completion scrollback (`spawn/backends/tmux.ts:71-77,93-197`). | Local filesystem done marker wins; absent marker uses `tmux list-panes` pane aliveness. Output/error are local byte tails (`spawn/backends/tmux.ts:79-91,199-211`; `spawn/backends/local.ts:23-92`). Registry and job directory persist; natural completion leaves the window. | `tmux kill-window` by recorded stable window id, with no verification/escalation (`spawn/backends/tmux.ts:213-217`). A killed window does not remain, despite the broad public tool description; job files do. |
| **exe.dev** | `ssh -V` only. SSH lists/reuses one configured user-owned VM or creates it and waits up to 180 s for SSH. It pipes a 0700 script to `$HOME/.pi-spawn/<job>`, then `setsid nohup`s it. The remote session-leader shell/process group owns execution; SSH and local pi may exit (`spawn/backends/exedev.ts:31-38,90-105,168-286`). | One SSH probe returns `done:<code>`, `running` from pid/`kill -0`, or `lost`. Separate SSH `cat`/`tail` calls fetch stdout/stderr. SSH failure preserves last state (`spawn/backends/exedev.ts:107-147,289-331`). Logs/markers remain only on the VM; neither remote job directories nor the billable VM are deleted (`spawn/backends/exedev.ts:11-13`). | Sends SIGTERM to the pid-file process group, falling back to the single PID; errors are hidden by shell `true`, and stop is not confirmed (`spawn/backends/exedev.ts:143-147,334-337`). |
| **microsandbox** | `msb --version` only. Creates the same host job files, mounts them at `/job`, optionally mounts cwd read-write at `/workspace`, and detaches/unrefs host `msb run`; that host process group is the runner/aliveness handle. Guest script installs pi from npm if absent (`spawn/backends/microsandbox.ts:43-107,109-173`; `spawn/host.ts:80-117`). | Guest and host share done/log/error files through the mount; host PID aliveness plus local markers derives status. A refresh transition to terminal optionally removes the named sandbox, while host files and registry remain (`spawn/backends/microsandbox.ts:175-193`; `spawn/backends/local.ts:23-92`). No poll means no natural-completion cleanup. | Best-effort SIGTERM to detached host process group, then `msb stop --force`, then optional `rm --force`; none is followed by a stopped-state assertion (`spawn/backends/microsandbox.ts:109-117,195-200`; `spawn/host.ts:97-116`). |

`available()` establishes executable presence, not operational readiness:
tmux-server permissions, exe.dev credentials/host-key/VM/model access, and
microsandbox virtualization/image/network health are deferred until launch or the
run script (`spawn/backends/tmux.ts:139-144`;
`spawn/backends/exedev.ts:239-244`; `spawn/backends/microsandbox.ts:122-127`).
Short helper calls use a 60 s default timeout; exe.dev overrides selected launch,
create, readiness, and probe timeouts (`spawn/host.ts:22-78`;
`spawn/backends/exedev.ts:34-38,177-186,212-233,264-267`).

## 3. Status, markers, logs, and polling semantics

### State machine and completion barrier

`running` is the only nonterminal state. Marker `0` becomes `done`; nonzero or
unparseable marker becomes `failed`; no marker plus live runner remains `running`;
no marker plus dead runner becomes `lost`; callers directly stamp `killed`
(`spawn/jobs.ts:32-37,82-102`). Once any terminal state is persisted, all public
refresh paths skip it, so there is no reconciliation API
(`spawn/index.ts:95-104`).

For local/mounted markers, refresh reads marker, probes aliveness only if absent,
and rereads marker once after a dead probe to close the specific race where the
runner publishes and exits between those operations
(`spawn/backends/local.ts:23-52`). This is a narrow barrier, not transactional
completion: filesystem/mount visibility delay after the second read can still
make `lost` permanent. exe.dev performs marker/pid checks in one remote shell,
but PID reuse can report a dead job as running and any successful unexpected
probe response falls through to `lost` (`spawn/backends/exedev.ts:107-120,289-309`).
`parseInt` also accepts a numeric prefix such as `0garbage` as successful exit
(`spawn/jobs.ts:92-101`). This is a narrow concern: marker file content is
controlled by the run script, so only corruption or direct filesystem
manipulation would produce a malformed marker.

### Filesystem and network polling cost

- Public completion is pull-only; there is no watcher, callback, event bus event,
  scheduler wake-up, or background reconciliation (`spawn/index.ts:206-302,348-378`).
- The synchronous adapter polls every 250 ms and rereads available output every
  iteration. With its infinite default, local backends read the complete growing
  file and exe.dev performs a complete remote `cat`, producing cumulative I/O
  and SSH transfer rather than cursor-based streaming
  (`spawn/runner-adapter.ts:31-33,194-195,279-326`;
  `spawn/backends/local.ts:68-92`; `spawn/backends/exedev.ts:122-129,312-321`).
- Delta streaming assumes each new read has the previous text as a prefix. A
  truncated, rotated, shortened, or non-prefix tail causes the complete available
  chunk to be emitted again; there are no byte cursors, sequence numbers, replay
  tokens, or acknowledgements (`spawn/runner-adapter.ts:279-291`). Byte tails can
  split UTF-8 code points (`spawn/backends/local.ts:76-88`).
- exe.dev transport failure intentionally leaves the last status unchanged,
  avoiding false `lost` but allowing public jobs—or synchronous jobs without a
  caller timeout—to remain `running` indefinitely. A fleet timeout is observed
  only after the in-flight SSH/output operation returns; the adapter then requests
  kill and stamps it without remote confirmation
  (`spawn/backends/exedev.ts:289-309`; `spawn/runner-adapter.ts:294-329`). Each
  individual real SSH helper is time-bounded, but the lifecycle has no independent
  uncertainty deadline or terminal `unknown` state.

## 4. Persistence, ownership, cancellation, and recovery limits

The durable index is version-1 `<logDir>/jobs.json`; saves write one fixed
`jobs.json.tmp` then rename (`spawn/jobs.ts:197-245`). Records include task/cwd,
status/timestamps, and backend handles. Local job files or remote `.pi-spawn`
directories hold scripts, logs, errors, and markers. The written version is not
validated on load, record fields are not schema-validated, records are never
expired, and missing/corrupt registry is treated as empty
(`spawn/jobs.ts:209-235`). There is no discovery scan of local directories, tmux
windows, sandboxes, or the VM to reconstruct orphaned jobs.

Launch precedes registry persistence in both public and adapter paths. A crash or
save failure in that gap leaves a running backend job with no durable index
(`spawn/index.ts:175-189`; `spawn/runner-adapter.ts:257-274`). Conversely a stale
record can outlive a missing backend resource. Public mutations use uncoordinated
load/mutate/save; the adapter's promise chain serializes only one adapter instance.
There is no cross-process lock, revision, compare-and-swap, or unique temp file,
although public spawn, fleet, critic, orchestrator, nested child pi processes, and
concurrent sessions share the registry (`spawn/index.ts:85-93`;
`spawn/runner-adapter.ts:201-223`; `spawn/jobs.ts:238-245`). Lost updates and temp
file races can orphan jobs or regress status.

Public jobs have no `parentPid`; backend resources own them until natural exit or
manual kill. Internal jobs record the local adapter process PID. On session start,
prefix-scoped cleanup kills a `running` internal record only if that PID is absent
(or missing for legacy records), preserving jobs whose concurrent parent remains
alive (`spawn/runner-adapter.ts:51-74,137-180`). Limitations are explicit:

- host PID identity is not durable and can be reused; it says nothing about
  remote runner identity or parent intent;
- cleanup does not refresh markers first, so an already-completed job whose
  registry still says `running` can be killed/stamped instead of reconciled;
- cleanup stamps `killed` even when backend kill throws, and normal adapter abort
  stamps it in `finally`; `killed` therefore means locally requested/stamped, not
  remotely verified stopped (`spawn/runner-adapter.ts:156-178,225-233`);
- restarted internal callers cannot reattach, recover stdout/result, or continue
  the old promise. Fleet marks its recorded in-flight batch aborted after cleanup
  (`fleet/index.ts:228-248`); critic and orchestrator use the same kill-on-restart
  pattern;
- terminal `lost`, `killed`, `failed`, and `done` records are immutable even if a
  late marker, recovered network, or surviving process contradicts them.

Cancellation guarantees also differ. Unlabeled local helpers receive SIGTERM and
SIGKILL after three seconds (`fleet/host.ts:48-92`). Labeled adapter jobs wait up
to a poll interval plus any in-flight backend operation, then use backend-specific
best-effort stop. Public launch ignores cancellation, and public kill has no
escalation/confirmation common contract. Fleet's timer only aborts a signal; if a
backend/adapter promise never settles, task completion is unbounded
(`fleet/runner.ts:305-313,370-393,430-445`).

## 5. Security and trust boundaries

| Boundary | Current behavior and risk |
|---|---|
| **Local tmux** | Agent code runs directly as the local user with the supplied host cwd and tool allowlist. This is observability, not isolation. API keys are copied by default into a 0700 run script because the tmux server has a different environment (`spawn/backends/tmux.ts:53-66,163-186`; `spawn/config.ts:47-50,198-218`). |
| **exe.dev cloud** | Commands, prompts, logs, optional credentials, repository clones, and model traffic cross into a user-owned third-party VM over SSH. Environment forwarding is off by default; there is no implicit workspace transfer. The VM and remote logs persist until the user removes them (`spawn/README.md:72-98`; `spawn/config.ts:51-58,209-212`). |
| **microsandbox microVM** | Hardware isolation is weakened by defaults: host cwd is mounted read-write and API keys are injected into the script. The default image may fetch and globally install the latest compatible pi package at runtime, adding network and package-supply-chain dependencies (`spawn/backends/microsandbox.ts:11-17,63-105,147-166`; `spawn/config.ts:213-218`). |
| **Control files and registry** | Marker/log/registry contents have no integrity/authentication. A child can write its mounted/local job files; any process with user access can alter `jobs.json`. Loaded records are not schema-validated, so manipulated `logPath`, tmux window id, SSH destination, remote directory, PID, or sandbox name can redirect later read/kill operations (`spawn/jobs.ts:39-80,214-235`; backend `output`/`kill` methods in section 2). Polling therefore trusts backend- and filesystem-supplied completion/result data. |
| **Secrets and prompts at rest** | Shell quoting prevents ordinary argument injection (`spawn/agent-command.ts:29-59`), names are sanitized, and generated local/remote scripts are 0700. However public task text is persisted in `jobs.json`; internal `taskPreview` persists the full command/argv including system prompt and task; logs/errors and registry have no retention/redaction policy or explicit chmod (`spawn/runner-adapter.ts:96-99,257-274`; `spawn/jobs.ts:238-245`). |
| **Host effects** | Real helper processes inherit the full host environment, while configured subsets may be copied into scripts (`spawn/host.ts:29-36,80-87`). `ssh` uses `BatchMode=yes`, so trust establishment must happen out of band (`spawn/backends/exedev.ts:177-186`; `spawn/README.md:83-88`). |

The done-after-log ordering is a useful integrity *ordering* invariant, not proof
of provenance, completeness under storage failure, or authenticity of the child
result.

## 6. Barriers to backend-neutral, agent-native completion/results

1. **Shell/log protocol instead of typed run protocol.** Input is argv plus a
   generated shell script; public result is text and internal result is recovered
   by reparsing pi JSONL. There are no structured tool events, usage, artifacts,
   checkpoints, or backend-independent result schema (`spawn/agent-command.ts:1-41`;
   `fleet/runner.ts:147-194`).
2. **No stable end-to-end run identity.** Backend job name, fleet task index,
   planner/orchestrator task id, transcript path, worktree, and parent PID are not
   joined in one durable record. `SpawnOutcome` and `TaskResult` omit backend job
   identity (`fleet/runner.ts:34-79`; `spawn/runner-adapter.ts:257-274`).
3. **Polling-only backend interface.** `refresh` mutates caller-owned records and
   `output(maxBytes)` has no cursor or wait primitive. It cannot express push
   completion, replay, monotonic event sequence, leases, heartbeats, or an
   acknowledged result (`spawn/jobs.ts:177-195`).
4. **No capability/placement contract.** The interface cannot declare local vs
   remote filesystem mapping, mount mode, network, credential handling, image,
   live streaming, durability, cancellation strength, artifact retrieval, or
   reattachment. `available()` consequently overstates readiness.
5. **No workspace transport.** tmux uses host cwd. Public exe.dev ignores cwd and
   starts in VM `$HOME`; internal exe.dev merely attempts the same absolute cwd
   string on the VM. Microsandbox optionally maps host cwd to `/workspace`
   (`spawn/backends/exedev.ts:62-86,249-263`; `spawn/README.md:89-96`;
   `spawn/backends/microsandbox.ts:85-105`). Backend-neutral scheduling cannot
   guarantee equivalent inputs or collect changed files/artifacts.
6. **Unsafe shared persistence and no recovery protocol.** The registry cannot
   safely coordinate the advertised concurrent/multi-session use, launch is not
   transactional, and recovery chooses kill or manual polling rather than
   reattach/replay/deduplicate.
7. **Inconsistent cancellation and uncertainty.** A common `kill(): void` cannot
   distinguish accepted, stopped, unreachable, already complete, or partially
   stopped. The state model has no `cancelling`, `unknown`, retryable transport
   error, or cancellation deadline.
8. **Closed provider surface.** Adding a backend requires changing the name union,
   job record, config, host factory, TypeBox tool union, prompt/docs, and tests
   (`spawn/jobs.ts:24-30,39-80`; `spawn/host.ts:119-131`;
   `spawn/index.ts:27-39,128-138`). Spawn also imports fleet registry and shell
   helpers while fleet imports spawn adapter/backend internals, so packages are
   source-coupled rather than stable provider/consumer APIs
   (`spawn/index.ts:7-8`; `spawn/agent-command.ts:13-14`;
   `spawn/config.ts:4`; `fleet/host.ts:30-39`).

## 7. Compatibility constraints and invariants to preserve

A replacement must preserve these behaviors or provide an explicit migration:

1. **Public contracts:** tool names and accepted fields for `spawn_agent`,
   `spawn_jobs`, `spawn_output`, `spawn_kill`; per-job backend override; current
   status vocabulary and useful structured job metadata (`spawn/index.ts:106-339`).
2. **Detached durability:** public launch returns promptly; jobs survive the tool
   call/session; a later session can list, tail, and kill them. Backend uncertainty
   must not be reported as successful completion (`spawn/jobs.ts:1-17`;
   `spawn/backends/exedev.ts:289-293`).
3. **Child invocation:** public spawn remains isolated from the parent context and
   uses agent model/thinking/tool settings; internal fleet remains
   `--mode json --no-session`, reports the final assistant text, ordered results,
   timeouts/aborts, full-transcript hooks, and worktree provenance
   (`spawn/agent-command.ts:16-27`; `fleet/runner.ts:118-194,290-499`).
4. **Report-back barrier:** stderr cannot corrupt structured stdout, and clean
   completion cannot become visible before the log is fully published (run-script
   references in section 2).
5. **Placement:** tmux is local/live; exe.dev is remote with no implicit repo
   transfer and a persistent user-owned VM; microsandbox is a local microVM whose
   cwd mount and credential forwarding remain explicit. Preserve or safely change
   current forwarding defaults (`spawn/config.ts:198-218`; `spawn/README.md:59-115`).
6. **Persistent migration:** version-1 `jobs.json`, backend-specific records,
   local job directories, remote `$HOME/.pi-spawn` directories, job-name/prefix
   conventions, and parent-PID cleanup need a loader/migration. Concurrent live
   parents must not be killed (`spawn/jobs.ts:104-128,197-245`;
   `spawn/runner-adapter.ts:137-180`).
7. **Integration routing:** only labeled pi children use spawn backends; unlabeled
   local helpers retain local synchronous semantics. Fleet, critic, and
   orchestrator currently select one process-wide backend through spawn config,
   while public spawn can select per call (`fleet/host.ts:243-302`).
8. **Configuration:** default tmux, shared `pi-agents`, default log location and
   tail size, exe.dev VM behavior, microsandbox mount/removal/resources, and
   file-versus-environment loading precedence are user-visible
   (`spawn/config.ts:10-24,100-115,163-269`; `spawn/spawn.example.json:1-29`). A
   present JSON file is the complete source; `SPAWN_*` values are used only when
   that file is absent. Historical fleet/critic/orchestrator `tmuxSession` and
   `piBinary` override spawn values; `tmux=false` no longer disables windows when
   the selected spawn backend is tmux (`fleet/host.ts:225-265`).
9. **Operational/platform assumptions:** generated scripts require POSIX `sh`;
   tmux must be local; exe.dev needs pre-established noninteractive SSH and pi/model
   access; microsandbox supports its documented host platforms, needs a compatible
   `msb` CLI and node/npm-capable image, and may need network for install
   (`spawn/README.md:59-115`). The package is ESM/ES2022 and directly includes
   fleet TypeScript sources (`spawn/package.json:1-18`; `spawn/tsconfig.json:1-18`;
   `spawn/README.md:199-216`).
10. **Pure test seams:** keep injected helper/detach effects and a command-level
    runner seam so lifecycle logic remains network/process-free in unit tests
    (`spawn/host.ts:1-6`; `fleet/runner.ts:1-7`).

Documentation drift that should not become a compatibility promise: the config
comment says `msbForwardEnv` uses `msb -e`, while implementation writes exports
into `run.sh` (`spawn/config.ts:63-66`;
`spawn/backends/microsandbox.ts:147-166`); and `spawn_kill`'s description suggests
tmux windows remain, while explicit tmux kill removes the window
(`spawn/index.ts:306-310`; `spawn/backends/tmux.ts:213-217`).

## 8. Test coverage and gaps

`spawn/test.ts` is network- and process-free, using fake `ExecFn`/detach effects
and real temporary directories (`spawn/test.ts:1-120`; `spawn/README.md:188-197`).
Covered behavior is:

- status derivation, terminal classification, safe naming, registry round-trip
  and corrupt/missing fallback, local marker race, and log/error tails
  (`spawn/test.ts:122-260`);
- public pi argv, POSIX shell quoting, and environment filtering
  (`spawn/test.ts:262-313`);
- tmux script/barrier ordering, serialized session/window creation, environment
  forwarding, prebuilt internal command, marker/pane refresh, and kill
  (`spawn/test.ts:315-491`);
- exe.dev command builders, VM-list shapes, existing/create/no-auto-create paths,
  SSH readiness, public HOME versus internal cwd script, status, and transient
  network failure (`spawn/test.ts:493-704`);
- microsandbox mounts/resources/script, detached launch, marker transition and
  one-time cleanup, and kill calls (`spawn/test.ts:706-846`);
- synchronous adapter launch/registry/output streaming, parent PID, failed-child
  stderr, unlabeled fallback, stale-prefix cleanup, and abort kill/stamp
  (`spawn/test.ts:848-1081`);
- basic JSON and environment config source selection and invalid backend rejection
  (`spawn/test.ts:1083-1130`).

Fleet separately tests command/result parsing, concurrency, timeout/abort,
worktrees, events, and its legacy (not production-wired) tmux mirror with fake
spawn (`fleet/test.ts:195-299,301-558,560-751`). Critic tests prompt/result logic,
and orchestrator tests a fake scheduler/DAG; neither exercises a real spawn
backend (`critic/test.ts:32-214`; `orchestrator/test.ts:72-343`).

Important gaps:

- no extension-level tests instantiate `spawn/index.ts`; schemas, public tool
  abort behavior, prompt injection, `/spawn`, concurrent tool calls, and details
  payloads are unverified;
- no real tmux/SSH/exe.dev/msb/pi test, no restart/cross-session test, and no
  fleet -> `createHostSpawn` -> backend -> real JSONL end-to-end test;
- no registry multi-adapter/process race, launch-before-save crash, temp-file
  contention, corruption reconstruction, migration/version, retention, or
  malicious-record validation test;
- no test for delayed mount visibility, false/permanent `lost`, PID reuse,
  malformed/forged markers, unexpected exe.dev probe output, unreachable remote
  kill, kill confirmation/escalation, or an abort during availability/launch/
  refresh/output;
- no large/growing-output cost, output shrink/rotation duplicate, UTF-8 tail split,
  missing remote log, or adapter replay/cursor test;
- no capability/readiness, workspace parity/transfer, secret-at-rest permissions,
  artifact collection, or sandbox boundary test.

The package test script runs only `tsx --test test.ts`; there is no package
`typecheck` script or root aggregate test script (`spawn/package.json:6-18`;
`package.json:1-43`).

## 9. Audit conclusion

The current system has strong pragmatic invariants: detached durability, three
placement choices, injected test seams, separate stderr, marker-after-log
publication, a local marker race reread, and parent-aware stale cleanup. Its
synchronous adapter successfully reuses those backends without changing fleet's
command-level result contract.

It is not backend-neutral agent orchestration. Completion and results are inferred
by repeatedly trusting mutable files, PIDs, SSH shell probes, and reparsed logs;
shared persistence is not concurrency-safe; cancellation is unverified;
capabilities/workspaces/artifacts are implicit; and restart recovery kills or
requires manual polling rather than reattaching to a typed durable run. Those are
the boundaries a later architecture must replace without regressing section 7.
