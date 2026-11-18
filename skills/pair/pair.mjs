#!/usr/bin/env node
// Pair programming between two visible Pi workers: an implementer and an auditor.
// Detects Herdr (herdr-core `hc`, with herdr-app panes when that CLI can see the caller) or Rex,
// starts one interactive worker per role, and relays turns through files.
// Zero dependencies; Node.js 22+.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULTS = {
  rounds: 3,
  turnTimeout: "60m",
  // Ordered preferences per role, not fixed IDs: the first model that is ready in the worker's environment is used.
  models: {
    implementer: ["claude-code/claude-opus-5-5", "anthropic/claude-opus-5-5"],
    auditor: ["openai/gpt-6.1-sol:xhigh", "opencode/gpt-6.1-sol:xhigh"],
  },
};
export const DONE = "<!-- pair:done -->";
/** The Rex app bundles under `/Applications`, whose helper carries the `rex` CLI. */
const REX_APP_BINS = ["/Applications/Rex.app", "/Applications/Rex Beta.app"].map((app) => `${app}/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`);

/**
 * Path rules for the platform being reasoned about, not the one this process runs on: a `win32` test on macOS must
 * still split `PATH` on `;` and join `C:\dir` with `\\`. Injecting `platform` (with `exists`) is what makes the
 * Windows paths testable here and keeps the same tests honest on a Windows runner.
 */
const pathOf = (platform = process.platform) => (platform === "win32" ? win32 : posix);
const pathDelimiter = (platform = process.platform) => pathOf(platform).delimiter;

/** Windows' own default when `PATHEXT` is missing from the environment. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * The file names to try for an executable. On Windows a command name is not a file name: `pi` is `pi.cmd` or
 * `pi.exe`, resolved through `PATHEXT`, so `onPath('pi')` has to do the same or it misses the real launcher (E2).
 *
 * Only the `PATHEXT` names are candidates, and they come before nothing else: npm installs both `pi` (a `#!/bin/sh`
 * wrapper only a POSIX shell can run) and `pi.cmd`, and the extensionless file is not something Windows starts, so
 * choosing it merely because it exists would point every worker and every readiness probe at a file Windows cannot
 * execute (audit 1). A name that already carries an extension is tried as given. `pathext` is the caller's own
 * environment value, never this process's: an injected Windows environment is judged by its own `PATHEXT` (audit 6).
 * Case is tried both ways, because a fake filesystem (and a case-sensitive one) is not the shell's lookup.
 */
export function executableNames(name, { platform = process.platform, pathext } = {}) {
  if (platform !== "win32" || /\.[^\\/]+$/.test(name)) return [name];
  const exts = String(pathext || DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
  const names = [];
  for (const ext of exts) for (const variant of [ext.toLowerCase(), ext.toUpperCase()]) names.push(name + variant);
  return [...new Set(names)];
}

const ROLES = ["implementer", "auditor"];
const CALLER_ROLE = "implementer";

const USAGE = `Usage:
  pair.mjs detect [--json]
  pair.mjs models [--json]   the model each role would use, why, and the ready alternatives
  pair.mjs doctor [--json] [--no-launch] [--mux herdr|rex]   check this environment as a worker sees it, one fix per failure
  pair.mjs run --task-file <path> [options]
  pair.mjs wait <run-id|run-dir> [--timeout 15m] [--json]  block until the run ends or the timeout passes
  pair.mjs close <worker>... [--mux herdr|rex] [--run <id>]   close finished workers (ids from run)

Options:
  --rounds <n>               audit → address cycles (default ${DEFAULTS.rounds})
  --implementer-model <m>    provider/id[:thinking] (default: first ready of ${DEFAULTS.models.implementer.join(", ")})
  --auditor-model <m>        provider/id[:thinking] (default: first ready of ${DEFAULTS.models.auditor.join(", ")})
  --mux herdr|rex            override environment detection
  --turn-timeout <dur>       per-turn limit, e.g. 45m (default ${DEFAULTS.turnTimeout})
  --cwd <dir>                worker working directory (default: current)
  --json                     machine-readable result`;

/** Windows batch files: a process cannot start one as an image, and nothing should pass it arguments either. */
const BATCH_FILE = /\.(?:cmd|bat)$/i;
/** A Node entry point, the thing a Windows `pi.cmd` shim actually starts. */
const NODE_SCRIPT = /\.(?:c?js|mjs|mts)$/i;

/** A variable from a caller environment. Windows environment names are case-insensitive (`Path`, `PathExt`, `ComSpec`),
 * so a snapshot is read the way the OS would read it rather than by exact spelling (audit 5). */
export function envGet(env, name, { platform = process.platform } = {}) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  if (platform !== "win32") return undefined;
  const wanted = String(name).toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === wanted) return env[key];
  return undefined;
}

export function run(cmd, args, { cwd, env, timeout, platform = process.platform } = {}) {
  // A batch file cannot be started as an image, and `cmd /c` would re-parse every argument (`&`, `%`, `^`, `"`, `!`)
  // with a grammar `execFile` does not quote for — a probe argument such as `a&echo` would run another command. Pi is
  // therefore resolved to its Node entry point instead (`shimEntry`), and a batch file reaching here is a bug.
  if (platform === "win32" && BATCH_FILE.test(String(cmd))) {
    return Promise.reject(new Error(`${cmd}: a Windows batch file cannot be started with its arguments intact; run its Node entry point instead`));
  }
  return new Promise((resolvePromise, reject) => {
    // `timeout` kills a child that overruns it, and it kills it outright (`SIGKILL`): a helper that installs a SIGTERM
    // handler would otherwise keep running — and keep this process's handles open — after the bounded check returned.
    execFile(cmd, args, { cwd, env, timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      // `code` is the exit status: readiness checks read exit 0/1/2 instead of a message (see `modelChecker`).
      if (error) reject(Object.assign(new Error(`${cmd} ${args.join(" ")}: ${(stderr || error.message).trim()}`), { stdout, code: error.code, killed: error.killed }));
      else resolvePromise(stdout);
    });
  });
}

/** `%~dp0` is the shim's own folder *with* a trailing separator, so a quoted target may or may not add one. */
const DP0 = /%~?dp0%?/i;

/**
 * What npm's `pi.cmd` would start: the Node entry point it runs, and the Node interpreter it prefers when one ships
 * beside it (`IF EXIST "%dp0%\\node.exe"` … `SET "_prog=%dp0%\\node.exe"`), which is the installation's own runtime.
 * `null` when this is not a batch shim.
 *
 * npm (and pnpm/yarn) write `pi.cmd` as a batch file whose last line runs Node on one quoted script path relative to
 * the shim's own folder — `"%dp0%\\node_modules\\pi\\dist\\cli.js"` — and that is the only safe way to start Pi from
 * here: `cmd.exe` re-parses a command line for `%`, `^`, `&`, `|` and quotes, so neither a path containing `%` nor an
 * argument such as `a&echo` survives it, and a timeout would kill `cmd.exe` rather than the Node process it started
 * (audit 1–3 of round 2). Resolving both lets the launcher and every readiness probe run `node <entry> <args>`
 * directly, with the interpreter the shim itself selected, which need not be the first `node` on PATH (audit 1 of
 * round 3).
 *
 * Only the shim's own folder variable and quoted targets are read; anything else (another extension, a missing file)
 * yields nothing for that target, and a shim with no readable entry is refused by the caller rather than guessed at.
 */
export function shimParts(shim, { exists = existsSync, readFile = readFileSync, platform = process.platform } = {}) {
  if (platform !== "win32" || !BATCH_FILE.test(String(shim)) || !exists(shim)) return null;
  let text;
  try {
    text = String(readFile(shim, "utf8"));
  } catch {
    return null;
  }
  // `%~dp0` ends with a separator, while `dirname` does not: substitute the folder plus one, as a callback so a folder
  // containing `$&` or `$'` stays a folder (a replacement string would read them as directives), then normalize away
  // the doubled separator a quoted `%dp0%\\script.js` produces (round-3 audit 2).
  const folder = win32.dirname(shim);
  const resolveQuoted = (quoted) => win32.normalize(quoted.replace(DP0, () => `${folder}\\`));
  let entry = null;
  let node = null;
  for (const match of text.matchAll(/"([^"\r\n]+)"/g)) {
    const quoted = match[1];
    if (!DP0.test(quoted)) continue;
    const absolute = resolveQuoted(quoted);
    if (!exists(absolute) || absolute === shim) continue;
    if (!entry && NODE_SCRIPT.test(absolute)) entry = absolute;
    // The shim's own interpreter: the Node it would run Pi with when it is present beside it.
    else if (!node && /(?:^|[\\/])node(?:\.exe)?$/i.test(absolute)) node = absolute;
  }
  return entry ? { entry, node } : null;
}

/** The entry point `shimParts` found, or null: the common case, where only the script matters. */
export function shimEntry(shim, options) {
  return shimParts(shim, options)?.entry ?? null;
}

/**
 * How Pi is started: as `node <entry>` when Pi is a JS entry point or a Windows batch shim whose entry was resolved,
 * else as the path itself (a native binary, or a POSIX script with its own shebang). One function, so a readiness
 * probe, `doctor`'s dry launch and a worker all start Pi the same way.
 */
export function piCommand({ pi, node, entry } = {}) {
  return entry && node ? [node, entry] : [pi];
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseDuration(value) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value).trim());
  if (!m) throw new Error(`invalid duration ${value} (use e.g. 90s, 45m)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"];
}

// ---------- environment ----------

/**
 * Decide which multiplexer hosts this process, from the variables each one injects.
 * Herdr app terminals are herdr-core terminals and carry HC_TERMINAL_ID (an address like t7, not a pane id).
 */
export function detect(env = process.env) {
  const herdr = Boolean(env.HC_TERMINAL_ID);
  const rex = Boolean(env.REX_SESSION && env.REX_BLOCK);
  if (herdr && rex) return { mux: null, reason: "both Herdr (HC_TERMINAL_ID) and Rex variables are set; pass --mux herdr|rex" };
  if (herdr) return { mux: "herdr", terminal: env.HC_TERMINAL_ID };
  if (rex) return { mux: "rex", session: env.REX_SESSION, pane: env.REX_BLOCK };
  return { mux: null, reason: "not running inside Herdr (HC_TERMINAL_ID) or Rex (REX_SESSION/REX_BLOCK)" };
}

// ---------- worker environment ----------

/**
 * Readonly or per-process shell state that a caller can have exported (SHELLOPTS, UID). The launcher replays the
 * snapshot as `export NAME=value` in a shell where such a name is readonly, and there the assignment aborts the whole
 * launch (`SHELLOPTS: readonly variable`) before Pi starts. None of it means anything to a worker, so it is session
 * state: it is not forwarded at all, rather than assigned and its error ignored.
 */
const SHELL_STATE = /^(?:SHELLOPTS|BASHOPTS|BASH_VERSINFO|BASH_ARGC|BASH_ARGV|BASH_ARGV0|BASH_LINENO|BASH_SOURCE|BASH_SUBSHELL|BASH_EXECUTION_STRING|FUNCNAME|PIPESTATUS|DIRSTACK|COMP_\w+|GROUPS|UID|EUID|PPID|RANDOM|SECONDS|EPOCHSECONDS|EPOCHREALTIME|LINENO|HISTCMD|OPTIND|OPTARG|PS4)$/;

/**
 * Variables a worker must not inherit: the caller's session state, the caller's own terminal identity, and the shell's
 * own state. The core gives each terminal its own HC_ and REX_ identity; forwarding the caller's would make a worker
 * believe it is the terminal the orchestrator runs in. Everything else is passed, because allow-lists break whenever a
 * provider adds one.
 */
const NOT_FOR_WORKERS = [/^PI_SESSION_/, /^PI_CODING_AGENT$/, /^HC_/, /^REX_/, /^(?:PWD|OLDPWD|_|SHLVL)$/, SHELL_STATE];

/** The caller's environment as its workers should see it: everything worth keeping minus session and terminal state. */
export function workerEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => typeof value === "string" && !NOT_FOR_WORKERS.some((pattern) => pattern.test(name))),
  );
}

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** The file the launcher appends a worker's exit code to, so startup and turns have a signal without agent status. */
export const LAUNCH_EXIT = "launch.exit";

/**
 * The variable that names the worker's own terminal, chosen by the multiplexer that started it. Both families can be
 * present in the core's environment (the CLI then needs `--mux`), so precedence would record a stale identity from
 * the other multiplexer and the exit record would never match the worker being watched.
 */
const identityVar = (mux) => (mux === "herdr" ? "HC_TERMINAL_ID" : mux === "rex" ? "REX_BLOCK" : null);

/**
 * The file the launcher writes its own multiplexer identity to as soon as it starts, so a check that lost the
 * creation answer can still find and close the terminal or block it created (see `dryLaunch`).
 */
export const LAUNCH_ID = "launch.id";

/**
 * A launcher that gives a worker the caller's environment, its working folder, and how it ended: a POSIX shell
 * script (`launch.sh`), or a PowerShell script on Windows (`launch.ps1`, see `powershellLauncher`). The caller's
 * multiplexer CLIs have no env option (`hc run`, `herdr-app pane.split`,
 * `rex split`), and workers otherwise start with the core's login environment. Filtering what the launcher exports is
 * not enough: the core may pass its own session markers and stale provider keys (which would override file-based
 * auth), so the script first empties the inherited environment, keeping only this worker's own multiplexer identity.
 * `mux` picks the variable that identity is read from, so the exit record names the worker the caller is watching.
 * The launcher changes directory itself (`cwd`), because `pane.split` has no folder argument (`herdr-app commands`):
 * the old `/bin/sh -c 'cd -- "$1" && …'` wrapper needed a POSIX shell on the machine the app opens terminals on, and a
 * Windows box has none (E1).
 * Every script also has to survive the environment it starts in and record how it ended on every path, because a
 * transport without agent status has no other signal that a launcher died before Pi started.
 * `idFile` records the worker's identity when the launcher starts (before any work), which is the recovery path for a
 * pane whose creation answer never arrived.
 */
export function launcherScript({ env = {}, pi, node, entry, exitFile, idFile, mux, cwd, platform = process.platform }) {
  const names = Object.keys(env).filter((name) => SHELL_NAME.test(name)).sort();
  const idVar = identityVar(mux);
  const command = piCommand({ pi, node, entry });
  if (platform === "win32") return powershellLauncher({ env, names, command, exitFile, idFile, idVar, cwd: cwd ? String(cwd) : null });
  const exit = exitFile ? shellQuote(exitFile) : null;
  const id = idVar ? `\${${idVar}:-?}` : "?";
  return [
    "#!/bin/sh",
    "# Written by the pair skill: run a Pi worker in the caller's environment and record how it ended.",
    "# Start from the caller's snapshot only: the core's login PATH, another terminal's session variables and stale",
    "# provider keys must not reach the worker. Its own HC_/REX_/HERDR_ identity came from the core and is kept.",
    "# The names come from the shell's own `export -p` (a POSIX builtin): an `env` command would be missing exactly",
    "# where this launcher matters, a core whose PATH does not find the caller's tools.",
    // First executable line: a core that exports SHELLOPTS=xtrace would print every provider value exported below,
    // verbose would echo this source, and errexit or nounset would let a refused `unset` end the launch.
    "set +e +u +v +x",
    ...(exit
      ? [
          "# Record the exit before anything can fail: a bootstrap error (an unreadable environment, a shell that",
          "# refuses an assignment) must leave the same record a Pi exit does, or a worker that never started looks",
          "# alive until the turn timeout on a transport that has no agent status.",
          "_pair_exit() {",
          "  _pair_code=$?",
          `  printf '%s %s\\n' "${id}" "$_pair_code" >> ${exit}`,
          "}",
          "trap _pair_exit EXIT",
        ]
      : []),
    ...(idFile
      ? [
          // The identity of the terminal this shell runs in: written before anything else, so a caller that never got",
          // the creation answer can still find this terminal and close it.",
          `_pair_self="${id}"`,
          `[ -n "$_pair_self" ] && [ "$_pair_self" != "?" ] && printf '%s\\n' "$_pair_self" > ${shellQuote(idFile)}`,
        ]
      : []),
    "set -f  # an environment value containing * must not be expanded into file names",
    "_pair_seen=0",
    "for _pair_item in $(export -p); do",
    "  _pair_name=${_pair_item%%=*}",
    "  case $_pair_name in",
    "    export|declare|typeset|readonly|-x|-p) continue ;;  # the shell's own words, not variable names",
    "    [!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;;  # a fragment of a multi-line value",
    "  esac",
    "  _pair_seen=$((_pair_seen + 1))",
    "  case $_pair_name in",
    "    HC_*|REX_*|HERDR_*) ;;  # this worker's own multiplexer identity",
    // A readonly shell variable (SHELLOPTS) cannot be unset and is this shell's own state, not the core's payload.
    '    *) unset "$_pair_name" 2>/dev/null ;;',
    "  esac",
    "done",
    "unset _pair_item _pair_name",
    // Never run Pi in the unsanitized core environment: if enumeration failed, stop with a distinct code instead.
    "if [ \"$_pair_seen\" -eq 0 ]; then",
    "  printf '%s\\n' 'pair launcher: could not read the inherited environment (export -p) to clear it; refusing to start pi with the core environment' >&2",
    "  exit 78",
    "fi",
    "unset _pair_seen",
    // The worker folder: `pane.split` has no folder argument, so the launcher goes there itself (E1). A failure is
    // recorded like any other early end, and says which folder could not be entered.
    ...(cwd ? [`cd -- ${shellQuote(cwd)} || { printf 'pair launcher: cannot enter %s\\n' ${shellQuote(cwd)} >&2; exit 1; }`] : []),
    ...names.map((name) => `export ${name}=${shellQuote(env[name])}`),
    // Not `exec`: this shell has to outlive Pi so the EXIT trap can record how the worker ended.
    `${command.map((word) => shellQuote(word)).join(" ")} "$@"`,
    "",
  ].join("\n");
}

/**
 * A PowerShell string literal for a value or a path: double-quoted, with the three characters PowerShell would
 * otherwise interpret escaped (`` ` `` → ``` `` ```, `$` → `` `$ ``, `"` → `` `" ``) and line breaks written as escapes
 * so the script stays one statement per line. That carries `%`, `^`, `&`, `!`, `'`, `"`, `$` and a path such as
 * `C:\%ALIAS%\repo` through literally, which batch cannot do without a multi-pass `%` analysis (audit 5).
 */
