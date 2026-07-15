# pi-kit

This repository contains pi-related integrations and extensions.

## Contents

### Core packages

- [`agent-types/`](./agent-types/) – agent-native execution contracts (zero-dep types: `RunId`, `ArtifactRef`, `AgentTask`, `AgentResult`, `BackendCapabilities`, `KillResult`, `RunEvent`)
- [`lykkja/`](./lykkja/) – loop-based agentic development framework for pi (a Plan-Do-Check-Act self-checking loop with tools, skills, and a single `/lykkja` command)
- [`fleet/`](./fleet/) – sub-agent runtime for pi (run concurrent child `pi` processes with per-agent role prompts, models, and tool restrictions; the `fleet_run` tool and `/fleet` command)
- [`planner/`](./planner/) – plans as data for pi (a validated task DAG with per-task acceptance criteria; the `plan_create`/`plan_update` tools and `/plan` dashboard)
- [`critic/`](./critic/) – independent advisor/reviewer for pi (fresh-context read-only review with the `critic_review`/`critic_advise` tools and `/critic` command)
- [`orchestrator/`](./orchestrator/) – thin multi-agent composition layer for pi (`/orchestrate` drives planner + fleet + critic inside a lykkja loop)
- [`spawn/`](./spawn/) – detached sub-agent jobs for pi (launch child `pi` processes as background jobs in tmux windows, on [exe.dev](https://exe.dev) cloud VMs, or in [microsandbox](https://microsandbox.dev) microVMs; the `spawn_agent`/`spawn_jobs`/`spawn_output`/`spawn_kill` tools and `/spawn` command)

### Integrations

- [`threema/`](./threema/) – Threema integration for pi
- [`exa/`](./exa/) – Exa web search extension for pi (adds the `exa_search` tool and `/exa` status command)
- [`kagi/`](./kagi/) – Kagi web search extension for pi (adds the `kagi_search` tool and `/kagi` status command)

## Design documents

- [`docs/multi-agent-orchestration.md`](./docs/multi-agent-orchestration.md) – design for the orchestrator, planner, critic, and sub-agent fleet extensions composed with lykkja (implemented by `fleet/`, `planner/`, `critic/`, and `orchestrator/`)

## Architecture documents

- [`docs/agent-native-architecture.md`](./docs/agent-native-architecture.md) – ADR: agent-native orchestration architecture (SHOT — Structured Handoff on existing transport)
- [`docs/micro-vave-execution-model.md`](./docs/micro-vave-execution-model.md) – how task orchestration, sub-agent spawning, and the PDCA loop implement the Micro-V'ave execution model: scope slices descending micro V-models in parallel stacks, waves along the time axis, and verified product chunks out
- [`docs/orchestrator-architecture.md`](./docs/orchestrator-architecture.md) – how an orchestration run works end to end: the goal loop, dispatch waves, the scheduler state machine, the critic gate, retries, merges, and failure recovery — with workflow diagrams
- [`docs/fleet-architecture.md`](./docs/fleet-architecture.md) – how the sub-agent runtime works: agent discovery, the concurrency pool, the child-process contract, worktree isolation, timeouts and kill semantics, and spawn backend execution — with workflow diagrams
- [`docs/agent-native-final-acceptance.md`](./docs/agent-native-final-acceptance.md) – final branch acceptance: ADR traceability, test evidence, public API, migration, and scoped file inventory

## Documentation

The top-level README is intentionally minimal.

For installation, configuration, usage, and troubleshooting, see the README inside the relevant child directory:

- [`lykkja/README.md`](./lykkja/README.md)
- [`fleet/README.md`](./fleet/README.md)
- [`planner/README.md`](./planner/README.md)
- [`critic/README.md`](./critic/README.md)
- [`orchestrator/README.md`](./orchestrator/README.md)
- [`spawn/README.md`](./spawn/README.md)
- [`threema/README.md`](./threema/README.md)
- [`exa/README.md`](./exa/README.md)
- [`kagi/README.md`](./kagi/README.md)
