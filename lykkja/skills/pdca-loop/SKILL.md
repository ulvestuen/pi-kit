---
name: pdca-loop
description: Run the lykkja Plan-Do-Check-Act self-checking loop to drive a task to an explicit quality bar. Use when the work should be iterated to strict, measurable success criteria rather than produced in a single shot — building a feature to spec, fixing a flaky behaviour, refactoring to a standard, or writing something that must clear a checklist.
---

# The lykkja loop (Plan-Do-Check-Act)

lykkja drives a task to a strict, explicit bar by looping. It combines the
Plan-Do-Check-Act cycle from systems engineering with a brutally honest
self-scoring protocol. You run the loop yourself; the `lykkja_start` and
`lykkja_checkpoint` tools keep the score and tell you when to stop.

## When to use this

Use the loop when "done" is defined by a bar you can check, and one pass is
unlikely to clear it:

- implement a feature against a specification or acceptance criteria
- fix a bug until a failing test passes and nothing else regresses
- refactor code to a standard (no type errors, no lint warnings, smaller API)
- write a document, config, or schema that must satisfy a checklist

Do **not** spin up a loop for trivial, single-step tasks. The overhead only
pays off when iteration and an explicit bar add value.

## The protocol

### 0. Open the loop

State the task precisely, then choose strict success criteria. Call
`lykkja_start` with the task and criteria. See the `success-criteria` skill for
how to write criteria that can be scored honestly. Default pass bar is 8/10;
override per criterion when something must be stronger or is allowed to be
weaker.

### Each pass, repeat:

1. **PLAN** — State the single next step. One step, not a plan for the whole
   task. On the first pass this is usually "produce a first version"; afterward
   it is "fix the weakest criterion from the last check."
2. **DO** — Produce or improve the work. Make the change for this step only.
3. **CHECK** — Score the result on every criterion, 1 to 10, honestly. List
   exactly what is still weak for anything below its threshold. See the
   `honest-verification` skill.
4. **DECIDE** — Call `lykkja_checkpoint` with the step (PLAN), what changed
   (DO), and the scores (CHECK). The tool returns the verdict:
   - **FINAL** — every criterion met its threshold. Stop. State that the bar is
     met and summarize the result.
   - **ITERATING** — at least one criterion is below its threshold. The tool
     names the weakest one. Fix that first, then run another pass.
   - **STOPPED** — the loop hit its safety limit on passes without clearing the
     bar. Stop and report honestly which criteria are still failing and why,
     rather than declaring success.

## Rules

- Never call it done until every criterion is at or above its threshold. No soft
  passes.
- Each pass must target the weakest criterion from the previous check first.
- Score honestly. Inflating a score to escape the loop defeats the entire
  point and produces work that silently misses the bar.
- Do not stall waiting for the user. If something is ambiguous, make a sensible
  assumption, record it in the DO summary or `changes`, and keep looping.
- Keep PLAN to a single step. If you find yourself listing several steps, the
  step is too big — pick the first one.

## Worked example

Task: "Add a `parseDuration(str)` helper that turns `'1h30m'` into seconds."

Criteria via `lykkja_start`:
- `parses compound units` (h/m/s combined), threshold 8
- `rejects invalid input` with a clear error, threshold 8
- `unit tests cover edge cases` (empty, zero, overflow), threshold 8

- Pass 1 — PLAN: write a first version + happy-path tests. DO: regex parse,
  three tests. CHECK: parses compound 8, rejects invalid 4 (silently returns
  NaN), tests 6 (no edge cases). `lykkja_checkpoint` → ITERATING, weakest
  "rejects invalid input".
- Pass 2 — PLAN: fix invalid-input handling. DO: throw on unmatched input, add
  tests for it. CHECK: parses 8, rejects 8, tests 7 (still no overflow test).
  → ITERATING, weakest "unit tests cover edge cases".
- Pass 3 — PLAN: add empty/zero/overflow tests. DO: three more tests, fix the
  overflow they exposed. CHECK: 9 / 9 / 9. → FINAL. Stop.

## Related

- `success-criteria` — how to write strict, measurable criteria.
- `honest-verification` — how to score 1-10 without fooling yourself.
- `/lykkja-run`, `/lykkja-plan`, `/lykkja-verify`, `/lykkja-ship` — slash
  commands that drive these phases. Run `/lykkja` to see the live dashboard.
