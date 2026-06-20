---
description: Run the ACT step of the lykkja loop — confirm the bar is met and finalize the work
argument-hint: (no arguments)
---

Run the **ACT** step of the lykkja loop: finalize only if the bar is genuinely
met.

1. Run `/lykkja` (or inspect the loop) to confirm the latest verdict is FINAL
   and every criterion is at or above its threshold. If it is not FINAL, do
   **not** ship — go back and run another pass with `/lykkja-verify`.
2. Do a last honest sweep for anything the criteria did not capture: leftover
   debug code, TODOs, untested branches, missing docs. If you find a real gap,
   the bar was not actually met — add or tighten a criterion and loop again.
3. Finalize the work as appropriate to the task: run the full test suite once
   more, ensure the type-checker and linter are clean, and make sure the change
   is self-contained.
4. Summarize what was produced, which criteria it met and at what scores, and
   any assumptions you made along the way. State plainly that the bar is met —
   without hedging — or, if it is not, say exactly what still falls short.

This is the Act in Plan-Do-Check-Act: lock in what works and make the result
ready to hand over.
