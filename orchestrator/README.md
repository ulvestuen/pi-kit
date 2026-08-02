# pi-orchestrator

Deterministic multi-agent execution of Planner task DAGs. `/orchestrate <goal>`
asks the model to create or revise a structured plan and then calls
`orchestrate_run`; only `plan_create` and `plan_update` are required.

Orchestrator uses Fleet's direct local child-process adapter for implementers,
evidence agents, and critics. There is no execution-runner selector.

## Execution

`orchestrate_step` drains currently ready work and can launch newly ready
dependents in the same call. The default `pipelineMode: "per-task"` applies
`maxConcurrent` to complete pipelines:

```text
implement → task checks → optional evidence → optional critic → commit/artifacts
```

`pipelineMode: "barrier"` retains wave barriers as a compatibility mode.
`reviewMode: "none"` disables semantic critic review; deterministic task checks
still run. Evidence is opt-in.

`orchestrate_run` continues until it reaches `verified`,
`tasks_complete_needs_merge`, `blocked`, `stopped`, or `budget_exhausted`.
Plan `finalChecks` run once after all tasks complete. The deprecated global
`integrationCheck` is used once only when a plan has no final checks.

## State and recovery

Authoritative `orchestrator-state-v2` snapshots persist the plan, active
pipelines, compact outcomes, final checks, and run log. Plans remain editable
until first dispatch and then become read-only Planner projections. Restart
requeues interrupted tasks without charging an attempt that never launched,
and interrupted final checks restart from `not_started`.

## Important defaults

- `pipelineMode: "per-task"`
- `controlMode: "deterministic"`
- `reviewMode: "critic"`
- `planReview: false`
- `maxConcurrent: 4`
- `maxAttempts: 1`
- `isolation: "none"`
- `outputCapBytes: 8192`
- `verboseDetails: false`

`controlMode: "pdca"` remains available for compatibility with parent-driven
goal checkpoints. It does not affect how child processes are launched.

See `orchestrator.example.json` for the complete configuration shape and
[`docs/orchestrator-architecture.md`](../docs/orchestrator-architecture.md)
for the controller and state model.

## Verification

```bash
npm test --workspace pi-orchestrator
```
