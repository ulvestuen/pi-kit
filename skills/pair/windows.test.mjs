// E1–E4 and D1–D3: the Windows half of the transport and Rex discovery, without a Windows machine.
// Every test injects `platform`, the environment and the filesystem, and writes its expectations with `path.win32` /
// `path.posix`, never the host's separator or join, so the same assertions pass on macOS, Linux and Windows.
// The tests that need a real Windows box are marked `skip: process.platform !== "win32"`; everything else runs here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { describe, it } from "node:test";

import { adapter, DONE, doctorMuxFix, envGet, environment, executableNames, findRex, LAUNCH_EXIT, launcherExit, launcherScript, launchEnv, modelChecker, muxVerdict, onPath, piCommand, prepareLaunch, powershell, reportDone, resolveLaunch, resolvePi, REX_NO_CLI, run, runOptions, screenError, screenTail, shimEntry, shimParts, STARTUP_ERRORS, waitForReport, writeLauncher } from "./pair.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "pair-win-"));
/** A fake filesystem: exactly these paths exist. */
const files = (list) => (candidate) => list.includes(candidate);
const PATHEXT = ".COM;.EXE;.BAT;.CMD";
const PS = win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

describe("Windows executable resolution (E2, E3)", () => {
  it("tries the PATHEXT suffixes, so a command name finds pi.cmd", () => {
    assert.deepEqual(executableNames("pi", { platform: "win32", pathext: ".EXE;.CMD" }), ["pi.exe", "pi.EXE", "pi.cmd", "pi.CMD"]);
    assert.deepEqual(executableNames("pi.cmd", { platform: "win32", pathext: ".CMD" }), ["pi.cmd"], "an explicit extension is used as given");
    assert.deepEqual(executableNames("pi", { platform: "darwin", pathext: ".CMD" }), ["pi"], "no suffixes outside Windows");
    // Without PATHEXT the Windows default applies, as cmd does.
    assert.ok(executableNames("node", { platform: "win32", pathext: undefined }).includes("node.exe"));
    // The extensionless name is never a candidate: npm's POSIX shim is not something Windows starts (audit 1).
    assert.ok(!executableNames("pi", { platform: "win32", pathext: PATHEXT }).includes("pi"));
  });

  it("prefers pi.cmd over npm's extensionless POSIX shim", () => {
    const shim = win32.join("C:\\tools", "pi");
    const cmd = win32.join("C:\\tools", "pi.cmd");
    const entry = npmEntry("C:\\tools");
    const env = { PATH: "C:\\tools", PATHEXT };
    const nodeExe = win32.join("C:\\node", "node.exe");
    const options = { env, platform: "win32", execPath: nodeExe, exists: files([shim, cmd, entry, nodeExe]), readFile: () => NPM_SHIM };
    assert.equal(resolvePi(options), cmd, "the file Windows can start wins, even though the shim exists");
    assert.deepEqual([resolveLaunch(options).pi, resolveLaunch(options).entry], [cmd, entry], "and it is started through its Node entry");
  });

  it("uses the caller's PATHEXT, not this process's", () => {
    // Nothing is passed as `pathext`: the injected environment alone has to decide (audit 6).
    const custom = win32.join("C:\\tools", "pi.custom");
    assert.equal(resolvePi({ env: { PATH: "C:\\tools", PATHEXT: ".CUSTOM" }, platform: "win32", exists: files([custom]) }), custom);
    assert.equal(onPath("node", "C:\\tools", { platform: "win32", env: { PATHEXT: ".CUSTOM" }, exists: files([win32.join("C:\\tools", "node.custom")]) }), win32.join("C:\\tools", "node.custom"));
  });

  it("splits PATH on `;` on Windows and never on `:`", () => {
    const exe = win32.join("C:\\tools", "pi.cmd");
    assert.equal(onPath("pi", "C:\\first;C:\\tools", { platform: "win32", env: { PATHEXT }, exists: files([exe]) }), exe);
    // A colon-joined PATH is not a Windows PATH: it is one entry, and nothing there resolves.
    assert.equal(onPath("pi", "/a:/b", { platform: "win32", env: { PATHEXT }, exists: (candidate) => candidate === "/a/pi.exe" }), null);
    // POSIX is unchanged: no suffixes, and `:` separates.
    assert.equal(onPath("pi", "/a:/b", { platform: "linux", exists: files(["/b/pi"]) }), "/b/pi");
  });

  it("resolves pi to pi.cmd and builds a `;`-joined worker PATH", () => {
    const piCmd = win32.join("C:\\tools", "pi.cmd");
    const nodeExe = win32.join("C:\\node", "node.exe");
    const entry = npmEntry("C:\\tools");
    const env = { PATH: "C:\\tools;C:\\node", PATHEXT, PAIR_PI_BIN: "pi" };
    const options = { env, platform: "win32", exists: files([piCmd, nodeExe, entry]), readFile: () => NPM_SHIM };
    assert.equal(resolvePi(options), piCmd);
    const launch = resolveLaunch(options);
    assert.deepEqual([launch.pi, launch.node, launch.entry], [piCmd, nodeExe, entry]);
    // node's folder first, then the caller's entries, joined with the platform's separator.
    assert.deepEqual(launch.PATH.split(";"), [win32.join("C:\\node"), "C:\\tools"]);
  });

  it("resolves a relative Windows PATH entry against the caller's folder", () => {
    const piCmd = win32.join("C:\\work", "bin", "pi.cmd");
    const entry = npmEntry(win32.join("C:\\work", "bin"));
    const nodeExe = win32.join("C:\\node", "node.exe");
    const launch = resolveLaunch({ env: { PATH: "bin", PATHEXT, PAIR_PI_BIN: "pi" }, cwd: "C:\\work", platform: "win32", execPath: nodeExe, exists: files([piCmd, entry, nodeExe]), readFile: () => NPM_SHIM });
    assert.equal(launch.pi, piCmd);
    assert.deepEqual(launch.PATH.split(";"), [win32.join("C:\\node"), win32.join("C:\\work", "bin")], "node's folder first, the relative entry made absolute against the caller's folder");
  });
});

