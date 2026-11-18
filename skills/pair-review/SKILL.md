---
name: pair-review
description: Runs a read-only pair review between two separate, visible Pi workers — a lead reviewer (Claude Opus 5.5 via the Claude Code subscription) and a peer reviewer (GPT-6.1 Sol at xhigh thinking via the OpenAI provider) — in new Herdr or Rex panes, or attachable Herdr core terminals over SSH. They review independently, cross-check each other's findings, and the lead writes one consolidated review. Use when the user invokes /pair-review or asks for a pair review or second-opinion review of a diff, branch, commit, or PR. For writing or changing code with an implementer and an auditor, use the pair skill (/pair) instead; for non-coding work with a doer and a verifier, use pair-work (/pair-work).
---

# Pair review

```mermaid
flowchart LR
    you["/pair-review target"] --> detect["pair-review.mjs detects<br/>Herdr or Rex"]
    detect --> lead["Lead reviewer<br/>claude-code/claude-opus-5-5"]
    detect --> peer["Peer reviewer<br/>openai/gpt-6.1-sol:xhigh"]
    lead -- "independent review" --> cross["Cross-check<br/>each other's findings"]
    peer -- "independent review" --> cross
    cross --> final["Lead consolidates<br/>one review + verdict"] --> you
    you --> close["pair-review.mjs close<br/>this run's reviewers"]
```

You orchestrate; you do not review alone or edit. This is the review
counterpart of the `pair` skill: `/pair` builds a change with an implementer and
an auditor, while `/pair-review` only reviews existing work and changes nothing.
`{baseDir}/pair-review.mjs` (Node.js 22+, no dependencies) reuses the worker
transport in `../pair/pair.mjs`, so keep both skill folders installed together.
It starts two interactive `pi` workers, in new panes next to yours or as Herdr
core terminals (see Environment), and relays turns through Markdown files.
These are separate workers, not subagents or one-shot `pi -p` runs.

## Environment

The same as `pair`; read its Environment section. Run
`node {baseDir}/pair-review.mjs doctor` first: one pass/fail line per check
(multiplexer, `pi`/`node`/worker `PATH`, each reviewer's model, and a
`pi --version` dry launch in a real pane through the workers' launcher), with a
fix for every failure. **If it fails, report its output and stop.** Write no
wrapper scripts, and set no `PAIR_PI_BIN`, `HERDR_APP_BIN`, `HC_BIN`, `REX_BIN`,
or model overrides on your own. `detect` prints a verdict and the reason for
each path tried: `herdr: panes via herdr-app (…)`, `herdr: panes via hc
labels`, `herdr: core-only (…)`, `rex`, or `none: <reason>`; `models` prints
the model each reviewer would use.

- `HC_TERMINAL_ID` names a Herdr Core terminal; it does not mean the desktop
  app CLI (`herdr-app`) is on this machine. Herdr over SSH is supported:
  `herdr-app` is found through `HERDR_APP_BIN`, `PATH`, `~/.local/bin`, the
  macOS/Windows/Linux install folders and, under WSL, the Windows
  `%LOCALAPPDATA%` through `cmd.exe` + `wslpath`. When it is missing or cannot
  see your terminal but `hc` can, the reviewers run as `hc run --bg`
  terminals; if your terminal carries `herdr.space`/`herdr.tab`, those labels
  are copied on as a placement request: with both, the caller's tab (split vs.
  new tab unverified); with the space alone, Herdr picks a tab in that space.
  Read `hc --skill` when choosing or debugging the transport.
- Missing `herdr-app` alone is not a reason to stop; never tell the user to
  install the desktop CLI on a remote machine.
