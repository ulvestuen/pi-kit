# lykkja — a loop-based agentic development framework for pi

**lykkja** (Norwegian for *the loop*) is a framework for the
[pi coding agent](https://pi.dev) that drives tasks to an explicit quality bar
using a **Plan-Do-Check-Act** self-checking loop.

Instead of producing work in one shot, the agent opens a loop with strict,
measurable success criteria and iterates — planning the next step, doing it,
scoring every criterion honestly, and deciding whether to loop again — until the
bar is met. lykkja keeps the score for it, so "done" means *every criterion
actually cleared its threshold*, not "looks finished."

## What you get

lykkja is a single pi package that bundles four kinds of resources:

| Kind          | Name                                                            | What it does                                                                 |
| ------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Extension** | `index.ts`                                                     | Loop engine: the `lykkja_start` and `lykkja_checkpoint` tools, the `/lykkja` dashboard command, persisted loop state, a status-bar line, and a short system-prompt injection. |
| **Skills**    | `pdca-loop`, `success-criteria`, `honest-verification`         | Model-invocable instructions for running the loop, writing strict criteria, and scoring honestly. |
| **Prompts**   | `/lykkja-run`, `/lykkja-plan`, `/lykkja-verify`, `/lykkja-ship` | Slash commands that drive each phase of the loop.                            |
| **Template**  | `templates/AGENTS.lykkja.md`                                   | A snippet to drop into your project's `AGENTS.md` to make the loop the default working style. |

## How the loop works

```
        ┌─────────────────────────────────────────────┐
        │  lykkja_start(task, criteria)                │
        └───────────────────────┬─────────────────────┘
                                 ▼
   ┌──── PLAN ──── DO ──── CHECK ──── DECIDE ──────────┐
   │   single      make    score      lykkja_checkpoint│
   │   next step   change  1-10       (verdict)         │
   └───────────────────────────────┬───────────────────┘
                                    ▼
              ITERATING ◀───────────┴───────────▶ FINAL / STOPPED
          (fix weakest criterion,          (bar met → stop, or
           loop again)                      safety limit → report)
```

1. **PLAN** — state the single next step.
2. **DO** — produce or improve the work.
3. **CHECK** — score the result 1-10 on each criterion, brutally honest; list
   what is still weak.
4. **DECIDE** — `lykkja_checkpoint` returns **FINAL** (every criterion at or
   above its threshold — stop), **ITERATING** (fix the named weakest criterion
   and loop), or **STOPPED** (hit the pass safety limit — report what still
   fails).

## Tools the agent can call

- **`lykkja_start`** — open a loop with a task and strict success criteria
  (each with an optional per-criterion threshold).
- **`lykkja_checkpoint`** — record one PLAN/DO/CHECK pass (the step, what
  changed, and a score for every criterion) and get the DECIDE verdict.

Loop state is persisted to the session (via the agent's entry log), so it
survives `/reload` and resumes with the session.

## Slash commands

- **`/lykkja-run <task>`** — open and run a loop end to end until FINAL.
- **`/lykkja-plan [task]`** — just the PLAN step: frame the task and define
  criteria.
- **`/lykkja-verify [what changed]`** — the CHECK/DECIDE step: score honestly and
  decide whether to iterate.
- **`/lykkja-ship`** — the ACT step: confirm the bar is met and finalize.
- **`/lykkja`** — show the live loop dashboard. `/lykkja reset` clears the loop.

## Installation

lykkja lives in the `lykkja/` subfolder of the
[pi-kit](https://github.com/ulvestuen/pi-kit) repository, which carries a
`pi-package` manifest exposing it.

### Option 1: install as a pi package from GitHub (recommended)

```bash
pi install https://github.com/ulvestuen/pi-kit
```

pi clones the repo, runs `npm install`, and registers the lykkja extension,
skills, and prompts automatically.

### Option 2: quick test with `--extension`

```bash
git clone https://github.com/ulvestuen/pi-kit.git
pi -e /absolute/path/to/pi-kit/lykkja/index.ts
```

This loads the extension (tools, command, system prompt). To also pick up the
skills and prompts in a quick test, point pi at the directories:

```bash
pi -e /absolute/path/to/pi-kit/lykkja/index.ts \
   --skills /absolute/path/to/pi-kit/lykkja/skills \
   --prompts /absolute/path/to/pi-kit/lykkja/prompts
```

### Option 3: copy into a pi resource location

```bash
git clone https://github.com/ulvestuen/pi-kit.git
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills ~/.pi/agent/prompts
cp -R pi-kit/lykkja ~/.pi/agent/extensions/lykkja
cp -R pi-kit/lykkja/skills/* ~/.pi/agent/skills/
cp -R pi-kit/lykkja/prompts/* ~/.pi/agent/prompts/
```

Then start pi (or run `/reload` if it is already running).

## Configuration

lykkja works with zero configuration. To change defaults, create a JSON config
at `~/.pi/agent/extensions/lykkja/lykkja.json`:

```json
{
  "passThreshold": 8,
  "scaleMax": 10,
  "maxIterations": 25,
  "injectSystemPrompt": true,
  "showStatus": true
}
```

| Field                | Default | Meaning                                                              |
| -------------------- | ------- | -------------------------------------------------------------------- |
| `passThreshold`      | `8`     | Default minimum score a criterion needs to pass.                     |
| `scaleMax`           | `10`    | Top of the scoring scale (scores run `1..scaleMax`).                 |
| `maxIterations`      | `25`    | Safety cap on passes before a loop self-stops without declaring FINAL. |
| `injectSystemPrompt` | `true`  | Whether to inject the short lykkja discipline into the system prompt. |
| `showStatus`         | `true`  | Whether to show the live loop status in the footer/status bar.       |

Environment overrides (used when no JSON config exists):
`LYKKJA_CONFIG_PATH`, `LYKKJA_PASS_THRESHOLD`, `LYKKJA_SCALE_MAX`,
`LYKKJA_MAX_ITERATIONS`, `LYKKJA_INJECT_SYSTEM_PROMPT`, `LYKKJA_SHOW_STATUS`.

If the config is invalid, lykkja logs a warning and falls back to defaults
rather than disabling itself.

## Make it your project's default

Paste `templates/AGENTS.lykkja.md` into your repository's `AGENTS.md` and fill in
your project-specific bars (test command, lint command, performance budgets).
pi loads `AGENTS.md` automatically, so the loop becomes the default working
style for the repo.

## Running tests

From the `lykkja/` directory:

```bash
npm test
```

This runs the loop-engine unit tests (`test.ts`) with Node's test runner via
`tsx`. The loop logic in `loop.ts` is pure and has no pi or Node dependencies,
so it is fully covered in isolation.

## Files

- `index.ts` — pi extension entry point (tools, command, hooks, state).
- `loop.ts` — pure loop state model and scoring logic.
- `config.ts` — configuration loading.
- `test.ts` — unit tests for the loop engine.
- `skills/` — `pdca-loop`, `success-criteria`, `honest-verification`.
- `prompts/` — the four `/lykkja-*` slash commands.
- `templates/AGENTS.lykkja.md` — project-instructions snippet.
- `lykkja.example.json` — configuration template.

## Design notes

- **The agent runs the loop; lykkja keeps the score.** The tools do not do the
  work — they record passes, enforce that every criterion is scored, compute the
  weakest failing one, and decide FINAL/ITERATING/STOPPED. This keeps the model
  honest without taking the reasoning away from it.
- **Honesty is the whole game.** The `honest-verification` skill and the required
  per-criterion `weakness` notes exist to fight the natural pull to inflate a
  score and escape the loop.
- **A safety limit prevents infinite loops.** If the bar genuinely cannot be met,
  the loop stops at `maxIterations` and reports what still fails, instead of
  spinning forever or faking success.
