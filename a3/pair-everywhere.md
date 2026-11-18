---
title: Pair skills start reliably everywhere
status: open
owner: idar
updated: 2026-11-18
---

# Improve pi-kit `pair`, `pair-review` and `pair-work`

Plan for making the three pair skills start reliably in **every environment**
(Windows, macOS, Linux; local or remote) and with **every authenticated
provider**, without the orchestrator needing hints from the user.

Target repo: `github.com/ulvestuen/pi-kit` (`skills/pair/pair.mjs` holds the
shared transport; `pair-review.mjs` and `pair-work.mjs` reuse it).

## Progress

| Step (section 4) | Status | Notes |
|---|---|---|
| 1. A1–A4 + F1 | done | `workerEnv()` takes the caller env minus `PI_SESSION_*`, `PI_CODING_AGENT`, `HC_*`, `REX_*`, `PWD`/`OLDPWD`/`_`/`SHLVL`, and readonly/per-process shell state (`SHELLOPTS`, `BASHOPTS`, `UID`, `RANDOM`, `PS4`, …), which the launcher would otherwise replay as `export NAME=value` and abort on (`SHELLOPTS: readonly variable`); none of it configures a worker, so it is dropped rather than assigned and the error ignored. No multiplexer CLI has an env option (`hc run --help`, `rex split --help`, `herdr-app commands`), so a 0700 `launch.sh` in the run folder first empties the core's inherited environment, keeping only the worker's own `HC_*`/`REX_*`/`HERDR_*` identity, then exports the snapshot and runs absolute `pi`. The names to clear come from the shell's own `export -p` (a POSIX builtin): a bare `env` was not on the core's PATH in the very case the launcher exists for, and a failed enumeration now stops the launch (exit 78) instead of starting pi in the core's environment. The POSIX launcher's first command neutralises inherited shell options (`set +e +u +v +x`), because a core that exported `SHELLOPTS=xtrace` traced every provider value the launcher exported, `verbose` echoed its source, and inherited `errexit` let a refused `unset` end the launch; the worker also inherits `SHELLOPTS` without those options. An early `trap _pair_exit EXIT` writes the exit record `launch.exit` (`<id> <code>`) on every termination path — including the exit-78 guard and a refused bootstrap assignment — so a worker that dies before Pi starts is never mistaken for one that is slowly starting; the identity variable is the selected mux's (`HC_TERMINAL_ID` for Herdr, `REX_BLOCK` for Rex) rather than whichever family the core happens to export, so a Rex worker with an inherited Herdr address is still matched; `launch.cmd` on Windows does not clear inherited variables yet (E1 owns the native launcher). `resolvePi()` resolves `PAIR_PI_BIN` (path vs. command name) and `pi` from PATH against the caller's directory, makes relative PATH entries absolute for the worker, and fails before any pane opens instead of recording a bare guess; `node` comes from pi's shebang, the caller's PATH, `pi-node` or `process.execPath`, first on PATH. `status.json.launch = {pi, node, PATH, launcher, shebang}`. Startup check: a reported agent `error` (even at turn > 0), an exit, a startup-error screen, or idle at turn 0 for 20 s ends the run `failed` with the screen tail and launch record; the screen is only classified once the worker itself reported a status, so neither Rex (no status) nor a Herdr worker without OSC status is judged on transcript text, and both rely on the recorded exit. F2-lite: the baseline for "this turn started" is the turn the previous turn ended on, so a send that already advanced and went idle again still counts, and a turn's ambiguous screen text (login banners) is judged only once that turn was observed. Provider limits are checked on every poll independently of that gate, including where no status exists, and end the run `stopped`. |
| 2. C2 | done | `bareId()` matches a qualified `ubuntu/t57` (exact id first, then bare) in `appPaneOf`, `anchor` and `close`; the app still gets qualified panes, `hc` gets bare ids; `closeWorkers` compares bare ids for your own terminal and fetches ownership labels by bare id; the blocked/timeout hints say `hc attach <bare>` / `hc read <bare>`. |
| 3. B1–B5 | done | Defaults are ordered preferences per role in `pair/DEFAULTS.models` (`claude-code/claude-opus-5-5` → `anthropic/claude-opus-5-5`, `openai/gpt-6.1-sol:xhigh` → `opencode/gpt-6.1-sol:xhigh`), resolved before any pane opens: the first ready one wins, stopping at the first hit. Readiness is `pi auth check --model <provider/id> --json` (exit 0) plus `pi --list-models <id>` matched on the provider *and* model columns, run with the resolved `pi` and the launch PATH in `workerEnv()`, with a `:thinking` suffix stripped and every probe cached per run. The executable and PATH entries are resolved in the caller's directory while the probes run in the worker's (`--cwd` moves the worker, not the caller), so preflight and the launcher agree. For the role that matches the orchestrator (implementer/doer/lead) the caller's own `PI_PROVIDER`/`PI_MODEL` comes first when ready — Pi injects those into bash-tool commands (`docs/environment-variables.md`), so nothing needed to be added and outside Pi they are simply unset. `PI_MODEL` is the raw model id and may itself contain slashes (router providers), even starting with the provider's own name (`openrouter/free` is provider `openrouter`, id `openrouter/free`), so the provider is always `PI_PROVIDER` and the id is never prefix-stripped. Only declared candidates are tried, so a model id is never moved to another provider on our own; when none is ready the run stops before any pane with `<role> model <spec> is not ready: <detail>; also not ready: …; ready alternatives: …; pass --<role>-model`. Alternatives are derived from every probe the run made, after all discovery finishes, so one role's scan reaches the others; a role with nothing ready is probed past the first budget until a ready alternative is found or the catalog is exhausted, and an exhausted catalog is reported as `none found (checked N models)` rather than as a claim about the machine. Candidates put the roles' own model ids on their other providers first, then a provider-balanced sweep. `models [--json]` on all three scripts prints per role the chosen model, why, and the ready alternatives (exit 1 if a role has none). G4 tests: preference fallback, cache, caller model with a slash-containing id, caller-vs-worker directory split, checked override, no cross-provider pick, discovery past the first budget for two failed roles, the two-part stop message, no pane opened on a stop, and `models` for each workflow's role names, all with injected `exec` fakes; no live provider calls. **Readiness fix (step-4 part 1):** `pi auth check` builds its own model runtime without extension-provided providers, so on this machine it answered `invalid_state` for `claude-code/claude-opus-5-5` and `provider_not_found` for `claude-code` while `pi --list-models` listed the model and `claude auth status` said logged in — the implementer's first default was reported `(none ready)`, which would have blocked every default `/pair` and blocked exactly the provider from the original incident (#4). A listed model that auth check cannot resolve is now **listed, auth unverifiable**: usable, `verified: false`, shown as `ready (auth unverifiable)` with the reason in `models`/`doctor`, with the startup check (F1) as the backstop. To tell that apart from a real answer, the provider is asked once (`pi auth check --provider <p> --json`): `provider_not_found`/`invalid_state` means auth check cannot see the provider, while a real `not_ready` (`credentials_not_configured` for a built-in provider) still blocks. Tests cover the usable-but-unverified path, the blocking built-in path, and an authorized provider whose model stays unresolvable; live `models` on this machine resolves `PI_PROVIDER=claude-code PI_MODEL=claude-opus-5-5` to `claude-code/claude-opus-5-5`. |
| 4. F3–F4 | done | `doctor [--json] [--no-launch] [--mux herdr\|rex]` on all three scripts, through `doctorCommand` in `pair.mjs` with each workflow's role names. One pass/fail line per check plus one fix per failure: the multiplexer (`environment()` with a `trace` line for every path tried — `herdr-app` pane lookup, `hc get`, Rex variables, or the `--mux` selection), the launch resolution (`pi` and its source, `node` from the shebang/PATH/`pi-node`, and the worker `PATH`), B2 readiness per role (a `--<role>-model` override is checked as it would be used), and a dry launch. `--mux` is honoured exactly as a run honours it: it selects the transport, validates that mux's environment (`HC_TERMINAL_ID`, `REX_SESSION`/`REX_BLOCK`) and drops the ambiguity error, while an unknown value fails with a fix. The dry launch runs `pi --version` through the same `prepareLaunch` launcher and `transport` the workers use, in a real pane or core terminal, and collects the result from the launcher's exit record (single-line fallback when the multiplexer names the terminal differently) or, without a record, from a bare version line on screen or a startup-error line. **Every mux and Pi command doctor runs is bounded, and a timed-out child is terminated, not abandoned**: `run()` passes the bound to `execFile` with `killSignal: SIGKILL`, so a helper that installs a SIGTERM handler is still killed and reaped (two real-child tests, one of them SIGTERM-ignoring, assert bounded completion and that the PID is gone), while a race covers an injected transport that never settles; each phase has its own budget (launch `timeout`, default 15 s; cleanup 5 s; 20 s per detection/probe command), and a conclusive exit record is never held up by the screen read for more than 1 s. **A pane a failed split created is still closed**: the adapters report the new identity through `onSpawn` the moment the mux has created it — before Herdr's focus restoration or ownership labeling, which can stall after the creation — and the launcher writes its own identity to `launch.id` as soon as it starts, which recovers a creation answer that never arrives. **Creation and recovery have the same lifetime**: the split's commands may run through the launch window plus `cleanupTimeout`, cleanup waits that whole lifetime (not a slice) for the creation to report, and an identity that only surfaces after it — a split killed at its bound whose pane's launcher wrote `launch.id` anyway — is adopted in a window of its own (`closeTimeout`, default 5 s), with the close that follows getting a further window of its own so waiting for an identity can never starve it; only a creation the transport can prove never happened — the mux CLI was not on the machine at all (`ENOENT`/`EACCES`/`EPERM`), so no pane can exist — skips that search and the close; every other rejection is ambiguous (the server can create the pane and then lose the answer, or a killed child can leave one), so it is searched for in the same window, and the launcher folder is removed last. The failure carries `{id, closed, closeError}` and doctor prints what happened to it plus the `close` command when it could not be confirmed. **Cleanup is part of the check's success criteria**: it closes what it opened (twice if needed) and `closed` means a *transport-specific* confirmed absence — Herdr's `{"error":{"kind":"not_found"}}` from `hc get` for that terminal, or a successful Rex `block list` that no longer contains the block — never an arbitrary transport error, a timeout or generic "not found" prose (control socket, server or command not found), whose error is kept in `closeError`; a launch that worked but left a pane it could not confirm closed fails the check and names the exact `close` command. It removes its temporary launch folder last, because the launcher and its identity record live there. `--no-launch` skips the dry launch (and is rejected by other commands). Exit 0 when every check passes, 1 otherwise. Tests with fakes: a Rex pass, a Herdr app-pane pass (same `/bin/sh` cd wrapper, focus handed back, ownership labels, pane closed), a checked model override, a failing role plus failing dry launch with a fix line each and the pane still closed, `--no-launch`, no multiplexer, `--mux` selection with both variable families set (on all three entry points), an unknown `--mux`, a selection without its environment, a stalled capture and a stalled close (bounded failing results, two cleanup attempts, wall-clock checked), a creation whose focus/labeling stalls (the pane is still closed), a late split answer (adopted), one that arrives after any half-budget slice but inside the creation lifetime (adopted, block confirmed closed, nothing left outstanding), a split killed at its bound whose launcher records its identity after that lifetime (adopted and closed in the reserved window, with a close command that takes real time), a split whose CLI never ran (no waiting, no close attempted), a split rejected after the server created the block and before its launcher recorded it, with a connection reset and a `launch.id` written 100 ms later (recovered and closed, no block left), a lost creation answer (recovered from `launch.id`), a refused close with a still-readable pane, an unreachable mux during verification, and generic `control socket not found` / `command not found` prose (all unconfirmed, with the cleanup command and both fix lines where the launch failed too), positive Herdr `kind: not_found` and Rex block-list cases (including an empty list and another block's row), a Rex block-list answer that is not a list at all — `{}`, an error envelope, a row with no identity, unparseable output — which doctor reports as unconfirmed closure with the cleanup command, `run()`'s timeout killing a child that exits and one that ignores SIGTERM, and the timeout/screen-error/screen-version/renamed-record paths. Live on this machine (Rex): 7 pass, 0 fail, ~2–3 s, block closed and the session left with only its own workers; `--mux rex` passes, `--mux herdr` fails with the trace of both paths. F4: all three SKILL.md files say to run `doctor` first, report its output and stop if it fails, and not to write wrappers or set override variables on their own, integrated into the existing `detect`/`models` guidance in Environment and Models, with `--mux` named for both `doctor` and `run`. |
| 5. C1 + C3 | done | `findHerdrApp` looks for the desktop CLI in this order: `HERDR_APP_BIN`; `PATH`; `~/.local/bin` (`HC_INSTALL_DIR`); platform install folders — macOS `/Applications/Herdr.app/Contents/MacOS/` and the same under `~/Applications`, probing both `herdr-app` and `Herdr` as the binary name (the real one here is `~/Applications/Herdr.app/Contents/MacOS/Herdr`, with `~/.local/bin/herdr-app` a symlink to it), `%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe` on Windows, that same Windows path through `cmd.exe /c echo %LOCALAPPDATA%` + `wslpath -u` when WSL is detected (`WSL_DISTRO_NAME`, or `/proc/version` containing `microsoft`), and `~/.local/share/herdr-app`, `/opt/herdr-app`, `/usr/bin` on Linux. Every candidate probed is traced as found or missing with its source (`herdr-app: /first/herdr-app missing (PATH)`), including candidates rejected before a later hit, and `exists`/`exec`/`readFile`/`platform` are injected, so G2 covers every platform (including the WSL bridge) without a Windows box (`discovery.test.mjs`). C3.1: when no app pane shows the caller, `probeHerdr` reads `hc get $HC_TERMINAL_ID` for labels; if they carry `herdr.space`, the layout is `labels` and the caller's `herdr.space` (plus `herdr.tab` when present) is copied onto every worker's `hc run`, so the app can place them with no app CLI on the remote box. These labels are a placement *request*, not a confirmed layout: with both, `run` reports "Worker terminals requested in the caller's Herdr tab by hc labels (split vs. new tab unverified)"; with the space alone, "…requested in the caller's Herdr space by hc labels (Herdr picks their tab)", matching what `herdr-app --skill` says (a tab is created in the space). A `herdr.tab` without a `herdr.space` places nothing and stays core-only. No `herdr.place` label was invented (open question 6). `run`/`formatResult` keep the `hc attach` commands as the fallback; `detect --json` uses `layout: panes\|labels\|terminals` plus `trace`, `app`, `appHow` and `placement` (`{space, tab?}`), and a run result with `labels` carries the same `placement` (Rex has no `layout`). C4: `detect` prints the verdict followed by the reason for every path tried, and `doctor`'s mux line uses the same verdict — `herdr: panes via herdr-app (HERDR_APP_BIN)`, `… (PATH)`, `… (WSL bridge)`, `herdr: panes via hc labels (tab requested; split vs. new tab unverified)` or `(space requested; Herdr creates a tab in it)`, `herdr: core-only (…app reason)`, `rex (Rex panes)`, or `none: <reason>`. All three SKILL.md Environment sections name the discovery order, the label path and WSL, and keep "missing `herdr-app` alone is not a reason to stop". Live here (macOS, inside Rex): `findHerdrApp` found `~/.local/bin/herdr-app` via `PATH`; with that folder off `PATH` the bundle path is next; `HC_TERMINAL_ID=t1` with the real `hc` reported layout `labels` from the terminal's own `herdr.space`/`herdr.tab` while `herdr-app ls` said "no Herdr window" (the app was closed), which is exactly the remote case. Doctor's dry launch is requested in that tab via the copied labels, so the label path is used by the check too. |
| 6. E1–E4, D1–D3 | done (audited) | **E1, no `/bin/sh`.** `herdr-app commands` shows `pane.split` takes no folder (`terminal.open` has `folder` and `place`, but it places relative to the *focused* pane, not the anchor pane a run splits), so the launcher changes directory itself and the `/bin/sh -c 'cd -- "$1" && …'` wrapper is gone: `pane.split` gets `[launcher, --model, …]` and the launcher is started directly (POSIX, through its shebang) or as `launch.ps1` under Windows PowerShell 5.1 (`-NoProfile -ExecutionPolicy Bypass -File`). **PowerShell, not batch (round-1 audits 3 and 5):** a batch launcher that runs npm's batch `pi.cmd` either transfers execution to it — the exit record is never written — or uses `call`, which re-parses `%*`; and batch cannot write a legal path such as `C:\%ALIAS%\repo` literally without a multi-pass `%` analysis. The script keeps full parity: `$ErrorActionPreference='Stop'`; identity first (`$env:HC_TERMINAL_ID`/`REX_BLOCK`, else `?`) written to `launch.id`; the inherited environment cleared from `[Environment]::GetEnvironmentVariables()` keeping only `HC_`/`REX_`/`HERDR_` (an empty enumeration exits 78 with a record); the snapshot set with `[Environment]::SetEnvironmentVariable`; folder via `Set-Location -LiteralPath` (record 1 on failure); `<id> <code>` appended to `launch.exit` on the normal, 78 and 1 paths; `exit $pairCode`. **Round-2 audit 4:** `launch.ps1` is written **UTF-8 with a BOM**, because PowerShell 5.1 reads a BOM-less script in the legacy ANSI code page and would corrupt a non-ASCII value or a Unicode user name; `launch.sh` stays BOM-less. **Round-2 audits 1–3, no `cmd` boundary anywhere:** npm's `pi.cmd` is resolved to the **Node entry point it runs** (`shimEntry` reads the one quoted `%~dp0…cli.js` path in the shim), and Pi is started as `node <entry> <args>` — by the launcher (`& "<node>" "<entry>" @args`), by every readiness probe (`modelChecker`) and by doctor's dry launch, all through `piCommand`. That removes three defects at once: `execFile(…, ["/c", "pi.cmd", …])` never encoded cmd's grammar (an argument like `a&echo` ran a second command), a `%`-named folder was expanded by cmd even though PowerShell quoted it, and a timeout killed `cmd.exe` rather than the Node process it started. A `.cmd` reaching `run()` is now an error ("cannot be started with its arguments intact"), and a shim whose entry cannot be read is refused in `resolveLaunch` before any pane with `set PAIR_PI_BIN to the .js entry or a pi .exe`. **Round-3 audit 1:** npm's shim can prefer a `node.exe` beside itself over the first `node` on PATH, so `shimParts()` returns both the entry and that interpreter, and `resolveLaunch` uses the shim's runtime for every probe and for the worker (a caller whose PATH holds an older Node still runs the installation's own). **Round-3 audit 2:** the `%~dp0` substitution is literal (a callback, so a folder such as `C:\users\$&\npm` is not read as `$&`) and adds the trailing separator `%~dp0` itself has before normalising, so both `"%dp0%\cli.js"` and `"%~dp0cli.js"` resolve. `prepareLaunch` takes `workdir` (worker folder) separately from `cwd` (caller folder, where relative `PAIR_PI_BIN`/PATH entries belong). **Round-2 audit 5:** Windows environment names are case-insensitive, so `launchEnv()` deduplicates the snapshot without case and replaces the caller's `Path`/`PATH` spelling with the resolved one (otherwise the second assignment dropped Node's folder), and `envGet()` reads `PATH`/`PATHEXT`/`SystemRoot`/`LOCALAPPDATA`/`USERPROFILE` the way Windows would. The POSIX launcher cds with `cd -- <quoted>` after clearing the environment. **E2/E3.** `executableNames()` returns only the `PATHEXT` names on Windows, both cases, with Windows' `.COM;.EXE;.BAT;.CMD` default, an explicit extension as given, and never the extensionless name: npm's `pi` shim is a `#!/bin/sh` wrapper Windows cannot start, so `pi.cmd`/`pi.exe` win (audit 1 of round 1). The extensions come from the caller's `env.PATHEXT` (`envGet`), threaded through `onPath`, `onPathFrom`, `resolvePi`, `resolveNode`, `resolveLaunch`, `findRex`, `findHerdrApp` and `findBin`; `findRex` therefore finds `rex.bat` under `PATHEXT=.BAT`. All of them split/join PATH with `pathOf(platform).delimiter` and use `pathOf(platform).join/isAbsolute/resolve/dirname`; no hard-coded `:`. **E4.** `linesOf()` splits `/\r?\n/` for every report, screen and record parse (`reportDone`/`waitForReport`, `launcherExit`, `dryExit`, `launch.id` recovery, `screenError`, `screenTail`, `usageLimit`, the dry-launch `versionOf`, `parseModelList`, `parseJson`, error text), and `reportDone()` normalises `\r\n` before the marker check. **D1.** `findRex()` tries `REX_BIN`, `PATH` (through the caller's `PATHEXT`), then the macOS app bundles plus the installed `~/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`, `%LOCALAPPDATA%\Programs\Rex` (`rex.exe`, `bin\rex.exe`, `Rex.exe`), and `~/.local/share/rex`, `~/.local/bin`, `/opt/rex`, `/usr/local/bin`, `/usr/bin` on Linux — tracing every candidate found or missing; `adapter("rex")` uses it, `probeRex()` feeds `detect`/`doctor`, and `runOptions` stops a run before a pane instead of failing at the first split. **D2, corrected after round-1 audit 4.** Rex has no Herdr-style label mode, and a forwarded socket is **control-only**: `rex hosts add LABEL unix:///tmp/rex.sock` over an `ssh -L` forward (or a `REX_SERVER` tailnet address) sends requests, but `rex split` still starts its command on the server's machine — where this box's launcher, repository, task and reports do not exist — so it is not remote worker-launch support. A remote shell inside a block reports `none: REX_* set but no rex CLI here (remote Rex block?)`, and the trace, `doctor`'s fix (`doctorMuxFix` picks its remedy from the detection reason: the flag for a refused/ambiguous `--mux`, this text for the no-CLI result, Herdr advice otherwise — round-1 audit 7), the `run` error and all three SKILL.md files say to run the orchestration where the Rex terminals run. D3: the Rex split starts the run's launcher (`rex split -s … -c <folder> --json -- <launcher> …`) and a test asserts that whole argv. **Tests:** `skills/pair/windows.test.mjs` (34 cases, injecting `platform`/env/fs, expectations with `path.win32`/`path.posix`; 2 are Windows-only and skipped here): `executableNames` order and env-derived `PATHEXT`, `pi.cmd` beating npm's `pi` shim, one PATH assignment for a caller spelling it `Path`, `shimParts`/`shimEntry` on npm's shim under a `%ALIAS% & caret^bang!` folder, under a `$&` folder and in the `%~dp0cli.js` form, the shim's own `node.exe` preferred over an earlier PATH Node (probe and launcher), `piCommand`, the refusal of a batch file / an unreadable shim, a real `run()` round trip of `%`, `^`, `&`, `"`, `!`, spaces, `\|` and an empty argument, the `.ps1` content (identity/exit records, clearing and keep rule, 78/1 records, literal values and paths, `@args`, `$LASTEXITCODE`, no batch constructs), the UTF-8 BOM byte assertion with a non-ASCII value, the PowerShell argv and `powershell()` fallback, a hung probe's Node child killed and reaped, the POSIX `cd --`, Rex discovery on all three platforms with `rex.bat` under a custom `PATHEXT`, the remote-block reason/verdict/trace and the ambiguity remedy, the no-CLI run stop, the Rex split argv, and CRLF reports/screens/exit records. Windows-only native fixtures: a real npm-style shim inside a literal `%ALIAS%` folder with a conflicting `ALIAS` value (arguments arrive verbatim, exit 7 recorded), and a non-ASCII env value plus Unicode folder through the real launcher. `npm test` (193 + 69, 2 Windows-only skips) and `git diff --check` pass; live `doctor` here is 7 pass, 0 fail. Remaining gaps: PowerShell 5.1 must exist (it ships with supported Windows), a MachinePolicy/UserPolicy execution policy still overrides `-ExecutionPolicy Bypass`, and a hand-written batch wrapper around Pi has no readable entry, so it is refused rather than run through cmd. **Audit round 3 closed:** both open findings are fixed and tested — (1) npm's shim may prefer a `node.exe` beside itself over the first `node` on PATH, so `shimParts()` returns the entry *and* its interpreter and `resolveLaunch()` uses it for the worker and every probe (test: `C:\tools\node.exe` beside the shim beats an earlier `C:\old-node\node.exe` on PATH, for the probe and the generated launcher); (2) the `%~dp0` replacement is a callback returning the literal folder *with* its trailing separator, then normalised, so `C:\users\$&\npm` stays a folder and the valid `"%~dp0cli.js"` form resolves. Re-run here after the fixes: `node --test skills/pair/windows.test.mjs` 32 pass / 2 Windows-only skips, full `npm test` 193 + 69, `git diff --check` clean, live `doctor` 7 pass / 0 fail. |
| 7. G8 | done | `.github/workflows/test.yml` is now a `fail-fast: false` matrix over `ubuntu-latest`, `macos-latest` and `windows-latest` (Node 22, `npm ci`). Every runner runs the full `npm test`; on Windows the three pair suites are also run first as an explicit file list, because `run` uses pwsh there and pwsh does not expand a glob for `node --test` the way a POSIX shell does — the list is independent of `package.json`, so a pair suite cannot silently drop out of the job that proves G8. Decision on the full suite: the other skill tests and the threema workspace use only `os.tmpdir`, `path.join`, `process.execPath` and injected `platform`, with no `/bin/sh`, `chmod` mode checks or hard-coded `:` PATH, so the full suite runs on all three runners instead of only on POSIX. The pair tests themselves were audited for host assumptions and now branch or skip explicitly: launcher name/content and the 0700 script assertions are host-branch or POSIX-only (the `.ps1` content test and the two native Windows fixtures in `windows.test.mjs` cover the Windows side), and the `resolvePi`/`detect` tests build PATH with `path.delimiter` and the platform's executable name (`pi.exe`, `herdr-app.com`); the two native Windows fixtures are `skip: process.platform !== "win32"`, so they run on `windows-latest` instead of skipping. **Audit round 1 (batch 6):** the run input-validation test now passes an explicit `REX_BIN: "rex"` fixture instead of requiring a real Rex install (the missing-CLI case keeps its injected-filesystem test in `windows.test.mjs`), and `findHerdrApp` builds every injected-platform path — macOS bundles, the Linux home install and the WSL bridge — with `pathOf(platform).join` (E3) instead of the host's `join`, so `discovery.test.mjs` passes with a Windows path API too (verified: 9/9 with native `join` replaced by `win32.join`, 4/9 before the fix). The YAML was parsed locally with Ruby's `YAML.load_file` (no repo dependency, no new package): one job, three-OS matrix, both steps and their conditions present. The matrix cannot be proven from here (no push); it ships with the orchestrator, who watches the run. |

## 1. What went wrong (evidence from one session, 17 Nov 2026)

Setup: Herdr desktop app on Windows. Pi, the repo and `hc` run in WSL Ubuntu,
which the app treats as the remote machine `ubuntu`.

| # | Symptom | Root cause | Where |
|---|---------|------------|-------|
| 1 | `detect` said `core-only … herdr-app ENOENT` even though the session was in a desktop pane | Only `herdr-app` on `PATH` and in `~/.local/bin` is checked. The real CLI was `/mnt/c/Users/<u>/AppData/Local/Programs/herdr-app/herdr-app.exe` | `findBin`, `herdrBins` |
| 2 | With `HERDR_APP_BIN` set, still `t57 is not shown in a Herdr app pane` | `herdr-app ls` qualifies remote IDs with a machine prefix (`ubuntu/t57`, `ubuntu/p…`, `ubuntu/sp…`). `appPaneOf` compares `t.terminal === id` exactly | `appPaneOf`, `anchor`, `close` |
| 3 | Both workers exited at once with code 127: `/usr/bin/env: 'node': No such file or directory` | Workers inherit the **herdr-core's** environment, not the caller's. Node comes from `fnm` (a per-shell PATH), so the core's PATH did not include it. `pi` is a `#!/usr/bin/env node` script | `spawn` → `split` argv |
| 4 | Doer: `No API key found for claude-code`, while the caller used `claude-code/claude-opus-5-5` fine | The `claude-code` provider checks auth by running `claude auth status`. `claude` lives in `~/.local/bin`, which was on the caller's PATH but not the worker's | Same env inheritance as #3 |
| 5 | The run reported `waiting for verifier` while the doer sat idle with an error | Launch-time failures (exit 127, auth error at prompt) are only noticed by the 15-poll `isAlive` check. An idle worker with an error banner is not a failure | `finish` / `waitForReport` |
| 6 | The orchestrator had to reverse-engineer the scripts and write two wrappers (`HERDR_APP_BIN` bridge that strips `ubuntu/`, `PAIR_PI_BIN` wrapper that pins PATH) | There is no supported knob for "launch workers with this environment"; no preflight to say what is wrong | — |

Also observed:

- `hc read` of a dead terminal printed nothing useful. The orchestrator needed
  `/proc/<pid>/environ` to find the PATH difference.
- `pi --list-models` and `pi auth check --provider <p> --json` already tell us
  which models and providers are ready. The skills do not use them.

## 2. Design principles

1. **Workers run in the caller's world.** A worker must see the same `PATH`,
   `HOME`, provider-related environment variables and working directory as the
   orchestrator that started it, unless told otherwise.
2. **Resolve, don't guess.** Find absolute paths for `node`, `pi` and
   multiplexer CLIs before launch. Store them in `status.json`.
3. **Preflight before panes.** Never open a pane for a worker that cannot start.
   Check the binary, the model and the provider's readiness, in the
   worker's environment, and fail with one actionable line.
4. **Fail fast.** A worker that exits or shows a startup or auth error within
   the first seconds ends the run as `failed` with the screen tail, not after
   a 15-minute wait.
5. **IDs are opaque and may be qualified.** Compare Herdr/Rex IDs through one
   normaliser that understands `machine/id`.
6. **One transport layer, three workflows.** All fixes go in `pair.mjs`, so
   `pair-review` and `pair-work` benefit without duplicate code.

## 3. Work items

### A. Worker environment (fixes #3, #4)

- A1. Add `workerEnv()` in `pair.mjs`: start from `process.env` (the caller),
  keep `PATH`, `HOME`/`USERPROFILE`, `XDG_*`, `PI_*` except session-specific
  ones (`PI_SESSION_*`, `PI_CODING_AGENT`), provider vars
  (`CLAUDE_CONFIG_DIR`, `PI_CLAUDE_CODE_*`, `ANTHROPIC_*`, `OPENAI_*`, …), the
  proxy variables, and `LANG`/`LC_*`. Default: pass the whole caller environment
  minus the drop list. Explicit allow-lists break whenever a new provider
  appears.
- A2. Pass that environment to the worker in a portable way, in this order:
  1. The multiplexer's own option, if it exists (`hc run --env K=V`,
     `herdr-app do pane.split {env:{…}}`, `rex split --env`). Ask the
     herdr-core/Rex maintainers to add one if missing; it is the cleanest fix.
  2. Otherwise a generated launcher in the run directory:
     - POSIX: `launch.sh` that `export`s the values and `exec`s the absolute `pi`.
     - Windows: `launch.cmd` or `launch.ps1` doing the same.
     Write it `0700`, and never print values that look like secrets. Prefer to
     forward only `PATH` and provider config locations, and let secrets come
     from the user's own files (`auth.json`, Claude config), not from argv.
- A3. Resolve `pi` to an absolute path, and resolve the interpreter it needs:
  read the shebang. If it is `#!/usr/bin/env node`, also resolve `node` from
  the caller's PATH (`process.execPath` is a reliable fallback, because the
  script itself runs on Node) and put its directory first in the worker's
  PATH. Do the same for `pi`'s managed `pi-node`.
- A4. Record `{pi, node, PATH}` in `status.json` → `launch`.

### B. Model and provider resolution (fixes #4, removes guessing)

- B1. Default models become **preferences, not fixed IDs**:
  `implementer: ["claude-code/claude-opus-5-5", "anthropic/claude-opus-5-5"]`
  and so on. Pick the first that is **ready**.
- B2. "Ready" = run, in the worker environment:
  - `pi auth check --model <provider/id> --json` (exit 0 = ready), and
  - `pi --list-models <id>` to confirm the model exists for that provider.
  Cache results for the run.
- B3. Respect the caller's current model: if `PI_PROVIDER`/`PI_MODEL` are set
  and the role has no explicit override, use them for the role that should match
  the orchestrator (implementer/doer/lead) when they are ready.
- B4. Never silently swap to a **different provider for the same model** (the
  SKILL.md rule stays). If no preference is ready, stop with:
  `doer model claude-code/claude-opus-5-5 is not ready: <auth check detail>; ready alternatives: …; pass --doer-model`.
- B5. Add `pair.mjs models [--json]`: prints, per role, the chosen model, why,
  and the ready alternatives. The skills tell the orchestrator to run it first.

### C. Herdr detection, local and remote (fixes #1, #2)

- C1. Find `herdr-app` in this order: `HERDR_APP_BIN`; `PATH`; `~/.local/bin`;
  platform install locations:
  - macOS: `/Applications/Herdr.app/Contents/MacOS/herdr-app` (and `~/Applications`).
  - Windows: `%LOCALAPPDATA%\Programs\herdr-app\herdr-app.exe`.
  - **WSL**: detect with `/proc/version` containing `microsoft` or `WSL_DISTRO_NAME`.
    Then resolve the Windows user profile through
    `cmd.exe /c echo %LOCALAPPDATA%` + `wslpath`, and try
    `<that>/Programs/herdr-app/herdr-app.exe`.
  - Linux: `~/.local/share/herdr-app/…`, `/opt/herdr-app/…`, `/usr/bin/herdr-app`.
- C2. **Normalise IDs**: `bare(id) = id.split("/").pop()`, and compare a
  terminal's bare address with `$HC_TERMINAL_ID`. Keep the qualified pane ID
  as returned (`ubuntu/p…`) when calling `pane.split`, `pane.focus` and
  `pane.close`, because the app needs the machine. Apply this in `appPaneOf`,
  `anchor`, `close` and `closeWorkers`' ownership check.
- C3. **Remote desktop panes without a local `herdr-app`** (SSH from a Mac,
  Windows or Linux desktop to a box). The app runs on the user's machine, and
  only `hc` exists remotely. Options, best first:
  1. Use hc labels: the skill doc already says a terminal started with
     `hc run --label herdr.space=<id> --label herdr.tab=<id>` opts into the
     window. Copy `herdr.space`/`herdr.tab` from the caller's own terminal
     (`hc get $HC_TERMINAL_ID` → `labels`) onto worker terminals. The app then
     shows them in the caller's tab **with no app CLI on the remote box**. This
     is the key change for remote use. Verify layout (split vs. new tab) with
     the herdr maintainers; add a `herdr.place=right|down` label if needed.
  2. If the app exposes a socket/API through the hc connection, use it.
  3. Otherwise keep core-only, but print the exact `hc attach` commands, as now.
- C4. `detect` prints a verdict **and** the reason for each path tried:
  `herdr: panes via herdr-app.exe (WSL bridge)`, `herdr: panes via hc labels`,
  `herdr: core-only (…)`.

### D. Rex, local and remote

- D1. Find `rex` via `REX_BIN`, PATH, macOS `.app` helpers (already done),
  Windows `%LOCALAPPDATA%\Programs\Rex\…`, and Linux install dirs.
- D2. When `REX_SESSION`/`REX_BLOCK` are set but the `rex` CLI is not on the box
  (remote shell inside a Rex block), check whether Rex has a remote mode like
  Herdr's labels or a control socket forwarded over SSH. Document the
  supported path and the fallback, as for Herdr.
- D3. Pass worker env as in A2 (`rex split` env option or the launcher).

### E. Windows-native support

- E1. No `/bin/sh` assumptions. Today `herdrAdapter.split` wraps the command in
  `/bin/sh -c 'cd -- "$1" && …'`. Use the multiplexer's folder option where it
  exists (`terminal.open --folder`, `hc run --cwd`); otherwise generate a
  `.cmd`/`.ps1` launcher on Windows and a `.sh` one elsewhere.
- E2. Resolve executables with `PATHEXT` on Windows (`pi.cmd`, `node.exe`).
  `onPath` currently joins `name` only and misses `pi.cmd`.
- E3. Use `path.delimiter` (`;` on Windows), not a hard-coded `:`, in `onPath`.
- E4. Line endings: the report-done marker check should trim `\r\n`.

### F. Fail fast and diagnose (fixes #5, #6)

- F1. After `spawn`, wait up to ~20 s for one of: Pi reports `idle`/`working`
  over OSC 7501 **and** turn > 0 or status `working`; or the terminal exits;
  or the screen shows a known startup error (`No API key found`,
  `Model not found`, `command not found`, `No such file or directory`,
  `/login`). On failure, end the run `failed` with the screen tail and the
  launch record from A4.
- F2. During a turn, treat "idle and no report file and the screen shows an
  error" as `failed` (or `blocked` for login prompts), checked every poll,
  not every 15th.
- F3. Add `pair.mjs doctor [--json]`: run C/D detection, A3 resolution, B2
  readiness for each default role, and a dry launch of `pi --version` through
  the same multiplexer path as the workers (so the worker environment is
  tested, not the caller's). Show pass/fail and a fix per line.
- F4. SKILL.md (all three): "Run `doctor` first. If it fails, report its
  output. Do not write wrappers or set override variables on your own."

### G. Tests

Use the fakes already there (`fake-herdr.mjs`, injected `exec`/`env`):

- G1. `appPaneOf` matches `ubuntu/t57` against `t57`; `close` uses the qualified pane.
- G2. `findBin` finds `herdr-app.exe` through a fake WSL `LOCALAPPDATA`.
- G3. The worker launcher sets PATH so `node` and `claude` resolve when the fake
  core's PATH lacks them (assert the generated launcher content and the argv).
- G4. Model resolution: first preference not ready → second is chosen; none ready →
  clear error; never a cross-provider swap of the same model id.
- G5. Fail fast: a fake worker that exits 127 in 1 s ends the run `failed`
  within the startup window; a screen with `No API key found` ends `failed`.
- G6. Windows: `onPath` with `PATHEXT` and `;`; launcher is `.cmd`.
- G7. Remote-label path: worker `hc run` carries the caller's `herdr.space`
  and `herdr.tab` labels.
- G8. A CI matrix (GitHub Actions `ubuntu`, `macos`, `windows`) running
  `node --test skills/pair*/**/*.test.mjs`.

## 4. Order of work

1. A1–A4 + F1 (biggest win; fixes both failures seen here, works for every mux).
2. C2 (one-line class of bug, unblocks remote Herdr panes in WSL).
3. B1–B5 (model/provider readiness and `models` command).
4. F3–F4 `doctor` + SKILL.md wording.
5. C1 + C3 (WSL/Windows/macOS app discovery; label-based remote panes).
6. E1–E4 Windows native, then D1–D3 Rex parity.
7. G8 CI matrix.

## 5. Acceptance criteria

Each scenario: `/pair-work <small task>` with **no** env overrides and no
orchestrator workarounds → both workers start in visible panes, use ready
models, and the run reaches a verdict.

| Desktop app | Where pi runs | Mux | Expected |
|-------------|---------------|-----|----------|
| Herdr, Windows | WSL (as remote `ubuntu`) | herdr | panes in caller's tab |
| Herdr, Windows | Windows native | herdr | panes |
| Herdr, macOS | local | herdr | panes |
| Herdr, Linux | local | herdr | panes |
| Herdr, any OS | SSH remote Linux box | herdr (hc only remotely) | panes via labels (C3.1), else core-only with attach commands |
| Rex, macOS | local | rex | panes |
| Rex, any OS | SSH remote box | rex | panes or documented fallback |

Plus:

- Node via `fnm`/`nvm`/`volta`/`mise`, not on the core's PATH → workers still start.
- `claude-code` provider with `claude` only in `~/.local/bin` → the doer is ready.
- Default model not authenticated → run stops before opening panes, naming ready alternatives.
- A worker that dies at launch → `failed` within ~20 s, with its screen tail.
- `doctor` output alone is enough to say what is wrong in every failed case above.

## 6. Verification still needed

The matrix and the POSIX branches are covered, but these acceptance scenarios
(section 5) need a real machine and could not be run here:

- **Herdr on Windows, Pi native.** `windows-latest` proves the launcher, shim,
  PATHEXT and CRLF code paths and runs the two native fixtures, but not a real
  Herdr app: pane placement, `hc` status and the exit record in a real pane.
- **Herdr on Windows with WSL as the remote machine `ubuntu`.** C1's
  `cmd.exe` + `wslpath` bridge and C2's qualified `ubuntu/t57` ids are tested
  with fakes; the real app plus WSL combination is the original incident.
- **Herdr on an SSH-remote Linux box (hc only).** The label path (C3.1) is
  tested through `hc` labels; whether the app splits beside the caller or opens
  a tab at the label's position is still open question 1 below.
- **Rex on an SSH-remote box.** D2's answer is control-only; confirm on a real
  remote that the documented "run the orchestration where the Rex terminals
  run" fallback is what the skill reports there.
- **A restrictive PowerShell execution policy.** `-ExecutionPolicy Bypass`
  loses to a MachinePolicy/UserPolicy setting; only a managed Windows box can
  show the resulting launcher error.

## Shipped (2026-11-18)

- `c3f3cb3` (all seven steps): ubuntu and macos green; windows failed one
  non-pair test, `decisions.test.mjs`, because the Windows checkout turned
  SKILL.md into CRLF and its example regex expected `\n`.
- `ea56e9b` (that test normalises CRLF): green on all three runners,
  https://github.com/ulvestuen/pi-kit/actions/runs/44243651583.
  On `windows-latest` the full `npm test` passed with 186 pass, 0 fail and
  9 skipped (only POSIX launcher/shebang tests, each with its reason); threema
  passed 69/69. Both Windows-only native fixtures ran and passed
  (`runs a real npm-style shim…`, `round-trips non-ASCII…`).
- Live on macOS in Rex: `pair.mjs doctor` 7/7 pass, including a real dry
  launch. Every pair run since batch 2 started its workers through the new
  launcher.
- Remaining before `status: closed`: the real-machine scenarios in section 6.

## 7. Open questions for the Herdr maintainers

- When an `hc run` terminal carries the caller's `herdr.space` and `herdr.tab`,
  does the app place it as a split beside the caller, or as a new tab at that
  tab's position? C3.1 assumes only "somewhere in the caller's tab"; confirm
  the behaviour, and say whether a placement hint exists or is planned (for
  example a `herdr.place=right|down` label). No such label is invented here
  until `herdr-app --skill` documents one.
- Is copying the caller's `herdr.tab` the intended way to land in the same tab,
  or is `herdr.space` alone plus the app's own tab choice the supported answer?
- Should placement labels be part of `hc --skill`/`herdr-app --skill`, so remote
  orchestration can document them instead of inferring from labels?
- On WSL, is `cmd.exe` + `wslpath` the supported way to reach a Windows
  install, or should a herdr-core machine entry (`hc machine`) be preferred?
