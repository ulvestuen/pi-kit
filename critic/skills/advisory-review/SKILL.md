---
name: advisory-review
description: Seek and act on independent review — when to use the critic_review and critic_advise tools, how to hand the critic enough context to verify work on its own, and how to act on the returned weakness list. Use when finishing significant work, before committing to a design, or as the CHECK step of a lykkja loop.
---

# Advisory review

Self-scoring is the weakest link in any self-checking loop: the agent that did
the work has a stake in it passing. The critic removes that conflict of
interest — a separate read-only agent with fresh context inspects the work and
scores it against the rubric.

## When to seek review

- **After implementing** anything with a real quality bar: run
  `critic_review` against the task's acceptance criteria before calling it
  done.
- **Before implementing** a non-trivial plan or design: run `critic_advise`
  and act on the concerns while changing course is still cheap.
- **As the CHECK step of a lykkja loop**: the critic returns scores in
  lykkja's exact `CriterionScore` shape — feed them into `lykkja_checkpoint`
  instead of self-reported scores. Fall back to the `honest-verification`
  skill only when the critic is unavailable.

Skip review for trivial, single-step work — a critic run is a full model
conversation and should pay for itself.

## Handing the critic enough context

The critic starts with fresh context and read-only tools. It can inspect the
repository, but it cannot read your mind. In `subject` and `context` provide:

- **what changed and where**: the files touched, the feature or fix intended;
- **how to verify each criterion**: the test command, the input to try, the
  invariant to check — phrased so someone who did not do the work can check it;
- **the constraints** the work was done under (API stability, style, scope).

Anti-pattern: "review my changes" with no paths. The critic will score low on
everything it cannot verify — by design.

## Acting on the result

- The verdict is `passed` only when **every** criterion met its threshold.
- `weaknesses` is prioritized worst-first. Fix the first item, then re-review;
  don't argue with the rubric mid-flight.
- The critic's scores win over your self-assessment. If you believe a score is
  wrong, the fix is a clearer subject/context (give it the evidence), not a
  self-awarded higher number.
- An unscorable review (the critic's output could not be parsed) counts as
  failed — it is automatically retried once; if it still fails, tighten the
  subject and try again.

## Related

- `honest-verification` (lykkja) — self-scoring discipline for when no critic
  is available.
- `success-criteria` (lykkja) — writing rubrics a reviewer can score from
  evidence.
- `/critic` — shows which agent definition, model, and scale are in use.
