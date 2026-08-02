# Pi-kit efficiency implementation progress

- [x] Phase 1: truthful root verification, documentation, baseline instrumentation
  - [x] Add root `test` and `verify` scripts
  - [x] Document project-specific `integrationCheck` (no invalid global config was present)
  - [x] Add orchestration baseline scenarios and metrics
- [x] Phase 2: fast default execution
  - [x] Set one attempt, no default auditor, and 8 KiB visible output
  - [x] Add local/spawn execution mode with local as the default
- [x] Phase 3: isolate Fleet implementer resources
- [x] Phase 4: bounded retries and compact handoffs
  - [x] Keep task descriptions immutable and add bounded attempt feedback
  - [x] Remove automatic unscorable critic reruns
  - [x] Cap handoffs and emit compact v2 orchestration details
- [x] Phase 5: typed deterministic task and final command checks
- [x] Phase 6: per-task orchestration pipelines with bounded concurrency
- [x] Phase 7: deterministic `orchestrate_run` and optional PDCA control
- [x] Phase 8: architecture cleanup
  - [x] Break the Fleet–Spawn dependency cycle with a shared runtime package
  - [x] Persist authoritative Orchestrator V2 run state with legacy migration
  - [x] Refactor the orchestration entry point into readable, named stages
- [x] Update examples and documentation for all changed contracts/defaults
- [x] Run all workspace tests and root verification

## Oracle review remediation

- [x] Keep plans editable during the pre-dispatch `planning` state
- [x] Recover interrupted final checks instead of wedging the run as blocked
- [x] Convert thrown pipeline phases into persisted retry/failure outcomes
- [x] Recover worktrees when interruption occurred before branch creation
- [x] Continue unrelated work while a fan-in task awaits branch integration
- [x] Include deterministic checks and artifact locations in critic evidence
- [x] Reject overlapping orchestration invocations with incompatible semantics
- [x] Restore true barrier pipeline behavior as the rollback mode
- [x] Emit bounded, paired events for successful, failed, and aborted phases
- [x] Complete baseline instrumentation through real controller/runtime seams
- [x] Warn when Spawn configuration is ignored by local execution mode
- [x] Prefer budget exhaustion when unrelated ready work remains beside merge-blocked work
- [x] Prevent dispatch and attempt consumption when abort arrives during readiness checks
- [x] Preserve live attempt starts during run-log trimming and use unique dispatch identities
- [x] Fail fast when barrier mode lacks a barrier pipeline implementation
- [x] Exercise baseline scenarios through the production controller/Fleet runtime factory
- [x] Run focused regression tests, all workspace tests, typechecks, and root verification
