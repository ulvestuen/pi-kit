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
4. **DECIDE** — call `lykkja_checkpoint`. On ITERATING, fix the weakest criterion
   first and loop again. On FINAL, stop and summarize.

Project-specific bars (edit for your repo):

- `all tests pass` — run `npm test` (or your suite); threshold 10, never regress.
- `no type errors` — run the type-checker; threshold 10.
- `no lint warnings` — run the linter; threshold 9.
- <!-- add your own: performance budgets, accessibility, API surface, etc. -->

Do not declare a task done until every criterion meets its threshold. Do not
inflate a score to end the loop. If something is ambiguous, make a sensible
assumption, note it, and keep going rather than stopping to ask.

Quick start: `/lykkja-run <task>` opens and runs a loop end to end. `/lykkja`
shows the live dashboard.
