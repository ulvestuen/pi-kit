---
title: Pick pair models in a pop-up instead of a preference list
status: open
owner: idar
updated: 2026-11-19
---

> Historical plan for the retired picker. Model selection now lives in [Swarm pair workflow setup](../extensions/swarm/README.md#pair-workflows).

## Background

`pair`, `pair-review` and `pair-work` start two Pi workers. Today each role
gets the first *ready* model from a fixed preference list, so the user cannot
see or choose the models before panes open without typing override flags into
the request. The user wants a small pop-up in the Pi TUI that opens whenever
the agent understands one of these workflows is wanted, and lets them choose
the models there.

## Current condition

- Defaults are hard-coded per role in `DEFAULTS.models`:
  `skills/pair/pair.mjs:19-20`, `skills/pair-review/pair-review.mjs:19-20`,
  `skills/pair-work/pair-work.mjs:21-22`. The Claude-side role uses
  `claude-code/claude-opus-5-5` and falls back to `anthropic/claude-opus-5-5`.
  The GPT-side role uses `openai/gpt-6.1-sol:xhigh` and falls back to
  `opencode/gpt-6.1-sol:xhigh`. The Claude-side role also tries the caller's
  `PI_PROVIDER`/`PI_MODEL` first.
- `prompts/pair.md`, `prompts/pair-review.md` and `prompts/pair-work.md` repeat
  the defaults in their text.
- Overrides exist only as flags (`--implementer-model`, `--auditor-model`,
  `--lead-model`, `--peer-model`, `--doer-model`, `--verifier-model`,
  `--rounds`). `models --json` already checks given overrides
  (`modelsCommand`, `pair.mjs:959`).
- `package.json` lists only `./threema` under `pi.extensions`, so pi-kit has no
  pair extension yet.
- Pi 1.5.2 provides the pieces:
  - `ctx.ui.custom(..., { overlay: true })` for a floating window.
  - `SelectList` and `SettingsList` from `@earendil-works/pi-tui`.
  - `ctx.scopedModels` and `ctx.modelRegistry.getAvailable()` for the model list.
  - `ctx.ui.select` in RPC mode.
  - `ctx.mode` and `ctx.hasUI` to tell the modes apart.
  - `pi.registerTool` and `pi.registerCommand`.

  Source: `docs/extensions.md`, sections Custom UI, ExtensionContext and
  Custom Tools.

## Goal

- [ ] Asking for pair programming, a pair review or pair work, in plain words
  or with `/pair`, `/pair-review` or `/pair-work`, opens a pop-up before any
  worker pane opens.
- [ ] In the pop-up, the user picks a model and a thinking level for each role
  and the number of rounds. The run then uses exactly those values, which the
  `run` output shows.
- [ ] A pick that is not ready is reported in the pop-up and no panes open.
- [ ] Without a TUI, the run still starts. RPC mode gets a simple select
  prompt. Print mode, JSON mode and Threema-driven sessions use the last picks
  or the defaults. The report says what was used.
- [ ] Without the extension, the skills behave as before (preference list).
- [ ] `npm test` and `git diff --check` pass.

## Root cause analysis

1. Why can't the user choose? Model choice happens inside the scripts
   (`resolveModels`), after the agent has decided to run. Nothing asks the user
   first. *Confirmed* from the code.
2. Why does nothing ask? Skills and prompts are text only, so they cannot show
   UI. Only an extension can open a dialog. *Confirmed* from the Pi docs.
3. Why do overrides go unused? They need exact `provider/id:thinking` strings,
   typed in the request. *Suspected*: the user has to know and remember those
   strings.

## Countermeasures

### C1: `pair_setup` tool plus a picker overlay in a new pair extension

Decisions made with the user on 2026-11-18:

1. **Scope:** the pop-up only picks. The skill still runs, waits and reports.
2. **Model list:** scoped models; all available models if none are scoped.
3. **Preselection:** the last pick per workflow and role, stored globally under
   `getAgentDir()`. The first run uses today's defaults.
4. **Fields:** a model and a thinking level for each role, plus rounds.
5. **When it opens:** always. Values named in the request are filled in, and
   Enter confirms.
6. **Commands and skills:** the extension registers `/pair`, `/pair-review` and
   `/pair-work`, and `prompts/pair*.md` are deleted. The skills keep the
   preference-list fallback for setups without the extension.
7. **Same model in both roles:** allowed, with a warning in the pop-up.
8. **No TUI:** RPC mode uses `ctx.ui.select` for each field. Print mode, JSON
   mode and Threema-driven sessions use the last picks or the defaults
   without asking.

Design:

- A new `extensions/pair/index.ts` is added to `pi.extensions`.
- **The tool:** `pair_setup({ workflow, task?, models?, thinking?, rounds? })`.
  Its description and `promptGuidelines` tell the agent to call it before
  running any of the three skills, whether the user asked in plain words or
  with a slash command.
  - It opens the overlay.
  - It checks the picks with `node skills/<wf>/<wf>.mjs models --<role>-model … --json`.
  - It saves the picks.
  - It returns the exact flags for `run`, for example
    `--implementer-model … --auditor-model … --rounds 3`.

  Esc returns "cancelled", and the agent stops.
- **The commands:** `/pair`, `/pair-review` and `/pair-work` open the same
  overlay first. They then send a user message telling the agent to follow the
  skill with the returned flags and the task text.
- **The overlay:**
  - One row per role, each opening a searchable model list (`SelectList`).
  - A thinking level for each role (`off`…`max`, limited to levels the model
    supports).
  - Rounds (pair 3, review 1, work 3).
  - A footer with the same-model warning, the readiness error, and
    Enter/Esc hints.
- **The skills:** `SKILL.md` for pair, pair-review and pair-work says: if the
  `pair_setup` tool exists, call it first and pass its flags. Otherwise use the
  preference list.

- Addresses: causes 1, 2 and 3.
- Prediction: the user picks models in one pop-up before any pane opens, and
  stops typing `--*-model` flags in requests.
- Check: in a live Pi TUI session, ask "pair on X" and type `/pair-review`, and
  see the overlay both times. Check the `run` output for the chosen models.
  Run `pi -p` to see the fallback without a TUI. Unit tests cover the
  list, preselection, fallback and flags.
- Result: pending (partly observed on 2026-11-18):
  - **TUI:** `pickModels` ran from a test command in a live `pi` TUI (tmux,
    Pi 1.5.2). The overlay opened centred with the defaults, and typing
    `sonnet` filtered the list. Picking `claude-code/claude-sonnet-5` and
    thinking `minimal`, then Start, ran the readiness check (about 20 s) and
    returned `--lead-model claude-code/claude-sonnet-5:minimal --peer-model
    openai/gpt-6.1-sol:xhigh --rounds 1`. The picks were saved to
    `~/.pi/agent/pair-picker.json`; the test file was removed afterwards.
  - **Print mode:** `pi -p` used the defaults, matched the request "gpt-6.1-sol:xhigh"
    to `openai/gpt-6.1-sol:xhigh`, passed the check, and reported that no pop-up
    was shown.
  - **Shipped:** commit `9c26fac` on `main`. CI passed on ubuntu, macOS and
    Windows: https://github.com/ulvestuen/pi-kit/actions/runs/44421752829
  - **Still open:**
    - Whether an agent calls `pair_setup` by itself when the user asks in
      plain words.
    - The RPC select fallback, which no live run has exercised.

## Implementation plan

- [x] C1.1: Scaffold `extensions/pair/` (package, tsconfig and tests, modelled
  on `threema/`), and add it to the workspaces, `pi.extensions` and `npm test`.
- [x] C1.2: Pure logic with tests:
  - the role table per workflow
  - building the model list (scoped, else available)
  - preselection (saved, then request values, then defaults)
  - the store under `getAgentDir()`
  - the same-model warning
  - building the flags
- [x] C1.3: The overlay component (`SelectList` per role, thinking level,
  rounds) with a render/input test.
- [x] C1.4: The `pair_setup` tool:
  - choose by mode (overlay, RPC select, or no-UI fallback)
  - run the readiness check through the skill's `models --json`
  - return the flags
- [x] C1.5: The `/pair`, `/pair-review` and `/pair-work` commands. Delete
  `prompts/pair*.md`.
- [x] C1.6: Update the three `SKILL.md` files and the README: "call
  `pair_setup` if available", and remove the hard-coded defaults from the
  prompt text.
- [x] C1.7: `npm test` and `git diff --check`, then a manual check in a TUI
  session and with `pi -p`.
- [ ] C1.8: In a real Herdr/Rex session, ask "pair on …" in plain words and
  type `/pair-review`, and confirm both open the pop-up and the run uses the
  picks.

## Follow-up

- The skill scripts gained `models --no-scan`. It checks only the given picks,
  so the pop-up's check takes seconds, not a catalogue scan. A pick that is not
  ready still gets alternatives.
- Model rows show where each value came from: request, last pick, or default.
  The label disappears once the user changes the value.
