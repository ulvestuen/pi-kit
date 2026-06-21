---
name: success-criteria
description: Write strict, measurable success criteria for a lykkja loop (or any task with a quality bar). Use when starting a loop, defining "done", or turning a vague goal into criteria that can be scored honestly and objectively.
---

# Writing strict success criteria

A lykkja loop is only as good as its criteria. Vague criteria let you declare
victory early; strict, checkable criteria force the work to actually clear the
bar. This skill is about turning "make it good" into a set of criteria you can
score 1-10 without lying to yourself.

## What makes a good criterion

A good criterion is:

- **Observable** — you can point at evidence (a passing test, a clean
  type-check, a measured number) rather than a feeling.
- **Specific** — it names one property, not a bundle. "Correct and fast and
  readable" is three criteria.
- **Falsifiable** — there is a concrete way it could fail. If nothing could
  make it score low, it is not a real criterion.
- **Independent** — it can be scored without first deciding another criterion.

## Turn vague goals into criteria

| Vague goal            | Strict criteria                                                              |
| --------------------- | --------------------------------------------------------------------------- |
| "good code"           | `all tests pass`, `no type errors`, `no lint warnings`, `public API ≤ 4 fns` |
| "works"               | `happy path returns correct result`, `errors on invalid input`, `no crashes on empty/null` |
| "well documented"     | `every public function has an example`, `README covers install + usage + failure modes` |
| "fast enough"         | `parses 1MB in < 100ms`, `no O(n²) over the input`                          |
| "secure"              | `validates all external input`, `no secrets in logs`, `authz checked before each action` |

## Set thresholds deliberately

The default pass bar is 8/10. Adjust per criterion:

- Raise to **9-10** for properties that must not regress: correctness on the
  core path, security checks, data integrity.
- Keep at **8** for solid-but-not-perfect quality: readability, test coverage of
  common cases, documentation completeness.
- Lower to **6-7** only for genuinely nice-to-have aspects you still want to
  track but would not block on.

A threshold of 10 means "flawless" — use it sparingly, because it can stall a
loop on diminishing returns.

## How many criteria

Aim for **3 to 6**. Fewer than 3 usually means you have bundled distinct
properties together. More than 6 usually means some are really sub-points of
others, or some are not worth scoring every pass. Each criterion should be worth
the cost of scoring it on every loop pass.

## Anti-patterns

- **Tautological** — "the code is correct." Correct against what? Name the
  checkable behaviour.
- **Unmeasurable** — "the API is elegant." Replace with a proxy you can observe:
  surface area, number of required arguments, consistency with siblings.
- **Moving target** — criteria you quietly relax mid-loop to reach FINAL. If a
  criterion was wrong, say so explicitly and restate it; do not silently soften
  it.
- **Process, not outcome** — "I tried hard." Score the result, not the effort.

## Then start the loop

Once you have your criteria, call `lykkja_start` with the task and the list.
Provide a `threshold` on any criterion that should differ from the default bar.
See the `pdca-loop` skill for running the loop and `honest-verification` for
scoring each pass.
