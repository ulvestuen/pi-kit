# critic — an independent advisor/reviewer for pi

**critic** removes the conflict of interest from self-checking work: a
separate agent with **fresh context** and read-only tools inspects the work
and scores it against an explicit rubric. It is part of the pi-kit
multi-agent stack (see
[`docs/multi-agent-orchestration.md`](../docs/multi-agent-orchestration.md))
but is a useful "second pair of eyes" in any session — including as the CHECK
step of a plain lykkja loop.

## What you get

| Kind        | Name              | What it does                                                          |
| ----------- | ----------------- | ---------------------------------------------------------------------- |
| **Tool**    | `critic_review`   | Score a subject against criteria with a fresh-context read-only critic sub-agent; returns lykkja-shaped scores, a pass/fail verdict, and prioritized weaknesses. |
| **Tool**    | `critic_advise`   | Pre-implementation design feedback — prioritized concerns rather than scores. |
| **Command** | `/critic`         | Show the agent definition, model, scale, and timeout in use.           |
| **Skill**   | `advisory-review` | When to seek review, how to hand the critic enough context, how to act on weaknesses. |

## How a review runs

`critic_review` builds a strict scoring prompt from the rubric
(`review.ts:buildCriticPrompt`) and dispatches the shipped read-only `critic`
agent definition through the fleet runner (`fleet/runner.ts`, a pure-module
import — never `fleet/index.ts`). The runner's labeled child execution is
spawn-backed through `fleet/host.ts` + `spawn/runner-adapter.ts`. The critic can
inspect the repository but not modify it.

The reply must contain one fenced JSON block of scores.
`review.ts:parseCriticOutput` is where robustness lives: tolerant JSON-block
extraction, per-criterion validation, and score clamping — **a review that
cannot be parsed is a failed review, never a silent pass** (one automatic
re-run is attempted first). `passed` is true only when every criterion met
its threshold; `weaknesses` is prioritized worst-margin-first.

## Composing with lykkja

The critic emits `CriterionScore[]` in lykkja's exact shape, so external
review drops straight into `lykkja_checkpoint`: run `critic_review` as the
CHECK step and feed the returned scores to the checkpoint — independent
scoring instead of self-report, with lykkja's `honest-verification` skill as
the fallback when the critic isn't installed.

## Agent definition

The critic uses the `critic` agent from the standard fleet discovery
locations (`fleet/agents/critic.md`, overridable in `~/.pi/agent/agents/` or
`.pi/agents/`), with a built-in fallback when none is found. The `model`
config field overrides the agent's model — a strong model here pays for
itself.

## Installation

```bash
pi install https://github.com/ulvestuen/pi-kit
```

or for a quick test:

```bash
git clone https://github.com/ulvestuen/pi-kit.git
pi -e /absolute/path/to/pi-kit/critic/index.ts \
   --skills /absolute/path/to/pi-kit/critic/skills
```

Note: critic imports the pure engines `lykkja/loop.ts`, `fleet/registry.ts`,
`fleet/runner.ts`, and the `fleet/host.ts` discovery/spawn-tooling helpers via
workspace-relative paths. Because `fleet/host.ts` delegates child execution to
spawn tooling, a standalone copy of `critic/` must keep the `lykkja/`,
`fleet/`, and `spawn/` folders alongside it or vendor those files.

## Configuration

critic works with zero configuration. To change defaults, create
`~/.pi/agent/extensions/critic/critic.json` (see `critic.example.json`):

| Field           | Default  | Meaning                                              |
| --------------- | -------- | ----------------------------------------------------- |
| `model`         | *(none)* | Model override for critic runs; empty = parent model. |
| `scaleMax`      | `10`     | Top of the scoring scale.                              |
| `passThreshold` | `8`      | Default threshold for criteria that carry none.        |
| `timeoutMs`     | `300000` | Timeout for one critic run (5 minutes).                |
| `piBinary`      | `"pi"`   | Binary spawned for critic runs.                        |
| `tmux`          | `true`   | Historical live-window flag. With spawn's `tmux` backend, tmux is the critic runner. |
| `tmuxSession`   | `"pi-agents"` | tmux session passed to the spawn tmux backend.     |
| `tmuxCloseWindows` | `false` | Historical mirror option; spawn tmux jobs remain inspectable after exit. |

Environment overrides (used when no JSON config exists):
`CRITIC_CONFIG_PATH`, `CRITIC_MODEL`, `CRITIC_SCALE_MAX`,
`CRITIC_PASS_THRESHOLD`, `CRITIC_TIMEOUT_MS`, `CRITIC_PI_BINARY`,
`CRITIC_TMUX`, `CRITIC_TMUX_SESSION`, `CRITIC_TMUX_CLOSE_WINDOWS`.
Backend selection and remote/sandbox details come from the spawn extension's
configuration (`~/.pi/agent/extensions/spawn/spawn.json` or `SPAWN_*`).

## Running tests

```bash
npm test
```

Prompt construction and `parseCriticOutput` (well-formed, malformed, and
partially-scored outputs; clamping) are covered by pure unit tests.

## Files

- `index.ts` — pi extension wiring (`critic_review`, `critic_advise`, `/critic`).
- `review.ts` — pure review engine: prompt construction and tolerant output parsing (the reusable module).
- `config.ts` — configuration loading.
- `test.ts` — unit tests.
- `skills/advisory-review/` — review-seeking skill.
- `critic.example.json` — configuration template.
