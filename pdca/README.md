# pdca — a loop-based agentic development framework for pi

**pdca** (named for the Plan-Do-Check-Act cycle) is a framework for the
[pi coding agent](https://pi.dev) that drives tasks to an explicit quality bar
using a **Plan-Do-Check-Act** self-checking loop.

Instead of producing work in one shot, the agent opens a loop with strict,
measurable success criteria and iterates — planning the next step, doing it,
scoring every criterion honestly, and deciding whether to loop again — until the
bar is met. pdca keeps the score for it, so "done" means *every criterion
actually cleared its threshold*, not "looks finished."

## What you get

pdca is a single pi package that bundles three kinds of resources:

| Kind          | Name                                                    | What it does                                                                 |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Extension** | `index.ts`                                             | Loop engine: the `pdca_start` and `pdca_checkpoint` tools, the single `/pdca` command, persisted loop state, a status-bar line, and a short system-prompt injection. |
| **Skills**    | `pdca-loop`, `success-criteria`, `honest-verification` | Model-invocable instructions for running the loop, writing strict criteria, and scoring honestly. |
| **Template**  | `templates/AGENTS.pdca.md`                           | A snippet to drop into your project's `AGENTS.md` to make the loop the default working style. |

## How the loop works

```
        ┌─────────────────────────────────────────────┐
        │  pdca_start(task, criteria)                │
        └───────────────────────┬─────────────────────┘
                                 ▼
   ┌──── PLAN ──── DO ──── CHECK ──── ACT ──────────────┐
   │   single      make    score      pdca_checkpoint│
   │   next step   change  1-10       (verdict/prompt)  │
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
4. **ACT** — `pdca_checkpoint` returns **FINAL** (every criterion at or
   above its threshold — finalize), **ITERATING** (act on the named weakest
   criterion and loop), or **STOPPED** (hit the pass safety limit — report what
   still fails).

## The `/pdca` command

One slash command drives everything:

- **`/pdca <task>`** — open a loop on the task and run it end to end until
  FINAL.
- **`/pdca plan <task>`** — PLAN only: frame the task, define strict criteria,
  open the loop, and pause so you can review the criteria before any work
  starts.
- **`/pdca go`** — continue the active loop: score the current state honestly,
  checkpoint, and follow the verdict. Use it to run a loop opened with `plan`,
  or to nudge a loop that stalled mid-way. (`continue` and `resume` are
  aliases.)
- **`/pdca`** — show the live loop dashboard.
- **`/pdca reset`** — clear the loop. (`clear` is an alias.)

There are no per-phase commands. The extension prompts the agent through the
whole PDCA cycle from the tool results (see below), so once a loop is running
the phases drive themselves; `go` is the only manual nudge you should ever
need.

## Tools the agent can call

- **`pdca_start`** — open a loop with a task and strict success criteria
  (each with an optional per-criterion threshold).
- **`pdca_checkpoint`** — record one PLAN/DO/CHECK pass (the step, what
  changed, and a score for every criterion) and get the ACT verdict.

Loop state is persisted to the session (via the agent's entry log), so it
survives `/reload` and resumes with the session.

## Automated PDCA prompting

pdca prompts the agent through the whole cycle from the tool results, not
just from the command text. After `pdca_start`, the extension returns an
`AUTOMATED PLAN→DO→CHECK PROMPT` that tells the agent to start pass 1, execute a
single next step, gather evidence, and call `pdca_checkpoint`. Each checkpoint
then returns one of three follow-up prompts:

- **ITERATING** → an `AUTOMATED ACT→PLAN→DO→CHECK PROMPT` telling the agent to
  start the next pass immediately and fix the weakest failing criterion first.
- **FINAL** → an `AUTOMATED ACT PROMPT` telling the agent to stop iterating,
  state `FINAL`, and summarize the evidence.
- **STOPPED** → an `AUTOMATED STOP PROMPT` telling the agent to report the
  remaining failures honestly instead of claiming success.

This means `/pdca <task>` can drive an end-to-end loop with no extra user
nudges. Use `/pdca plan <task>` when you intentionally want to pause after
criteria creation, then `/pdca go` to set the loop running; otherwise let the
automated prompts carry the agent from PLAN to DO to CHECK to ACT.

## Best ways to use pdca

Use pdca when the task has a real quality bar and benefits from feedback after
each pass. Good prompts include the desired outcome, constraints, and any known
validation command:

```text
/pdca Add CSV export to the invoices page. Preserve existing filters, add
unit tests for escaping and empty rows, and run npm test -- invoices.
```

It is especially useful for:

- **Feature work:** implement a UI/API feature until tests, edge cases, and docs
  all clear their thresholds.
- **Bug fixes:** reproduce the failure, fix the weakest evidence gap first, and
  keep looping until the regression test passes.
- **Refactors:** require behavior parity, no type/lint regressions, and smaller
  or clearer interfaces.
- **Documentation or release work:** score completeness, accuracy against the
  code, and example usability before shipping.

Avoid pdca for trivial one-command tasks, broad exploratory research with no
checkable bar, or cases where you explicitly want a single draft rather than an
iterated result.

## Example use cases

### 1. Bug fix with regression protection

```text
/pdca Fix the login redirect loop. Success means the redirect is
reproduced by a failing test, the test passes after the fix, existing auth tests
still pass, and the cause is documented in the PR notes.
```

### 2. Safe refactor

```text
/pdca Refactor the billing date helpers into a single module. Preserve the
public API, remove duplicated parsing logic, keep TypeScript strict checks clean,
and add edge-case coverage for time zones.
```

### 3. Docs that match implementation

```text
/pdca Update the pdca README for automated PDCA prompting. It must
explain when to use it, when not to use it, and include at least three concrete
examples that a new pi user can copy.
```

## Installation

pdca lives in the `pdca/` subfolder of the
[pi-kit](https://github.com/ulvestuen/pi-kit) repository, which carries a
`pi-package` manifest exposing it.

### Option 1: install as a pi package from GitHub (recommended)

```bash
pi install https://github.com/ulvestuen/pi-kit
```

pi clones the repo, runs `npm install`, and registers the pdca extension and
skills automatically.

### Option 2: quick test with `--extension`

```bash
git clone https://github.com/ulvestuen/pi-kit.git
pi -e /absolute/path/to/pi-kit/pdca/index.ts
```

This loads the extension (tools, the `/pdca` command, system prompt). To also
pick up the skills in a quick test, point pi at the directory:

```bash
pi -e /absolute/path/to/pi-kit/pdca/index.ts \
   --skills /absolute/path/to/pi-kit/pdca/skills
```

### Option 3: copy into a pi resource location

```bash
git clone https://github.com/ulvestuen/pi-kit.git
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
cp -R pi-kit/pdca ~/.pi/agent/extensions/pdca
cp -R pi-kit/pdca/skills/* ~/.pi/agent/skills/
```

Then start pi (or run `/reload` if it is already running).

## Configuration

pdca works with zero configuration. To change defaults, create a JSON config
at `~/.pi/agent/extensions/pdca/pdca.json`:

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
| `injectSystemPrompt` | `true`  | Whether to inject the short pdca discipline into the system prompt. |
| `showStatus`         | `true`  | Whether to show the live loop status in the footer/status bar.       |

Environment overrides (used when no JSON config exists):
`PDCA_CONFIG_PATH`, `PDCA_PASS_THRESHOLD`, `PDCA_SCALE_MAX`,
`PDCA_MAX_ITERATIONS`, `PDCA_INJECT_SYSTEM_PROMPT`, `PDCA_SHOW_STATUS`.

If the config is invalid, pdca logs a warning and falls back to defaults
rather than disabling itself.

## Make it your project's default

Paste `templates/AGENTS.pdca.md` into your repository's `AGENTS.md` and fill in
your project-specific bars (test command, lint command, performance budgets).
pi loads `AGENTS.md` automatically, so the loop becomes the default working
style for the repo.

## Running tests

From the `pdca/` directory:

```bash
npm test
```

This runs the loop-engine unit tests (`test.ts`) with Node's test runner via
`tsx`. The loop logic in `loop.ts` is pure and has no pi or Node dependencies,
so it is fully covered in isolation.

## Files

- `index.ts` — pi extension entry point (tools, the `/pdca` command, hooks, state).
- `loop.ts` — pure loop state model and scoring logic.
- `config.ts` — configuration loading.
- `test.ts` — unit tests for the loop engine.
- `skills/` — `pdca-loop`, `success-criteria`, `honest-verification`.
- `templates/AGENTS.pdca.md` — project-instructions snippet.
- `pdca.example.json` — configuration template.

## Design notes

- **The agent runs the loop; pdca keeps the score.** The tools do not do the
  work — they record passes, enforce that every criterion is scored, compute the
  weakest failing one, and return the ACT verdict (FINAL/ITERATING/STOPPED). This keeps the model
  honest without taking the reasoning away from it.
- **One command, not five.** The automated prompting makes per-phase commands
  redundant: the tool results themselves carry the next-phase prompt. So the
  whole surface is `/pdca` — a task argument to run, `plan` to pause after
  criteria, `go` to continue, and `reset` to clear.
- **Honesty is the whole game.** The `honest-verification` skill and the required
  per-criterion `weakness` notes exist to fight the natural pull to inflate a
  score and escape the loop.
- **A safety limit prevents infinite loops.** If the bar genuinely cannot be met,
  the loop stops at `maxIterations` and reports what still fails, instead of
  spinning forever or faking success.
- **The loop is the wave engine of the Micro-V'ave execution model.** In a
  multi-agent orchestration run, each PDCA pass drives one wave of micro
  V-model cycles: criteria opened with `pdca_start` are the acceptance
  contract at the top of every V, and the `pdca_checkpoint` verdict is what
  advances (or ends) the wave sequence. See
  [`docs/micro-vave-execution-model.md`](../docs/micro-vave-execution-model.md).
