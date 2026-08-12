# pi-kit

This repository contains pi-related integrations and skills.

## Verification

Run every workspace test suite from the repository root:

```sh
npm test
npm run verify
```

Both commands run the same real workspace verification. The repository has no
build artifacts, so it intentionally does not define a `build` script.

## Contents

### Extensions

- [`threema/`](./threema/) – Threema integration for pi

### Skills

Plain skills under [`skills/`](./skills/) — each is a `SKILL.md` plus, where
useful, a zero-dependency Node script the agent runs from the shell:

- [`skills/exa-search/`](./skills/exa-search/) – web search via the Exa API (`exa-search.mjs`, needs `EXA_API_KEY`)
- [`skills/jira/`](./skills/jira/) – Jira Cloud and Server/Data Center issue management via a zero-dependency CLI (`jira.mjs`, needs `JIRA_BASE_URL` and `JIRA_AUTH_TOKEN`)
- [`skills/kagi-search/`](./skills/kagi-search/) – web search via the Kagi API (`kagi-search.mjs`, needs `KAGI_API_KEY`)
- [`skills/linear/`](./skills/linear/) – read and manage Linear issues through its GraphQL API (`linear.mjs`, needs `LINEAR_API_KEY`)
- [`skills/subagents/`](./skills/subagents/) – delegate focused work to isolated `pi` child processes with role prompts (scout, planner, implementer, critic, auditor) via `run-subagent.mjs`
- [`skills/pdca/`](./skills/pdca/) – the Plan-Do-Check-Act quality loop, described by a single diagram

## Documentation

For installation, configuration, usage, and troubleshooting of the Threema
integration, see [`threema/README.md`](./threema/README.md).
