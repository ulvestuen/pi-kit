# pi-orchestrator

Deterministic multi-agent execution of planner task DAGs. `/orchestrate <goal>` asks the model to create or revise a plan and then calls `orchestrate_run`; only `plan_create` and `plan_update` are required.

`orchestrate_step` drains ready work, dynamically launching dependents in the same call. The default `pipelineMode: "per-task"` applies `maxConcurrent` to complete implement → task checks → optional evidence → optional critic review pipelines. Reviews are disabled with `reviewMode: "none"`; evidence is opt-in. A failed check never invokes the critic, and critic output is never rerun.

`orchestrate_run` uses the same controller and continues to `verified`, `tasks_complete_needs_merge`, `blocked`, `stopped`, or `budget_exhausted`. Plan `finalChecks` run once after all tasks. The deprecated `integrationCheck` is used once through `sh -c` only when no final checks exist.

State is persisted as authoritative `orchestrator-state-v2` snapshots. Plans remain editable while the run is still in its undispatched `planning` state, then become read-only Planner projections after execution starts. Restart restores V2 first, otherwise migrates the latest legacy planner snapshot. In-flight tasks are requeued without incrementing attempts until actually relaunched, and interrupted final checks restart from `not_started`. Session startup calls the Fleet host runtime cleanup. `executionMode: "local"` is synchronous and does not initialize Spawn; set it to `"spawn"` explicitly for Spawn-backed execution. During the compatibility period, local mode warns when an explicit Spawn configuration is being ignored.

Important configuration defaults: `executionMode: "local"`, `pipelineMode: "per-task"`, `controlMode: "deterministic"`, `reviewMode: "critic"`, `planReview: false`, `maxConcurrent: 4`, `maxAttempts: 1`, and `verboseDetails: false`. `controlMode: "pdca"` restores parent-driven goal checkpoints, while `pipelineMode: "barrier"` is the rollback mode: every implementation in a bounded wave finishes before checks, and every check/evidence phase finishes before reviews begin.