- Rex needs its `rex` CLI on the machine you run on (`REX_BIN`, `PATH`, the
  macOS app/Rex Server bundles, `%LOCALAPPDATA%\Programs\Rex` on Windows, the
  Linux install folders). A remote shell inside a Rex block has the `REX_*`
  variables but no CLI: `detect` then says `none: REX_* set but no rex CLI here
  (remote Rex block?)` and `run` stops before a pane. A forwarded socket is
  control-only (`rex split` still starts its command on the server's machine),
  so report it and run the pair where the Rex terminals run — a block on the
  machine that runs the Rex server. Do not install anything yourself.
- Core-only reviewers are not placed in the app at all. hc-label reviewers are
  `hc` terminals whose rendering (split vs. new tab) is unverified, so do not
  claim a split either. Give the user the terminal ids that `run` prints, with
  `hc attach <t>` (Ctrl+\ detaches) or Herdr's terminal list as the fallback.
- If detection prints `none`, tell the user that `/pair-review` needs Herdr (a
  working `hc` that sees `$HC_TERMINAL_ID`) or Rex, quote the reason, and stop,
  unless the prompt explicitly asks for another approach. If both are detected,
  ask which one to use and pass `--mux` to `doctor` and `run`.

Herdr reviewers are identified by terminal address (`t7`) and Rex reviewers by
block ID. The `pair` skill page explains the overrides (`HERDR_APP_BIN`,
`HC_BIN`, `REX_BIN`).

## Models

The same as `pair`, with the reviewers' roles: `node {baseDir}/pair-review.mjs
models` (which `doctor` also runs) prints the model each reviewer would use,
why, and the ready alternatives. Defaults are ordered preferences, the first
ready one wins (lead `claude-code/claude-opus-5-5` →
`anthropic/claude-opus-5-5`, peer `openai/gpt-6.1-sol:xhigh` →
`opencode/gpt-6.1-sol:xhigh`); the lead also tries
your own model (`PI_PROVIDER`/`PI_MODEL`) first, and the peer follows its own
list, so the two can share a model when that is all that is ready. If nothing
is ready, `run` stops before opening panes and names the alternatives: report
that and ask the user. Never switch a model to another provider on your own;
pass `--lead-model`/`--peer-model` if the user wants specific or different
models.

## Run

1. Write the review target to a temporary Markdown file **verbatim**: what to
   review (working tree, `main..HEAD`, a commit, or PR number), its intent,
   and any focus areas. Add only facts the reviewers cannot discover, such as
   the base branch. If no target is given, review the uncommitted working-tree
   changes. If there are none, review the current branch against its upstream
   or default branch.
2. Apply overrides from the prompt: rounds, models, or another multiplexer.
   Otherwise use the detected preferences (see Models); do not substitute
   another provider for the same model on your own.
3. Start the review in the background, then follow it with `wait` until it
   ends. `run` prints its run id (`pair-review.mjs run …: follow it with … wait <id>`),
   and its report folder holds `status.json`:

   ```sh
   node {baseDir}/pair-review.mjs run --task-file /tmp/pair-review-task.md > /tmp/pair-review.out 2>&1 &
   node {baseDir}/pair-review.mjs wait <run-id>          # blocks up to 15m; repeat while it prints "running"
   ```

   Run each `wait` with a tool timeout longer than `--timeout` (default 15m).
   `wait` prints `running` (call it again), the full result when `done`,
   `stopped` on a provider limit, or `failed`; see *Waiting and stops*.
   For example, with overrides:

   ```sh
   node {baseDir}/pair-review.mjs run --task-file /tmp/pair-review-task.md
   node {baseDir}/pair-review.mjs run --task-file /tmp/pair-review-task.md --rounds 2 \
     --lead-model claude-code/claude-opus-5-5:high --peer-model openai/gpt-6.1-sol:xhigh
   ```

| Flag | Meaning |
| --- | --- |
| `--rounds <n>` | cross-check rounds after the independent reviews (default 1) |
| `--lead-model`, `--peer-model` | Pi `provider/id[:thinking]` |
| `--mux herdr\|rex` | override detection (Herdr still picks panes or core-only itself) |
| `--turn-timeout <dur>` | limit per turn (default `60m`) |
| `--cwd <dir>`, `--json` | worker directory; machine-readable result |

Sequence: both reviewers review at the same time without reading each other's
work. In each round, each reviewer confirms or disputes the other's findings
with evidence and adds anything both missed. The lead then merges all reports
into one review ordered by severity. Each finding is marked agreed or disputed,
and the review ends with a verdict. Reports go under
`$TMPDIR/pi-pair-review/<timestamp>/`.

## Waiting and stops

A run takes many minutes per turn. While it is running, **do not end your
turn** to post progress: keep calling `wait` until it prints `done`,
`stopped`, or `failed`. Ending the turn while workers run leaves the user to
type "continue". Between `wait` calls you may read reports or worker screens,
but do not send input to the workers.

**Tasks with several items** (a roadmap, an A3 plan, a list of issues): after one
item is finished, checked, and shipped where the user asked for shipping, close
its workers and start the next item without asking. Keep progress in the A3 or
plan file so a later session can resume. Stop and hand back only when every
item is done, on a blocker you cannot resolve, or on a decision only the user
can make.

**Provider limits stop the run.** When `wait` prints `stopped` (a worker hit a
plan usage limit, or a request was charged to paid usage credits), stop and
ask the user how to continue. Do not switch the worker to another model or
provider, enable paid credits, or restart the run on your own.

**Threema, when available.** If a `threema_send` tool is available, send a
short message after each shipped item ("<item> shipped, CI green; starting
<next>") and keep working without waiting for a reply. Also send one when you
stop for a limit, blocker, or decision. Without that tool, send nothing; the
A3 or plan file is the record.

## Report back

Read the consolidated review. Spot-check its blocker and major findings against
the code yourself; a reviewer's claim is not proof. Present the findings by
severity with file:line, note disputed findings with both positions, and give
the verdict. Do not fix anything unless the user asks. If they do, that is a
separate task, and `/pair` may suit it. Say where the reviewers are: in panes, or
the core-only terminal ids and how to attach. On timeout or a missing
reviewer, read it (`hc read <t> --lines 100` / `rex capture`) and the report
directory, then report what happened. Do not restart the review or start
replacement reviewers automatically.

## Clean up

You own the reviewer pair you started; close it when the review is complete.
After reading and checking the consolidated review, close both reviewers with
the command that `run` printed:

```sh
node {baseDir}/pair-review.mjs close <lead> <peer> --mux herdr --run <run-id>
node {baseDir}/pair-review.mjs close <lead> <peer> --mux rex
```

It refuses your own terminal or pane; in Herdr it also refuses terminals
without a `pair.run` label and, with `--run`, another run's workers. The
reports stay, so cite their paths. Close only the reviewers this run created.
Keep them open only if the user asked to, a reviewer is waiting on `/login`,
or a failed run still needs a person to look at them. In those cases, say
which reviewers are open and why. Close completed
pairs before you start another `/pair-review` or `/pair` run.

## Safety

- Both reviewers are read-only: no file edits, staging, commits, pushes, or
  posting review comments on GitHub. Posting a review needs explicit approval
  and is done by you, not by a worker.
- They share your working tree, so do not edit files while the review runs.
- Do not send input to a reviewer while a turn is running.
- If a reviewer shows a login or provider error, ask the user to log in with
  `/login` in that reviewer (core-only: `hc attach <t>`). Never handle credentials yourself.