const psString = (value) =>
  `"${String(value)
    .replace(/`/g, "``")
    .replace(/\$/g, "`$")
    .replace(/"/g, '`"')
    .replace(/\r/g, "`r")
    .replace(/\n/g, "`n")}"`;

/**
 * The Windows launcher (E1): the same job as the POSIX one — keep only this worker's own multiplexer identity out of
 * the inherited environment, set the caller's snapshot, change folder, run Pi, record the exit — in PowerShell rather
 * than batch, because Windows has no `/bin/sh` and batch cannot do this job:
 *
 * - Pi is installed on Windows as a batch file (`pi.cmd` via npm). A batch launcher that runs another batch either
 *   transfers execution to it and never returns — so the exit record is never written — or uses `call`, which parses
 *   the already-parsed `%*` a second time. PowerShell runs the `.cmd` as a child and continues, with `$LASTEXITCODE`
 *   (audit 3).
 * - Batch cannot write a path literal containing `%` (a legal folder name) without counting parse passes; PowerShell
 *   string literals carry it as-is, and `Set-Location -LiteralPath` takes the folder literally (audit 5).
 * - Environment values stay one statement each, with no `%`/`^`/`!`/quote analysis, so the line-break gap is gone too.
 *
 * Windows PowerShell 5.1 ships with every supported Windows; `prepareLaunch` starts it with `-NoProfile
 * -ExecutionPolicy Bypass -File` (see `powershell`).
 */
function powershellLauncher({ env, names, command, exitFile, idFile, idVar, cwd }) {
  const record = (code, pad = "") => (exitFile ? [`${pad}[IO.File]::AppendAllText(${psString(exitFile)}, "$pairId ${code}\`n")`] : []);
  const identity = idVar ? `$env:${idVar}` : "'?'";
  return [
    "# Written by the pair skill: run a Pi worker with the caller's environment, in the worker folder, and record how it",
    "# ended. PowerShell, not a .cmd: npm installs Pi as a batch file (pi.cmd), and a batch launcher cannot run another",
    "# batch and regain control to record the exit code, nor write a path containing '%' literally.",
    "$ErrorActionPreference = 'Stop'",
    // The identity comes first: a worker whose launcher dies before Pi starts still names its terminal or block.
    `$pairId = ${identity}`,
    "if (-not $pairId) { $pairId = '?' }",
    ...(idFile ? [`if ($pairId -ne '?') { [IO.File]::WriteAllText(${psString(idFile)}, "$pairId\`n") }`] : []),
    "# Clear the core's inherited variables, keeping only this worker's own HC_/REX_/HERDR_ identity: the core's login",
    "# PATH and another terminal's session markers must not reach the worker. -match ignores case.",
    "$pairSeen = 0",
    "try { $pairNames = @([Environment]::GetEnvironmentVariables().Keys) } catch { $pairNames = @() }",
    "foreach ($pairName in $pairNames) {",
    "  $pairSeen++",
    "  if ($pairName -match '^(?:HC_|REX_|HERDR_)') { continue }",
    "  # A drive pseudo-variable such as =C: is not an environment value and cannot be removed; the worker never reads it.",
    "  try { [Environment]::SetEnvironmentVariable($pairName, $null) } catch { }",
    "}",
    "if ($pairSeen -eq 0) {",
    "  [Console]::Error.WriteLine('pair launcher: could not read the inherited environment to clear it; refusing to start pi with the core environment')",
    ...record(78, "  "),
    "  exit 78",
    "}",
    ...names.map((name) => `[Environment]::SetEnvironmentVariable('${name}', ${psString(env[name])})`),
    ...(cwd
      ? [
          "try {",
          `  Set-Location -LiteralPath ${psString(cwd)}`,
          "} catch {",
          "  [Console]::Error.WriteLine('pair launcher: cannot enter the worker folder')",
          ...record(1, "  "),
          "  exit 1",
          "}",
        ]
      : []),
    "$pairCode = 0",
    "try {",
    `  & ${command.map((word) => psString(word)).join(" ")} @args`,
    // No batch file in the middle: Pi's own Node entry point is a real executable, so arguments are passed as an array
    // (no `%`/`^`/`&`/quote parsing) and control returns here with its exit status; a command that cannot be found is
    // the only thing that throws.
    "  if ($null -ne $LASTEXITCODE) { $pairCode = $LASTEXITCODE }",
    "} catch {",
    '  [Console]::Error.WriteLine("pair launcher: $_")',
    "  $pairCode = 1",
    "}",
    ...(exitFile ? [`[IO.File]::AppendAllText(${psString(exitFile)}, "$pairId $pairCode\`n")`] : []),
    "exit $pairCode",
    "",
  ].join("\r\n");
}

/**
 * The Windows PowerShell to start the launcher with: the copy that ships with Windows (`%SystemRoot%\System32\
 * WindowsPowerShell\v1.0\powershell.exe`), else `powershell.exe` from PATH. Execution policy is bypassed for this
 * one script; a machine policy set at the MachinePolicy/UserPolicy scope still wins, which is a documented limit.
 */
export function powershell(env = process.env, { exists = existsSync } = {}) {
  const root = envGet(env, "SystemRoot", { platform: "win32" }) || "C:\\Windows";
  const shipped = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return exists(shipped) ? shipped : "powershell.exe";
}

/**
 * Write the worker launcher into the run folder, readable and executable by its owner only, and return its path.
 * Windows PowerShell 5.1 reads a BOM-less script in the legacy ANSI code page, so `launch.ps1` gets a UTF-8 BOM:
 * without it a non-ASCII caller value or a Unicode user name in a path is corrupted before the worker starts
 * (audit 4). The POSIX script is plain UTF-8, as `sh` expects.
 */
export function writeLauncher({ dir, env, pi, node, entry, exitFile, idFile, mux, cwd, platform = process.platform }) {
  const windows = platform === "win32";
  const file = join(dir, windows ? "launch.ps1" : "launch.sh");
  const text = launcherScript({ env, pi, node, entry, exitFile, idFile, mux, cwd, platform });
  writeFileSync(file, windows ? `\uFEFF${text}` : text, { mode: 0o700 });
  if (!windows) chmodSync(file, 0o700);
  return file;
}

/**
 * Lines of a file or a terminal capture. Windows tools — a report written by a worker there, `cmd`'s exit record,
 * `hc`/`rex` output from a Windows host — end lines with `\r\n`, so no parser may split on `\n` alone (E4).
 */
const linesOf = (text) => String(text ?? "").split(/\r?\n/);

/**
 * True when a report is finished: its last non-empty line is the done marker. Trailing `\r\n` and trailing blank
 * lines are ignored, so a report written on Windows counts as done like one written on macOS (E4).
 */
export function reportDone(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trimEnd().endsWith(DONE);
}

/** The first line of a script, or "" when it cannot be read (e.g. a bare command name resolved from PATH). */
function shebangOf(pi, { exists = existsSync, readFile = readFileSync } = {}) {
  try {
    return exists(pi) ? linesOf(readFile(pi, "utf8"))[0].trim() : "";
  } catch {
    return "";
  }
}

/**
 * The `node` a worker needs: the shebang's own interpreter when it names one, else the caller's PATH, Pi's managed
 * `pi-node`, and finally this process's executable, which is always a working Node.
 */
function resolveNode({ pi, env, cwd, execPath, exists, readFile, platform = process.platform, pathext }) {
  const extensions = pathext ?? envGet(env, "PATHEXT", { platform });
  const shebang = shebangOf(pi, { exists, readFile });
  const direct = /^#!\s*(\/\S+)/.exec(shebang)?.[1];
  const viaEnv = /^#!\s*\/usr\/bin\/env\s+(?:-S\s+)?(\S+)/.test(shebang);
  const name = platform === "win32" ? "node.exe" : "node";
  const joinPath = pathOf(platform).join;
  const dataHome = env.XDG_DATA_HOME || (env.HOME ? joinPath(env.HOME, ".local", "share") : null);
  const candidates = [
    direct && !viaEnv && /[\\/]node(?:\.exe)?$/.test(direct) ? direct : null,
    onPathFrom(name, envGet(env, "PATH", { platform }), cwd, exists, { platform, pathext: extensions }),
    dataHome ? joinPath(dataHome, "pi-node", "current", ...(platform === "win32" ? ["node.exe"] : ["bin", "node"])) : null,
    execPath,
  ].map((candidate) => candidate && absoluteFrom(candidate, cwd, platform));
  return { node: candidates.find((candidate) => candidate && exists(candidate)) ?? null, shebang };
}

/** `dir` first in `path`, without duplicate or empty entries. */
function prependPath(dir, path = "", platform = process.platform) {
  const separator = pathDelimiter(platform);
  return [dir, ...String(path).split(separator)].filter(Boolean).filter((entry, index, all) => all.indexOf(entry) === index).join(separator);
}

/** `value` as an absolute path: relative paths belong to the caller's directory, not the worker's. */
const absoluteFrom = (value, cwd, platform = process.platform) => (pathOf(platform).isAbsolute(value) ? value : pathOf(platform).resolve(cwd, value));

/**
 * `name` in `path`, resolved against the caller's directory so a relative PATH entry stays the caller's file. `platform`
 * decides the separator (`;` or `:`) and, on Windows, the `PATHEXT` suffixes a command name can have (`pi.cmd`, E2).
 */
function onPathFrom(name, path = "", cwd = process.cwd(), exists = existsSync, { platform = process.platform, pathext } = {}) {
  const joinPath = pathOf(platform).join;
  const names = executableNames(name, { platform, pathext });
  for (const dir of String(path).split(pathDelimiter(platform)).filter(Boolean)) {
    for (const candidate of names) {
      const file = joinPath(absoluteFrom(dir, cwd, platform), candidate);
      if (exists(file)) return file;
    }
  }
  return null;
}

/**
 * The absolute `pi` a worker runs. `PAIR_PI_BIN` may be a path (resolved against the caller's directory) or a command
 * name (resolved through the caller's PATH); otherwise `pi` comes from the caller's PATH. Resolution happens here,
 * because a worker pane starts in the worker's folder with the core's PATH, where a bare name may mean another file.
 * A failure is actionable and happens before any pane opens.
 */
export function resolvePi({ env = process.env, cwd = process.cwd(), exists = existsSync, platform = process.platform, pathext } = {}) {
  // The caller's own PATHEXT decides what a command name can be, never this process's (audit 6).
  const extensions = pathext ?? envGet(env, "PATHEXT", { platform });
  const given = env.PAIR_PI_BIN;
  const name = given || "pi";
  if (/[\\/]/.test(name)) {
    const file = absoluteFrom(name, cwd, platform);
    if (exists(file)) return file;
    throw new Error(`pi not found: ${given ? `PAIR_PI_BIN=${given}` : name} resolves to ${file}, which does not exist; set PAIR_PI_BIN to the pi executable or put pi on PATH`);
  }
  const found = onPathFrom(name, envGet(env, "PATH", { platform }), cwd, exists, { platform, pathext: extensions });
  if (found) return found;
  throw new Error(`pi not found: ${given ? `PAIR_PI_BIN=${given} is not a path and ` : ""}no executable ${name} on PATH (${env.PATH || "empty"}); install pi, put it on PATH, or set PAIR_PI_BIN to the pi executable`);
}

/**
 * Resolve an absolute worker launch: `pi`, the `node` its shebang needs, and a PATH that finds both plus the caller's
 * tools (`claude` for the claude-code provider, for example). `status.json.launch` records exactly this.
 */
export function resolveLaunch({ env = process.env, cwd = process.cwd(), execPath = process.execPath, exists = existsSync, readFile = readFileSync, platform = process.platform, pathext } = {}) {
  // Windows environment names are case-insensitive, so the caller's `Path`/`PathExt` spellings count (audit 5).
  const extensions = pathext ?? envGet(env, "PATHEXT", { platform });
  const pi = resolvePi({ env, cwd, exists, platform, pathext: extensions });
  // Pi on Windows is npm's `pi.cmd`, and the shim names both what it runs and the Node it runs it with. Both are needed
  // before the generic resolution, because the shim's own `node.exe` wins over the first `node` on PATH (round-3
  // audit 1).
  const shim = platform === "win32" && BATCH_FILE.test(pi) ? shimParts(pi, { exists, readFile, platform }) : null;
  const resolved = resolveNode({ pi, env, cwd, execPath, exists, readFile, platform, pathext: extensions });
  const node = shim?.node ?? resolved.node;
  const { shebang } = resolved;
  // A relative PATH entry means the caller's file; the worker starts in another folder, so make them absolute. The
  // separator is the platform's (`;` on Windows), never a hard-coded `:` (E3).
  const separator = pathDelimiter(platform);
  const path = String(envGet(env, "PATH", { platform }) ?? "").split(separator).filter(Boolean).map((entry) => absoluteFrom(entry, cwd, platform)).join(separator);
  // It is started as `node <entry>` so no command interpreter re-parses a path or an argument (round-2 audits 1–3). A
  // batch shim pair cannot start that way — no readable entry, or no node to run it — is refused here, before any
  // pane, rather than run through cmd with arguments that would not survive it.
  const entry = shim ? shim.entry : NODE_SCRIPT.test(pi) ? pi : null;
  if (platform === "win32" && BATCH_FILE.test(pi) && !(entry && node)) {
    const why = entry ? "no node was found to run its entry point" : "its Node entry point could not be read";
    throw new Error(
      `pi not found: ${pi} is a Windows batch file that pair cannot start safely (${why}); set PAIR_PI_BIN to the .js entry point it runs (e.g. node_modules/…/cli.js) or to a pi .exe`,
    );
  }
  return { pi, node, shebang, entry, PATH: prependPath(node && pathOf(platform).dirname(node), path, platform) };
}

/**
 * The environment a worker gets: the caller's snapshot with the resolved PATH as its one entry. Windows environment
 * names are case-insensitive and the caller's own spelling is often `Path`/`PathExt`, so on Windows keys are
 * deduplicated without case and the PATH spelling is replaced rather than duplicated: two assignments (`PATH` then
 * `Path`) would otherwise let the caller's plain value win and drop Node's folder from the worker's path (audit 5).
 */
export function launchEnv(env, PATH, platform = process.platform) {
  const entries = Object.entries(workerEnv(env));
  const kept = platform === "win32"
    ? entries.filter(([name], index, all) => all.findIndex(([other]) => other.toUpperCase() === name.toUpperCase()) === index && name.toUpperCase() !== "PATH")
    : entries;
  return Object.fromEntries([...kept, ["PATH", PATH]]);
}

/**
 * Everything a run needs to start workers in the caller's environment: the launcher and the argv prefix that goes
 * through it, the launch record for `status.json` (`pi`, `node`, `PATH`), and the file the launcher records exits in.
 * `mux` selects the identity variable the launcher records the exit under (see `launcherScript`).
 *
 * `workdir` is the folder the worker runs in (the launcher's `cd`); `cwd` is the caller's folder, where relative
 * `PAIR_PI_BIN` and PATH entries point.
 *
 * On Windows the argv names PowerShell first and the launcher is `launch.ps1`: it has to run a batch `pi.cmd` as a
 * child (so it regains control to record the exit) and carry path literals such as `C:\%ALIAS%\repo` unchanged, and
 * batch cannot do either (see `powershellLauncher`). `-ExecutionPolicy Bypass` applies to this one script.
 */
