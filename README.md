# pi-kit

This repository contains pi-related integrations and extensions.

## Contents

- [`lykkja/`](./lykkja/) – loop-based agentic development framework for pi (a Plan-Do-Check-Act self-checking loop with tools, skills, and a single `/lykkja` command)
- [`fleet/`](./fleet/) – sub-agent runtime for pi (run concurrent child `pi` processes with per-agent role prompts, models, and tool restrictions; the `fleet_run` tool and `/fleet` command)
- [`planner/`](./planner/) – plans as data for pi (a validated task DAG with per-task acceptance criteria; the `plan_create`/`plan_update` tools and `/plan` dashboard)
- [`critic/`](./critic/) – independent advisor/reviewer for pi (fresh-context read-only review with the `critic_review`/`critic_advise` tools and `/critic` command)
- [`orchestrator/`](./orchestrator/) – thin multi-agent composition layer for pi (`/orchestrate` drives planner + fleet + critic inside a lykkja loop)
- [`threema/`](./threema/) – Threema integration for pi
- [`exa/`](./exa/) – Exa web search extension for pi (adds the `exa_search` tool and `/exa` status command)
- [`kagi/`](./kagi/) – Kagi web search extension for pi (adds the `kagi_search` tool and `/kagi` status command)

## Design documents

- [`docs/multi-agent-orchestration.md`](./docs/multi-agent-orchestration.md) – design for the orchestrator, planner, critic, and sub-agent fleet extensions composed with lykkja (implemented by `fleet/`, `planner/`, `critic/`, and `orchestrator/`)

## Documentation

The top-level README is intentionally minimal.

For installation, configuration, usage, and troubleshooting, see the README inside the relevant child directory:

- [`lykkja/README.md`](./lykkja/README.md)
- [`fleet/README.md`](./fleet/README.md)
- [`planner/README.md`](./planner/README.md)
- [`critic/README.md`](./critic/README.md)
- [`orchestrator/README.md`](./orchestrator/README.md)
- [`threema/README.md`](./threema/README.md)
- [`exa/README.md`](./exa/README.md)
- [`kagi/README.md`](./kagi/README.md)