/** npm's cmd-shim, verbatim enough: a batch file whose last line runs Node on one quoted script path. */
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*',
  "",
].join("\r\n");

/** Whether a PID is still running (a zombie-free check: on Windows `kill(pid, 0)` opens the process). */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** The entry point the npm shim above names, inside `dir`. */
const npmEntry = (dir) => win32.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

describe("Pi is started without a cmd boundary (audits 1–3)", () => {
  it("reads the Node entry point out of npm's pi.cmd, even under a %-named folder", () => {
    const shim = win32.join("C:\\%ALIAS% & caret^bang!", "pi.cmd");
    const entry = win32.join("C:\\%ALIAS% & caret^bang!", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    assert.equal(shimEntry(shim, { platform: "win32", readFile: () => NPM_SHIM, exists: files([shim, entry]) }), entry);
    // Only a shim whose entry can actually be found is used; a missing file is not a guess.
    assert.equal(shimEntry(shim, { platform: "win32", readFile: () => NPM_SHIM, exists: files([shim]) }), null);
    // A hand-written batch wrapper cannot be resolved, and nothing else is read.
    assert.equal(shimEntry(shim, { platform: "win32", readFile: () => "@echo off\r\nnpx pi %*\r\n", exists: () => true }), null);
    assert.equal(shimEntry("/opt/pi", { platform: "linux", readFile: () => NPM_SHIM, exists: () => true }), null, "POSIX scripts are run directly");
  });

  it("uses the Node the shim itself prefers over an earlier node on PATH (audit 1)", async () => {
    const tools = "C:\\tools";
    const shim = win32.join(tools, "pi.cmd");
    const entry = npmEntry(tools);
    const shimNode = win32.join(tools, "node.exe");
    const oldNode = win32.join("C:\\old-node", "node.exe");
    // npm's shim prefers `%dp0%\node.exe`; PATH would give the (possibly too old) C:\old-node runtime.
    const env = { PATH: "C:\\old-node;C:\\tools", PATHEXT, PAIR_PI_BIN: "pi" };
    const exists = files([shim, entry, shimNode, oldNode]);
    const launch = resolveLaunch({ env, platform: "win32", exists, readFile: () => NPM_SHIM });
    assert.deepEqual([launch.pi, launch.node, launch.entry], [shim, shimNode, entry], "the shim's own node, not PATH's");
    // Every readiness probe starts Pi the way the worker will: same file, same interpreter.
    assert.deepEqual(piCommand(launch), [shimNode, entry]);
    const calls = [];
    const checker = modelChecker({ pi: launch.pi, node: launch.node, entry: launch.entry, env, exec: async (cmd, args) => (calls.push([cmd, ...args]), "provider  model\n") });
    await checker.check("provider/model");
    assert.ok(calls.length > 0 && calls.every((call) => call[0] === shimNode && call[1] === entry), calls.map((c) => c.slice(0, 2)));
    // And the generated launcher names that runtime.
    const dir = tmp();
    const prepared = prepareLaunch({ dir, env, mux: "herdr", cwd: "C:\\work", platform: "win32", exists, readFile: () => NPM_SHIM });
    assert.deepEqual([prepared.node, prepared.entry], [shimNode, entry]);
    assert.ok(readFileSync(prepared.launcher, "utf8").includes(`& "${shimNode}" "${entry}" @args`));
  });

  it("resolves a shim's folder literally: a $& directory and the %~dp0 form (audit 2)", () => {
    // `$&` is a String.replace directive if the folder is used as a replacement string; it is a folder here.
    const dollarDir = "C:\\users\\$&\\npm";
    const dollarShim = win32.join(dollarDir, "pi.cmd");
    const dollarEntry = npmEntry(dollarDir);
    assert.equal(shimEntry(dollarShim, { platform: "win32", readFile: () => NPM_SHIM, exists: files([dollarShim, dollarEntry]) }), dollarEntry);
    // `%~dp0` already ends with a separator, so `"%~dp0cli.js"` is a valid target and means the folder's own file.
    const dir = "C:\\tools";
    const direct = win32.join(dir, "cli.js");
    const directShim = win32.join(dir, "pi.cmd");
    const text = '@ECHO off\r\nendLocal & "%_prog%" "%~dp0cli.js" %*\r\n';
    assert.equal(shimEntry(directShim, { platform: "win32", readFile: () => text, exists: files([directShim, direct]) }), direct);
    // A folder with no local node still resolves the entry, with no interpreter preference.
    assert.deepEqual(shimParts(directShim, { platform: "win32", readFile: () => text, exists: files([directShim, direct]) }), { entry: direct, node: null });
  });

  it("starts Pi as node <entry>, so arguments and paths are never re-parsed by cmd", () => {
    assert.deepEqual(piCommand({ pi: "C:\\tools\\pi.cmd", node: "C:\\node\\node.exe", entry: "C:\\tools\\cli.js" }), ["C:\\node\\node.exe", "C:\\tools\\cli.js"]);
    assert.deepEqual(piCommand({ pi: "C:\\tools\\pi.exe", node: "C:\\node\\node.exe", entry: null }), ["C:\\tools\\pi.exe"]);
    assert.deepEqual(piCommand({ pi: "/opt/pi", node: "/usr/bin/node", entry: null }), ["/opt/pi"], "a POSIX script keeps its shebang");
    // With node missing there is nothing to run an entry with; the launch check reports that instead.
    assert.deepEqual(piCommand({ pi: "C:\\tools\\pi.cmd", node: null, entry: "C:\\tools\\cli.js" }), ["C:\\tools\\pi.cmd"]);
  });

  it("refuses to hand a batch file to a shell, on Windows", async () => {
    await assert.rejects(run("C:\\tools\\pi.cmd", ["--version"], { platform: "win32" }), /cannot be started with its arguments intact/);
    // Resolution refuses an unreadable shim before any pane opens.
    assert.throws(
      () => resolveLaunch({ env: { PATH: "C:\\tools", PATHEXT, PAIR_PI_BIN: "pi" }, platform: "win32", exists: files([win32.join("C:\\tools", "pi.cmd")]), readFile: () => "@echo off\r\nnpx pi %*\r\n" }),
      /is a Windows batch file that pair cannot start safely \(its Node entry point could not be read\); set PAIR_PI_BIN to the \.js entry point/,
    );
  });

  it("round-trips %, ^, &, quotes, !, spaces and an empty argument through the real run() path", async () => {
    // No cmd.exe anywhere: the arguments reach Node as an array, so nothing interprets them.
    const dir = tmp();
    const script = join(dir, "argv.mjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
    const args = ["a&echo", "%PATH%", "a^b", "a!b", 'say "hi"', "a b", "", "a|b", "c:\\dir with %ALIAS%", "-p"];
    const out = await run(process.execPath, [script, ...args]);
    assert.deepEqual(JSON.parse(out), args);
  });
});

describe("the Windows launcher (E1, audits 3–5)", () => {
  const winEnv = { PATH: "C:\\tools;C:\\bin", HOME: "C:\\Users\\me", PERCENT: "50%", AMP: "x&y", CARET: "a^b", BANG: "a!b", QUOTED: 'say "hi" & bye', DOLLAR: "a$b`c", MULTI: "line1\nline2" };
  // Every character the audit named (%, ^, &, !) in the executable, worker-folder and run-folder paths.
  const piPath = "C:\\100% tools\\pi.cmd";
  const entry = win32.join("C:\\100% tools", "node_modules", "pi", "cli.js");
  const nodePath = "C:\\Program Files\\nodejs\\node.exe";
  const runDir = "C:\\%ALIAS% & caret^bang!\\pair run";
  const workdir = "C:\\work %TEMP% & stuff!";
  const script = () => launcherScript({ env: winEnv, pi: piPath, node: nodePath, entry, exitFile: win32.join(runDir, LAUNCH_EXIT), idFile: win32.join(runDir, "launch.id"), mux: "herdr", cwd: workdir, platform: "win32" });

  it("is a .ps1, and starts Pi's Node entry rather than a batch file", () => {
    const text = script();
    assert.ok(!text.startsWith("@echo off") && !text.includes("cd /d ") && !text.includes("%*"), "no batch constructs at all");
    assert.ok(!text.includes("/bin/sh"), "nothing here assumes a POSIX shell");
    assert.ok(text.startsWith("# Written by the pair skill:"), "a comment, then statements");
    assert.ok(text.includes("$ErrorActionPreference = 'Stop'"));
    assert.ok(text.includes(`& "${nodePath}" "${entry}" @args`), "node and the entry, so no cmd.exe parses a path or an argument");
    assert.ok(!text.includes(`& "${piPath}"`), "the batch shim itself is never what runs");
  });

  it("clears inherited variables except this worker's own identity, and records its identity first", () => {
    const text = script();
    const identity = text.indexOf("$pairId = $env:HC_TERMINAL_ID");
    assert.ok(identity >= 0, "the selected mux names the worker");
    assert.ok(text.includes("[Environment]::GetEnvironmentVariables().Keys"), "the inherited environment comes from the runtime, not a tool on PATH");
    assert.ok(text.includes("if ($pairName -match '^(?:HC_|REX_|HERDR_)') { continue }"), "HC_/REX_/HERDR_ survive the clearing");
    assert.ok(text.includes("try { [Environment]::SetEnvironmentVariable($pairName, $null) } catch { }"));
    assert.ok(text.includes("refusing to start pi with the core environment") && text.includes("exit 78"), "an empty enumeration stops the launch");
    assert.ok(identity < text.indexOf("[Environment]::GetEnvironmentVariables()"), "the identity is read before anything is cleared");
    assert.ok(text.includes(`[IO.File]::WriteAllText("${win32.join(runDir, "launch.id")}", "$pairId`), "and recorded for a lost creation answer");
  });

  it("carries values and paths literally: %, ^, &, !, quotes, $, backticks and line breaks", () => {
    const text = script();
    assert.ok(text.includes(`[Environment]::SetEnvironmentVariable('PERCENT', "50%")`), "a bare % needs no escaping in PowerShell");
    assert.ok(text.includes(`[Environment]::SetEnvironmentVariable('AMP', "x&y")`));
    assert.ok(text.includes(`[Environment]::SetEnvironmentVariable('CARET', "a^b")`));
    assert.ok(text.includes(`[Environment]::SetEnvironmentVariable('BANG', "a!b")`));
    assert.ok(text.includes(`[Environment]::SetEnvironmentVariable('QUOTED', "say \`"hi\`" & bye")`), "a quote is escaped, not left to a shell");
    assert.ok(text.includes(`[Environment]::SetEnvironmentVariable('DOLLAR', "a\`$b\`\`c")`), "so is $ and the escape character itself");
    assert.ok(text.includes(`[Environment]::SetEnvironmentVariable('MULTI', "line1\`nline2")`), "a line break is an escape, not a second line");
    assert.ok(!text.includes("%%") && !text.includes("^&") && !text.includes("^!"), "no batch escaping leaks into a path");
    assert.ok(text.includes(`Set-Location -LiteralPath "${workdir}"`), "the worker folder is taken literally");
    assert.ok(text.includes(`[IO.File]::AppendAllText("${win32.join(runDir, LAUNCH_EXIT)}", "$pairId $pairCode`), "as is the record path");
  });

  it("returns to the launcher after Pi, so the exit record is always written", () => {
    const text = script();
    assert.ok(text.includes("$pairCode = 0"));
    assert.ok(text.indexOf("$pairCode = $LASTEXITCODE") > text.indexOf("@args"), "the child's status is read after it ends");
    assert.ok(text.includes("exit $pairCode"));
    assert.ok(text.includes("$pairCode = 1"), "a command that cannot start is recorded as a failure");
    // Every early end is recorded too, so a worker that never started cannot look alive.
    assert.ok(text.includes(`[IO.File]::AppendAllText("${win32.join(runDir, LAUNCH_EXIT)}", "$pairId 78`));
    assert.ok(text.includes(`[IO.File]::AppendAllText("${win32.join(runDir, LAUNCH_EXIT)}", "$pairId 1`));
  });

  it("writes launch.ps1 with a UTF-8 BOM, which is what PowerShell 5.1 reads as UTF-8", () => {
    const dir = tmp();
    const file = writeLauncher({ dir, env: { PATH: "C:\\tools", UNICODE: "Grüße 日本語" }, pi: "C:\\tools\\pi.exe", exitFile: join(dir, LAUNCH_EXIT), idFile: join(dir, "launch.id"), mux: "herdr", cwd: dir, platform: "win32" });
    const bytes = readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM first, so non-ASCII values are not read as ANSI");
    assert.ok(bytes.subarray(3).toString("utf8").startsWith("# Written by the pair skill:"));
    assert.ok(bytes.toString("utf8").includes("Grüße 日本語"), "and the value is UTF-8 after it");
    // The POSIX script stays BOM-less, as `sh` expects.
    const sh = writeLauncher({ dir, env: { PATH: "/usr/bin" }, pi: "/opt/pi", exitFile: join(dir, LAUNCH_EXIT), idFile: join(dir, "launch.id"), mux: "herdr", cwd: dir, platform: "linux" });
    assert.deepEqual([...readFileSync(sh).subarray(0, 2)], [0x23, 0x21], "#!/ — no BOM");
  });

  it("is started through PowerShell, since a .ps1 is a script and not an executable image", () => {
    const dir = tmp();
    const shim = win32.join("C:\\tools", "pi.cmd");
    const npmJs = npmEntry("C:\\tools");
    const nodeExe = win32.join("C:\\node", "node.exe");
    const env = { SystemRoot: "C:\\Windows", PATH: "C:\\tools;C:\\node", PATHEXT, PAIR_PI_BIN: "pi" };
    const launch = prepareLaunch({ dir, env, mux: "herdr", cwd: "C:\\work", platform: "win32", exists: files([shim, npmJs, nodeExe, PS]), readFile: () => NPM_SHIM });
    assert.equal(launch.launcher, join(dir, "launch.ps1"));
    assert.deepEqual([launch.pi, launch.entry], [shim, npmJs], "the shim is resolved to its entry in the launch record");
    assert.deepEqual(launch.argv(["--version"]), [PS, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dir, "launch.ps1"), "--version"]);
    assert.equal(powershell({}, { exists: () => false }), "powershell.exe", "PATH's powershell when the shipped one is missing");
    const text = readFileSync(launch.launcher, "utf8");
    assert.ok(text.includes(`& "${nodeExe}" "${npmJs}" @args`), "the worker runs node on Pi's entry");
    assert.ok(text.includes('Set-Location -LiteralPath "C:\\work"'), "the worker folder, not the caller's");
  });

  it("keeps one PATH entry when the caller spells it Path (audit 5)", () => {
    // Windows environment names are case-insensitive; the caller's own snapshot often says `Path` and `PathExt`.
    const dir = tmp();
    const caller = { Path: "C:\\tools", PathExt: PATHEXT, USERPROFILE: "C:\\Users\\me", PI_MODEL: "m" };
    assert.equal(envGet(caller, "PATH", { platform: "win32" }), "C:\\tools");
    const launch = resolveLaunch({
      env: caller,
      cwd: "C:\\work",
      platform: "win32",
      execPath: "C:\\node\\node.exe",
      exists: files([win32.join("C:\\tools", "pi.exe"), "C:\\node\\node.exe"]),
    });
    assert.equal(launch.pi, win32.join("C:\\tools", "pi.exe"), "a Path spelling still finds pi");
    const snapshot = launchEnv(caller, launch.PATH, "win32");
    assert.equal(snapshot.Path, undefined, "the caller's spelling is replaced, not kept alongside");
    assert.equal(snapshot.PATH, launch.PATH);
    assert.equal(snapshot.PathExt, PATHEXT, "only PATH is replaced; other keys keep their own spelling");
    // The generated launcher therefore assigns PATH once, with the resolved value.
    const prepared = prepareLaunch({
      dir,
      env: caller,
      mux: "herdr",
      cwd: "C:\\work",
      platform: "win32",
      execPath: "C:\\node\\node.exe",
      exists: files([win32.join("C:\\tools", "pi.exe"), "C:\\node\\node.exe"]),
      readFile: () => "",
    });
    assert.equal(prepared.PATH, launch.PATH);
    const assignments = [...readFileSync(prepared.launcher, "utf8").matchAll(/SetEnvironmentVariable\('([A-Za-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(assignments.filter((name) => name.toUpperCase() === "PATH"), ["PATH"], "one PATH assignment, not PATH and Path");
    assert.ok(readFileSync(prepared.launcher, "utf8").includes(`SetEnvironmentVariable('PATH', "${launch.PATH}")`), "with the resolved value, as status.json.launch records it");
  });

  it("runs a real npm-style shim in a %-named folder and records its exit (Windows only)", { skip: process.platform !== "win32" && "needs a real Windows host for PowerShell and cmd-shim behaviour" }, () => {
    const dir = tmp();
    const aliasDir = join(dir, "%ALIAS% & caret^bang!");
    mkdirSync(aliasDir);
    const entryFile = join(aliasDir, "entry.mjs");
    const marker = join(dir, "entry-ran");
    writeFileSync(entryFile, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join("|"));\nprocess.exit(7);\n`);
    const shim = join(aliasDir, "pi.cmd");
    writeFileSync(shim, `@ECHO off\r\nendLocal & "%_prog%"  "%dp0%\\entry.mjs" %*\r\n`);
    const env = { ...process.env, ALIAS: "C:\\somewhere-else", PAIR_PI_BIN: shim, HC_TERMINAL_ID: "t7" };
    const launch = prepareLaunch({ dir, env, mux: "herdr", cwd: dir, workdir: dir });
    assert.equal(launch.entry, entryFile, "the literal %-named folder was resolved as a path, not expanded");
    const [exe, ...args] = launch.argv(["--version", "a&echo", "%ALIAS%"]);
    const child = spawnSync(exe, args, { env, encoding: "utf8" });
    assert.equal(child.status, 7, "the launcher returns Pi's own code");
    assert.equal(readFileSync(marker, "utf8"), "--version|a&echo|%ALIAS%", "arguments arrive verbatim: no % expansion, no & split");
    assert.equal(readFileSync(launch.exitFile, "utf8"), "t7 7\n", "and the exit record is written after the shim returns");
    assert.equal(readFileSync(launch.idFile, "utf8"), "t7\n");
  });

  it("round-trips non-ASCII values and paths through the real launcher (Windows only)", { skip: process.platform !== "win32" && "needs a real Windows host for PowerShell and cmd-shim behaviour" }, () => {
    const dir = tmp();
    const uniDir = join(dir, "ünïcode 日本語");
    mkdirSync(uniDir);
    const entryFile = join(uniDir, "entry.mjs");
    const marker = join(uniDir, "env.txt");
    writeFileSync(entryFile, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, process.env.PAIR_TEST_UNICODE ?? "missing");\n`);
    const env = { ...process.env, PAIR_PI_BIN: entryFile, PAIR_TEST_UNICODE: "Grüße 日本語 ✓", HC_TERMINAL_ID: "t8" };
    const launch = prepareLaunch({ dir, env, mux: "herdr", cwd: uniDir, workdir: uniDir });
    const [exe, ...args] = launch.argv(["--version"]);
    const child = spawnSync(exe, args, { env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(marker, "utf8"), "Grüße 日本語 ✓", "a BOM makes PowerShell 5.1 read UTF-8, so the value survives");
    assert.equal(readFileSync(launch.exitFile, "utf8"), "t8 0\n");
  });

  it("kills a hung probe's Node child and reaps it", async () => {
    // The same code path a readiness probe uses: node is spawned directly, so the deadline kills the probe itself.
    const dir = tmp();
    const pidFile = join(dir, "child.pid");
    const scriptFile = join(dir, "hang.mjs");
    writeFileSync(scriptFile, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    let pid = null;
    try {
      await assert.rejects(run(process.execPath, [scriptFile], { timeout: 1_500 }), (error) => {
        assert.ok(error.killed, "bounded, and killed at the deadline");
        return true;
      });
      pid = Number(readFileSync(pidFile, "utf8"));
      for (let attempt = 0; attempt < 40 && alive(pid); attempt++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(alive(pid), false, "the probe process itself is gone, not just a shell in front of it");
    } finally {
      if (pid && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the POSIX launcher a shell script that changes folder itself", () => {
    const text = launcherScript({ env: { PATH: "/usr/bin" }, pi: "/opt/pi", exitFile: "/run/launch.exit", idFile: "/run/launch.id", mux: "herdr", cwd: "/repo with space", platform: "linux" });
    assert.ok(text.startsWith("#!/bin/sh\n"), "line feeds here");
    assert.ok(text.includes("cd -- '/repo with space' ||"), "quoted, so a space or quote cannot break it");
    assert.ok(text.indexOf("cd -- ") < text.indexOf("'/opt/pi' \"$@\""), "before pi runs");
  });
});

describe("Rex discovery and the remote block case (D1, D2, D3)", () => {
  it("takes REX_BIN as given, then PATH, then the platform's install folders", () => {
    assert.deepEqual(findRex({ env: { REX_BIN: "/opt/rex/rex", PATH: "/usr/bin" }, platform: "linux", exists: files(["/usr/bin/rex"]) }), { bin: "/opt/rex/rex", how: "REX_BIN" });
    const winExe = win32.join("C:\\Users\\me\\AppData\\Local", "Programs", "Rex", "rex.exe");
    const found = findRex({ env: { PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, platform: "win32", exists: files([winExe]) });
    assert.deepEqual(found, { bin: winExe, how: "Windows LOCALAPPDATA" });
    const mac = posix.join("/Users/me", "Library", "Application Support", "com.superlogical.rex", "RexServer", "Versions", "Current", "Rex Server.app", "Contents", "MacOS", "rex");
    assert.deepEqual(findRex({ env: { PATH: "/usr/bin", HOME: "/Users/me" }, platform: "darwin", exists: files([mac]) }), { bin: mac, how: "macOS Rex Server" });
    const linux = findRex({ env: { PATH: "/nowhere", HOME: "/home/me" }, platform: "linux", exists: files(["/opt/rex/rex"]) });
    assert.deepEqual(linux, { bin: "/opt/rex/rex", how: "Linux install folder" });
  });

  it("finds rex through the caller's PATHEXT, so a .bat shim is not missed", () => {
    const bat = win32.join("C:\\tools", "rex.bat");
    const found = findRex({ env: { PATH: "C:\\tools", PATHEXT: ".BAT", LOCALAPPDATA: "C:\\none" }, platform: "win32", exists: files([bat]) });
    assert.deepEqual(found, { bin: bat, how: "PATH" });
  });

  it("names every path it tried, including the ones it rejected before a hit", () => {
    const trace = [];
    findRex({ env: { PATH: "/a:/b", HOME: "/home/me" }, platform: "linux", exists: () => false, trace });
    const text = trace.join("\n");
    assert.match(text, /rex: REX_BIN is unset/);
    assert.match(text, /rex: \/a\/rex missing \(PATH\)/);
    assert.match(text, /rex: \/opt\/rex\/rex missing \(Linux install folder\)/);
    assert.match(text, /rex: not found$/);
  });

  it("says why a remote Rex block cannot open panes, and reports no mux", async () => {
    const env = { REX_SESSION: "sess", REX_BLOCK: "blk0", PATH: "/nowhere", HOME: "/home/me" };
    const trace = [];
    const found = await environment({ env, platform: "linux", exists: () => false, trace });
    assert.deepEqual(found, { mux: null, reason: REX_NO_CLI });
    assert.equal(muxVerdict(found), "none: REX_* set but no rex CLI here (remote Rex block?)");
    const text = trace.join("\n");
    assert.match(text, /Rex terminals run on the server's machine/, "the trace says where the workers would run");
    assert.match(text, /forwarded socket is control-only/, "and that a forwarded socket does not change that");
    // The same with an explicit --mux, which still validates the environment it was given.
    const selected = await environment({ env, platform: "linux", mux: "rex", exists: () => false, trace: [] });
    assert.equal(selected.mux, null);
    // The fix is to run the orchestration where the terminals run — not to install a CLI and forward a socket.
    assert.match(doctorMuxFix(found), /run the pair on the machine that runs the Rex server/);
    assert.match(doctorMuxFix(found), /control-only/);
  });

  it("does not give the Remote-Rex remedy for a mux ambiguity, even with Rex installed", async () => {
    // Both variable families, and a real Rex CLI: environment() asks for --mux, so the fix must be about the flag (audit 7).
    const env = { HC_TERMINAL_ID: "t0", REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "/opt/rex/rex", PATH: "/nowhere", HOME: "/home/me" };
    const found = await environment({ env, platform: "linux", exists: () => false });
    assert.match(found.reason, /--mux herdr\|rex/);
    assert.match(doctorMuxFix(found), /pass a mux this machine can run in/);
    assert.doesNotMatch(doctorMuxFix(found), /rex CLI|control-only/);
    // And a Herdr failure keeps the Herdr advice.
    assert.match(doctorMuxFix({ reason: "not running inside Herdr (HC_TERMINAL_ID) or Rex (REX_SESSION/REX_BLOCK)" }), /run doctor inside a Herdr pane or a Rex block/);
  });

  it("reports the CLI it found, so doctor's Rex line can be traced to a file", async () => {
    const found = await environment({ env: { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "/opt/rex/rex" }, platform: "linux" });
    assert.deepEqual(found, { mux: "rex", session: "sess", pane: "blk0", bin: "/opt/rex/rex", how: "REX_BIN" });
  });

  it("stops a run before a pane when the rex CLI is missing", () => {
    const absent = { platform: "linux", exists: () => false, defaults: { rounds: 1, turnTimeout: "1m" }, found: { mux: "rex" }, env: { REX_SESSION: "s", REX_BLOCK: "b", PATH: "/nowhere", HOME: "/home/me" } };
    assert.throws(() => runOptions({ "task-file": "unused" }, absent), /REX_SESSION and REX_BLOCK are set but there is no rex CLI on this machine/);
  });

  it("starts Rex workers through the run's launcher, with the worker folder on the split", async () => {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return JSON.stringify({ block_ids: ["blk1"] });
    };
    const panes = adapter("rex", { exec, env: { REX_SESSION: "sess", REX_BLOCK: "blk0", REX_BIN: "rex" }, cwd: "/repo" });
    const id = await panes.split("blk0", "right", "pair: implementer", ["/run/launch.sh", "--model", "claude-code/claude-opus-5-5", "prompt"]);
    assert.equal(id, "blk1");
    assert.deepEqual(calls[0], [
      "rex", "split", "-s", "sess", "-b", "blk0", "--split=right", "-c", "/repo", "--label", "pair: implementer", "--focus=false", "--json", "--",
      "/run/launch.sh", "--model", "claude-code/claude-opus-5-5", "prompt",
    ]);
  });
});

describe("CRLF reports and screens (E4)", () => {
  it("accepts a done marker followed by CRLF, and rejects a report without one", async () => {
    assert.equal(reportDone(`report\r\n${DONE}\r\n`), true);
    assert.equal(reportDone(`report\r\n${DONE}\r\n\r\n`), true, "trailing blank lines are not part of the marker");
    assert.equal(reportDone(`report\r\n${DONE}`), true);
    assert.equal(reportDone("report\r\n"), false);
    const dir = tmp();
    const done = join(dir, "done.md");
    writeFileSync(done, `report written on Windows\r\n\r\n${DONE}\r\n`);
    assert.match(await waitForReport(done, { sleep: async () => {}, now: () => 0, timeout: 1000 }), /report written on Windows/);
    const unfinished = join(dir, "unfinished.md");
    writeFileSync(unfinished, "report\r\n");
    let t = 0;
    await assert.rejects(waitForReport(unfinished, { sleep: async () => {}, now: () => (t += 400), timeout: 1 }), /timed out/);
  });

  it("reads a startup error and the screen tail from CRLF output", () => {
    const screen = "Pi is starting\r\nNo API key found for claude-code\r\n";
    assert.equal(screenError(screen, STARTUP_ERRORS), "No API key found for claude-code", "no stray \\r on the matched line");
    assert.equal(screenTail(screen, 2), "No API key found for claude-code", "the tail has no \\r either");
  });

  it("reads a CRLF exit record", () => {
    const dir = tmp();
    const exitFile = join(dir, LAUNCH_EXIT);
    writeFileSync(exitFile, "t7 0\r\n");
    assert.equal(launcherExit(exitFile, "t7"), 0);
    writeFileSync(exitFile, "blk1 127\r\n");
    assert.equal(launcherExit(exitFile, "blk1"), 127);
    assert.equal(launcherExit(exitFile, "t7"), null, "another worker's record is not this worker's");
  });
});