export function prepareLaunch({ dir, env = process.env, mux, cwd = process.cwd(), workdir = cwd, platform = process.platform, execPath, exists, readFile, pathext } = {}) {
  const { pi, node, shebang, entry, PATH } = resolveLaunch({ env, cwd, execPath, exists, readFile, platform, pathext });
  const exitFile = join(dir, LAUNCH_EXIT);
  const idFile = join(dir, LAUNCH_ID);
  const launcher = writeLauncher({ dir, env: launchEnv(env, PATH, platform), pi, node, entry, exitFile, idFile, mux, cwd: workdir, platform });
  const runner = platform === "win32" ? [powershell(env, { exists: exists ?? existsSync }), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"] : [];
  return { pi, node, entry, PATH, launcher, exitFile, idFile, record: { pi, node, entry, PATH, launcher, shebang }, argv: (args) => [...runner, launcher, ...args] };
}

/**
 * The exit code a worker's launcher recorded in `launch.exit`, or null while it has not exited. A line naming the
 * worker's own address matches it; `?` is an identity the launcher could not determine (the selected mux's variable
 * was unset, or no mux was known) and counts for any worker, because a worker exiting during a turn or startup is a
 * failure either way.
 */
export function launcherExit(exitFile, id) {
  if (!exitFile) return null;
  let text;
  try {
    text = readFileSync(exitFile, "utf8");
  } catch {
    return null;
  }
  for (const line of linesOf(text)) {
    const [who, code] = line.trim().split(/\s+/);
    if (!who) continue;
    if (who === "?" || bareId(who) === bareId(id)) return Number.isFinite(Number(code)) ? Number(code) : null;
  }
  return null;
}

// ---------- model and provider readiness ----------

/** Reasoning levels Pi accepts after `provider/id:`; the suffix is not part of the model id. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Probes per scan call. Discovering a ready alternative for a role that has none keeps going in further calls until
 * one is found or the catalog is exhausted; the `models` top-up is one bounded pass per role, because it only makes
 * a report longer.
 */
const DISCOVERY_BUDGET = 16;
const TOP_UP_BUDGET = 8;

/**
 * `openai/gpt-6.1-sol:xhigh` → `{ spec, model: "openai/gpt-6.1-sol", provider: "openai", id: "gpt-6.1-sol", thinking: "xhigh" }`.
 * Only a known reasoning level counts as a suffix, so an id that itself contains a colon stays intact.
 */
export function modelParts(spec) {
  const text = String(spec ?? "").trim();
  const suffix = /^(.*):([a-z]+)$/.exec(text);
  const thinking = suffix && THINKING_LEVELS.includes(suffix[2]) ? suffix[2] : null;
  const model = thinking ? suffix[1] : text;
  const slash = model.indexOf("/");
  return slash > 0
    ? { spec: text, model, thinking, provider: model.slice(0, slash), id: model.slice(slash + 1) }
    : { spec: text, model, thinking, provider: null, id: model };
}

/** Rows of `pi --list-models [search]`: its provider and model columns. Header and non-table lines are dropped. */
export function parseModelList(text) {
  return linesOf(text)
    .slice(1)
    .flatMap((line) => {
      const [provider, model] = line.trim().split(/\s{2,}/);
      return provider && model && /^[\w.@-]+$/.test(provider) ? [{ provider, model }] : [];
    });
}

/**
 * What `pi auth check` answers when its own model runtime cannot resolve the model or provider at all:
 * `invalid_state` (the runtime failed or the model is unknown to it) and `provider_not_found` (no such provider).
 */
const UNRESOLVED_AUTH = new Set(["invalid_state", "provider_not_found"]);

/** The JSON a Pi readiness command printed, or null when it printed none. */
function parseJson(text) {
  const line = linesOf(text).findLast((entry) => entry.trim().startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

/** The `<auth check detail>` of a plan-style message: the reason Pi gave, without the wrapper around it. */
function authDetail(parsed) {
  if (!parsed) return null;
  if (parsed.status === "invalid") return `invalid (${parsed.reason ?? "pi rejected the model"})`;
  return parsed.reason ?? parsed.status ?? null;
}

/**
 * Model readiness as a worker sees it: `pi auth check --model <provider/id> --json` (exit 0 = ready) and
 * `pi --list-models <id>` confirming that this provider offers the id. `pi` is the resolved absolute binary and `env`
 * the worker environment (`workerEnv()` plus the launch PATH), so a provider that shells out to its own CLI
 * (claude-code runs `claude auth status`) is judged in the worker's world, not the caller's shell. Every model is
 * probed once and cached for the run, however many roles name it.
 *
 * A model that `--list-models` lists but `auth check` cannot resolve (it builds its own model runtime and so does not
 * load extension-provided providers) is ready but `verified: false` — "listed, auth unverifiable" — and a real
 * `not_ready` from a provider auth check still blocks. `verified` is true only for an authorized model.
 */
export function modelChecker({ pi, node, entry, env = process.env, cwd = process.cwd(), exec = run }) {
  // `node <entry>` when Pi is a JS entry point (a Windows bat shim is resolved first), else the path itself.
  const [file, ...prefix] = piCommand({ pi, node, entry });
  const spawn = (args) => exec(file, [...prefix, ...args], { cwd, env });
  const tables = new Map();
  const statuses = new Map();
  const providers = new Map();
  const table = async (search = "") => {
    if (!tables.has(search)) tables.set(search, parseModelList(await spawn(["--list-models", ...(search ? [search] : [])])));
    return tables.get(search);
  };
  // One full list (the alternative scan) answers every membership question; otherwise ask the list for this id.
  const listed = async (parts) => {
    const rows = tables.has("") ? await table() : await table(parts.id);
    return rows.some((row) => row.model === parts.id && (!parts.provider || row.provider === parts.provider));
  };
  const authCheck = async (args) => {
    // Exit 0 is ready; exit 1 not_ready and exit 2 invalid both print the structured reason on stdout, so the JSON is
    // what is judged, not the exit code. A command that printed no JSON keeps its error text as the reason.
    try {
      return parseJson(await spawn(args));
    } catch (error) {
      return parseJson(error?.stdout) ?? { status: "unknown", reason: errorText(error) };
    }
  };
  /**
   * Whether `pi auth check` knows a provider and whether it is authorized. Extension-provided providers (installed as a
   * package, such as claude-code) are absent from the runtime auth check builds for itself, which answers
   * `not_ready` + `provider_not_found`: that is "cannot check", not "not authorized". A real `not_ready`
   * (`credentials_not_configured`) is about a built-in provider and still blocks.
   */
  const providerStatus = async (provider) => {
    if (!providers.has(provider)) {
      const parsed = await authCheck(["auth", "check", "--provider", provider, "--json"]);
      const unknown = parsed?.status === "not_ready" && parsed.reason === "provider_not_found";
      providers.set(provider, { status: unknown ? "unknown" : parsed?.status ?? "unknown", reason: parsed?.reason ?? null });
    }
    return providers.get(provider);
  };
  const probe = async (parts) => {
    const status = { spec: parts.spec, model: parts.model, thinking: parts.thinking };
    try {
      if (!(await listed(parts))) {
        const who = parts.provider ? `${parts.provider} does not offer` : "pi --list-models does not list";
        return { ...status, ready: false, verified: false, detail: `${who} ${parts.id}` };
      }
    } catch (error) {
      return { ...status, ready: false, verified: false, detail: `pi --list-models failed: ${errorText(error)}` };
    }
    const parsed = await authCheck(["auth", "check", "--model", parts.model, "--json"]);
    if (parsed?.status === "ready") {
      return { ...status, ready: true, verified: true, detail: `ready (${parsed.authType ?? parsed.provider ?? "authorized"})` };
    }
    // A model that `--list-models` shows but auth check cannot resolve is "listed, auth unverifiable": usable, because
    // `--list-models` loads the extensions that auth check does not, and a worker that still cannot authenticate is
    // caught by the startup check (F1). Asking about the provider separates that from a real, built-in not_ready.
    if (UNRESOLVED_AUTH.has(parsed?.reason) && parts.provider) {
      const provider = await providerStatus(parts.provider);
      if (provider.status === "not_ready") return { ...status, ready: false, verified: false, detail: provider.reason ?? "credentials_not_configured" };
      const why = provider.status === "ready"
        ? `pi auth check cannot resolve ${parts.model} (${parsed.reason}) although provider ${parts.provider} is authorized`
        : `${parts.provider} is not loaded by pi auth check (${provider.reason ?? parsed.reason}); pi --list-models lists the model`;
      return { ...status, ready: true, verified: false, detail: `listed; auth unverifiable (${why})` };
    }
    return { ...status, ready: false, verified: false, detail: authDetail(parsed) ?? "auth check printed no status" };
  };
  const check = async (spec) => {
    const parts = modelParts(spec);
    if (!statuses.has(parts.model)) statuses.set(parts.model, await probe(parts));
    return statuses.get(parts.model);
  };
  return {
    check,
    /** Every model probed so far, in order, so a caller can name the ready ones without probing again. */
    known: () => [...statuses.values()],
    /**
     * Ready models to name as alternatives, probed from `pi --list-models`. Candidates are ordered per call — the
     * roles' own model ids on their other providers first, then a provider-balanced sweep so one unauthenticated
     * provider cannot use up every probe — and models probed by an earlier call are never probed again, so a caller
     * can keep asking until `exhausted` says the catalog has nothing left. `budget` bounds the probes in one call.
     */
    async scan({ prefer = [], limit = 5, budget = 8 } = {}) {
      let rows;
      try {
        rows = await table();
      } catch {
        return { ready: [], exhausted: true };
      }
      const byProvider = new Map();
      const providersOf = new Map();
      for (const row of rows) {
        if (row.model === "default") continue;
        byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row.model]);
        providersOf.set(row.model, [...(providersOf.get(row.model) ?? []), row.provider]);
      }
      const order = [];
      const add = (spec) => {
        const { model } = modelParts(spec);
        if (!statuses.has(model) && !order.includes(model)) order.push(model);
      };
      // The same model id on its other providers first: that is the one substitution a user can make knowingly, and
      // the alternative a pairing role actually names.
      for (const id of prefer) for (const provider of providersOf.get(id) ?? []) add(`${provider}/${id}`);
      for (let pass = 0; ; pass++) {
        let entries = 0;
        for (const [provider, models] of byProvider) {
          const id = models[pass];
          if (!id) continue;
          entries++;
          add(`${provider}/${id}`);
        }
        if (!entries) break;
      }
      const pending = order.slice(0, budget);
      const ready = [];
      for (const spec of pending) {
        if ((await check(spec)).ready) ready.push(spec);
        if (ready.length >= limit) break;
      }
      return { ready, exhausted: order.length <= budget };
    },
  };
}

/**
 * The caller's own model, from the variables Pi injects into commands run by its bash tool (PI_PROVIDER, PI_MODEL).
 * Pi documents PI_MODEL as the raw model id, and an id can contain slashes and even start with the provider's own
 * name (`anthropic/claude-opus-5-5` on a router, or OpenRouter's literal `openrouter/free`). So the fields are used
 * literally: the provider is always PI_PROVIDER, and the whole PI_MODEL is the id — nothing is inferred from a
 * prefix, or `openrouter/free` would become `openrouter/free` instead of `openrouter/openrouter/free`. An
 * already-qualified spec is what the role model flags are for.
 */
export function callerModel(env = process.env) {
  const model = String(env.PI_MODEL ?? "");
  if (!model) return null;
  const provider = String(env.PI_PROVIDER ?? "");
  return provider ? `${provider}/${model}` : model;
}

/**
 * The model each role would run, resolved before any pane opens. Order: an explicit `--<role>-model` (used as given,
 * but checked); otherwise, for the role that should match the orchestrator (implementer, doer, lead), the caller's own
 * model from PI_PROVIDER/PI_MODEL; otherwise the role's preferences in order, first one that is ready. Only declared
 * candidates are tried: a model id is never moved to a different provider on our own, even when that would work.
 * A role with nothing ready gets `model: null` and the reason; `requireModels` turns that into the run's stop message.
 *
 * `callerCwd` is where the caller's `pi` and PATH entries are resolved — `--cwd` moves the workers, not the caller —
 * while the readiness commands run in `cwd`, the worker's directory, where its project and provider config apply.
 */
export async function resolveModels({ roles, preferences = {}, overrides = {}, callerRole, env = process.env, cwd = process.cwd(), callerCwd = process.cwd(), launch, exec = run, checker, scan = false, limit = 5 }) {
  const probe = checker ?? (() => {
    // The same resolution the worker launcher uses (`workers` → `prepareLaunch`), so what is checked is what is run.
    const resolved = launch ?? resolveLaunch({ env, cwd: callerCwd });
    return modelChecker({ pi: resolved.pi, node: resolved.node, entry: resolved.entry, env: { ...workerEnv(env), PATH: resolved.PATH }, cwd, exec });
  })();
  const caller = callerRole ? callerModel(env) : null;
  // The model ids the roles care about: the scan tries these on their other providers before anything else, so a
  // "same model, different provider" option is named as a choice the user can make, never made for them.
  const prefer = [...new Set([...(caller ? [modelParts(caller).id] : []), ...Object.values(preferences).flat().map((spec) => modelParts(spec).id)])];
  const choices = {};
  for (const role of roles) {
    const list = (preferences[role] ?? []).map((spec, index) => ({ spec, source: "preference", index, count: (preferences[role] ?? []).length }));
    const candidates = [];
    if (overrides[role]) candidates.push({ spec: overrides[role], source: "flag" });
    else {
      if (role === callerRole && caller) candidates.push({ spec: caller, source: "caller" });
      candidates.push(...list);
    }
    const checked = [];
    let pick = null;
    // Stop at the first ready candidate: later preferences are only probed when the earlier ones are not ready.
    for (const candidate of candidates) {
      const status = await probe.check(candidate.spec);
      checked.push({ model: status.spec, ready: status.ready, verified: status.verified, detail: status.detail });
      if (status.ready) {
        pick = { ...candidate, status };
        break;
      }
    }
    const why = (source, candidate) => {
      if (source === "flag") return `passed as --${role}-model`;
      if (source === "caller") return "the caller's own model (PI_PROVIDER/PI_MODEL)";
      return `preference ${candidate.index + 1} of ${candidate.count}`;
    };
    choices[role] = {
      model: pick?.spec ?? null,
      source: pick?.source ?? "none",
      explicit: Boolean(overrides[role]),
      reason: pick ? why(pick.source, pick) : "no candidate is ready",
      ready: Boolean(pick),
      // False when the model is listed but its provider cannot be checked by `pi auth check` (see `modelChecker`).
      verified: Boolean(pick?.status.verified),
      checked,
      alternatives: [],
    };
  }
  // Alternatives: every model this run has proved ready, minus the role's own choice. Discovery runs before any role's
  // list is derived, so one role's scan cannot leave another claiming there is nothing ready. A role with nothing
  // ready is probed past the first budget until something is found or the catalog is exhausted; the `models` report
  // tops every role up to `limit` with one bounded pass each.
  const chosenModel = (role) => (choices[role].model ? modelParts(choices[role].model).model : null);
  const pool = (role) => [...new Set(probe.known().filter((status) => status.ready && status.model !== chosenModel(role)).map((status) => status.spec))];
  const wants = (role) => scan || !choices[role].ready;
  let exhausted = false;
  while (!exhausted) {
    if (!roles.some((role) => wants(role) && pool(role).length === 0)) break;
    exhausted = (await probe.scan({ prefer, limit: 1, budget: DISCOVERY_BUDGET })).exhausted;
  }
  if (scan) {
    for (const role of roles) {
      if (pool(role).length >= limit) continue;
      await probe.scan({ prefer, limit: limit - pool(role).length, budget: TOP_UP_BUDGET });
    }
  }
  for (const role of roles) {
    const choice = choices[role];
    choice.alternatives = pool(role).slice(0, limit);
    choice.probed = probe.known().length;
  }
  return choices;
}

/**
 * `doer model claude-code/claude-opus-5-5 is not ready: credentials_not_configured; ready alternatives: …; pass
 * --doer-model`, the shape the pair plan asks for. Every checked candidate keeps its own reason after the first.
 * When nothing ready was found, the message says so with how far discovery went, rather than claiming the machine has
 * nothing: only the models that were checked are known.
 */
export function notReadyMessage(role, choice) {
  const [first, ...rest] = choice.checked;
  if (!first) return `${role} has no model: pass --${role}-model`;
  const also = rest.length ? [`also not ready: ${rest.map((entry) => `${entry.model} (${entry.detail})`).join(", ")}`] : [];
  const alternatives = choice.alternatives.length
    ? choice.alternatives.join(", ")
    : `none found (checked ${choice.probed ?? choice.checked.length} model${(choice.probed ?? choice.checked.length) === 1 ? "" : "s"})`;
  const flag = choice.explicit ? `pass another --${role}-model` : `pass --${role}-model`;
  return [[`${role} model ${first.model} is not ready: ${first.detail}`, ...also].join("; "), `ready alternatives: ${alternatives}`, flag].join("; ");
}

/** Throw the plan-shaped stop when a role has no ready model; nothing has been opened at this point. */
export function requireModels(choices, roles) {
  for (const role of roles) if (!choices[role].ready) throw new Error(notReadyMessage(role, choices[role]));
  return choices;
}

/** Per role: the model, why it was chosen, and the ready alternatives (B5's `models` output). */
export function formatModels(choices, { workflow, pi, roles }) {
  const lines = [`${workflow} models (checked in a worker's environment: ${pi ?? "pi"})`];
  const readiness = (entry) => (entry.ready ? (entry.verified === false ? "ready (auth unverifiable)" : "ready") : "not ready");
  for (const role of roles) {
    const choice = choices[role];
    const why = choice.ready
      ? `${choice.reason}; checked: ${choice.checked.map((entry) => `${entry.model} ${readiness(entry)}`).join(", ")}`
      : choice.checked.map((entry) => `${entry.model} is not ready: ${entry.detail}`).join("; ") || "no candidate is configured";
    lines.push(`  ${role.padEnd(12)} ${choice.model ?? "(none ready)"}`);
    lines.push(`  ${"".padEnd(12)} why: ${why}`);
    // Say why the auth could not be checked, so "unverifiable" is not read as "not authorized".
    if (choice.ready && choice.verified === false) lines.push(`  ${"".padEnd(12)} auth: ${choice.checked.at(-1)?.detail}`);
    lines.push(`  ${"".padEnd(12)} ready alternatives: ${choice.alternatives.length ? choice.alternatives.join(", ") : `none found (checked ${choice.probed ?? choice.checked.length} models)`}`);
  }
  return lines.join("\n");
}

/**
 * `models [--json]`: what a run would use, without starting one. Exit 0 when every role has a ready model, 1 when one
 * does not (for a script or the orchestrator to check before `run`). Overrides are shown and checked as they would be.
 * `--cwd` is the worker directory; the caller's `pi` and PATH entries are resolved here, like the worker launcher does.
 */
export async function modelsCommand(flags, { workflow, roles, preferences, callerRole, env, exec, log, cwd = process.cwd(), callerCwd = process.cwd() }) {
  const options = Object.fromEntries(roles.map((role) => [role, flags[`${role}-model`]]));
  const launch = resolveLaunch({ env, cwd: callerCwd });
  const choices = await resolveModels({ roles, preferences, overrides: options, callerRole, env, cwd: resolve(cwd), callerCwd, launch, exec, scan: true });
  log(flags.json ? JSON.stringify({ workflow, pi: launch.pi, models: choices }, null, 2) : formatModels(choices, { workflow, pi: launch.pi, roles }));
  return roles.every((role) => choices[role].ready) ? 0 : 1;
}

/**
 * Worker operations behind one interface: anchor() → id, split(anchor, direction, label, argv) → id, send, read,
 * close, and optionally alive (throws when the worker is gone), status (agent state and turn), and idle (true once the
 * agent stopped working).
 * `layout` says how workers are shown: desktop panes ("panes"), hc terminals placed in the caller's Herdr tab by
 * copied labels ("labels"), or only attachable Herdr core terminals ("terminals"). Herdr picks its layout at
 * runtime; see `herdrTransport`.
 */
export function adapter(mux, { exec = run, env = process.env, cwd, onSpawn, ...rest }) {
  if (mux === "herdr") return herdrAdapter({ exec, env, cwd, onSpawn, ...rest });
  if (mux === "rex") {
    // The same discovery `detect`/`doctor` report, so what a run uses is what the check named (D1).
    const bin = findRex({ env }).bin;
    const session = env.REX_SESSION;
    const rex = async (args) => exec(bin, args);
    return {
      layout: "panes",
      anchor: async () => env.REX_BLOCK,
      async split(anchor, direction, label, argv) {
        let answer;
        try {
          answer = await rex(["split", "-s", session, "-b", anchor, `--split=${direction}`, "-c", cwd, "--label", label, "--focus=false", "--json", "--", ...argv]);
        } catch (error) {
          // Only a CLI that never ran proves nothing was created; a lost answer may hide a pane (see `provedNoPane`).
          if (provedNoPane(error)) error.noPane = true;
          throw error;
        }
        const out = JSON.parse(answer);
        const id = out.block_ids?.[0];
        if (!id) throw new Error("rex split returned no block id");
        // The block exists from here on: say so before anything else can fail, so it can still be closed.
        onSpawn?.(id);
        return id;
      },
      async send(id, text) {
        await rex(["send", "-s", session, "-b", id, text]);
        await rex(["send-key", "-s", session, "-b", id, "enter"]);
      },
      read: (id) => rex(["capture", "-s", session, "-b", id, "--trim"]),
      close: (id) => rex(["block", "close", "-s", session, id]),
      /**
       * True only when a successful block list no longer contains it. Text such as "not found" is not evidence by
       * itself — an unreachable server says that too — and a failed list is thrown for the caller to report. The
       * answer must be a block list with usable identities: an unexpected payload proves nothing, so it is thrown
       * rather than read as "no blocks left".
       */
      async gone(id) {
        const out = JSON.parse(await rex(["block", "list", "-s", session, "--json"]));
        if (!Array.isArray(out?.blocks)) throw new Error(`rex block list: unexpected answer ${JSON.stringify(out)}`);
        const ids = out.blocks.map((block) => block?.block_id ?? block?.id);
        if (ids.some((known) => typeof known !== "string" || !known)) throw new Error("rex block list: a row has no block id");
        return !ids.some((known) => known === id || bareId(known) === bareId(id));
      },
    };
  }
  throw new Error(`unsupported multiplexer ${mux}`);
}

/** A CLI found via an override variable, PATH, or Herdr's install folder (~/.local/bin by default). */
function findBin(name, override, env, { platform = process.platform } = {}) {
  if (override) return override;
  const joinPath = pathOf(platform).join;
  const installDir = env.HC_INSTALL_DIR || joinPath(env.HOME || homedir(), ".local", "bin");
  // A Windows install is an `.exe` found through PATHEXT; the hard-coded folder probe is the Herdr-specific fallback.
  const pathext = envGet(env, "PATHEXT", { platform });
  const installNames = executableNames(name, { platform, pathext });
  return onPath(name, envGet(env, "PATH", { platform }), { platform, pathext }) || installNames.map((candidate) => joinPath(installDir, candidate)).find((p) => existsSync(p)) || name;
}

const herdrBins = (env) => ({ hc: findBin("hc", env.HC_BIN, env) });

/**
 * Locate the Rex CLI: `REX_BIN`, `PATH`, then the platform's install folders — the macOS app bundles and the installed
 * Rex Server under `~/Library/Application Support/com.superlogical.rex`, `%LOCALAPPDATA%\\Programs\\Rex` on Windows,
 * and the usual Linux directories. Every candidate is appended to `trace` as found or missing, in probe order, so
 * `detect` and `doctor` can say why Rex was or was not used (D1, the same trace as C4). `exists` and `platform` are
 * injected for tests: no Windows box is needed to check the Windows paths.
 */
export function findRex({ env = process.env, platform = process.platform, exists = existsSync, trace = [] } = {}) {
  const joinPath = pathOf(platform).join;
  // The caller's PATHEXT decides the Windows names (`rex.bat` with `PATHEXT=.BAT`), never a fixed list (audit 6).
  const names = executableNames("rex", { platform, pathext: env.PATHEXT });
  const found = (bin, how) => {
    trace.push(`rex: ${bin} (${how})`);
    return { bin, how };
  };
  const probe = (path, how) => {
    if (exists(path)) return found(path, how);
    trace.push(`rex: ${path} missing (${how})`);
    return null;
  };
  // An explicit override is taken as given, like PAIR_PI_BIN: an unusable one fails where its reason is visible.
  if (env.REX_BIN) return found(env.REX_BIN, "REX_BIN");
  trace.push("rex: REX_BIN is unset");
  const home = env.HOME || env.USERPROFILE || homedir();
  const pathDirs = String(env.PATH ?? "").split(pathDelimiter(platform)).filter(Boolean);
  if (!pathDirs.length) trace.push("rex: PATH has no entries to check");
  for (const dir of pathDirs) for (const name of names) {
    const hit = probe(joinPath(dir, name), "PATH");
    if (hit) return hit;
  }
  const candidates = [];
  if (platform === "darwin") {
    for (const bin of REX_APP_BINS) candidates.push({ path: bin, how: "macOS app" });
    // Where the installed Rex Server keeps its CLI on this Mac (the app is not in /Applications).
    candidates.push({
      path: joinPath(home, "Library", "Application Support", "com.superlogical.rex", "RexServer", "Versions", "Current", "Rex Server.app", "Contents", "MacOS", "rex"),
      how: "macOS Rex Server",
    });
  } else if (platform === "win32") {
    const local = envGet(env, "LOCALAPPDATA", { platform }) || (envGet(env, "USERPROFILE", { platform }) ? win32.join(envGet(env, "USERPROFILE", { platform }), "AppData", "Local") : null);
    if (local) {
      for (const rel of [["Programs", "Rex", "rex.exe"], ["Programs", "Rex", "bin", "rex.exe"], ["Programs", "Rex", "Rex.exe"]]) {
        candidates.push({ path: win32.join(local, ...rel), how: "Windows LOCALAPPDATA" });
      }
    } else trace.push("rex: LOCALAPPDATA is unset, so the Windows install folder cannot be checked");
  } else {
    for (const path of [
      joinPath(home, ".local", "share", "rex", "rex"),
      joinPath(home, ".local", "bin", "rex"),
      "/opt/rex/rex",
      "/usr/local/bin/rex",
      "/usr/bin/rex",
    ]) candidates.push({ path, how: "Linux install folder" });
  }
  for (const candidate of candidates) {
    const hit = probe(candidate.path, candidate.how);
    if (hit) return hit;
  }
  trace.push("rex: not found");
  return { bin: names[0], how: null };
}

/**
 * The reason `probeRex` gives when the Rex variables came from a remote block and there is no CLI on this box. It is
 * its own string so `doctor` can pick the matching remedy instead of guessing from the variables (audit 7).
 */
export const REX_NO_CLI = "REX_* set but no rex CLI here (remote Rex block?)";

/**
 * Rex when its CLI is on this machine. A Rex terminal exports `REX_SESSION`/`REX_BLOCK`, and a shell inside one over
 * SSH inherits them while having neither the CLI nor the server.
 *
 * That case cannot be bridged: the pair hands `rex split` an absolute launcher path inside this machine's run folder,
 * plus a `-c` folder, and the server starts that command **on its own machine** — where this box's repository, task,
 * launcher and report files do not exist. A forwarded control socket (`rex hosts add LABEL
 * unix:///tmp/rex.sock`, the local end of an `ssh -L` forward, as `rex hosts add --help` documents) carries requests
 * only and does not change where the command runs, so it is control-only, not remote worker-launch support (D2,
 * audit 4). The supported answer is to run the orchestration where the Rex terminals execute: in a block on the
 * machine that runs the Rex server.
 */
export function probeRex({ env = process.env, platform = process.platform, exists = existsSync, trace = [] } = {}) {
  const rex = findRex({ env, platform, exists, trace });
  if (rex.how) return { mux: "rex", session: env.REX_SESSION, pane: env.REX_BLOCK, bin: rex.bin, how: rex.how };
  trace.push(
    "rex: REX_* are inherited, but there is no rex CLI here; Rex terminals run on the server's machine, where this folder's launcher, task and reports do not exist, so run the pair on the machine that runs the Rex server (a forwarded socket is control-only: rex split still starts its command there)",
  );
  return { mux: null, reason: REX_NO_CLI };
}

/**
 * Locate the Herdr desktop CLI (`herdr-app`, or `Herdr` inside the macOS app bundle): `HERDR_APP_BIN`, `PATH`,
 * `~/.local/bin` (`HC_INSTALL_DIR`), then the platform's install folders — the macOS app bundle, `%LOCALAPPDATA%` on
 * Windows, its WSL bridge from `/mnt/c`, and the Linux install directories. Finding it is not a layout decision:
 * `probeHerdr` still asks the app whether it can see the caller's terminal.
 *
 * Every candidate probed is appended to `trace` as found or missing, with its source, in probe order — a later hit
 * never hides the paths rejected before it — so `detect` and `doctor` can say why the app was or was not used (C4).
 * `exists`, `exec`, `readFile` and `platform` are injectable for tests; the WSL bridge needs
 * `cmd.exe /c echo %LOCALAPPDATA%` plus `wslpath`, so discovery is async.
 */
export async function findHerdrApp({ env = process.env, platform = process.platform, exists = existsSync, exec = run, readFile = (path) => readFileSync(path, "utf8"), trace = [] } = {}) {
  const joinPath = pathOf(platform).join;
  const found = (bin, how) => {
    trace.push(`herdr-app: ${bin} (${how})`);
    return { bin, how };
  };
  // Every candidate probed is recorded — found or missing — before moving on, so a later hit never hides which
  // locations were checked first (C4: "each path tried, with its reason").
  const probe = (path, how) => {
    if (exists(path)) return found(path, how);
    trace.push(`herdr-app: ${path} missing (${how})`);
    return null;
  };
  // An explicit override is taken as given, like PAIR_PI_BIN: an unusable one fails where its reason is visible.
  if (env.HERDR_APP_BIN) return found(env.HERDR_APP_BIN, "HERDR_APP_BIN");
  trace.push("herdr-app: HERDR_APP_BIN is unset");
  const names = executableNames("herdr-app", { platform, pathext: envGet(env, "PATHEXT", { platform }) });
  const home = env.HOME || envGet(env, "USERPROFILE", { platform }) || homedir();
  const pathDirs = String(envGet(env, "PATH", { platform }) ?? "").split(pathDelimiter(platform)).filter(Boolean);
  if (!pathDirs.length) trace.push("herdr-app: PATH has no entries to check");
  for (const dir of pathDirs) for (const name of names) {
    const hit = probe(joinPath(dir, name), "PATH");
    if (hit) return hit;
  }
  const installDirs = [...new Set([env.HC_INSTALL_DIR, joinPath(home, ".local", "bin")].filter(Boolean))];
  for (const dir of installDirs) {
    const how = dir === env.HC_INSTALL_DIR ? "HC_INSTALL_DIR" : "~/.local/bin";
    for (const name of names) {
      const hit = probe(joinPath(dir, name), how);
      if (hit) return hit;
    }
  }

  const bundles = [];
  if (platform === "darwin") {
    // The binary is `herdr-app` in a download; `Herdr` in the installed app bundle (a `herdr-app` symlink points at it).
    for (const root of ["/Applications", joinPath(home, "Applications")]) {
      for (const name of ["herdr-app", "Herdr"]) bundles.push({ path: joinPath(root, "Herdr.app", "Contents", "MacOS", name), how: "macOS app bundle" });
    }
  } else if (platform === "win32") {
    const local = envGet(env, "LOCALAPPDATA", { platform });
    if (local) bundles.push({ path: joinPath(local, "Programs", "herdr-app", "herdr-app.exe"), how: "Windows LOCALAPPDATA" });
    else trace.push("herdr-app: LOCALAPPDATA is unset, so the Windows install folder cannot be checked");
  } else if (platform === "linux") {
    for (const candidate of [joinPath(home, ".local", "share", "herdr-app", "herdr-app"), "/opt/herdr-app/herdr-app", "/usr/bin/herdr-app"]) {
      bundles.push({ path: candidate, how: "Linux install folder" });
    }
  }
  for (const candidate of bundles) {
    const hit = probe(candidate.path, candidate.how);
    if (hit) return hit;
  }

  // On WSL the app is installed on the Windows side; reach it through the Windows profile that cmd.exe knows.
  if (platform === "linux") {
    let procVersion = "";
    try {
      procVersion = readFile("/proc/version");
    } catch {
      procVersion = "";
    }
    if (!env.WSL_DISTRO_NAME && !/microsoft/i.test(procVersion)) {
      trace.push("herdr-app: not WSL (no WSL_DISTRO_NAME, /proc/version has no microsoft), so no Windows bridge");
    } else {
      try {
        const windows = String(await exec("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], { timeout: 10_000 })).trim();
        if (!windows || windows === "%LOCALAPPDATA%") throw new Error("cmd.exe printed the variable name, not its value");
        const unix = String(await exec("wslpath", ["-u", windows], { timeout: 10_000 })).trim();
        if (!unix) throw new Error("wslpath printed no path");
        const bridge = joinPath(unix, "Programs", "herdr-app", "herdr-app.exe");
        trace.push(`herdr-app: WSL bridge: ${windows} → ${bridge}`);
        const hit = probe(bridge, "WSL bridge");
        if (hit) return hit;
      } catch (error) {
        trace.push(`herdr-app: WSL bridge unusable: ${errorText(error)}`);
      }
    }
  }
  trace.push("herdr-app: not found; Herdr can still run core-only through hc");
  return { bin: names[0], how: null };
}
const errorText = (error) => linesOf(error?.message ?? error)[0];

/**
 * True only when the multiplexer CLI never ran at all (it is not installed here, or cannot be executed), so nothing can
 * have been created. Every other failure — a lost answer, a connection reset, a child killed at its bound, a payload
 * that did not parse — may have created the pane after the server acted, so cleanup must keep looking for its
 * identity (see `dryLaunch`).
 */
const provedNoPane = (error) => ["ENOENT", "EACCES", "EPERM"].includes(error?.code);

/** `ubuntu/t57` → `t57`: the Herdr app qualifies remote IDs with their machine; the core and its callers use the bare id. */
export const bareId = (id) => String(id ?? "").split("/").pop();

/** The Herdr app pane showing terminal `id`, from `herdr-app ls`; throws when the app CLI is missing or has no window. */
async function appPaneOf(exec, app, id) {
  const bare = bareId(id);
  const { spaces = [] } = JSON.parse(await exec(app, ["ls"]));
  const terminals = spaces.flatMap((s) => s.tabs ?? []).flatMap((t) => t.terminals ?? []);
  // Prefer an exact id; otherwise accept the app's machine qualifier (`ubuntu/t57` for `t57`). The caller's own
  // terminal is only known bare, so a same-id terminal on another machine could also match; then the first wins.
  return (terminals.find((t) => t.terminal === id) ?? terminals.find((t) => bareId(t.terminal) === bare))?.pane ?? null;
}

/**
 * Which Herdr controls work from here. `HC_TERMINAL_ID` names a Herdr core terminal; it does not mean the desktop
 * app CLI runs on this machine (over SSH it usually does not). Prefer app panes when `herdr-app ls` shows the caller.
 * Otherwise, if `hc` can see the caller, copy its `herdr.space`/`herdr.tab` labels onto worker terminals (layout
 * `labels`) or, with no such labels, stay core-only (layout `terminals`). Never needs SSH variables.
 * `trace` collects one line per path tried, so `doctor` can show why each path did or did not work.
 */
export async function probeHerdr({ exec = run, env = process.env, trace = [], platform = process.platform, exists = existsSync, readFile } = {}) {
  const self = env.HC_TERMINAL_ID;
  const bins = herdrBins(env);
  const app = await findHerdrApp({ env, platform, exists, exec, readFile, trace });
  let appReason;
  try {
    const pane = await appPaneOf(exec, app.bin, self);
    if (pane) {
      trace.push(`herdr-app (${app.bin}) ls: pane ${pane} shows ${self}`);
      return { layout: "panes", terminal: self, app: app.bin, appHow: app.how };
    }
    appReason = `terminal ${self} is not shown in a Herdr app pane (herdr-app ls)`;
    trace.push(`herdr-app (${app.bin}) ls: ${appReason}`);
  } catch (error) {
    appReason = `herdr-app unavailable here: ${errorText(error)}`;
    trace.push(`herdr-app (${app.bin}): ${errorText(error)}`);
  }
  let info;
  try {
    info = JSON.parse(await exec(bins.hc, ["get", self, "--json"]));
  } catch (error) {
    trace.push(`hc (${bins.hc}) get ${self}: ${errorText(error)}`);
    throw new Error(`Herdr app panes unusable (${appReason}) and Herdr core cannot see ${self} (hc get ${self}: ${errorText(error)})`);
  }
  if (info.state !== "live") {
    trace.push(`hc (${bins.hc}) get ${self}: state ${info.state ?? "unknown"}`);
    throw new Error(`Herdr app panes unusable (${appReason}) and hc get ${self} reports state ${info.state ?? "unknown"}`);
  }
  // C3.1: a terminal started with hc opts into the app's window with `herdr.space` (and `herdr.tab` picks its tab).
  // Copying the caller's own labels onto worker terminals is the only way to show panes from a machine where the
  // desktop CLI does not exist. Whether the app splits the tab or opens a new one is not verified; see the A3.
  const labels = info.labels ?? {};
  const space = labels["herdr.space"];
  const tab = labels["herdr.tab"];
  if (space) {
    const placement = { space, ...(tab ? { tab } : {}) };
    const requested = tab
      ? `request worker terminals in the caller's tab (herdr.space=${space} herdr.tab=${tab})`
      : `request worker terminals in the caller's space (herdr.space=${space}); Herdr creates a tab for them`;
    trace.push(`hc (${bins.hc}) get ${self}: live; labels ${requested}`);
    return { layout: "labels", terminal: self, app: app.bin, appHow: app.how, appReason, placement };
  }
  trace.push(`hc (${bins.hc}) get ${self}: live; labels carry no herdr.space, so worker terminals stay hidden (core-only)`);
  return { layout: "terminals", terminal: self, app: app.bin, appHow: app.how, appReason };
}

/** "pair-review: lead" → { workflow: "pair-review", role: "lead" } */
const parseLabel = (label) => {
  const m = /^([\w-]+):\s*([\w-]+)$/.exec(label);
  return m ? { workflow: m[1], role: m[2] } : { workflow: "pair", role: label.replace(/\W+/g, "-") };
};
const ownerLabels = (label, runId) => {
  const { workflow, role } = parseLabel(label);
  return [`pair.workflow=${workflow}`, `pair.role=${role}`, ...(runId ? [`pair.run=${runId}`] : [])];
};

/**
 * Talking to Herdr core terminals, shared by both Herdr layouts. Pi reports its status to the core (OSC 7501);
 * `ready` waits with `hc wait` while a worker is working, never types into a blocked worker, and gives up at `timeout`.
 */
function hcControls({ hc, sleep = sleepMs, now = Date.now, timeout = 3_600_000, progress = () => {} }) {
  const noted = new Set();
  // The app may hand back a machine-qualified address (`ubuntu/t7`); the core this `hc` talks to knows the bare one.
  const get = async (id) => JSON.parse(await hc(["get", bareId(id), "--json"]));
  const gone = (id, t) => new Error(`terminal ${id} is ${t.state}${t.exit_code == null ? "" : ` (exit ${t.exit_code})`}`);
  const noteBlocked = (id) => {
    if (noted.has(id)) return;
    noted.add(id);
    // `hc` takes the core's bare address, not the app's machine-qualified one; the label keeps what the app calls it.
    progress(`worker ${id} is blocked and needs a person: hc attach ${bareId(id)} (or open it in Herdr), answer it, then the run continues`);
  };
  /** The agent status and turn the worker reported (OSC 7501), or null before its first report. */
  const status = async (id) => {
    const t = await get(id);
    return t.status?.state ? { state: t.status.state, turn: t.turn ?? 0 } : null;
  };
  /** True once the worker reported a status other than working; false when it never reports status. */
  async function ready(id) {
    const start = now();
    for (;;) {
      const t = await get(id);
      if (t.state !== "live") throw gone(id, t);
      const status = t.status?.state;
      if (!status) return false;
      if (status !== "working" && status !== "blocked") return true;
      if (now() - start > timeout) throw new Error(`worker ${id} is still ${status} after ${Math.round(timeout / 60_000)}m; inspect it with hc read ${bareId(id)} --lines 100`);
      // hc wait returns when the turn ends (or checks in after 120s); if hc itself fails, back off instead of spinning.
      if (status === "working") await hc(["wait", bareId(id), "--timeout", "120", "--json"]).catch(() => sleep(5_000));
      else {
        noteBlocked(id);
        await sleep(15_000);
      }
    }
  }
  return {
    status,
    // After a finished report: true once the turn ended. Errors (e.g. the worker exited) fall back to settling its screen.
    idle: (id) => ready(id).catch(() => false),
    // Before a send: wait while it works; throws if it is gone or stays blocked past the turn timeout.
    async send(id, text) {
      await ready(id);
      await hc(["send", bareId(id), text]);
    },
    read: (id) => hc(["read", bareId(id), "--lines", "40"]),
    // `hc read` still works after a terminal finished, so ask the core whether it is live.
    async alive(id) {
      const t = await get(id);
      if (t.state !== "live") throw gone(id, t);
      if (t.status?.state === "blocked") noteBlocked(id);
    },
    /**
     * True only when the core says this terminal does not exist: `hc get` then answers exit 3 with
     * `{"error":{"kind":"not_found","message":"no terminal \"t7\""}}` on stdout. A socket or server failure is not
     * evidence that the pane disappeared, so it is thrown for the caller to report as unconfirmed closure.
     */
    async gone(id) {
      try {
        await get(id);
        return false;
      } catch (error) {
        if (parseJson(error?.stdout)?.error?.kind === "not_found") return true;
        throw error;
      }
    },
  };
}

/**
 * Herdr core only (e.g. over SSH, where `herdr-app` is absent): workers are background `hc` terminals started in
 * the worker folder with their first task as Pi's argument. They are attachable, and with the caller's labels copied
 * on the app is asked to place them in its space or tab (C3.1).
 */
function herdrCoreAdapter({ exec, env, cwd, runId, onSpawn, placement, ...controls }) {
  const hcBin = herdrBins(env).hc;
  const hc = (args) => exec(hcBin, args);
  // The caller's own herdr.space/herdr.tab labels, copied as a placement request to the app (C3.1).
  const placeLabels = (placement ? [["herdr.space", placement.space], ...(placement.tab ? [["herdr.tab", placement.tab]] : [])] : []).map(([key, value]) => `${key}=${value}`);
  return {
    layout: placement ? "labels" : "terminals",
    ...(placement ? { placement } : {}),
    ...hcControls({ hc, ...controls }),
    anchor: async () => env.HC_TERMINAL_ID,
    async split(_anchor, _direction, label, argv) {
      const { workflow, role } = parseLabel(label);
      const name = `${workflow}-${role}-${runId}`.slice(0, 32);
      const labels = [...ownerLabels(label, runId), ...placeLabels].flatMap((l) => ["--label", l]);
      // --no-notify: hc must not type notes into the caller while it runs this orchestration.
      let stdout;
      try {
        stdout = await hc(["run", "--bg", "--json", "--no-notify", "--name", name, "--cwd", cwd, ...labels, "--", ...argv]);
      } catch (error) {
        // A missing `hc` had no chance to start a terminal; a lost or killed answer may hide one (see `provedNoPane`).
        if (provedNoPane(error)) error.noPane = true;
        throw error;
      }
      const out = JSON.parse(stdout);
      if (!out.address) throw new Error("hc run returned no terminal address");
      // The terminal exists from here on: say so before anything else can fail, so it can still be closed.
      onSpawn?.(out.address);
      return out.address;
    },
    async close(id) {
      await hc(["kill", bareId(id)]).catch(() => {});
      await hc(["rm", bareId(id)]).catch(() => {});
    },
  };
}

/** Herdr with app panes, label-placed core terminals, or core-only, chosen by `probeHerdr`. */
export async function herdrTransport(options) {
  const probe = await probeHerdr(options);
  const progress = options.progress ?? (() => {});
  if (probe.layout === "labels") {
    const asked = probe.placement.tab ? "the caller's Herdr tab" : "the caller's Herdr space (Herdr creates a tab)";
    progress(`herdr: panes via hc labels (${probe.appReason}); workers are requested in ${asked}`);
  }
  else if (probe.layout === "terminals") progress(`herdr: no automatic panes (${probe.appReason}); using Herdr core terminals`);
  return probe.layout === "panes"
    ? herdrAdapter({ ...options, app: probe.app })
    : herdrCoreAdapter({ ...options, placement: probe.placement });
}

/**
 * Herdr app: `herdr-app` arranges panes in the window, herdr-core `hc` talks to the terminals in them.
 * Workers are identified by their terminal address (t7); the adapter remembers each one's pane for splitting.
 */
function herdrAdapter({ exec, env, runId, onSpawn, app: appBin, ...controls }) {
  const { hc: hcBin } = herdrBins(env);
  const app = appBin ?? findBin("herdr-app", env.HERDR_APP_BIN, env);
  const herdrApp = async (command, args) => {
    // On failure herdr-app prints {"error": "..."} on stdout and exits 1.
    const stdout = await exec(app, ["do", command, JSON.stringify(args)]).catch((error) => error.stdout || Promise.reject(error));
    const out = JSON.parse(stdout);
    if (out?.error) throw new Error(`herdr-app ${command}: ${out.error}`);
    return out;
  };
  const hc = (args) => exec(hcBin, args);
  const paneOf = new Map();
  let home = null;
  return {
    layout: "panes",
    ...hcControls({ hc, ...controls }),
    // The caller's pane: the window's pane showing our own terminal ($HC_TERMINAL_ID).
    async anchor() {
      const self = env.HC_TERMINAL_ID;
      const pane = await appPaneOf(exec, app, self);
      if (!pane) throw new Error(`terminal ${self} is not shown in a Herdr app pane (herdr-app ls)`);
      paneOf.set(self, pane);
      home = pane;
      return self;
    },
    async split(anchor, direction, label, argv) {
      // No shell wrapper: `pane.split` has no folder argument (`herdr-app commands`), so the launcher changes directory
      // itself, which also works where there is no `/bin/sh` — a Windows box — and keeps the argv free of a shell that
      // would re-quote the prompt (E1).
      const out = await herdrApp("pane.split", { direction: direction === "below" ? "down" : "right", pane: paneOf.get(anchor) ?? anchor, argv }).catch((error) => {
        // A missing `herdr-app` had no chance to open a pane; anything else might have (see `provedNoPane`).
        if (provedNoPane(error)) error.noPane = true;
        throw error;
      });
      if (!out.terminal || !out.pane) throw new Error("herdr-app pane.split returned no terminal");
      paneOf.set(out.terminal, out.pane);
      // The pane exists from here on: say so before focus or labeling can fail, so it can still be closed.
      onSpawn?.(out.terminal);
      // pane.split focuses the new pane; give the keyboard back to the user's pane.
      if (home) await herdrApp("pane.focus", { pane: home }).catch(() => {});
      // Ownership labels let `close` refuse terminals that this run did not start.
      await hc(["label", bareId(out.terminal), ...ownerLabels(label, runId)]).catch(() => {});
      return out.terminal;
    },
    // Close the worker's pane (ending its terminal), then drop the finished terminal from herdr-core. The app needs
    // the qualified pane id `ls` returned; the core needs the bare terminal id.
    async close(id) {
      const pane = await appPaneOf(exec, app, id).catch(() => null);
      if (pane) await herdrApp("pane.close", { pane });
      else await hc(["kill", bareId(id)]).catch(() => {});
      await hc(["rm", bareId(id)]).catch(() => {});
    },
  };
}

/**
 * Absolute path of an executable, so non-interactive pane shells need not share our PATH. Uses the platform's PATH
 * separator (`;` on Windows, never a hard-coded `:`, E3) and, on Windows, `PATHEXT` so a command name finds `pi.cmd`
 * or `node.exe` (E2).
 */
export function onPath(name, path = "", { platform = process.platform, exists = existsSync, pathext, env } = {}) {
  const joinPath = pathOf(platform).join;
  const names = executableNames(name, { platform, pathext: pathext ?? env?.PATHEXT });
  for (const dir of String(path).split(pathDelimiter(platform)).filter(Boolean)) {
    for (const candidate of names) if (exists(joinPath(dir, candidate))) return joinPath(dir, candidate);
  }
  return null;
}

// ---------- turn files ----------

const RULES = {
  implementer: `You are the IMPLEMENTER in a pair-programming session with a separate auditor.
- Carry out the task in this repository. Follow AGENTS.md and the repo's conventions.
- Run the relevant checks yourself and report the commands and results.
- Do not commit, push, deploy, or send external messages.
- The auditor reviews your work after each turn. Address every finding: fix it or explain concretely why not.`,
  auditor: `You are the AUDITOR in a pair-programming session with a separate implementer.
- Do not modify repository files. You may read files and run read-only commands and tests.
- Review the working-tree changes (git status, git diff, and untracked files) against the task.
- Report only actionable findings, ordered by severity (blocker, major, minor), each with file:line and a concrete fix.
- Check correctness, missed requirements, edge cases, tests, and whether the claimed verification really passed.
- End with a verdict line: "Verdict: approve" or "Verdict: changes requested".`,
};

export function turnText({ role, kind, task, report, previous, round, rounds, baseline }) {
  const steps = {
    orient: "Read the task below and familiarize yourself with the relevant code. Do not review yet; there are no changes to audit.",
    implement: "Implement the task below.",
    audit: `Audit round ${round} of ${rounds}. Read the implementer's report at ${previous} and review the current changes.`,
    address: `Address the auditor's round ${round} feedback in ${previous}.${round === rounds ? " This is the final round: also summarize the end state, remaining risks, and verification." : ""}`,
  }[kind];
  return [
    RULES[role],
    "",
    `## This turn\n\n${steps}`,
    "",
    `When finished, write your report as Markdown to:\n\n${report}\n\nWrite the report file last. Its final line must be exactly: ${DONE}`,
    "",
    baseline ? `## Repository state before the session\n\n${baseline}\n` : "",
    `## Task\n\n${task}`,
  ].join("\n");
}

// ---------- orchestration ----------

/** Poll for a finished report; every `checkEvery` polls, `isAlive` may throw if the worker's pane is gone. */
export async function waitForReport(path, { sleep = sleepMs, now = Date.now, timeout, interval = 2000, checkEvery = 15, isAlive }) {
  const start = now();
  for (let poll = 1; ; poll++) {
    if (existsSync(path) && reportDone(readFileSync(path, "utf8"))) return readFileSync(path, "utf8");
    if (now() - start > timeout) throw new Error(`timed out waiting for ${path}`);
    if (isAlive && poll % checkEvery === 0) await isAlive();
    await sleep(interval);
  }
}

/**
 * Provider errors that end a worker's turn without a report: plan usage limits and requests charged to paid usage
 * credits. These stop the run so the user decides; the script never switches models or enables credits itself.
 */
export const LIMIT_PATTERNS = [
  /usage limit (?:has been reached|exceeded|reached)/i,
  /charged to (?:\w+ )?usage credits/i,
  /UsageLimitError/,
  /out of (?:plan )?(?:usage|quota)/i,
];

/**
 * The provider-limit error line in the last lines of a worker's screen, or null. Only lines that read as an error or
 * billing notice count, so a worker that merely discusses rate limits in its output is not mistaken for a stop.
 */
export function usageLimit(screen, lines = 12) {
  for (const line of linesOf(screen).slice(-lines)) {
    if (/error|billing|\b4\d\d\b/i.test(line) && LIMIT_PATTERNS.some((p) => p.test(line))) return line.trim().slice(0, 200);
  }
  return null;
}

/** Thrown when a worker stopped on a provider limit; the run ends as `stopped` rather than `failed`. */
export class StoppedError extends Error {
  constructor(message) {
    super(message);
    this.stopReason = "usage-limit";
  }
}

/**
 * Lines that mean a worker never started: the program is missing, the model is unknown, or no provider is logged in.
 * Startup has nothing else on screen yet, so these are safe to match there.
 */
export const STARTUP_ERRORS = [/No API key found/i, /Model not found/i, /unknown model/i, /command not found/i, /No such file or directory/i, /Use \/login|\/login to log/i];

/** The same notices that are still conclusive during a turn: nobody is logged in, so no report is coming. */
export const TURN_ERRORS = [/No API key found/i, /Model not found/i, /unknown model/i, /Use \/login|\/login to log/i, /not (?:logged|signed) in/i, /not authenticated/i];

/** The last lines of a worker's screen, for an error message. */
export const screenTail = (screen, lines = 12) => linesOf(screen).slice(-lines).join("\n").trim();

/** The first line of a worker's screen that matches one of `patterns`, or null. */
export function screenError(screen, patterns = STARTUP_ERRORS, lines = 20) {
  for (const line of linesOf(screen).slice(-lines)) if (patterns.some((pattern) => pattern.test(line))) return line.trim().slice(0, 200);
  return null;
}

/**
 * Fail fast on a worker that never started. After `spawn`, watch the startup window for: the terminal or launcher
 * exit, an agent error, or a first turn. Its screen is only classified once the worker itself reported an agent status:
 * a capture-only transport (Rex) shows its transcript as much as its errors, and so does a Herdr worker that has not
 * reported OSC status yet (or has status reporting turned off). Those rely on the launcher's exit record instead.
 */
export async function awaitStartup(id, { panes, role, launch, dir, exitFile, timeout = 20_000, interval = 500, sleep = sleepMs, now = Date.now, progress = () => {} }) {
  const watched = typeof panes.status === "function";
  const startedAt = now();
  const maxPolls = Math.max(1, Math.ceil(timeout / interval));
  const read = async () => String(await panes.read(id).catch(() => ""));
  const failure = async (reason) => {
    const tail = screenTail(await read());
    return new Error([
      `worker ${role} ${id} did not start: ${reason}`,
      tail ? `Screen tail:\n${tail}` : null,
      `Launch: pi ${launch.pi}, node ${launch.node ?? "(none found)"}`,
      `PATH ${launch.PATH || "(empty)"}`,
      `Launcher and reports: ${dir}`,
    ].filter(Boolean).join("\n"));
  };
  for (let poll = 1; ; poll++) {
    if (panes.alive) {
      try {
        await panes.alive(id);
      } catch (error) {
        throw await failure(`its terminal is gone (${errorText(error)})`);
      }
    }
    // The launcher records Pi's exit code, so a dead worker is visible even where the agent reports no status.
    const code = launcherExit(exitFile, id);
    if (code !== null) throw await failure(`it exited (code ${code}) before taking its first turn`);
    const status = watched ? await panes.status(id).catch(() => null) : null;
    // A reported error outranks a positive turn: Pi can report an error after starting a turn, which is not a launch.
    if (status?.state === "error") {
      const limit = usageLimit(await read());
      if (limit) throw new StoppedError(`${role} ${id} stopped on a provider limit: "${limit}". Reports are in ${dir}`);
      throw await failure("the agent reported an error (status: error)");
    }
    if (["working", "blocked", "done"].includes(status?.state) || (status?.turn ?? 0) > 0) return;
    // Screen text is startup output only while the worker reports a status at all: `status()` existing is not enough,
    // because Herdr always exposes one, including for a worker that never reported. Without a status, a capture may
    // already quote an error from its transcript, so it is not classified here.
    if (status) {
      const text = await read();
      const limit = usageLimit(text);
      if (limit) throw new StoppedError(`${role} ${id} stopped on a provider limit: "${limit}". Reports are in ${dir}`);
      const hit = screenError(text);
      if (hit) throw await failure(`its screen shows a startup error: "${hit}"`);
    }
    if (poll >= maxPolls || now() - startedAt >= timeout) {
      // A transport or terminal that never reports status is not evidence of a failed start; carry on as before.
      if (!status) {
        if (watched) progress(`${role} ${id} never reported an agent status; continuing without a startup check`);
        return;
      }
      throw await failure(`it reported "${status.state}" at turn ${status.turn} for ${Math.round(timeout / 1000)}s instead of taking its first turn`);
    }
    await sleep(interval);
  }
}

// ---------- run status (for `wait`) ----------

export const STATUS_FILE = "status.json";
const RUN_DIRS = ["pi-pair", "pi-pair-review", "pi-pair-work"];

export function readStatus(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, STATUS_FILE), "utf8"));
  } catch {
    return null;
  }
}

