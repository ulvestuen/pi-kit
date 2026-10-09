# pi-kit

This repository contains pi-related integrations and skills.

See [`ROADMAP.md`](./ROADMAP.md) for the project direction: keeping every
skill, process, and piece of tooling simple and visually understandable.

```text
Pi agent
├─ skills/       search · issue trackers · canvas · orchestration · PDCA
├─ subagents/    extension → fresh SDK sessions → live progress + results
└─ threema/      extension → send + receive messages
```

## Opt into the coding baseline

[`CODING.md`](./CODING.md) is a short reusable policy for investigating,
implementing, and verifying coding tasks. [`AGENTS.md`](./AGENTS.md) adds facts
and check commands for working on pi-kit itself. Neither is installed into
your personal configuration by `pi install`; no companion skill is required.

To use the baseline in every project on the machine where you run Pi:

1. Review `CODING.md` and your existing global instructions. Pi's agent
   directory defaults to `~/.pi/agent/`, or `PI_CODING_AGENT_DIR` when set.
2. Merge the policy text once into the active context file there, normally
   `AGENTS.md`, preserving existing instructions and resolving contradictions.
   Pi selects the first existing file per directory in this order:
   `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`.
   Edit the active file instead of creating one that shadows existing rules.
   If none exists, create `AGENTS.md`. Copy the policy text, not just a link,
   so it is included at startup rather than requiring a later file read.
3. Keep project architecture and exact verification commands in each project's
   own context file. Do not copy pi-kit's commands into unrelated projects.
4. Start a fresh `pi --verbose` session and check that the startup header lists
   the intended instruction files. Use `/reload` after later edits. For deeper
   inspection after a turn, `/debug` saves session messages in the agent
   directory's `pi-debug.log`; keep that file private and inspect its system
   messages for the policy. Do not use `/share` for this check.

Use context instructions rather than replacing `SYSTEM.md`: replacement
prompts bypass Pi's normal base/tool guidance. No model setting or global file
is changed by this repository. To opt out, remove only the policy section you
added, preserve your other instructions, and reload or start a fresh session.
See Pi's [configuration](https://pi.dev/docs/latest/configuration) and
[terminal usage](https://pi.dev/docs/latest/usage) documentation.

### Check whether it helps

Compare a reproducible bug fix, a small feature following an existing pattern,
and a review with a known defect. Use fresh sessions and separate disposable
checkouts from the same starting state. Keep the provider/model and thinking
level fixed between the current setup and the revised one; change one thing
at a time. Record accepted behavior, defects, corrective prompts, elapsed time,
and reported usage/cost. Keep session traces local and repeat surprising results.
Fixture tests verify the harness contracts, not real-model coding quality.

## Verification

Run every workspace test suite from the repository root:

```sh
npm test
npm run verify
```

Both commands run the same real workspace verification. The repository has no
build artifacts, so it intentionally does not define a `build` script.

Check skill configuration without exposing any values:

```sh
node skills/doctor.mjs
```

## Contents

### Extensions

The extensions target Pi **1.1.0+** using the `@earendil-works` SDK packages.

- [`threema/`](./threema/) – Threema integration for pi
- [`subagents/`](./subagents/) – standalone Pi SDK delegation with five roles, live progress, bounded parallelism, and cancellation; no Herdr or shell launcher

### Skills

Plain skills under [`skills/`](./skills/) — each is a `SKILL.md` plus, where
useful, a zero-dependency Node script the agent runs from the shell:

- [`skills/exa-search/`](./skills/exa-search/) – web search via the Exa API (`exa-search.mjs`, needs `EXA_API_KEY`)
- [`skills/grafana-logs/`](./skills/grafana-logs/) – search Grafana Cloud Loki logs through the hosted MCP server; bundled Node.js proxy with OAuth browser login, PKCE, and automatic token refresh; no `gcx` required
- [`skills/grafana-metrics/`](./skills/grafana-metrics/) – discover and query Grafana Cloud Prometheus metrics through its bundled read-only MCP proxy, sharing the OAuth login with the logs skill
- [`skills/jira/`](./skills/jira/) – Jira Cloud issue management with scoped or unscoped API tokens via a zero-dependency CLI (`jira.mjs`, needs `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_AUTH_TOKEN`)
- [`skills/kagi-search/`](./skills/kagi-search/) – web search via the Kagi API (`kagi-search.mjs`, needs `KAGI_API_KEY`)
- [`skills/cloudwatch-logs/`](./skills/cloudwatch-logs/) – look up AWS CloudWatch Logs and run Logs Insights queries directly with an installed, pre-authenticated AWS CLI; no additional credentials or scripts
- [`skills/tldraw-offline/`](./skills/tldraw-offline/) – inspect, edit, lint, and script open tldraw Desktop canvases through the local agent API (`tq.mjs` handles per-launch discovery and authentication)
- [`skills/orchestrate/`](./skills/orchestrate/) – outcome-first workflow with task dependencies, user checkpoints, bounded delegation, and acceptance, regression, and scope audits; load with `/skill:orchestrate`
- [`skills/pdca/`](./skills/pdca/) – the Plan-Do-Check-Act quality loop, described by a single diagram
- [`skills/using-jev/`](./skills/using-jev/) – make TypeSafe JEV API requests for yes/no probabilities, choices, and scores (`jev.mjs`, needs `TYPESAFE_API_KEY`)

Each Grafana skill includes its own `grafana.mjs` and test file directly in
[`grafana-logs/`](./skills/grafana-logs/) or
[`grafana-metrics/`](./skills/grafana-metrics/) (Node.js 22+, no dependencies).
Either directory can be copied and used independently. The duplicated scripts
use the same credential cache, so one login serves both. From the repository root:

```sh
node skills/grafana-logs/grafana.mjs login
node skills/grafana-logs/grafana.mjs tools query_loki_logs
node skills/grafana-metrics/grafana.mjs tools query_prometheus
```

Set `GRAFANA_URL` to your HTTPS stack origin if desired. For remote-shell login,
follow the [manual OAuth flow](./skills/grafana-logs/SKILL.md#configuration-and-login).
Credentials stay outside the repository; `node skills/grafana-logs/grafana.mjs status`
checks their local status. The environment doctor does not check OAuth logins.

New skills start from [`skills/TEMPLATE.md`](./skills/TEMPLATE.md): diagram
first, one page of prose, one script and focused test when code is needed, and
no runtime dependencies.

## Documentation

For installation, configuration, usage, and troubleshooting of the Threema
integration, see [`threema/README.md`](./threema/README.md).
