---
description: Run the CHECK/DECIDE step of the lykkja loop — score the current work honestly and decide whether to iterate
argument-hint: [what changed this pass]
---

Run the **CHECK** and **DECIDE** steps of the active lykkja loop.

WHAT CHANGED THIS PASS (if empty, infer it from the recent work):
$ARGUMENTS

Score the current state of the work, brutally honestly, following the
`honest-verification` skill:

1. For each success criterion, gather evidence this pass — run the tests, run the
   type-checker, trace the edge case, re-read the spec clause. Do not score from
   memory or assumption.
2. Give each criterion an honest 1-10 score. For anything below its threshold,
   write one concrete sentence naming the specific weakness.
3. Call `lykkja_checkpoint` with the single step you took (PLAN), what changed
   (DO), and the scores (CHECK).
4. Act on the verdict:
   - ITERATING → fix the weakest criterion it names first, then start the next
     pass.
   - FINAL → print `FINAL`, summarize, and stop.
   - STOPPED → report honestly which criteria still fail and why.

Do not inflate a score to end the loop. A pass that honestly drops a score
because you found a real defect is the loop working.