export function updateStatus(dir, patch) {
  // A run folder holds reports and the worker launcher with the caller's environment: owner-only when we create it.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = { ...readStatus(dir), ...patch, updated: new Date().toISOString() };
  writeFileSync(join(dir, STATUS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Run a workflow while keeping `<dir>/status.json` current, so `wait` in another process can follow it:
 * `running` (with the last progress line), then `done` with the result and its summary, `stopped` on a provider
 * limit, or `failed` on any other error.
 */
export async function tracked({ dir, runId, workflow, script, progress = () => {} }, body, format) {
  updateStatus(dir, { state: "running", workflow, runId, dir, pid: process.pid, started: new Date().toISOString() });
  progress(`${workflow} run ${runId}: follow it with \`node ${script} wait ${runId}\` (status in ${join(dir, STATUS_FILE)})`);
  const note = (message) => {
    progress(message);
    updateStatus(dir, { last: message });
  };
  try {
    const result = await body(note);
    updateStatus(dir, { state: "done", result, summary: format(result) });
    return result;
  } catch (error) {
    updateStatus(dir, { state: error.stopReason ? "stopped" : "failed", stopReason: error.stopReason, reason: error.message });
    throw error;
  }
}

/** The run folder for a run id (searched under the temp folder) or a run folder path. */
export function findRun(target, { roots = RUN_DIRS.map((name) => join(tmpdir(), name)) } = {}) {
  if (readStatus(target)) return target;
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) if (readStatus(join(root, entry))?.runId === target) return join(root, entry);
  }
  throw new Error(`no pair run ${target} found (pass the run id printed by run, or its report folder)`);
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * Block until the run is no longer `running` or `timeout` passes, then return its status. A run whose orchestrating
 * process died without writing a result is marked `failed`.
 */
export async function waitForRun(dir, { timeout = 900_000, interval = 5_000, sleep = sleepMs, now = Date.now, alive = pidAlive } = {}) {
  const start = now();
  for (;;) {
    let status = readStatus(dir);
    if (!status) throw new Error(`no ${STATUS_FILE} in ${dir}`);
    if (status.state === "running" && status.pid && !alive(status.pid)) {
      status = updateStatus(dir, { state: "failed", reason: `the run process (pid ${status.pid}) exited without a result; read the workers and reports in ${dir}` });
    }
    if (status.state !== "running" || now() - start >= timeout) return status;
    await sleep(interval);
  }
}

export function formatWait(status) {
  const workers = Object.entries(status.workers ?? {}).map(([role, id]) => `${role} ${id}`).join(", ");
  const where = `Reports: ${status.dir}${workers ? `. Workers: ${workers}` : ""}`;
  if (status.state === "done") return status.summary ?? `done: ${where}`;
  if (status.state === "running") return `running: ${status.workflow ?? "pair"} run ${status.runId} is still working${status.last ? ` (last: ${status.last})` : ""}. Call wait again; do not end your turn.`;
  if (status.state === "stopped") return `stopped: ${status.reason}\n${where}\nAsk the user how to continue. Do not switch models or enable paid credits.`;
  return `failed: ${status.reason}\n${where}`;
}

/** `wait <run-id|dir> [--timeout 15m] [--json]`: exit 0 while running or done, 1 when stopped or failed. */
export async function waitCommand(target, flags, { log = console.log, sleep, now, roots } = {}) {
  if (!target) throw new Error("wait needs the run id printed by run (or the run's report folder)");
  const status = await waitForRun(findRun(target, roots ? { roots } : undefined), { timeout: parseDuration(flags.timeout ?? "15m"), sleep, now });
  const { result, ...brief } = status;
  log(flags.json ? JSON.stringify(status.state === "done" ? status : brief, null, 2) : formatWait(status));
  return status.state === "running" || status.state === "done" ? 0 : 1;
}

/** Wait until a pane's output stops changing, so the next prompt is not sent mid-response. */
export async function settle(read, { sleep = sleepMs, interval = 1500, maxPolls = 20 } = {}) {
  let previous = null;
  for (let i = 0; i < maxPolls; i++) {
    const current = await read().catch(() => "");
    if (current === previous) return;
    previous = current;
    await sleep(interval);
  }
}

/** The worker transport for `mux`: Rex panes, Herdr app panes, or Herdr core terminals (see `probeHerdr`). */
export async function transport(mux, options) {
  return mux === "herdr" ? herdrTransport(options) : adapter(mux, options);
}

/** Eight hex characters that tag this run's workers so concurrent runs and `close` cannot confuse them. */
export const newRunId = () => randomBytes(4).toString("hex");

/**
 * Shared worker plumbing for pair, pair-review, and pair-work: numbered turn/report files in `dir`, two Pi workers
 * started through the chosen transport, and waiting for a worker's finished report. Reports stay on this machine.
 */
export async function workers({ task, mux, cwd, dir, turnTimeout, label = "Pair session", render, exec = run, env = process.env, sleep = sleepMs, now = Date.now, progress = () => {}, runId = newRunId() }) {
  const timeout = parseDuration(turnTimeout);
  const panes = await transport(mux, { exec, env, cwd, runId, sleep, now, timeout, progress });
  // Reports and the worker launcher hold the caller's environment: keep them for this user only.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The caller's environment, resolved in the caller's directory: relative overrides and PATH entries are the
  // caller's files, not the worker folder's.
  const launch = prepareLaunch({ dir, env, mux, cwd: process.cwd(), workdir: cwd });
  const baseline = await exec("git", ["status", "--short", "--branch"], { cwd }).then((s) => `\`git status --short --branch\`:\n\n\`\`\`\n${s.trim()}\n\`\`\``, () => "");
  writeFileSync(join(dir, "task.md"), task);
  updateStatus(dir, { launch: launch.record });

  let step = 0;
  const reports = [];
  // The turn each worker's last observed status had, so a send that has not been picked up yet is not mistaken for
  // an idle worker sitting on an error from the previous turn.
  const lastTurn = new Map();
  return {
    panes,
    reports,
    runId,
    /** Fields every workflow's result carries: transport layout, run id, and the caller's own pane or terminal. */
    meta: {
      layout: panes.layout,
      runId,
      caller: mux === "herdr" ? env.HC_TERMINAL_ID : env.REX_BLOCK,
      ...(panes.placement ? { placement: panes.placement } : {}),
    },
    /** Write the next turn file; `render` gets the role, kind, report path, task, and baseline plus `extra`. */
    prepare(role, kind, extra = {}) {
      const base = join(dir, `${String(++step).padStart(2, "0")}-${role}-${kind}`);
      const turn = `${base}.turn.md`;
      const report = `${base}.report.md`;
      writeFileSync(turn, render({ role, kind, task, report, baseline, ...extra }));
      return { turn, report, prompt: `${label} (${role}, ${kind}): read ${turn} and follow it exactly.` };
    },
    // The first task is Pi's launch argument, so it cannot be dropped by a send to a booting agent.
    async spawn(anchor, direction, name, model, prompt) {
      const role = parseLabel(name).role;
      const id = await panes.split(anchor, direction, name, launch.argv(["--model", model, prompt]));
      const status = readStatus(dir);
      if (status) updateStatus(dir, { mux, layout: panes.layout, workers: { ...status.workers, [role]: id } });
      await awaitStartup(id, { panes, role, launch: launch.record, dir, exitFile: launch.exitFile, sleep, now, progress });
      return id;
    },
    async finish(role, id, { report }) {
      progress(`waiting for ${role}: ${report}`);
      // The baseline is the turn this worker's previous turn ended on, not a fresh reading: a send may already have
      // advanced the turn (and gone idle again) before this function starts, and folding that into the baseline would
      // swallow the advance. Any turn counted past the baseline means the send was picked up.
      const base = lastTurn.get(id) ?? 0;
      const before = await panes.status?.(id).catch(() => null);
      let started = before?.state === "working" || (before?.turn ?? 0) > base;
      let last = before;
      const isAlive = async () => {
        // Liveness and the screen are one check already on a transport without `alive` (Rex): read once.
        let screen = null;
        await (panes.alive ?? panes.read)(id).then((text) => {
          if (typeof text === "string") screen = text;
        }, (error) => {
          throw new Error(`${role} ${panes.layout === "panes" ? "pane" : "terminal"} ${id} is gone (${error.message}); reports so far are in ${dir}`);
        });
        // The launcher records Pi's exit, which is a death signal even where the agent reports no status.
        const code = launcherExit(launch.exitFile, id);
        if (code !== null) throw new Error(`${role} ${id} exited (code ${code}) before writing ${report}; reports so far are in ${dir}`);
        const status = await panes.status?.(id).catch(() => null);
        last = status ?? last;
        if (status?.state === "working" || (status?.turn ?? 0) > base) started = true;
        if (status?.state === "working") return;
        // A provider limit ends the turn whatever this worker's turn state is, and no report is coming: this check is
        // deliberately independent of the turn-freshness gate below, which only covers ambiguous transcript text.
        const text = screen ?? String(await panes.read(id).catch(() => ""));
        const limit = usageLimit(text);
        if (limit) throw new StoppedError(`${role} ${id} stopped on a provider limit: "${limit}". Reports so far are in ${dir}`);
        // Only diagnose a login or agent error for a turn this worker actually started. Otherwise the text belongs to
        // the previous turn, where an error banner is history rather than a failure of this turn.
        if (!started && status?.state !== "error") return;
        const notice = screenError(text, TURN_ERRORS, 12);
        const needs = status?.state === "error" ? "reported an agent error" : notice ? `shows "${notice}"` : null;
        if (!needs) return;
        throw new Error(`${role} ${id} ${needs} instead of writing ${report}. Open it and answer it (${panes.layout === "panes" ? "focus its pane" : `hc attach ${id}`}); reports so far are in ${dir}`);
      };
      const text = await waitForReport(report, { sleep, now, timeout, isAlive, checkEvery: 1 });
      lastTurn.set(id, Math.max(last?.turn ?? 0, base));
      reports.push({ role, path: report });
      if (!(await panes.idle?.(id))) await settle(() => panes.read(id), { sleep });
      return text;
    },
  };
}

export async function runPair({ task, mux, cwd, dir, rounds, implementerModel, auditorModel, turnTimeout, exec = run, env = process.env, sleep = sleepMs, now = Date.now, progress = () => {}, runId }) {
  const { panes, reports, meta, prepare, spawn, finish } = await workers({ task, mux, cwd, dir, turnTimeout, render: (o) => turnText({ rounds, ...o }), exec, env, sleep, now, progress, runId });
  const first = prepare("implementer", "implement");
  const implementer = await spawn(await panes.anchor(), "right", "pair: implementer", implementerModel, first.prompt);
  const orient = prepare("auditor", "orient");
  const auditor = await spawn(implementer, "below", "pair: auditor", auditorModel, orient.prompt);
  progress(`${mux}: implementer ${implementer} (${implementerModel}), auditor ${auditor} (${auditorModel}); files in ${dir}`);

  await finish("auditor", auditor, orient);
  let last = await finish("implementer", implementer, first);
  let verdict = "";
  for (let round = 1; round <= rounds; round++) {
    const audit = prepare("auditor", "audit", { round, previous: reports.at(-1).path });
    await panes.send(auditor, audit.prompt);
    const feedback = await finish("auditor", auditor, audit);
    verdict = /verdict:\s*([^\n]*)/i.exec(feedback)?.[1].trim() ?? "";
    const address = prepare("implementer", "address", { round, previous: audit.report });
    await panes.send(implementer, address.prompt);
    last = await finish("implementer", implementer, address);
  }
  return { mux, ...meta, dir, panes: { implementer, auditor }, models: { implementer: implementerModel, auditor: auditorModel }, rounds, lastAuditVerdict: verdict, reports, finalReport: last.replace(DONE, "").trim() };
}

// ---------- doctor (F3) ----------

/** A passing doctor check; `more` holds extra indented lines (paths tried, alternatives). */
const pass = (name, detail, more = []) => ({ name, ok: true, detail, more });
/** A failing doctor check, always with at least one fix (`fix` is a string or a list). */
const fail = (name, detail, fix, more = []) => ({ name, ok: false, detail, fix, more });
const skipped = (name, detail) => ({ name, ok: true, skipped: true, detail });

/**
 * Await a multiplexer or Pi command for at most `ms`. Those commands are external processes, so `run()` is given the
 * same bound and kills a child that overruns it; the race keeps the caller's deadline even when the transport is an
 * injected function that never settles. A rejection carries `timeout: true` so callers can tell a stall from a refusal.
 */
function within(promise, ms, what) {
  const bound = Math.max(1, Math.round(ms));
  let timer;
  // Deliberately not unref'd: this timer is the only thing that must fire when the awaited command never answers.
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} did not answer within ${bound} ms`), { timeout: true })), bound);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** A version line on a worker's screen (what `pi --version` prints), or null. */
const versionOf = (screen) =>
  linesOf(screen).map((line) => line.trim()).find((line) => /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(line)) ?? null;

/**
 * The exit code this dry launch recorded. The launcher file belongs to this one launch, so a single record is its
 * answer even when the multiplexer names the terminal differently from the id it returned; matching the worker id
 * first keeps the same rule as a real run.
 */
function dryExit(exitFile, id) {
  const code = launcherExit(exitFile, id);
  if (code !== null) return code;
  let lines;
  try {
    lines = linesOf(readFileSync(exitFile, "utf8")).map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
  if (lines.length !== 1) return null;
  const only = Number(lines[0].split(/\s+/)[1]);
  return Number.isFinite(only) ? only : null;
}

/**
 * `pi --version` through the same launcher and multiplexer path as the workers (F3): the worker environment is what
 * is tested, in a real pane or terminal. The result comes from the launcher's exit record, or from the screen when no
 * record arrives (`--version` prints one bare version line). Every mux command has a hard deadline of its own (the
 * `timeout` for the launch, `cleanupTimeout` for closing), so a stalled CLI cannot make doctor wait forever, and a
 * conclusive exit record is never held up by a screen read for longer than a moment. Creation itself may run through
 * its whole permitted lifetime — the launch window plus `cleanupTimeout` — and cleanup waits that whole lifetime for
 * it. An identity that only surfaces after it is then adopted in a window of `closeTimeout`, and the close that
 * follows gets a further window of its own, so waiting for an identity can never starve the close: a rejected split
 * (the server can create the pane and then lose the answer, or a killed child can leave one) and a killed command are
 * both searched for. Only a mux CLI that never ran (`ENOENT`/`EACCES`/`EPERM`) proves no pane was created, and only
 * that skips the search. No allowed creation can still open a pane when this returns.
 *
 * **Finding the pane again is part of the job.** A split can create the pane and still fail afterwards (focusing,
 * labeling) or answer too late, so the created id is recorded the moment the adapter has it (`onSpawn`), cleanup
 * waits out the creation's whole lifetime for its answer, and the launcher writes its own
 * identity to `launch.id` as soon as it starts. Any of those lets cleanup close the pane.
 *
 * It then closes what it opened and confirms the pane or block is gone: `closed` is true only for a transport-specific
 * `not found` answer about *that* terminal or block (`hc get`'s structured `kind: not_found`, a Rex block list that no
 * longer contains it), never for a timeout or an unreachable helper, whose error is kept in `closeError`. Cleanup is
 * attempted twice. A temporary run folder is removed last, because the launcher and its identity record live there.
 */
export async function dryLaunch({ mux, env = process.env, cwd = process.cwd(), callerCwd = cwd, exec = run, platform = process.platform, dir, timeout = 15_000, cleanupTimeout = 5_000, closeTimeout = 5_000, opTimeout = 5_000, interval = 500, sleep = sleepMs, now = Date.now, progress = () => {}, runId = newRunId() } = {}) {
  const ownDir = !dir;
  const workDir = dir ?? mkdtempSync(join(tmpdir(), "pi-pair-doctor-"));
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  // The launch clock starts when the multiplexer work does, not while pi and the launcher are being prepared: a slow
  // disk (or a large interpreter being read for its shebang) must not eat the pane's own budget.
  let start = now();
  let deadline = start + timeout;
  // Commands the split itself runs (a create, then focus or labeling) may take into the cleanup window: a creation
  // answer that arrives late is still the identity that has to be closed, and it is reported through `onSpawn`.
  let callCap = opTimeout;
  let execEnd = deadline;
  /** Time one mux command may take: never past the phase's deadline, and never more than one command's share. */
  const left = () => Math.max(1, Math.min(opTimeout, deadline - now()));
  // Passed into the transport as `exec`: every multiplexer call is bounded, and a real child is killed on overrun.
  const call = (cmd, args, opts = {}) => {
    const ms = Math.max(1, Math.min(callCap, execEnd - now()));
    return within(exec(cmd, args, { ...opts, timeout: ms }), ms, `${cmd} ${args[0] ?? ""}`.trim());
  };
  let launch = null;
  let panes = null;
  let id = null;
  let split = null;
  let splitSettled = false;
  // Only a creation that provably never happened (the mux CLI was not even on the machine) needs no identity search.
  let splitProvedNothing = false;
  /** When the creation command must have settled or been killed: launch deadline plus the cleanup budget. */
  let creationEnd = start + timeout + cleanupTimeout;
  let closed = false;
  let closeError = null;
  let result = null;
  let failure = null;
  // The adapter calls this the moment the pane or block exists, before focus and labeling can fail.
  const onSpawn = (created) => {
    if (created && !id) id = created;
  };
  /** The identity the launcher recorded at start, for a creation answer that never arrived. */
  const launcherIdentity = () => {
    if (!launch) return null;
    try {
      const named = linesOf(readFileSync(launch.idFile, "utf8"))[0].trim();
      return named && named !== "?" ? named : null;
    } catch {
      return null;
    }
  };
  /**
   * The identity the launch created, waited for until `until` — the end of the creation's own permitted lifetime, not
   * a shorter slice. A split that settles inside that lifetime is adopted (through `onSpawn`, its answer, or the
   * launcher's identity record), so closing always gets its turn afterwards. `null` means the creation command itself
   * produced no identity before its bound; a command killed at that bound may still be followed by the launcher's own
   * record, which cleanup looks for next.
   */
  const settleCreation = async (until) => {
    // Enough slices to cover the whole remaining lifetime, and never an unbounded number even with an injected clock.
    const slices = Math.max(1, Math.ceil(Math.max(0, until - now()) / 100) + 2);
    for (let attempt = 0; attempt < slices; attempt++) {
      if (id) return id;
      const named = launcherIdentity();
      if (named) return named;
      // Waiting here is pointless once it settled: the adoption window that follows looks for a pane regardless.
      if (splitSettled) return null;
      if (now() >= until) return null;
      const slice = Math.max(1, Math.min(100, until - now()));
      if (split) await within(split.then((value) => value, () => null), slice, "split").catch(() => null);
      else await sleep(slice);
    }
    return id ?? launcherIdentity();
  };
  try {
    launch = prepareLaunch({ dir: workDir, env, mux, cwd: callerCwd, workdir: cwd, platform });
    start = now();
    deadline = start + timeout;
    execEnd = deadline;
    panes = await transport(mux, { exec: call, env, cwd, runId, sleep, now, timeout, progress, onSpawn });
    const anchor = await within(panes.anchor(), left(), "anchor");
    // Kept even if this deadline hits: the split may still have created (or be about to create) the pane. It may run
    // through the whole creation lifetime (launch window plus cleanup budget); closing is reserved on top of that.
    creationEnd = start + timeout + cleanupTimeout;
    callCap = Math.max(opTimeout, cleanupTimeout);
    execEnd = creationEnd;
    split = panes.split(anchor, "right", "pair: doctor", launch.argv(["--version"]));
    // A late rejection is not an unhandled one. Only a rejection the transport proved created nothing counts as such:
    // a lost answer, a connection reset or a killed command may all hide a pane that has to be found again.
    split.then(() => (splitSettled = true), (error) => {
      splitSettled = true;
      splitProvedNothing = error?.noPane === true;
    });
    id = await within(split, left(), "split");
    for (;;) {
      const code = dryExit(launch.exitFile, id);
      // The exit record is the answer; the screen only adds the version line, so it gets a short look when the record
      // is already there instead of holding the result up for the rest of the deadline.
      let screen = "";
      let screenFailed = false;
      try {
        screen = screenTail(await within(panes.read(id), code !== null ? Math.min(1_000, left()) : left(), "read"), 20);
      } catch {
        screenFailed = true;
      }
      const version = versionOf(screen);
      if (code !== null) result = { ok: code === 0, exitCode: code, version, screen, ...(screenFailed ? { screenFailed } : {}) };
      else {
        const hit = screenError(screen, STARTUP_ERRORS, 20);
        if (hit) result = { ok: false, exitCode: null, error: hit, screen };
        else if (version) result = { ok: true, exitCode: null, version, screen, fromScreen: true };
      }
      if (result) break;
      if (now() - start >= timeout) {
        result = { ok: false, exitCode: null, timeout: true, screen, ...(screenFailed ? { screenFailed } : {}) };
        break;
      }
      await sleep(interval);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (panes) {
      // 1. Let creation finish inside its own lifetime before closing: a split that outlives the launch deadline may
      //    still be allowed to create, and its pane is ours to close. Nothing may be removed while this is pending.
      deadline = creationEnd;
      execEnd = creationEnd;
      if (!id && split) id = await settleCreation(creationEnd);
      // 2. An identity that only shows up late — the split's answer was lost or rejected after the server created the
      //    pane, and the launcher inside it wrote `launch.id` a moment later — gets a bounded window of its own, so it
      //    is closed rather than left in a variable nobody reads again. Only a creation the transport proved never
      //    happened (the CLI was not there) skips the search: a mux that *answered* an error has not proven it.
      const adoptUntil = now() + closeTimeout;
      const slices = Math.max(1, Math.ceil(closeTimeout / 100) + 2);
      const mayHaveCreated = split && !(splitSettled && splitProvedNothing);
      for (let slice = 0; mayHaveCreated && !id && slice < slices && now() < adoptUntil; slice++) {
        id = launcherIdentity();
        if (!id) await sleep(Math.min(100, Math.max(1, adoptUntil - now())));
      }
      // 3. The close then gets a window of its own that starts when there is something to close, so waiting for an
      //    identity can never starve it: every command it runs is bounded by this window, not by what is left of one
      //    that adoption already spent.
      if (id) {
        deadline = now() + closeTimeout;
        execEnd = deadline;
        callCap = Math.max(opTimeout, closeTimeout);
        for (let attempt = 0; attempt < 2 && !closed; attempt++) {
          try {
            await within(panes.close(id), left(), "close");
          } catch (error) {
            // Not fatal by itself (a Rex block closes itself, so `close` answers `not found`); absence decides.
            closeError ??= errorText(error);
          }
          closed = await absence(panes, id, left(), (error) => (closeError ??= errorText(error)));
          if (!closed && attempt === 0 && deadline - now() > 300) await sleep(250);
        }
      }
    }
    if (ownDir) rmSync(workDir, { recursive: true, force: true });
  }
  if (failure) throw Object.assign(failure, { id, closed, closeError });
  return { ...result, id, closed, closeError, launch: launch.record };
}

/**
 * True only when the transport proves the pane or block no longer exists (`panes.gone`: Herdr's structured
 * `not_found` for that terminal, or a Rex block list without it). An answer that it is there, a timeout, or an
 * unreachable helper all count as "still there", and the error is passed to `note` so the caller can show why.
 */
async function absence(panes, id, ms, note) {
  try {
    if (typeof panes.gone === "function") return await within(panes.gone(id), ms, "verify");
    // A transport with no lookup of its own: an answer means it is there, anything else proves nothing.
    await within(typeof panes.alive === "function" ? panes.alive(id) : panes.read(id), ms, "verify");
    return false;
  } catch (error) {
    note(error);
    return false;
  }
}

/**
 * `doctor`: everything a run needs, checked the way a worker sees it — multiplexer detection with the reason for each
 * path tried, the launch resolution (pi, node, PATH), model readiness for every role, and a dry launch of
 * `pi --version` through the workers' own launcher and transport. Each check is pass/fail with one fix per failure.
 * `launchTest: false` skips the dry launch (`--no-launch`); `overrides` checks given model flags as they would be used;
 * `mux` selects one transport explicitly (`--mux`), so a machine with both variable families set is not ambiguous.
 * Every command run here is bounded, so a stalled multiplexer or provider CLI fails its check instead of hanging.
 */
export async function doctor({ workflow, roles, preferences = {}, overrides = {}, callerRole, mux: selected, env = process.env, exec = run, cwd = process.cwd(), callerCwd = process.cwd(), launchTest = true, platform = process.platform, dir, timeout = 15_000, cleanupTimeout = 5_000, opTimeout = 20_000, sleep = sleepMs, now = Date.now, progress = () => {} } = {}) {
  const checks = [];
  const trace = [];
  // One bound per command: detection, the provider probes and the dry launch all go through it, so none of them can
  // hold doctor open. `run()` kills a real child that overruns; the race covers an injected transport that never settles.
  const call = (cmd, args, opts = {}) => within(exec(cmd, args, { ...opts, timeout: opTimeout }), opTimeout, `${cmd} ${args[0] ?? ""}`.trim());
  const found = await environment({ env, exec: call, trace, mux: selected, platform });
  const spot = found.layout === "labels" ? "Herdr tab (hc labels)" : found.layout === "terminals" ? "Herdr core terminal" : found.mux === "herdr" ? "Herdr pane" : "Rex pane";
  checks.push(found.mux ? pass("mux", muxVerdict(found), trace) : fail("mux", `none: ${found.reason}`, doctorMuxFix(found), trace));

  let launch = null;
  try {
    launch = resolveLaunch({ env, cwd: callerCwd, platform });
    // A Windows batch shim is not what runs: say which Node entry it was resolved to, so the line matches the workers.
    checks.push(pass("pi", `${launch.pi} (${env.PAIR_PI_BIN ? "PAIR_PI_BIN" : "PATH"})${launch.entry ? ` → node ${launch.entry}` : ""}`));
    checks.push(launch.node
      ? pass("node", `${launch.node}${launch.shebang ? ` (from ${launch.shebang})` : ""}`)
      : fail("node", `pi needs an interpreter (${launch.shebang || "no shebang"}) and no node was found`, "install Node.js 22+ or put node on PATH; pi's own node under ~/.local/share/pi-node is used automatically"));
    checks.push(pass("PATH", `${launch.PATH.split(pathDelimiter(platform)).filter(Boolean).length} entries for the worker: ${launch.PATH}`));
  } catch (error) {
    checks.push(fail("pi", error.message, "install pi, put it on PATH, or set PAIR_PI_BIN to the pi executable"));
  }

  if (!launch) {
    checks.push(skipped(`${roles.join(" + ")} models`, "not checked: pi could not be resolved"));
  } else {
    const choices = await resolveModels({ roles, preferences, overrides, callerRole, env, cwd, callerCwd, launch, exec: call });
    for (const role of roles) {
      const choice = choices[role];
      if (choice.ready) {
        const last = choice.checked.at(-1);
        checks.push(pass(role, `${choice.model} (${choice.reason}) — ${last?.detail ?? "ready"}`));
      } else {
        const detail = choice.checked.map((entry) => `${entry.model} not ready (${entry.detail})`).join(", ") || "no candidate is configured";
        const flag = choice.explicit ? `pass another --${role}-model` : `pass --${role}-model`;
        checks.push(fail(role, detail, `log in with \`pi auth login <provider>\`, or ${flag} <provider/id> with one of: ${choice.alternatives.join(", ") || "no ready alternative found"}`));
      }
    }
  }

  if (!launchTest) checks.push(skipped("launch", "skipped (--no-launch)"));
  else if (!launch) checks.push(skipped("launch", "not run: pi could not be resolved"));
  else if (found.mux !== "herdr" && found.mux !== "rex") checks.push(skipped("launch", "not run: no multiplexer to open a worker in"));
  else {
    try {
      const dry = await dryLaunch({ mux: found.mux, env, exec, cwd, callerCwd, platform, dir, timeout, cleanupTimeout, opTimeout, sleep, now, progress });
      const how = dry.exitCode !== null ? `exit ${dry.exitCode}` : "no exit record, read from the screen";
      const printed = dry.version ? `printed ${dry.version}` : dry.screen ? "printed no version line" : "its screen was already gone";
      const closeFix = `close the temporary ${spot} yourself: \`node ${fileURLToPath(import.meta.url)} close ${dry.id} --mux ${found.mux}\``;
      const launchFix = "a worker starts through this launcher: fix the node and PATH lines above first";
      const cleanup = dry.closed
        ? `${dry.id} closed`
        : `${dry.id} could not be confirmed closed${dry.closeError ? ` (${dry.closeError})` : ""}`;
      if (dry.ok && dry.closed) checks.push(pass("launch", `pi --version in a ${spot}: ${how}, ${printed} (${cleanup})`));
      // A pane the doctor cannot close is a failed check, however well the launch itself went: it must not leave
      // anything behind, and a mux that cannot close its own terminal cannot clean up after a worker either.
      else if (dry.ok) checks.push(fail("launch", `pi --version in a ${spot} worked (${how}, ${printed}), but its temporary ${cleanup}`, closeFix));
      else {
        const why = dry.error ? `the screen shows "${dry.error}"` : dry.timeout ? `no exit record within ${Math.round(timeout / 1000)}s` : `exit ${dry.exitCode}`;
        checks.push(fail("launch", `pi --version in a ${spot} did not work: ${why} (${cleanup})`, dry.closed ? launchFix : [launchFix, closeFix], dry.screen ? [`screen tail:\n${dry.screen}`] : []));
      }
    } catch (error) {
      // A failure can still have created a pane (a split that timed out after creating it). Say what happened to it.
      const orphan = error?.id ? `${error.id} ${error.closed ? "was closed" : `could not be confirmed closed${error.closeError ? ` (${error.closeError})` : ""}`}` : null;
      checks.push(fail(
        "launch",
        `could not open a ${spot}: ${errorText(error)}${orphan ? ` (${orphan})` : ""}`,
        error?.id && !error.closed
          ? ["check the mux line above, or pass --no-launch to skip this check", `close the temporary ${spot} yourself: \`node ${fileURLToPath(import.meta.url)} close ${error.id} --mux ${found.mux}\``]
          : "check the mux line above, or pass --no-launch to skip this check",
      ));
    }
  }

  return { workflow, ok: checks.every((entry) => entry.ok), checks };
}

