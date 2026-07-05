# pi-kit

This repository contains pi-related integrations and extensions.

## Contents

- [`lykkja/`](./lykkja/) – loop-based agentic development framework for pi (a Plan-Do-Check-Act self-checking loop with tools, skills, and a single `/lykkja` command)
- [`threema/`](./threema/) – Threema integration for pi
- [`exa/`](./exa/) – Exa web search extension for pi (adds the `exa_search` tool and `/exa` status command)
- [`kagi/`](./kagi/) – Kagi web search extension for pi (adds the `kagi_search` tool and `/kagi` status command)

## Design documents

- [`docs/multi-agent-orchestration.md`](./docs/multi-agent-orchestration.md) – design for orchestrator, planner, critic, and sub-agent fleet extensions composed with lykkja

## Documentation

The top-level README is intentionally minimal.

For installation, configuration, usage, and troubleshooting, see the README inside the relevant child directory:

- [`lykkja/README.md`](./lykkja/README.md)
- [`threema/README.md`](./threema/README.md)
- [`exa/README.md`](./exa/README.md)
- [`kagi/README.md`](./kagi/README.md)
