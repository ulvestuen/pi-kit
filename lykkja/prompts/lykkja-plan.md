---
description: Run the PLAN step of the lykkja loop — frame the task and define strict success criteria
argument-hint: [task description]
---

Run the **PLAN** step of a lykkja loop.

TASK (if empty, use the task already in context):
$ARGUMENTS

Do only the planning, not the work:

1. State exactly what should be produced, in one precise sentence.
2. Surface the key assumptions and constraints. Where something is ambiguous,
   choose a sensible default and note it rather than asking.
3. Define **3-6 strict, measurable success criteria** following the
   `success-criteria` skill. For each, give a one-line reason it is checkable and
   a threshold (default 8/10; raise for must-not-regress properties).
4. Name the single next step you would take on the first pass.

Then call `lykkja_start` with the task and criteria so the loop is opened, and
stop. Do not begin implementing yet — wait for the DO/CHECK passes (or
`/lykkja-verify`).
