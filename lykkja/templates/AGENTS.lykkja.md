<!--
  lykkja project instructions snippet.

  Paste this block into your project's AGENTS.md (which the pi coding agent
  loads automatically) to make loop-based, bar-driven work the default for this
  repository. Trim it to taste. The lykkja extension already injects a short
  version of this into the system prompt; this snippet is for teams that want to
  make the discipline explicit and project-specific.
-->

## Working style: lykkja loop

For any task with a checkable quality bar — building a feature to spec, fixing a
bug until tests pass, refactoring to a standard — drive it with the lykkja
Plan-Do-Check-Act loop instead of a single shot.

1. **PLAN** — restate the task precisely and define 3-6 strict, measurable
   success criteria. Open the loop with `lykkja_start`. (Skill: `success-criteria`.)
2. **DO** — make the single next change for this pass.
3. **CHECK** — score every criterion 1-10 against real evidence (run the tests,
   the type-checker, the edge case). Be brutally honest. (Skill: `honest-verification`.)
4. **ACT** — call `lykkja_checkpoint`. Follow the returned AUTOMATED prompt:
   on ITERATING, immediately fix the weakest criterion first and loop again; on
   FINAL, stop and summarize; on STOPPED, report the remaining failures.

Project-specific bars (edit for your repo):

- `all tests pass` — run `npm test` (or your suite); threshold 10, never regress.
- `no type errors` — run the type-checker; threshold 10.
- `no lint warnings` — run the linter; threshold 9.
- <!-- add your own: performance budgets, accessibility, API surface, etc. -->

Do not declare a task done until every criterion meets its threshold. Do not
inflate a score to end the loop. Do not wait for the user between PDCA phases
unless they explicitly asked for a pause. If something is ambiguous, make a
sensible assumption, note it, and keep going rather than stopping to ask.

Quick start: `/lykkja <task>` opens and runs a loop end to end. Bare `/lykkja`
shows the live dashboard.
