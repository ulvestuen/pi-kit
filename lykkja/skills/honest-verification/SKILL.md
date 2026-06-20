---
name: honest-verification
description: Score work brutally honestly during the CHECK step of a lykkja loop. Use when verifying or self-assessing output against success criteria, scoring 1-10, or deciding whether work truly meets the bar versus only appearing to.
---

# Honest verification

The CHECK step is where loops succeed or quietly fail. If you inflate scores to
end the loop, you ship work that misses the bar and you have wasted the whole
exercise. This skill is about scoring so that an 8 actually means an 8.

## Score against evidence, not vibes

Before scoring a criterion, find the evidence:

- "tests pass" → actually run them this pass; read the output. A test you did
  not run is not evidence.
- "no type errors" → run the type-checker now. Do not assume.
- "handles empty input" → trace or test the empty case specifically.
- "matches the spec" → re-read the spec clause and compare line by line.

If you have not produced evidence for a criterion this pass, its score is a
guess — and a guess defaults low, not high.

## What the numbers mean

Use a consistent scale. A rough rubric on 1-10:

- **1-3** — broken or absent. The property mostly does not hold.
- **4-5** — partial. Works in the easy case, fails real ones.
- **6-7** — mostly there, with known gaps you can name.
- **8** — meets the bar: solid, gaps are minor and acceptable.
- **9** — strong: you went looking for problems and found little.
- **10** — flawless against this criterion. Rare; reserve it.

If you cannot name what separates your score from the next one up, you are
guessing. An 8 should come with "what would make it a 9," and a 6 with "exactly
what is missing."

## Always name the weakness

For every criterion below its threshold, write one concrete sentence of what is
still weak — the specific gap, not a restatement of the criterion. Pass this as
`weakness` in `lykkja_checkpoint`. "Validation is weak" is useless; "rejects
negative numbers but silently accepts NaN" tells the next pass exactly what to
fix.

This is also a check on your own honesty: if you score something 6 but cannot
name a single concrete weakness, the real score is probably higher and you are
sandbagging. If you score something 9 but can list three real gaps, the real
score is lower and you are inflating.

## Guard against the usual self-deception

- **Anchoring on effort** — "I worked hard on validation, call it 8." Effort is
  not evidence. Score the result.
- **Rounding up to escape** — nudging a 7 to an 8 because you are tired of the
  loop. That is exactly the failure mode the loop exists to prevent.
- **Scoring the plan, not the artifact** — "this will be robust once finished."
  Score what exists now.
- **Halo effect** — letting one strong criterion inflate the others. Score each
  independently.
- **Confirmation bias** — only testing the cases you expect to pass. Actively
  look for the input that breaks it.

## Be willing to score your own work low

The most valuable CHECK is the one that catches a problem before the user does.
A pass where you honestly drop a criterion from 8 to 5 because you found a real
defect is the loop working, not the loop failing. Reward yourself for finding
the weakness, not for reaching FINAL quickly.

## Then decide

Feed the honest scores into `lykkja_checkpoint`. Trust its verdict: if it says
ITERATING, the bar is genuinely not met — fix the weakest criterion it names and
loop again. See the `pdca-loop` skill for the full cycle.