/** `doctor` as printed: one line per check, with the fix under a failing one and the count in the header. */
export function formatDoctor(report) {
  const failed = report.checks.filter((entry) => !entry.ok).length;
  const skippedCount = report.checks.filter((entry) => entry.skipped).length;
  const passed = report.checks.length - failed - skippedCount;
  const lines = [`${report.workflow} doctor: ${passed} pass, ${failed} fail${skippedCount ? `, ${skippedCount} skipped` : ""}`];
  for (const entry of report.checks) {
    const status = entry.skipped ? "skip" : entry.ok ? "pass" : "fail";
    const [first, ...rest] = [entry.detail, ...(entry.more ?? [])].join("\n").split("\n");
    lines.push(`  ${status}  ${entry.name}: ${first}`);
    for (const line of rest) lines.push(`        ${line}`);
    for (const fix of [entry.fix ?? []].flat()) lines.push(`        fix: ${fix}`);
  }
  return lines.join("\n");
}

/** `doctor [--json] [--no-launch]`: exit 0 when every check passes, 1 when one fails, so a script can gate on it. */
export async function doctorCommand(flags, { workflow, roles, preferences, callerRole, env = process.env, exec = run, log = console.log, cwd = process.cwd(), callerCwd = process.cwd(), sleep, now, platform, timeout } = {}) {
  const overrides = Object.fromEntries(roles.map((role) => [role, flags[`${role}-model`]]));
  const report = await doctor({ workflow, roles, preferences, overrides, callerRole, mux: flags.mux, env, exec, cwd: resolve(cwd), callerCwd, launchTest: !flags["no-launch"], platform, timeout, sleep, now });
  log(flags.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report.ok ? 0 : 1;
}

// ---------- CLI ----------

const PAIR_FLAGS = ["task-file", "rounds", "implementer-model", "auditor-model", "mux", "turn-timeout", "cwd", "run", "timeout"];

export function parseArgs(argv, valueFlags = PAIR_FLAGS, boolFlags = ["json", "help", "h"]) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.startsWith("--") ? arg.slice(2) : arg === "-h" ? "h" : null;
    if (name && boolFlags.includes(name)) flags[name] = true;
    else if (arg.startsWith("--")) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = argv[++i];
    } else positional.push(arg);
  }
  const known = new Set([...boolFlags, ...valueFlags]);
  for (const name of Object.keys(flags)) if (!known.has(name)) throw new Error(`unknown option --${name}`);
  return { positional, flags };
}

