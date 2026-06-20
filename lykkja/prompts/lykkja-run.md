---
description: Start and run a lykkja self-checking loop on a task until it meets the bar
argument-hint: <task description>
---

Run a **lykkja self-checking loop** on the following task until it meets the bar.

TASK:
$ARGUMENTS

Follow the `pdca-loop` skill. Concretely:

1. Restate the task in one precise sentence. If it is ambiguous, make a sensible
   assumption, state it, and proceed — do not stop to ask.
2. Define strict, measurable success criteria (use the `success-criteria`
   skill). Then call `lykkja_start` with the task and those criteria.
3. Loop. Each pass: PLAN the single next step, DO it, CHECK every criterion with
   an honest 1-10 score (use the `honest-verification` skill), then call
   `lykkja_checkpoint` with the step, what changed, and the scores.
4. When `lykkja_checkpoint` returns ITERATING, fix the weakest criterion it
   names first, then loop again. Only stop when it returns FINAL.
5. On FINAL, print `FINAL`, summarize the result, and stop. If the loop is
   STOPPED at the safety limit, report honestly which criteria still fail and
   why — do not claim success.

Do not ask me questions mid-loop. Make sensible assumptions, note them, and keep
going until FINAL.
