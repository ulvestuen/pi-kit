# critic — independent review for pi

**critic** asks a separate read-only child agent to inspect work against an
explicit rubric. The child has fresh context and no stake in the result, which
removes the conflict of interest from self-scoring.

Critic always uses Fleet's direct local child-process adapter. There is no
runner or placement selector.

## What you get

| Kind | Name | Purpose |
| --- | --- | --- |
| Tool | `critic_review` | Score a subject against named criteria and thresholds. |
| Tool | `critic_advise` | Give prioritized pre-implementation design concerns. |
| Command | `/critic` | Show the active agent, model, tools, scale, timeout, and config. |
| Skill | `advisory-review` | Guidance for requesting and acting on independent review. |

## How reviews run

`critic_review` builds a strict prompt from the subject, context, artifacts,
and rubric. It launches the discovered `critic` role through
`fleet/runner.ts`, which starts one local child `pi` process. The shipped role
is read-only.

The response must contain one JSON verdict. `parseCriticOutput` validates every
criterion, clamps scores to the configured scale, and fails closed when output
is malformed or incomplete. A pass requires every score to meet its threshold.

`critic_advise` uses the same isolated child but requests concerns and concrete
improvements rather than scores.

## Agent definition

Critic uses the `critic` definition from the standard Fleet discovery order:

1. `fleet/agents/critic.md`
2. `~/.pi/agent/agents/critic.md`
3. `<project>/.pi/agents/critic.md`

A built-in read-only definition is used when none is discovered. The `model`
configuration field overrides the selected definition's model.

## Configuration

Optional JSON configuration lives at
`~/.pi/agent/extensions/critic/critic.json`; see `critic.example.json`.

| Field | Default | Meaning |
| --- | ---: | --- |
| `model` | unset | Model override for critic children. |
| `scaleMax` | `10` | Highest allowed score. |
| `passThreshold` | `8` | Default criterion threshold. |
| `timeoutMs` | `300000` | Child timeout. |
| `piBinary` | `"pi"` | Child executable. |

Environment fallbacks, used when no JSON file exists:

- `CRITIC_CONFIG_PATH`
- `CRITIC_MODEL`
- `CRITIC_SCALE_MAX`
- `CRITIC_PASS_THRESHOLD`
- `CRITIC_TIMEOUT_MS`
- `CRITIC_PI_BINARY`

## Composition with PDCA

Critic returns the same criterion-score shape consumed by
`pdca_checkpoint`, so it can provide an independent CHECK step. Critic itself
does not require a PDCA loop.

## Installation

```bash
pi install https://github.com/ulvestuen/pi-kit
```

A standalone source checkout must keep `critic/`, `fleet/`, `pdca/`, and
`agent-types/` available at their repository-relative paths.

## Verification

```bash
npm test --workspace pi-critic
```

Tests cover prompt construction and strict parsing of valid, malformed,
incomplete, corrected, and out-of-range verdicts.
