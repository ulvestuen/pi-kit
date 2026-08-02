# pi-kit

This repository contains pi-related integrations and extensions.

## Verification

Run every workspace test suite from the repository root:

```sh
npm test
npm run verify
```

Both commands run the same real workspace verification. The repository has no
build artifacts, so it intentionally does not define a `build` script.

Orchestrator command checks belong in each project's plan. The legacy
`integrationCheck` setting is project-specific compatibility configuration;
do not install a global default such as `npm run build`, because projects have
different verification commands and this repository has no build command.

## Contents

### Core packages

- [`agent-types/`](./agent-types/) – shared agent definitions and execution contracts (`RunId`, `ArtifactRef`, `AgentTask`, `AgentResult`, process requests/results, and `RunEvent`)
- [`pdca/`](./pdca/) – loop-based agentic development framework for pi (a Plan-Do-Check-Act self-checking loop with tools, skills, and a single `/pdca` command)
- [`fleet/`](./fleet/) – sub-agent runtime for pi (run concurrent child `pi` processes with per-agent role prompts, models, and tool restrictions; the `fleet_run` tool and `/fleet` command)
- [`planner/`](./planner/) – plans as data for pi (a validated task DAG with per-task acceptance criteria; the `plan_create`/`plan_update` tools and `/plan` dashboard)
- [`critic/`](./critic/) – independent advisor/reviewer for pi (fresh-context read-only review with the `critic_review`/`critic_advise` tools and `/critic` command)
- [`orchestrator/`](./orchestrator/) – deterministic multi-agent composition layer for pi (`/orchestrate` drives typed task pipelines and final verification; PDCA remains an optional compatibility control mode)

### Integrations

- [`threema/`](./threema/) – Threema integration for pi
- [`exa/`](./exa/) – Exa web search extension for pi (adds the `exa_search` tool and `/exa` status command)
- [`kagi/`](./kagi/) – Kagi web search extension for pi (adds the `kagi_search` tool and `/kagi` status command)

## Design documents

- [`docs/multi-agent-orchestration.md`](./docs/multi-agent-orchestration.md) – design for the orchestrator, planner, critic, and sub-agent fleet extensions composed with pdca (implemented by `fleet/`, `planner/`, `critic/`, and `orchestrator/`)

## Architecture documents

- [`docs/micro-vave-execution-model.md`](./docs/micro-vave-execution-model.md) – how task orchestration, direct child agents, verification, and optional PDCA control implement the Micro-V'ave model
- [`docs/orchestrator-architecture.md`](./docs/orchestrator-architecture.md) – how controller pipelines, checks, review, artifacts, state, and recovery work end to end
- [`docs/fleet-architecture.md`](./docs/fleet-architecture.md) – how the sub-agent runtime works: agent discovery, direct child processes, concurrency, worktree isolation, timeouts, cancellation, and output handling

## Documentation

The top-level README is intentionally minimal.

For installation, configuration, usage, and troubleshooting, see the README inside the relevant child directory:

- [`pdca/README.md`](./pdca/README.md)
- [`fleet/README.md`](./fleet/README.md)
- [`planner/README.md`](./planner/README.md)
- [`critic/README.md`](./critic/README.md)
- [`orchestrator/README.md`](./orchestrator/README.md)
- [`threema/README.md`](./threema/README.md)
- [`exa/README.md`](./exa/README.md)
- [`kagi/README.md`](./kagi/README.md)
