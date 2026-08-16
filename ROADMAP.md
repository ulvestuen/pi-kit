# pi-kit Roadmap

**Guiding principle: every skill, process, and piece of tooling in this
repository should be simple and visually understandable.** A newcomer should
grasp what a component does from one diagram and a short page of prose — and
anything that can't be explained that way is a candidate for simplification,
not more documentation.

## Where the project is today

pi-kit is a small toolkit for the `pi` agent: six plain skills and one
extension, all zero-dependency Node scripts verified by `npm test` from the
repository root.

```mermaid
flowchart LR
    subgraph pikit["pi-kit"]
        direction TB
        subgraph skills["skills/ (plain skills)"]
            search["exa-search / kagi-search<br/>web search CLIs"]
            trackers["jira / linear<br/>issue-tracker CLIs"]
            subagents["subagents<br/>delegate to pi child processes"]
            pdca["pdca<br/>quality loop (diagram-driven)"]
        end
        subgraph ext["threema/ (extension)"]
            threema["send + receive<br/>Threema messages"]
        end
    end
    pi(("pi agent")) --> skills
    pi --> ext
```

### Review snapshot (August 2026)

What already matches the principle, and what doesn't yet:

| Area | State | Verdict |
| --- | --- | --- |
| Zero-dependency skill scripts | Each skill is one `SKILL.md` + one small `.mjs` | ✅ Simple |
| PDCA skill | Entire process carried by a single SVG diagram | ✅ The model to copy |
| Test story | One `npm test` at the root runs everything | ✅ Simple |
| Skill docs | Every skill has a diagram and follows the shared template | ✅ Visual |
| Subagents skill | One tested helper owns the Herdr tab lifecycle | ✅ Simple |
| README | Architecture and configuration health are visible at a glance | ✅ Visual |
| CI | GitHub Actions runs the root test command on pushes and pull requests | ✅ Automated |
| Test coverage | Exa request shaping and the Threema webhook flow have focused tests | ✅ Even |

## Implementation plan

The roadmap is implemented in five reviewable workstreams. Each workstream has
one owner, a concrete acceptance check, and no build or runtime dependency.

| Workstream | Implementation | Acceptance |
| --- | --- | --- |
| Visual foundation | Put the repo map in `README.md`; add a small flow diagram to each skill; add outbound and inbound sequences to `threema/README.md`; define `skills/TEMPLATE.md` | A visitor can identify every component and its data flow before reading commands |
| Sub-agent simplification | Move Herdr tab creation, streaming, result capture, and cleanup into `run-in-herdr-tab.sh`; replace the prose recipe and patterns list with two diagrams | A focused test proves IDs are parsed, output stays clean, and the temporary tab is closed |
| CLI consistency | Standardize search docs and flags on `--limit` and `--json`; retain Exa's `--num` as a compatibility alias; isolate and test Exa request shaping | Learning either search skill transfers directly to the other without breaking old Exa calls |
| Safety net | Run all focused tests from root `npm test`; add a Node 22 GitHub Actions job for pushes and pull requests; exercise the real Threema webhook boundary | Local and CI verification use exactly the same command |
| Controlled growth | Add `skills/doctor.mjs` for a value-free environment status table; require future skills to use the template, one script, one test, and zero runtime dependencies | `node skills/doctor.mjs` gives an at-a-glance status and the template defines the admission gate |

## The plan

Three phases, ordered so that the visual foundation lands first, then the
simplifications it exposes, then growth on top of the settled patterns.

```mermaid
flowchart LR
    now["Phase 1 · Now<br/>Make it visual"] --> next["Phase 2 · Next<br/>Make it simpler"] --> later["Phase 3 · Later<br/>Grow carefully"]
```

### Phase 1 — Make it visual

Goal: every component explains itself with a diagram, the way PDCA already
does.

- [x] **Repo map in the README.** Add the architecture diagram above (or a
      refined version) to `README.md` so the first thing a visitor sees is the
      shape of the project, not a link list.
- [x] **One diagram per skill.** Give each `SKILL.md` a small Mermaid diagram
      at the top: the search and tracker skills get a three-node
      `env vars → CLI → API` strip; `subagents` gets a flow showing
      orchestrator → role → result.
- [x] **Threema message-flow diagram.** `threema/README.md` is thorough but
      300 lines of prose; add one sequence diagram for outbound send and one
      for the inbound webhook path (Gateway → MAC check → allowlist →
      decrypt → pi), then trim prose the diagrams make redundant.
- [x] **Standard skill template.** Write a short `skills/TEMPLATE.md` fixing
      the common shape: frontmatter, diagram, configuration table, commands,
      safety notes. New and existing skills converge on it.

### Phase 2 — Make it simpler

Goal: remove the places where following the docs requires careful multi-step
reading.

- [x] **Script the Herdr procedure.** Replace the 6-step manual tab recipe in
      `skills/subagents/SKILL.md` with a small helper (e.g.
      `run-in-herdr-tab.sh`) so the skill doc shrinks to "inside Herdr, run
      this instead" plus one diagram. Cover it with a test alongside
      `run-subagent.test.mjs`.
- [x] **Add CI.** One GitHub Actions workflow that runs `npm test` on pushes
      and pull requests — a green check is the simplest possible status
      visualization.
- [x] **Even out test coverage.** Add a request-shaping test for
      `exa-search.mjs` (mirroring `kagi-search-request.test.mjs`) so every
      skill script has at least one focused test.
- [x] **Align the search skills.** `exa-search` and `kagi-search` should share
      identical doc structure and flag conventions (`--json`, limits, error
      handling) so learning one means knowing both.

### Phase 3 — Grow carefully

Goal: add capability only where it keeps the one-diagram, one-page property.

- [x] **Skill health check.** A tiny `doctor` script that reports, per skill,
      whether its required environment variables are set — one table, at a
      glance.
- [x] **New skills on the template.** Candidate integrations (e.g. GitHub
      issues, calendar) enter only via the Phase 1 template: diagram first,
      one script, one test, zero dependencies.
- [x] **Sub-agent role diagram.** A single picture of how the five roles
      (scout, planner, implementer, critic, auditor) compose into the
      plan → implement → review pattern, replacing the prose "Patterns"
      section.

## What we deliberately won't do

Simplicity is also about refusal:

- No build step — the repo stays runnable-as-checked-out.
- No runtime dependencies in skills — each stays a single copyable script.
- No frameworks or generators for docs — Markdown plus Mermaid, rendered by
  GitHub, is the whole toolchain.
- No skill whose behavior can't be captured in one diagram and one page.

## Definition of done, per component

```mermaid
flowchart TD
    q1{"Explained by<br/>one diagram?"} -- no --> fix1["Simplify or diagram it"]
    q1 -- yes --> q2{"One page<br/>of prose?"}
    q2 -- no --> fix2["Cut prose the<br/>diagram covers"]
    q2 -- yes --> q3{"Tested by<br/>npm test?"}
    q3 -- no --> fix3["Add a focused test"]
    q3 -- yes --> done(["✅ Meets the bar"])
```

Progress is tracked by checking off the items above; a phase is finished when
its boxes are ticked and each touched component passes the definition of done.