export async function main(argv, { env = process.env, exec = run, log = console.log, progress = console.error, sleep, now } = {}) {
  const { positional, flags } = parseArgs(argv, PAIR_FLAGS, ["json", "help", "h", "no-launch"]);
  const [command] = positional;
  if (!command || flags.help || flags.h) {
    log(USAGE);
    return command || flags.help || flags.h ? 0 : 2;
  }
  if (flags["no-launch"] && command !== "doctor") throw new Error("--no-launch belongs to doctor");
  const found = detect(env);
  if (command === "detect") return detectCommand(flags, { env, exec, log });
  if (command === "models") return modelsCommand(flags, { workflow: "pair", roles: ROLES, preferences: DEFAULTS.models, callerRole: CALLER_ROLE, env, exec, log, cwd: flags.cwd ?? process.cwd() });
  if (command === "doctor") return doctorCommand(flags, { workflow: "pair", roles: ROLES, preferences: DEFAULTS.models, callerRole: CALLER_ROLE, env, exec, log, cwd: flags.cwd ?? process.cwd(), sleep, now });
  if (command === "close") return closeWorkers(positional.slice(1), { mux: flags.mux ?? found.mux, reason: found.reason, runId: flags.run, env, exec, log });
  if (command === "wait") return waitCommand(positional[1], flags, { log, sleep, now });
  if (command !== "run") throw new Error(`unknown command ${command}\n\n${USAGE}`);

  const { mux, task, rounds, turnTimeout, cwd, dir } = runOptions(flags, { found, env, now, defaults: DEFAULTS, dirName: "pi-pair" });
  // Which model each role runs is settled here, in the worker's environment, before a pane exists: a role with no
  // ready model stops the run with what is ready instead of opening a worker that would fail at its prompt.
  const models = requireModels(await resolveModels({
    roles: ROLES,
    preferences: DEFAULTS.models,
    overrides: { implementer: flags["implementer-model"], auditor: flags["auditor-model"] },
    callerRole: CALLER_ROLE,
    env,
    exec,
    cwd,
  }), ROLES);
  const runId = newRunId();
  const script = fileURLToPath(import.meta.url);
  const result = await tracked({ dir, runId, workflow: "pair", script, progress }, (note) => runPair({
    task,
    mux,
    cwd,
    dir,
    rounds,
    implementerModel: models.implementer.model,
    auditorModel: models.auditor.model,
    turnTimeout,
    exec,
    env,
    sleep,
    now,
    progress: note,
    runId,
  }), formatResult);
  log(flags.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return 0;
}

/**
 * Detection with Herdr's usable controls checked: `herdr` (app panes), `herdr (core-only: ...)` when only `hc` works,
 * or `none: <reason>`. Missing `herdr-app` alone never makes Herdr unavailable. Exit code 0 when a transport is usable.
 * `trace` collects one line per path tried (see `probeHerdr`).
 *
 * `mux` selects one explicitly (`--mux`), exactly as a run does: neither variable family has to be the only one set, but
 * the selected mux still needs the environment it runs in, and Herdr is still probed for its usable controls.
 */
export async function environment({ env = process.env, exec = run, trace = [], mux, platform = process.platform, exists = existsSync } = {}) {
  if (mux !== undefined && !["herdr", "rex"].includes(mux)) {
    trace.push(`--mux ${mux} is not herdr or rex`);
    return { mux: null, reason: `--mux must be herdr or rex, not ${mux}` };
  }
  if (mux === "rex") {
    trace.push("selected with --mux rex");
    if (!(env.REX_SESSION && env.REX_BLOCK)) {
      trace.push("rex: REX_SESSION and/or REX_BLOCK are unset");
      return { mux: null, reason: "--mux rex needs REX_SESSION and REX_BLOCK (run inside a Rex pane)" };
    }
    trace.push("rex: REX_SESSION and REX_BLOCK are set");
    return probeRex({ env, platform, exists, trace });
  }
  if (mux === "herdr") {
    trace.push("selected with --mux herdr");
    if (!env.HC_TERMINAL_ID) {
      trace.push("herdr: HC_TERMINAL_ID is unset");
      return { mux: null, reason: "--mux herdr needs HC_TERMINAL_ID (run inside a Herdr terminal)" };
    }
  } else {
    const found = detect(env);
    if (found.mux !== "herdr") {
      if (found.mux !== "rex") {
        trace.push(`no multiplexer: ${found.reason}`);
        return found;
      }
      // Rex is only usable with its CLI: a remote shell inside a Rex block has the variables but neither the CLI nor
      // the server (D2), and that is reported as its own reason instead of failing later at the first split.
      trace.push("rex: REX_SESSION and REX_BLOCK are set");
      return probeRex({ env, platform, exists, trace });
    }
  }
  trace.push(`herdr: HC_TERMINAL_ID=${env.HC_TERMINAL_ID}`);
  try {
    const probe = await probeHerdr({ exec, env, trace, platform });
    return { mux: "herdr", terminal: env.HC_TERMINAL_ID, ...probe };
  } catch (error) {
    return { mux: null, reason: error.message };
  }
}

/**
 * The one-line verdict for a detection result (C4), with the reason: how Herdr came out, and why. `detect` prints it
 * followed by the trace, and `doctor` uses it as its mux line. Layout values in `--json`: `panes` (app panes through
 * `herdr-app`), `labels` (Herdr core terminals whose `hc run` carries the caller's copied labels — `placement` says
 * which: `{space, tab?}`), `terminals` (core-only, attach by hand), or no `layout` for Rex. The label verdict says what
 * was *requested* of the app, never that a particular rendering (split vs. new tab) was confirmed.
 */
export function muxVerdict(found) {
  if (!found.mux) return `none: ${found.reason}`;
  if (found.mux === "rex") return "rex (Rex panes)";
  if (found.layout === "panes") return `herdr: panes via herdr-app (${found.appHow ?? "herdr-app"})`;
  if (found.layout === "labels") {
    return found.placement?.tab
      ? "herdr: panes via hc labels (tab requested; split vs. new tab unverified)"
      : "herdr: panes via hc labels (space requested; Herdr creates a tab in it)";
  }
  return `herdr: core-only (hc terminals, no automatic panes: ${found.appReason ?? "herdr-app unavailable"})`;
}

/**
 * The fix line for a failing mux check. Rex inside a remote block is not something the user can "run doctor inside":
 * the variables are there and the CLI is not, so the fix is the documented remote path (D2).
 */
export function doctorMuxFix(found) {
  // A refused or incomplete selection, or an ambiguous environment that asks for the flag, is about the flag —
  // whichever variables are set: both families plus an installed Rex CLI must not be told about remote Rex (audit 7).
  if (/^--mux|pass --mux herdr\|rex/.test(found.reason ?? "")) return 'pass a mux this machine can run in ("--mux herdr" or "--mux rex"), or start doctor inside one';
  if (found.reason === REX_NO_CLI) {
    return "run the pair on the machine that runs the Rex server, in a Rex block there; a forwarded Rex socket is control-only and cannot start workers against this machine's files";
  }
  if (found.reason?.startsWith("Herdr app panes unusable")) return "read the herdr-app and hc lines above; without app panes the workers run as hc terminals the app may place by label";
  return "run doctor inside a Herdr pane or a Rex block, or pass --mux herdr|rex";
}

/** The verdict plus the reason for every path tried, indented under it. */
export function formatDetect(found) {
  return [muxVerdict(found), ...(found.trace ?? []).map((line) => `  ${line}`)].join("\n");
}

export async function detectCommand(flags, { env, exec, log, platform }) {
  const trace = [];
  const found = await environment({ env, exec, trace, platform });
  log(flags.json ? JSON.stringify({ ...found, trace }) : formatDetect({ ...found, trace }));
  return found.mux ? 0 : 1;
}

/** Validate the shared `run` flags: multiplexer, task file, rounds, timeout; pick the worker folder and report folder. */
export function runOptions(flags, { found, env, now, defaults, dirName, platform = process.platform, exists = existsSync }) {
  const mux = flags.mux ?? found.mux;
  if (!["herdr", "rex"].includes(mux)) throw new Error(found.reason ?? `--mux must be herdr or rex`);
  if (mux === "herdr" && !env.HC_TERMINAL_ID) throw new Error("--mux herdr needs HC_TERMINAL_ID (run inside a Herdr terminal)");
  if (mux === "rex" && !(env.REX_SESSION && env.REX_BLOCK)) throw new Error("--mux rex needs REX_SESSION and REX_BLOCK (run inside a Rex pane)");
  // Stop before a pane instead of failing at the first split: inside a remote Rex block there are the variables but no
  // CLI (D2). The fix is the one `detect` prints.
  if (mux === "rex" && !findRex({ env, platform, exists }).how) {
    throw new Error(
      "REX_SESSION and REX_BLOCK are set but there is no rex CLI on this machine (a remote shell inside a Rex block?). Rex terminals run where the Rex server runs, so the pair has to run there too: a forwarded Rex socket is control-only (`rex split` starts its command on the server's machine) and cannot start workers against this machine's files.",
    );
  }
  if (flags.run) throw new Error("--run belongs to close; run creates its own run id");
  if (flags.timeout) throw new Error("--timeout belongs to wait; use --turn-timeout for run");
  if (!flags["task-file"]) throw new Error("run needs --task-file");
  const task = readFileSync(flags["task-file"], "utf8").trim();
  if (!task) throw new Error("task file is empty");
  const rounds = Number(flags.rounds ?? defaults.rounds);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error("--rounds must be a positive integer");
  const turnTimeout = flags["turn-timeout"] ?? defaults.turnTimeout;
  parseDuration(turnTimeout);
  const dir = join(tmpdir(), dirName, new Date(now ? now() : Date.now()).toISOString().replace(/[:.]/g, "-"));
  return { mux, task, rounds, turnTimeout, cwd: resolve(flags.cwd ?? process.cwd()), dir };
}

/**
 * Refuse Herdr terminals that no pair run started (no `pair.run`/`pair.role` label), or that belong to another run
 * when `runId` is given. Checks every id before anything is closed.
 */
async function checkOwnership(ids, { env, exec, runId }) {
  const hcBin = herdrBins(env).hc;
  for (const id of ids) {
    let t;
    try {
      // The app may qualify the id with its machine; the core knows the bare terminal address.
      t = JSON.parse(await exec(hcBin, ["get", bareId(id), "--json"]));
    } catch (error) {
      throw new Error(`refusing to close ${id}: hc get ${bareId(id)} failed (${errorText(error)})`);
    }
    const labels = t.labels ?? {};
    const owner = labels["pair.run"];
    if (!owner && !labels["pair.role"]) throw new Error(`refusing to close ${id}: ${id} was not started by a pair run (no pair.run label)`);
    if (runId && owner !== runId) throw new Error(`refusing to close ${id}: ${id} belongs to pair run ${owner ?? "(unlabelled)"}, not ${runId}`);
  }
}

/**
 * Close workers from a finished run. Never closes the caller's own pane or terminal. In Herdr, closes only terminals
 * labelled by a pair run (and by `runId` when given): the app pane when one shows it, else `hc kill` then `hc rm`.
 */
export async function closeWorkers(ids, { mux, reason, runId, env = process.env, exec = run, log = console.log }) {
  if (!["herdr", "rex"].includes(mux)) throw new Error(reason ?? "--mux must be herdr or rex");
  if (!ids.length) throw new Error("close needs the worker ids printed by run, e.g. close t1 t2");
  const self = mux === "herdr" ? env.HC_TERMINAL_ID : env.REX_BLOCK;
  // Compare bare addresses: a qualified `ubuntu/t57` is the same terminal as `t57`.
  const own = (id) => (mux === "herdr" ? bareId(id) === bareId(self) : id === self);
  if (ids.some(own)) throw new Error(`refusing to close ${self}: that is your own ${mux === "herdr" ? "terminal" : "pane"}`);
  if (mux === "herdr") await checkOwnership(ids, { env, exec, runId });
  // The pane adapter closes the app pane when one shows the worker and falls back to hc kill + rm otherwise. The app
  // CLI is resolved the same way a run finds it (HERDR_APP_BIN, PATH, ~/.local/bin, the platform's install folders).
  // The WSL bridge may run cmd.exe; bound it so a stalled Windows helper cannot hold a cleanup open.
  const app = mux === "herdr" ? (await findHerdrApp({ env, exec: (cmd, args, opts = {}) => exec(cmd, args, { timeout: 10_000, ...opts }) })).bin : undefined;
  const panes = adapter(mux, { exec, env, app, cwd: process.cwd() });
  const failed = [];
  for (const id of ids) {
    try {
      await panes.close(id);
      log(`closed ${id}`);
    } catch (error) {
      failed.push(`${id}: ${error.message}`);
    }
  }
  if (failed.length) throw new Error(`could not close ${failed.join("; ")}`);
  return 0;
}

/**
 * The "where are the workers" lines shared by every workflow's result: still-open panes; the placement a label mode
 * requested of the app (and the attach fallback for `hc` terminals); or, in core-only Herdr, the terminal ids and how
 * to open them, because nothing requested a place in the app at all.
 */
export function workerLines(r, script, roles) {
  const ids = roles.map((role) => r.panes[role]);
  const list = roles.map((role) => `${role} ${r.panes[role]}`).join(", ");
  const close = `node ${script} close ${ids.join(" ")} --mux ${r.mux}${r.mux === "herdr" && r.runId ? ` --run ${r.runId}` : ""}`;
  const attach = `if one is not visible, attach from any terminal on this machine: ${ids.map((id) => `hc attach ${id}`).join(" or ")} (Ctrl+\\ detaches)`;
  if (r.layout === "labels") {
    const where = r.placement?.tab
      ? "Worker terminals requested in the caller's Herdr tab by hc labels (split vs. new tab unverified)"
      : "Worker terminals requested in the caller's Herdr space by hc labels (Herdr picks their tab)";
    return [`${where}: ${list}.`, `${attach}.`, `After reviewing the result, close them: ${close}`];
  }
  if (r.layout !== "terminals") return [`Worker panes still open: ${list}.`, `After reviewing the result, close them: ${close}`];
  return [
    `Worker terminals still running (Herdr core, not placed in desktop panes): ${list}; labels pair.run=${r.runId}.`,
    `To watch one, attach from any terminal on this machine: ${ids.map((id) => `hc attach ${id}`).join(" or ")} (Ctrl+\\ detaches), or open it from Herdr's terminal list.`,
    `After reviewing the result, close them: ${close}`,
  ];
}

export function formatResult(r) {
  const [where, ...how] = workerLines(r, fileURLToPath(import.meta.url), ["implementer", "auditor"]);
  return [
    `Pair session complete (${r.mux}, ${r.rounds} rounds). ${where}`,
    ...how,
    `Last audit verdict: ${r.lastAuditVerdict || "(none given)"}`,
    `Reports:`,
    ...r.reports.map((x) => `  ${x.role.padEnd(11)} ${x.path}`),
    "",
    "Final implementer report:",
    "",
    r.finalReport,
  ].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`pair: ${error.message}`);
      process.exitCode = 2;
    },
  );
}
