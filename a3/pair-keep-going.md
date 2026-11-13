---
title: Pair orchestrator stops early and needs 'continue'
status: open
owner: idar
updated: 2026-11-13
---

## Background

Long roadmap runs (signa, sweatr) are driven by one orchestrating Pi session
that starts `/pair` workers item by item. The user wants these to run
unattended, but has to type "continue" or "what is next?" to keep them going.
Each nudge is a context switch for the user, and the run sits idle until they
notice it.

## Current condition

`node skills/hansei/hansei.mjs --since 30d` on 2026-11-13 (312 sessions, 1079 prompts):

| Project | Nudges per 100 prompts | Prompts | Cost |
| --- | --- | --- | --- |
| signa | 13 | 122 | $160 |
| sweatr | 12 | 110 | $143 |
| all projects | 4.4 | 1079 | $836 |

- 85 model errors. Grouped by message: 22 `openai-codex` "usage limit has been
  reached", 14 `claude-code` "charged to Claude usage credits instead of your
  plan", 13 incomplete Claude Code responses, 8 opencode-go (5 hosted outside
  Europe, 3 Go usage limit).
- The assistant text before each nudge in
  `signa/2026-11-07T08-56-32…jsonl` and `sweatr/2026-11-07T09-01-46…jsonl`
  falls into three groups:
  - Ended the turn while workers ran:
    > The implementer has been working on the first implementation for about
    > 15 minutes, with no report yet. The pair runs on its own…
  - Stopped between items:
    > **Next:** M4.3 editor layout work … I'll start a new pair in this tab.
  - Stopped on quota:
    > Claude exhausted its subscription quota … Please restore quota or
    > explicitly authorize usage credits so I can continue.
- The orchestrator ran `pair.mjs run … &` and checked in with 1200 s bash
  timeouts (17 calls with `"timeout":1200` in the signa session).

## Goal

- [ ] Nudges per 100 prompts in long multi-item orchestration projects (signa,
  sweatr, or their successors) are below 6 over three weeks after the change,
  with at least 20 prompts after the split.
- [ ] No paid usage credits are used without the user's approval in that period.

## Root cause analysis

1. Why does the user type "continue"? The orchestrator ended its turn while
   work was unfinished. *Confirmed* from the session text above.
2. Why did it end the turn? The pair skill said "let it block … or run it in the
   background", but gave no way to wait for a background run and no rule against
   ending the turn. The model filled the gap with progress updates. *Confirmed*:
   SKILL.md before this change.
3. Why did it stop between items? Nothing said to continue a multi-item task
   after shipping one item. The default is to report and wait. *Confirmed*.
4. Why did limits stop it? Quota limits are a real stop, and the user chose to
   keep them as stops (no automatic fallback). But the run did not detect them.
   A worker stuck on a limit was only noticed when the orchestrator looked at
   it. *Confirmed* for 22 + 14 errors; detection *suspected* to cost
   wall-clock time rather than nudges.

## Countermeasures

### C1: `wait` command and status file for pair runs

- Addresses: cause 2
- Prediction: orchestrators call `pair.mjs wait <run-id>` repeatedly instead of
  ending the turn, so nudges that follow a "workers still running" message
  disappear.
- Check: `hansei.mjs --split 2026-11-13`, then read the assistant text before
  any remaining nudges in signa or sweatr.
- Result: pending

### C2: Keep-going and stop rules in pair, pair-work, pair-review skills

- Addresses: causes 2 and 3
- Prediction: after shipping one item, the orchestrator starts the next item
  without a prompt and sends a Threema update when `threema_send` is available.
- Check: same split. Count nudges whose previous assistant text ends with "Next:".
- Result: pending

### C3: Stop on provider limits and paid credits, and detect them

- Addresses: cause 4
- Prediction: limit stops show up as `wait` → `stopped` with the provider line,
  within about 30 s of the worker going idle rather than after the 60 m turn
  timeout. No paid-credit charges without approval.
- Check: `status.json` of the next stopped run. The error summary of the next
  30 days shows no new "charged to … usage credits" lines unless approved.
- Result: pending

### C4: Opt-in global rules file

- Addresses: causes 3 and 4 outside pair runs
- Prediction: the same keep-going, limit, and Threema rules apply in every
  project without being copied into each project's AGENTS.md.
- Check: `pi --verbose` lists `~/.pi/agent/AGENTS.md`. Project sessions follow
  the rules in the same split.
- Result: pending

## Implementation plan

- [x] C1: `pair.mjs wait`, `status.json` (running/done/stopped/failed), shared by pair-review and pair-work, with fixture tests
- [x] C3: detect usage-limit and paid-credit lines on an idle worker's screen and stop the run as `stopped`
- [x] C2: "Waiting and stops" section and background `run` + `wait` in all three SKILL.md files
- [x] C4: `context/AGENTS.global.md`, README and AGENTS.md notes, symlink `~/.pi/agent/AGENTS.md`
- [ ] Ship and confirm CI on the pushed commit
- [ ] After about 3 weeks: `node skills/hansei/hansei.mjs --split 2026-11-13` and record results

## Follow-up

Pending the check. If nudges stay above 6, read the sessions behind them. If the
remaining nudges come from limit stops, revisit the decision to keep limits as
hard stops (for example, a pre-approved fallback model).
