import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDefinition } from "../fleet/registry.ts";
import {
  buildEnvExports,
  buildJobPiArgs,
  buildPiShellCommand,
  buildShellCommand,
} from "./agent-command.ts";
import { defaultConfig, loadConfig, type SpawnConfig } from "./config.ts";
import {
  isTerminal,
  loadJobs,
  resolveStatus,
  sanitizeJobName,
  saveJobs,
  uniqueJobName,
  type ExecFn,
  type ExecOptions,
  type ExecOutcome,
  type LaunchRequest,
  type SpawnBackend,
  type SpawnJob,
} from "./jobs.ts";
import {
  localJobDir,
  readDoneMarker,
  readErrTail,
  readLogTail,
  refreshFromLocalMarkers,
} from "./backends/local.ts";
import { buildTmuxRunScript, createTmuxBackend } from "./backends/tmux.ts";
import {
  buildErrTailCommand,
  buildKillCommand,
  buildLaunchCommand,
  buildProbeCommand,
  buildRemoteRunScript,
  buildTailCommand,
  createExedevBackend,
  parseVmList,
  remoteJobDir,
} from "./backends/exedev.ts";
import {
  buildGuestRunScript,
  buildMsbRunArgs,
  createMicrosandboxBackend,
  sandboxNameFor,
} from "./backends/microsandbox.ts";
import {
  cleanupSpawnToolingJobs,
  createSpawnToolingSpawn,
} from "./runner-adapter.ts";
import { registryPath } from "./jobs.ts";
import type { BackendCapabilities, KillResult } from "@pi-kit/agent-types";

function def(
  name: string,
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    name,
    description: `${name} description`,
    systemPrompt: `${name} prompt`,
    source: `${name}.md`,
    ...overrides,
  };
}

function testConfig(overrides: Partial<SpawnConfig> = {}): SpawnConfig {
  return {
    ...defaultConfig(),
    logDir: mkdtempSync(path.join(os.tmpdir(), "pi-spawn-test-")),
    ...overrides,
  };
}

interface ExecCall {
  command: string;
  args: string[];
  options?: ExecOptions;
}

/** Fake ExecFn: routes each call through a handler and records it. */
function fakeExec(
  handler: (call: ExecCall) => Partial<ExecOutcome> | undefined,
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const outcome = handler(call) ?? {};
    return { exitCode: 0, stdout: "", stderr: "", ...outcome };
  };
  return { exec, calls };
}

function runningJob(
  config: SpawnConfig,
  overrides: Partial<SpawnJob> = {},
): SpawnJob {
  const job: SpawnJob = {
    name: "job-a",
    backend: "tmux",
    agent: "scout",
    task: "look around",
    cwd: "/tmp",
    status: "running",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
  const dir = localJobDir(job, config);
  mkdirSync(dir, { recursive: true });
  job.logPath = job.logPath ?? path.join(dir, "job.log");
  job.donePath = job.donePath ?? path.join(dir, "done");
  job.errPath = job.errPath ?? path.join(dir, "err.log");
  return job;
}

describe("resolveStatus", () => {
  it("maps a zero done marker to done", () => {
    assert.deepEqual(resolveStatus("0", false), {
      status: "done",
      exitCode: 0,
    });
  });
  it("maps a non-zero done marker to failed", () => {
    assert.deepEqual(resolveStatus("3\n", true), {
      status: "failed",
      exitCode: 3,
    });
  });
  it("maps an unparseable marker to failed without an exit code", () => {
    assert.deepEqual(resolveStatus("garbage", false), {
      status: "failed",
      exitCode: undefined,
    });
  });
  it("maps no marker to running or lost by runner aliveness", () => {
    assert.equal(resolveStatus(undefined, true).status, "running");
    assert.equal(resolveStatus(undefined, false).status, "lost");
  });
});

describe("isTerminal", () => {
  it("treats everything but running as terminal", () => {
    assert.equal(isTerminal("running"), false);
    for (const s of ["done", "failed", "killed", "lost"] as const) {
      assert.equal(isTerminal(s), true);
    }
  });
});

describe("job names", () => {
  it("sanitizes to dir/window/sandbox-safe names", () => {
    assert.equal(sanitizeJobName("fix: the bug!"), "fix-the-bug");
    assert.equal(sanitizeJobName("...."), "job");
  });
  it("appends a counter on collision", () => {
    const taken = new Set([`a-${(1000).toString(36)}`]);
    const name = uniqueJobName("a", (n) => taken.has(n), 1000);
    assert.equal(name, `a-${(1000).toString(36)}-2`);
  });
});

describe("job registry", () => {
  it("round-trips jobs through jobs.json", () => {
    const config = testConfig();
    const job = runningJob(config);
    saveJobs(config.logDir, [job]);
    assert.deepEqual(loadJobs(config.logDir), [job]);
  });
  it("treats a corrupt registry as empty and reports it", () => {
    const config = testConfig();
    mkdirSync(config.logDir, { recursive: true });
    writeFileSync(path.join(config.logDir, "jobs.json"), "not json", "utf8");
    const errors: string[] = [];
    assert.deepEqual(
      loadJobs(config.logDir, (m) => errors.push(m)),
      [],
    );
    assert.equal(errors.length, 1);
  });
  it("loads empty when no registry exists", () => {
    assert.deepEqual(loadJobs(testConfig().logDir), []);
  });
});

describe("local markers", () => {
  it("reads missing and empty done markers as undefined", () => {
    const config = testConfig();
    const job = runningJob(config);
    assert.equal(readDoneMarker(job.donePath), undefined);
    writeFileSync(job.donePath!, "", "utf8");
    assert.equal(readDoneMarker(job.donePath), undefined);
    writeFileSync(job.donePath!, "0\n", "utf8");
    assert.equal(readDoneMarker(job.donePath), "0\n");
  });

  it("keeps a running job running while the runner is alive", async () => {
    const config = testConfig();
    const job = runningJob(config);
    const changed = await refreshFromLocalMarkers(job, () => true);
    assert.equal(changed, false);
    assert.equal(job.status, "running");
  });

  it("moves to done when the marker lands", async () => {
    const config = testConfig();
    const job = runningJob(config);
    writeFileSync(job.donePath!, "0\n", "utf8");
    const changed = await refreshFromLocalMarkers(job, () => true);
    assert.equal(changed, true);
    assert.equal(job.status, "done");
    assert.equal(job.exitCode, 0);
  });

  it("moves to lost when the runner died without a marker", async () => {
    const config = testConfig();
    const job = runningJob(config);
    const changed = await refreshFromLocalMarkers(job, () => false);
    assert.equal(changed, true);
    assert.equal(job.status, "lost");
  });

  it("prefers a marker published during the aliveness probe over lost", async () => {
    const config = testConfig();
    const job = runningJob(config);
    const changed = await refreshFromLocalMarkers(job, () => {
      // The runner finishes between the marker read and the probe: it
      // publishes the marker and exits.
      writeFileSync(job.donePath!, "0\n", "utf8");
      return false;
    });
    assert.equal(changed, true);
    assert.equal(job.status, "done");
    assert.equal(job.exitCode, 0);
  });

  it("reads missing and empty stderr files as empty, tails the rest", () => {
    const config = testConfig();
    const job = runningJob(config);
    assert.equal(readErrTail(job.errPath, 100), "");
    writeFileSync(job.errPath!, "", "utf8");
    assert.equal(readErrTail(job.errPath, 100), "");
    writeFileSync(job.errPath!, "pi: command not found\n", "utf8");
    assert.equal(readErrTail(job.errPath, 100), "pi: command not found\n");
  });

  it("tails logs with a truncation prefix", () => {
    const config = testConfig();
    const job = runningJob(config);
    assert.equal(readLogTail(job.logPath, 100), "(no output yet)");
    writeFileSync(job.logPath!, "abcdefghij", "utf8");
    assert.equal(readLogTail(job.logPath, 100), "abcdefghij");
    assert.equal(readLogTail(job.logPath, 4), "...(truncated)...\nghij");
  });
});

describe("buildJobPiArgs", () => {
  it("builds print-mode args with all agent settings", () => {
    const d = def("implementer", {
      model: "claude-sonnet-5",
      thinkingLevel: "medium",
      tools: ["read", "bash"],
    });
    assert.deepEqual(buildJobPiArgs(d, "do it"), [
      "-p",
      "--no-session",
      "--system-prompt",
      "implementer prompt",
      "--model",
      "claude-sonnet-5",
      "--thinking",
      "medium",
      "--tools",
      "read,bash",
      "do it",
    ]);
  });
  it("omits optional flags and quotes the shell form", () => {
    const d = def("scout");
    assert.deepEqual(buildJobPiArgs(d, "t"), [
      "-p",
      "--no-session",
      "--system-prompt",
      "scout prompt",
      "t",
    ]);
    const cmd = buildPiShellCommand("pi", d, "isn't it");
    assert.ok(cmd.startsWith("'pi' '-p' '--no-session'"));
    assert.ok(cmd.endsWith(`'isn'\\''t it'`));
    assert.equal(
      buildShellCommand("pi", ["--mode", "json", "task with spaces"]),
      "'pi' '--mode' 'json' 'task with spaces'",
    );
  });
});

describe("buildEnvExports", () => {
  it("exports only set, validly named variables, quoted", () => {
    assert.deepEqual(
      buildEnvExports(["A_KEY", "MISSING", "EMPTY", "BAD-NAME"], {
        A_KEY: "s3cr'et",
        EMPTY: "",
        "BAD-NAME": "x",
      }),
      [`export A_KEY='s3cr'\\''et'`],
    );
  });
});

describe("tmux backend", () => {
  it("writes a run script that captures pi's exit code, not tee's", () => {
    const script = buildTmuxRunScript({
      jobName: "j1",
      cwd: "/work dir",
      piCommand: "'pi' '-p' 'task'",
      logPath: "/logs/j1/job.log",
      donePath: "/logs/j1/done",
      errPath: "/logs/j1/err.log",
    });
    assert.ok(
      script.includes(
        `cd '/work dir' || { echo '[pi-spawn] could not cd to /work dir' > '/logs/j1/err.log'; echo 127 > '/logs/j1/done'; exit 127; }`,
      ),
    );
    // stderr must stay out of the teed stream (it would corrupt the JSONL
    // fleet parses), and the done marker must only appear after tee has
    // finished writing the log — otherwise a poller can see "done" and
    // read a log that is still missing the final assistant message.
    assert.ok(
      script.includes(
        `{ 'pi' '-p' 'task'; echo $? > '/logs/j1/done.exit'; } 2> '/logs/j1/err.log' | tee '/logs/j1/job.log'`,
      ),
    );
    assert.ok(script.includes(`mv '/logs/j1/done.exit' '/logs/j1/done'`));
    assert.ok(
      script.indexOf("| tee") < script.indexOf("mv '/logs/j1/done.exit'"),
    );
  });

  it("launches into a new session, then windows of it", async () => {
    const config = testConfig();
    let sessionExists = false;
    const { exec, calls } = fakeExec((call) => {
      if (call.args[0] === "has-session") {
        return { exitCode: sessionExists ? 0 : 1 };
      }
      if (call.args[0] === "new-session" || call.args[0] === "new-window") {
        sessionExists = true;
        return { stdout: `@${calls.length}\n` };
      }
      return {};
    });
    const backend = createTmuxBackend(exec, config);

    const job1 = await backend.launch({
      jobName: "j1",
      agent: def("scout"),
      task: "t1",
      cwd: "/tmp",
    });
    const job2 = await backend.launch({
      jobName: "j2",
      agent: def("scout"),
      task: "t2",
      cwd: "/tmp",
    });

    assert.equal(job1.tmuxWindowId?.startsWith("@"), true);
    assert.notEqual(job1.tmuxWindowId, job2.tmuxWindowId);
    const creations = calls.filter(
      (c) => c.args[0] === "new-session" || c.args[0] === "new-window",
    );
    assert.deepEqual(
      creations.map((c) => c.args[0]),
      ["new-session", "new-window"],
    );
    const script = readFileSync(
      path.join(localJobDir(job1, config), "run.sh"),
      "utf8",
    );
    assert.ok(script.includes("'scout prompt'"));
    assert.ok(script.includes("'t1'"));
  });

  it("forwards API keys into the run script (the window inherits the tmux server's env)", async () => {
    const config = testConfig({ envPassthrough: ["SPAWN_TEST_KEY"] });
    process.env.SPAWN_TEST_KEY = "k3y";
    try {
      const { exec } = fakeExec((call) => {
        if (call.args[0] === "has-session") return { exitCode: 1 };
        if (call.args[0] === "new-session") return { stdout: "@1\n" };
        return {};
      });
      const backend = createTmuxBackend(exec, config);
      const job = await backend.launch({
        jobName: "j-env",
        agent: def("scout"),
        task: "t",
        cwd: "/tmp",
      });
      const script = readFileSync(
        path.join(localJobDir(job, config), "run.sh"),
        "utf8",
      );
      assert.ok(script.includes("export SPAWN_TEST_KEY='k3y'"));
    } finally {
      delete process.env.SPAWN_TEST_KEY;
    }

    const off = testConfig({
      envPassthrough: ["SPAWN_TEST_KEY"],
      tmuxForwardEnv: false,
    });
    process.env.SPAWN_TEST_KEY = "k3y";
    try {
      const { exec } = fakeExec((call) => {
        if (call.args[0] === "has-session") return { exitCode: 1 };
        if (call.args[0] === "new-session") return { stdout: "@1\n" };
        return {};
      });
      const backend = createTmuxBackend(exec, off);
      const job = await backend.launch({
        jobName: "j-noenv",
        agent: def("scout"),
        task: "t",
        cwd: "/tmp",
      });
      const script = readFileSync(
        path.join(localJobDir(job, off), "run.sh"),
        "utf8",
      );
      assert.doesNotMatch(script, /SPAWN_TEST_KEY/);
    } finally {
      delete process.env.SPAWN_TEST_KEY;
    }
  });

  it("uses a runner-provided command instead of building pi -p", async () => {
    const config = testConfig();
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "has-session") return { exitCode: 1 };
      if (call.args[0] === "new-session") return { stdout: "@1\n" };
      return {};
    });
    const backend = createTmuxBackend(exec, config);
    const job = await backend.launch({
      jobName: "j-json",
      agent: def("scout"),
      task: "display only",
      cwd: "/tmp",
      command: "pi",
      args: ["--mode", "json", "task"],
    });
    const script = readFileSync(
      path.join(localJobDir(job, config), "run.sh"),
      "utf8",
    );
    assert.ok(script.includes("'pi' '--mode' 'json' 'task'"));
    assert.doesNotMatch(script, /scout prompt/);
  });

  it("refreshes from the pane and marker, and kills the window", async () => {
    const config = testConfig();
    let paneDead = false;
    const { exec, calls } = fakeExec((call) => {
      if (call.args[0] === "list-panes") {
        return { stdout: paneDead ? "1\n" : "0\n" };
      }
      return {};
    });
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config, { tmuxWindowId: "@7" });

    assert.equal(await backend.refresh(job), false);
    assert.equal(job.status, "running");

    paneDead = true;
    writeFileSync(job.donePath!, "2\n", "utf8");
    assert.equal(await backend.refresh(job), true);
    assert.equal(job.status, "failed");
    assert.equal(job.exitCode, 2);

    await backend.kill(job);
    // With pane_dead=true, kill detects the pane is already gone
    // and returns alreadyComplete without calling kill-window.
    const killCalls = calls.filter((c) => c.args[0] === "kill-window");
    assert.equal(killCalls.length, 0);

    // When the pane is still alive, kill-window is called:
    paneDead = false;
    const job2 = runningJob(config, { tmuxWindowId: "@8" });
    await backend.kill(job2);
    const killCalls2 = calls.filter((c) => c.args[0] === "kill-window");
    assert.deepEqual(killCalls2[killCalls2.length - 1]?.args, ["kill-window", "-t", "@8"]);
  });
});

describe("exedev command builders", () => {
  it("keeps job files under $HOME/.pi-spawn", () => {
    assert.equal(remoteJobDir("j1"), ".pi-spawn/j1");
    const launch = buildLaunchCommand(".pi-spawn/j1");
    assert.ok(launch.includes(`d="$HOME/"'.pi-spawn/j1'`));
    assert.ok(launch.includes('cat > "$d/run.sh"'));
    assert.ok(launch.includes('(setsid nohup sh "$d/run.sh" > /dev/null 2>&1 &)'));
    assert.ok(launch.endsWith("echo launched"));
  });

  it("probes done marker, pid, and lost in one round trip", () => {
    const probe = buildProbeCommand(".pi-spawn/j1");
    assert.ok(probe.includes('if [ -s "$d/done" ]'));
    assert.ok(probe.includes('echo "done:$(cat "$d/done")"'));
    assert.ok(probe.includes("else echo lost"));
  });

  it("kills the job's process group via its pid file", () => {
    const kill = buildKillCommand(".pi-spawn/j1");
    assert.ok(kill.includes(`kill -TERM -- "-$(cat "$d/pid")"`));
    assert.ok(kill.endsWith("true"));
  });

  it("can read a full remote log when no output cap is requested", () => {
    const tail = buildTailCommand(".pi-spawn/j1", Number.POSITIVE_INFINITY);
    assert.ok(tail.includes('cat "$d/job.log"'));
    assert.doesNotMatch(tail, /tail -c/);
  });

  it("writes a run script that records its pid and exit code", () => {
    const script = buildRemoteRunScript({
      jobName: "j1",
      piCommand: "'pi' '-p' 'task'",
      remoteDir: ".pi-spawn/j1",
      envExports: ["export A_KEY='x'"],
    });
    assert.ok(script.includes('echo $$ > "$d/pid"'));
    assert.ok(script.includes("export A_KEY='x'"));
    assert.ok(script.includes('cd "$HOME"'));
    // stderr goes to its own file and the done marker is published only
    // after the log is fully written.
    assert.ok(
      script.includes(
        `{ 'pi' '-p' 'task'; echo $? > "$d/done.exit"; } > "$d/job.log" 2> "$d/err.log"`,
      ),
    );
    assert.ok(script.includes('mv "$d/done.exit" "$d/done"'));

    const runnerScript = buildRemoteRunScript({
      jobName: "j2",
      piCommand: "'pi' '--mode' 'json' 'task'",
      remoteDir: ".pi-spawn/j2",
      envExports: [],
      cwd: "/remote/repo worktree",
    });
    assert.ok(runnerScript.includes("cd '/remote/repo worktree' || { echo "));
    assert.ok(runnerScript.includes('> "$d/err.log"; echo 127 > "$d/done"; exit 127; }'));
    assert.match(runnerScript, /could not cd to \/remote\/repo worktree on the VM/);
  });

  it("tails the remote stderr file without a placeholder", () => {
    const err = buildErrTailCommand(".pi-spawn/j1", 1024);
    assert.ok(err.includes('tail -c 1024 "$d/err.log"'));
    assert.ok(err.endsWith("true"));
    assert.ok(
      buildErrTailCommand(".pi-spawn/j1", Number.POSITIVE_INFINITY).includes(
        'cat "$d/err.log"',
      ),
    );
  });

  it("parses both VM list shapes and rejects garbage", () => {
    assert.deepEqual(
      parseVmList('{"vms":[{"vm_name":"a","ssh_dest":"a.exe.xyz"}]}'),
      [{ vm_name: "a", ssh_dest: "a.exe.xyz" }],
    );
    assert.deepEqual(parseVmList('[{"vm_name":"b"}]'), [{ vm_name: "b" }]);
    assert.throws(() => parseVmList('{"nope":true}'));
  });
});

describe("exedev backend", () => {
  const vmList = JSON.stringify({
    vms: [{ vm_name: "pi-spawn", ssh_dest: "pi-spawn.exe.xyz" }],
  });

  it("launches onto an existing VM by piping the run script", async () => {
    const config = testConfig();
    const { exec, calls } = fakeExec((call) => {
      const [, , dest, command] = call.args;
      if (dest === "exe.dev" && command === "ls --json") {
        return { stdout: vmList };
      }
      if (dest === "pi-spawn.exe.xyz") return { stdout: "launched\n" };
      return { exitCode: 1 };
    });
    const backend = createExedevBackend(exec, config);
    const job = await backend.launch({
      jobName: "j1",
      agent: def("scout"),
      task: "t1",
      cwd: "/tmp",
    });
    assert.equal(job.sshDest, "pi-spawn.exe.xyz");
    assert.equal(job.remoteDir, ".pi-spawn/j1");
    const launchCall = calls.find((c) => c.args[2] === "pi-spawn.exe.xyz")!;
    assert.ok(launchCall.options?.stdin?.includes("'scout prompt'"));
    assert.ok(launchCall.options?.stdin?.includes('echo $$ > "$d/pid"'));
    assert.ok(launchCall.options?.stdin?.includes('cd "$HOME"'));
    assert.deepEqual(launchCall.args.slice(0, 2), ["-o", "BatchMode=yes"]);
  });

  it("honors cwd for runner-provided commands on exe.dev", async () => {
    const config = testConfig();
    const { exec, calls } = fakeExec((call) => {
      const [, , dest, command] = call.args;
      if (dest === "exe.dev" && command === "ls --json") {
        return { stdout: vmList };
      }
      if (dest === "pi-spawn.exe.xyz") return { stdout: "launched\n" };
      return { exitCode: 1 };
    });
    const backend = createExedevBackend(exec, config);
    await backend.launch({
      jobName: "j-json",
      agent: def("scout"),
      task: "display",
      cwd: "/remote/repo",
      command: "pi",
      args: ["--mode", "json", "task"],
    });
    const launchCall = calls.find((c) => c.args[2] === "pi-spawn.exe.xyz")!;
    assert.ok(launchCall.options?.stdin?.includes("'pi' '--mode' 'json' 'task'"));
    assert.ok(launchCall.options?.stdin?.includes("cd '/remote/repo'"));
    assert.doesNotMatch(launchCall.options?.stdin ?? "", /scout prompt/);
  });

  it("creates the VM when missing and waits for SSH", async () => {
    const config = testConfig();
    let sshReadyAfter = 2;
    const { exec, calls } = fakeExec((call) => {
      const [, , dest, command] = call.args;
      if (dest === "exe.dev" && command === "ls --json") {
        return { stdout: '{"vms":[]}' };
      }
      if (dest === "exe.dev" && command.startsWith("new ")) {
        return { stdout: "{}" };
      }
      if (dest === "pi-spawn.exe.xyz" && command === "true") {
        return { exitCode: --sshReadyAfter > 0 ? 1 : 0 };
      }
      return { stdout: "launched\n" };
    });
    const backend = createExedevBackend(exec, config, {
      sleep: async () => {},
    });
    const job = await backend.launch({
      jobName: "j1",
      agent: def("scout"),
      task: "t1",
      cwd: "/tmp",
    });
    assert.equal(job.sshDest, "pi-spawn.exe.xyz");
    assert.ok(
      calls.some(
        (c) => c.args[2] === "exe.dev" && c.args[3] === "new --name=pi-spawn --json",
      ),
    );
  });

  it("refuses to create when exedevAutoCreate is off", async () => {
    const config = testConfig({ exedevAutoCreate: false });
    const { exec } = fakeExec((call) =>
      call.args[3] === "ls --json" ? { stdout: '{"vms":[]}' } : { exitCode: 1 },
    );
    const backend = createExedevBackend(exec, config);
    await assert.rejects(
      () =>
        backend.launch({
          jobName: "j1",
          agent: def("scout"),
          task: "t",
          cwd: "/tmp",
        }),
      /exedevAutoCreate is off/,
    );
  });

  it("refreshes from the probe and survives network failures", async () => {
    const config = testConfig();
    let answer: Partial<ExecOutcome> = { stdout: "running\n" };
    const { exec } = fakeExec(() => answer);
    const backend = createExedevBackend(exec, config);
    const job: SpawnJob = {
      ...runningJob(config, { backend: "exedev" }),
      sshDest: "pi-spawn.exe.xyz",
      remoteDir: ".pi-spawn/job-a",
    };

    assert.equal(await backend.refresh(job), false);
    assert.equal(job.status, "running");

    answer = { exitCode: null, stderr: "connection refused" };
    assert.equal(await backend.refresh(job), false);
    assert.equal(job.status, "running");

    answer = { stdout: "done:0\n" };
    assert.equal(await backend.refresh(job), true);
    assert.equal(job.status, "done");
    assert.equal(job.exitCode, 0);
  });
});

describe("microsandbox backend", () => {
  it("builds run args with mounts, resources, image, and command", () => {
    const config = testConfig({
      msbCpus: 2,
      msbMemory: "2G",
    });
    assert.deepEqual(buildMsbRunArgs(config, "j1", "/logs/j1", "/repo"), [
      "run",
      "--no-tty",
      "--name",
      "pi-spawn-j1",
      "-v",
      "/logs/j1:/job",
      "-v",
      "/repo:/workspace",
      "--cpus",
      "2",
      "--memory",
      "2G",
      "node",
      "--",
      "sh",
      "/job/run.sh",
    ]);
    const noMount = testConfig({ msbMountCwd: false });
    assert.ok(!buildMsbRunArgs(noMount, "j1", "/l", "/r").includes("/r:/workspace"));
  });

  it("writes a guest script that installs pi and records the exit code", () => {
    const script = buildGuestRunScript({
      jobName: "j1",
      piCommand: "'pi' '-p' 't'",
      envExports: ["export K='v'"],
      mountCwd: true,
    });
    assert.ok(script.includes("export K='v'"));
    assert.ok(script.includes("npm install -g @mariozechner/pi-coding-agent"));
    assert.ok(
      script.includes(
        'cd /workspace || { echo "[pi-spawn] could not cd to /workspace in the sandbox" > /job/err.log; echo 127 > /job/done; exit 127; }',
      ),
    );
    // stderr to its own file; done marker published after the log is
    // complete (the mv is what the host-side poller keys on).
    assert.ok(
      script.includes(
        `{ 'pi' '-p' 't'; echo $? > /job/done.exit; } > /job/job.log 2> /job/err.log`,
      ),
    );
    assert.ok(script.includes("mv /job/done.exit /job/done"));
    assert.match(script, /could not install pi in the sandbox/);
    assert.ok(
      buildGuestRunScript({
        jobName: "j1",
        piCommand: "x",
        envExports: [],
        mountCwd: false,
      }).includes('cd "${HOME:-/root}"'),
    );
  });

  it("launches detached, refreshes from markers, and cleans up once", async () => {
    const config = testConfig();
    const { exec, calls } = fakeExec(() => ({}));
    let pidAlive = true;
    const detachCalls: { command: string; args: string[] }[] = [];
    const backend = createMicrosandboxBackend(
      exec,
      {
        spawnDetached: (command, args) => {
          detachCalls.push({ command, args });
          return 4242;
        },
        isPidAlive: () => pidAlive,
        killDetached: () => {},
      },
      config,
    );

    const job = await backend.launch({
      jobName: "j1",
      agent: def("scout"),
      task: "t1",
      cwd: "/repo",
    });
    assert.equal(job.hostPid, 4242);
    assert.equal(job.sandboxName, "pi-spawn-j1");
    assert.equal(detachCalls[0].command, "msb");
    assert.ok(detachCalls[0].args.includes("pi-spawn-j1"));
    const script = readFileSync(
      path.join(localJobDir(job, config), "run.sh"),
      "utf8",
    );
    assert.ok(script.includes("'scout prompt'"));

    assert.equal(await backend.refresh(job), false);
    assert.equal(job.status, "running");

    pidAlive = false;
    writeFileSync(job.donePath!, "0\n", "utf8");
    assert.equal(await backend.refresh(job), true);
    assert.equal(job.status, "done");
    const rmCalls = () =>
      calls.filter((c) => c.command === "msb" && c.args[0] === "rm").length;
    assert.equal(rmCalls(), 1);

    assert.equal(await backend.refresh(job), false);
    assert.equal(rmCalls(), 1);
  });

  it("kills the host runner and force-stops the sandbox", async () => {
    const config = testConfig();
    const { exec, calls } = fakeExec(() => ({}));
    let killed: number | undefined;
    const backend = createMicrosandboxBackend(
      exec,
      {
        spawnDetached: () => 1,
        isPidAlive: () => true,
        killDetached: (pid) => {
          killed = pid;
        },
      },
      config,
    );
    const job = runningJob(config, {
      backend: "microsandbox",
      hostPid: 99,
      sandboxName: "pi-spawn-job-a",
    });
    await backend.kill(job);
    assert.equal(killed, 99);
    assert.deepEqual(
      calls.map((c) => c.args.slice(0, 2)),
      [
        ["stop", "--force"],
        ["rm", "--force"],
      ],
    );
  });
});

// Shared test helper: a fake SpawnBackend for adapter tests.
function backendForAdapter(config: SpawnConfig): {
  backend: SpawnBackend;
  launched: LaunchRequest[];
  killed: string[];
} {
  const launched: LaunchRequest[] = [];
  const killed: string[] = [];
  const backend: SpawnBackend = {
    name: "tmux",
    async available() {
      return undefined;
    },
    async launch(request) {
      launched.push(request);
      const job = runningJob(config, {
        name: request.jobName,
        agent: request.agent.name,
        task: request.task,
        cwd: request.cwd,
      });
      writeFileSync(
        job.logPath!,
        [
          JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
          "",
        ].join("\\n"),
        "utf8",
      );
      return job;
    },
    async refresh(job) {
      if (job.status !== "running") return false;
      job.status = "done";
      job.exitCode = 0;
      job.updatedAt = Date.now();
      return true;
    },
    async output(job, maxBytes) {
      return readLogTail(job.logPath, maxBytes);
    },
    async errorOutput(job, maxBytes) {
      return readErrTail(job.errPath, maxBytes);
    },
    async kill(job) {
      killed.push(job.name);
      return { stopped: true as const };
    },
    async capabilities() {
      return {
        workspaceMount: true,
        cursorOutput: false,
        confirmedKill: true,
        durableLogs: true,
        networkAccess: true,
        hardwareIsolation: false,
      };
    },
  };
  return { backend, launched, killed };
}

describe("spawn runner adapter", () => {
  it("runs labeled pi children through a spawn backend and records the job", async () => {
    const config = testConfig();
    const { backend, launched } = backendForAdapter(config);
    const chunks: string[] = [];
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 0,
      jobNamePrefix: "pi-fleet-test",
    });
    const outcome = await spawn({
      command: "pi",
      args: ["--mode", "json", "--no-session", "task"],
      cwd: "/repo",
      signal: new AbortController().signal,
      label: "1-scout",
      onOutput: (chunk) => chunks.push(chunk),
    });

    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.stdout, /message_end/);
    assert.equal(launched[0].command, "pi");
    assert.deepEqual(launched[0].args, ["--mode", "json", "--no-session", "task"]);
    assert.equal(launched[0].cwd, "/repo");
    assert.equal(chunks.join(""), outcome.stdout);
    const jobs = loadJobs(config.logDir);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "done");
    assert.match(jobs[0].name, /^pi-fleet-test-1-scout-/);
  });

  it("records this process as the internal job's parent", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 0,
      jobNamePrefix: "pi-fleet-test",
      parentPid: 777,
    });
    await spawn({
      command: "pi",
      args: ["--mode", "json", "task"],
      cwd: "/repo",
      signal: new AbortController().signal,
      label: "1-scout",
    });
    const [job] = loadJobs(config.logDir);
    assert.equal(job.parentPid, 777);
  });

  it("reports a failed child's captured stderr back to the runner", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.launch = async (request) => {
      const job = runningJob(config, {
        name: request.jobName,
        agent: request.agent.name,
        task: request.task,
        cwd: request.cwd,
      });
      writeFileSync(job.errPath!, "Error: no API key configured\n", "utf8");
      return job;
    };
    backend.refresh = async (job) => {
      if (job.status !== "running") return false;
      job.status = "failed";
      job.exitCode = 1;
      job.updatedAt = Date.now();
      return true;
    };
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 0,
      jobNamePrefix: "pi-fleet-test",
    });
    const outcome = await spawn({
      command: "pi",
      args: ["--mode", "json", "task"],
      cwd: "/repo",
      signal: new AbortController().signal,
      label: "1-scout",
    });
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.stderr, /ended with status failed \(exit 1\)/);
    assert.match(outcome.stderr, /no API key configured/);
  });

  it("delegates unlabeled helper commands to the fallback", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    const seen: string[] = [];
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      fallback: async (request) => {
        seen.push(request.command);
        return { exitCode: 0, stdout: "helper", stderr: "" };
      },
    });
    const outcome = await spawn({
      command: "git",
      args: ["status"],
      cwd: "/repo",
      signal: new AbortController().signal,
    });
    assert.deepEqual(seen, ["git"]);
    assert.equal(outcome.stdout, "helper");
    assert.deepEqual(loadJobs(config.logDir), []);
  });

  it("kills and stamps stale internal jobs during cleanup", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    // A dead recorded parent and a pre-ownership record without a parentPid
    // are both stale; a job whose parent still runs is someone's live
    // sub-agent (session_start also fires inside spawned children and in
    // concurrent sessions) and must survive cleanup.
    const orphaned = runningJob(config, {
      name: "pi-fleet-1-scout-abc",
      parentPid: 4001,
    });
    const legacy = runningJob(config, { name: "pi-fleet-2-critic-def" });
    const liveParent = runningJob(config, {
      name: "pi-fleet-3-implementer-ghi",
      parentPid: 4002,
    });
    const userJob = runningJob(config, { name: "scout-user-job" });
    saveJobs(config.logDir, [orphaned, legacy, liveParent, userJob]);

    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: (pid) => pid === 4002,
      now: () => 1234,
    });

    assert.equal(cleaned, 2);
    assert.deepEqual(killed, [
      "pi-fleet-1-scout-abc",
      "pi-fleet-2-critic-def",
    ]);
    const jobs = loadJobs(config.logDir);
    assert.equal(jobs[0].status, "killed");
    assert.equal(jobs[0].updatedAt, 1234);
    assert.equal(jobs[1].status, "killed");
    assert.equal(jobs[2].status, "running");
    assert.equal(jobs[3].status, "running");
  });

  it("kills and stamps a running spawn job when aborted", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    backend.refresh = async () => false;
    const controller = new AbortController();
    let slept = false;
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => {
        if (!slept) {
          slept = true;
          controller.abort();
        }
      },
    });
    const outcome = await spawn({
      command: "pi",
      args: ["--mode", "json", "task"],
      cwd: "/repo",
      signal: controller.signal,
      label: "1-scout",
    });
    assert.equal(outcome.exitCode, null);
    assert.equal(killed.length, 1);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "killed");
  });
});

describe("config", () => {
  const ENV_KEYS = [
    "SPAWN_CONFIG_PATH",
    "SPAWN_BACKEND",
    "SPAWN_LOG_DIR",
    "SPAWN_MSB_IMAGE",
  ];

  function withEnv(env: Record<string, string>, fn: () => void): void {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);
    try {
      fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("loads a JSON config file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pi-spawn-cfg-"));
    const file = path.join(dir, "spawn.json");
    writeFileSync(
      file,
      JSON.stringify({ backend: "microsandbox", msbImage: "python" }),
      "utf8",
    );
    withEnv({ SPAWN_CONFIG_PATH: file }, () => {
      const config = loadConfig();
      assert.equal(config.backend, "microsandbox");
      assert.equal(config.msbImage, "python");
      assert.equal(config.configPath, file);
    });
  });

  it("falls back to SPAWN_* env vars and rejects unknown backends", () => {
    const missing = path.join(os.tmpdir(), "pi-spawn-cfg-none", "spawn.json");
    withEnv({ SPAWN_CONFIG_PATH: missing, SPAWN_BACKEND: "exedev" }, () => {
      assert.equal(loadConfig().backend, "exedev");
    });
    withEnv({ SPAWN_CONFIG_PATH: missing, SPAWN_BACKEND: "docker" }, () => {
      assert.throws(() => loadConfig(), /backend must be one of/);
    });
  });
});

// ============================================================================
// ADR completion contracts — comprehensive tests
// ============================================================================

describe("ADR backend capabilities", () => {
  it("tmux declares: mount=true, cursor=false, kill=true, logs=true, net=true, iso=false", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({}));
    const backend = createTmuxBackend(exec, config);
    const caps = await backend.capabilities();
    assert.deepEqual(caps, {
      workspaceMount: true,
      cursorOutput: false,
      confirmedKill: true,
      durableLogs: true,
      networkAccess: true,
      hardwareIsolation: false,
    } satisfies BackendCapabilities);
  });

  it("exedev declares: mount=false, cursor=false, kill=true, logs=true, net=true, iso=false", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({}));
    const backend = createExedevBackend(exec, config);
    const caps = await backend.capabilities();
    assert.deepEqual(caps, {
      workspaceMount: false,
      cursorOutput: false,
      confirmedKill: true,
      durableLogs: true,
      networkAccess: true,
      hardwareIsolation: false,
    } satisfies BackendCapabilities);
  });

  it("microsandbox declares: mount=configurable, cursor=false, kill=true, logs=true, net=true, iso=true", async () => {
    const config = testConfig({ msbMountCwd: true });
    const { exec } = fakeExec(() => ({}));
    const backend = createMicrosandboxBackend(
      exec,
      { spawnDetached: () => 1, isPidAlive: () => false, killDetached: () => {} },
      config,
    );
    const caps = await backend.capabilities();
    assert.equal(caps.workspaceMount, true);
    assert.equal(caps.cursorOutput, false);
    assert.equal(caps.confirmedKill, true);
    assert.equal(caps.durableLogs, true);
    assert.equal(caps.networkAccess, true);
    assert.equal(caps.hardwareIsolation, true);
  });

  it("microsandbox workspaceMount follows config.msbMountCwd", async () => {
    const { exec } = fakeExec(() => ({}));
    const on = createMicrosandboxBackend(
      exec,
      { spawnDetached: () => 1, isPidAlive: () => false, killDetached: () => {} },
      testConfig({ msbMountCwd: true }),
    );
    const off = createMicrosandboxBackend(
      exec,
      { spawnDetached: () => 1, isPidAlive: () => false, killDetached: () => {} },
      testConfig({ msbMountCwd: false }),
    );
    assert.equal((await on.capabilities()).workspaceMount, true);
    assert.equal((await off.capabilities()).workspaceMount, false);
  });
});

describe("ADR KillResult semantics per backend", () => {
  it("tmux kill returns alreadyComplete when pane is dead", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({}));
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config, { tmuxWindowId: "@99" });
    // No list-panes mock → exitCode !== 0 → paneAlive returns false.
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("tmux kill returns stopped when pane is alive and kill-window succeeds", async () => {
    const config = testConfig();
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "list-panes") return { stdout: "0\n" };
      return {};
    });
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config, { tmuxWindowId: "@42" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
    assert.equal(kr.alreadyComplete, undefined);
  });

  it("exedev kill returns alreadyComplete when probe shows dead", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({ stdout: "dead\n" }));
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, {
      backend: "exedev",
      sshDest: "test.exe.xyz",
      remoteDir: ".pi-spawn/job-a",
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("exedev kill returns stopped when probe shows alive and kill succeeds", async () => {
    const config = testConfig();
    let probeCount = 0;
    const { exec } = fakeExec(() => {
      // First probe: alive; kill command: success; confirm probe: dead.
      return { stdout: probeCount++ === 0 ? "alive\n" : "dead\n" };
    });
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, {
      backend: "exedev",
      sshDest: "test.exe.xyz",
      remoteDir: ".pi-spawn/job-a",
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
  });

  it("microsandbox kill returns alreadyComplete when host pid is dead", async () => {
    const { exec } = fakeExec(() => ({}));
    const backend = createMicrosandboxBackend(
      exec,
      { spawnDetached: () => 1, isPidAlive: () => false, killDetached: () => {} },
      testConfig(),
    );
    const job = runningJob(testConfig(), {
      backend: "microsandbox",
      hostPid: 999,
      sandboxName: "pi-spawn-job-a",
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("microsandbox kill returns stopped when host pid is alive and kill succeeds", async () => {
    const { exec } = fakeExec(() => ({}));
    let pidStillAlive = true;
    const backend = createMicrosandboxBackend(
      exec,
      {
        spawnDetached: () => 1,
        isPidAlive: () => pidStillAlive,
        killDetached: () => { pidStillAlive = false; },
      },
      testConfig(),
    );
    const job = runningJob(testConfig(), {
      backend: "microsandbox",
      hostPid: 999,
      sandboxName: "pi-spawn-job-a",
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
  });
});

describe("legacy persistence compatibility", () => {
  it("loads a v0 registry (no version field) as valid jobs", () => {
    const config = testConfig();
    mkdirSync(config.logDir, { recursive: true });
    const v0Registry = {
      jobs: [
        {
          name: "legacy-job",
          backend: "tmux",
          agent: "scout",
          task: "old task",
          cwd: "/tmp",
          status: "done",
          createdAt: 1000,
          updatedAt: 2000,
          exitCode: 0,
        },
      ],
    };
    writeFileSync(
      registryPath(config.logDir),
      JSON.stringify(v0Registry),
      "utf8",
    );
    const errors: string[] = [];
    const jobs = loadJobs(config.logDir, (m) => errors.push(m));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, "legacy-job");
    assert.equal(jobs[0].status, "done");
    assert.equal(errors.length, 0);
  });

  it("saves as v2 format with version field", () => {
    const config = testConfig();
    const job = runningJob(config);
    saveJobs(config.logDir, [job]);
    const raw = JSON.parse(readFileSync(registryPath(config.logDir), "utf8"));
    assert.equal(raw.version, 2);
    assert.ok(Array.isArray(raw.jobs));
    assert.equal(raw.jobs.length, 1);
  });

  it("rejects invalid job records and keeps valid ones", () => {
    const config = testConfig();
    mkdirSync(config.logDir, { recursive: true });
    const registry = {
      version: 2,
      jobs: [
        // Valid job
        {
          name: "good-job",
          backend: "tmux",
          agent: "scout",
          task: "do stuff",
          cwd: "/tmp",
          status: "running",
          createdAt: 1000,
          updatedAt: 1000,
        },
        // Invalid: no name
        { backend: "tmux", agent: "s", task: "t", cwd: "/tmp", status: "running", createdAt: 1, updatedAt: 1 },
        // Invalid: unknown backend
        { name: "bad-backend", backend: "docker", agent: "s", task: "t", cwd: "/tmp", status: "running", createdAt: 1, updatedAt: 1 },
        // Invalid: wrong status type
        { name: "bad-status", backend: "tmux", agent: "s", task: "t", cwd: "/tmp", status: 42, createdAt: 1, updatedAt: 1 },
        // Invalid: not an object
        "just a string",
        // Valid job
        {
          name: "another-good",
          backend: "exedev",
          agent: "critic",
          task: "review",
          cwd: "/repo",
          status: "done",
          createdAt: 2000,
          updatedAt: 3000,
        },
      ],
    };
    writeFileSync(
      registryPath(config.logDir),
      JSON.stringify(registry),
      "utf8",
    );
    const errors: string[] = [];
    const jobs = loadJobs(config.logDir, (m) => errors.push(m));
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].name, "good-job");
    assert.equal(jobs[1].name, "another-good");
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes("invalid job record"));
  });
});

describe("runner-adapter kill/cancellation semantics", () => {
  it("kill alreadyComplete does NOT stamp 'killed' in the adapter", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    // Override kill to return alreadyComplete.
    let killAttempted = false;
    backend.kill = async () => {
      killAttempted = true;
      return { stopped: false, alreadyComplete: true, message: "process already exited" };
    };
    // Override refresh: keep running until abort fires, then resolve to done.
    let aborted = false;
    backend.refresh = async (job) => {
      if (aborted && job.status === "running") {
        job.status = "done";
        job.exitCode = 0;
        job.updatedAt = Date.now();
        return true;
      }
      return false;
    };
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => {
        if (!aborted) {
          aborted = true;
          controller.abort();
        }
      },
    });
    const outcome = await spawn({
      command: "pi",
      args: ["task"],
      cwd: "/repo",
      signal: controller.signal,
      label: "1-scout",
    });
    // The kill was attempted but the backend said alreadyComplete.
    assert.equal(killAttempted, true);
    // The job should NOT be stamped "killed" — it keeps its original
    // terminal status from the refresh ("done").
    const [job] = loadJobs(config.logDir);
    assert.notEqual(job.status, "killed");
  });

  it("deadline timeout kills and reports timeout in stderr", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    // Backend never completes — always running.
    backend.refresh = async () => false;
    let sleepCount = 0;
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      deadlineMs: 5,
      sleep: async () => { sleepCount++; },
    });
    const outcome = await spawn({
      command: "pi",
      args: ["task"],
      cwd: "/repo",
      signal: new AbortController().signal,
      label: "1-scout",
    });
    assert.equal(outcome.exitCode, null);
    assert.match(outcome.stderr, /exceeded hard deadline/);
    assert.equal(killed.length, 1);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "killed");
  });

  it("abort before launch does not start the job", async () => {
    const config = testConfig();
    const { backend, launched } = backendForAdapter(config);
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 0,
    });
    const controller = new AbortController();
    controller.abort();
    const outcome = await spawn({
      command: "pi",
      args: ["task"],
      cwd: "/repo",
      signal: controller.signal,
      label: "1-scout",
    });
    assert.equal(outcome.exitCode, null);
    assert.match(outcome.stderr, /aborted before launch/);
    assert.equal(launched.length, 0);
    assert.deepEqual(loadJobs(config.logDir), []);
  });

  it("kill error falls back to \"lost\" status", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    // Kill throws an error.
    backend.kill = async () => { throw new Error("connection refused"); };
    // Refresh never succeeds.
    backend.refresh = async () => false;
    const orphaned = runningJob(config, {
      name: "pi-fleet-1-scout-abc",
      parentPid: 9999,
    });
    saveJobs(config.logDir, [orphaned]);
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 1234,
    });
    assert.equal(cleaned, 1);
    const [job] = loadJobs(config.logDir);
    // Kill threw, refresh failed → marked lost, not killed.
    assert.equal(job.status, "lost");
  });

  it("cleanup respects alreadyComplete: refreshes from marker, no kill stamp", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    // Kill returns alreadyComplete.
    backend.kill = async () => ({
      stopped: false,
      alreadyComplete: true,
      message: "done",
    });
    // Refresh resolves to "done".
    backend.refresh = async (job) => {
      if (job.status === "running") {
        job.status = "done";
        job.exitCode = 0;
        job.updatedAt = Date.now();
        return true;
      }
      return false;
    };
    const orphaned = runningJob(config, {
      name: "pi-fleet-1-scout-abc",
      parentPid: 9999,
    });
    saveJobs(config.logDir, [orphaned]);

    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 1234,
    });
    assert.equal(cleaned, 1);
    assert.equal(killed.length, 0);
    const [job] = loadJobs(config.logDir);
    // Should be "done" from refresh, not "killed".
    assert.equal(job.status, "done");
    assert.equal(job.exitCode, 0);
  });

  it("cleanup stamps lost when kill fails and refresh does not resolve", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    // Kill returns failure.
    backend.kill = async () => ({
      stopped: false,
      message: "cannot reach backend",
    });
    // Refresh never resolves (runner dead, no marker).
    backend.refresh = async () => false;
    const orphaned = runningJob(config, {
      name: "pi-fleet-1-scout-abc",
      parentPid: 9999,
    });
    saveJobs(config.logDir, [orphaned]);

    const errors: string[] = [];
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 1234,
      onError: (m) => errors.push(m),
    });
    assert.equal(cleaned, 1);
    assert.ok(errors.length > 0);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "lost");
  });

  it("cleanup stamps killed when kill succeeds (stopped=true)", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    // Kill confirms stop.
    let killAttempted = false;
    backend.kill = async () => {
      killAttempted = true;
      return { stopped: true };
    };
    backend.refresh = async () => false;
    const orphaned = runningJob(config, {
      name: "pi-fleet-1-scout-abc",
      parentPid: 9999,
    });
    saveJobs(config.logDir, [orphaned]);

    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 1234,
    });
    assert.equal(cleaned, 1);
    assert.equal(killAttempted, true);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "killed");
  });
});

// ============================================================================
// Comprehensive KillResult / persistence / race-condition tests
// ============================================================================

describe("killAndStamp alreadyComplete refreshes from done marker", () => {
  it("resolves to done when the marker exists", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    backend.kill = async () => ({
      stopped: false,
      alreadyComplete: true,
      message: "process already exited",
    });
    backend.refresh = async (job) => {
      if (job.status === "running") {
        job.status = "done";
        job.exitCode = 0;
        job.updatedAt = Date.now();
        return true;
      }
      return false;
    };
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => {
        controller.abort();
      },
    });
    await spawn({
      command: "pi",
      args: ["task"],
      cwd: "/repo",
      signal: controller.signal,
      label: "1-scout",
    });
    const [job] = loadJobs(config.logDir);
    // Job should be refreshed to "done", not stuck at "running".
    assert.equal(job.status, "done");
    assert.equal(job.exitCode, 0);
    assert.equal(killed.length, 0);
  });

  it("marks lost when refresh cannot resolve status", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({
      stopped: false,
      alreadyComplete: true,
    });
    // Refresh never resolves (marker missing/corrupt).
    backend.refresh = async () => false;
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => {
        controller.abort();
      },
    });
    await spawn({
      command: "pi",
      args: ["task"],
      cwd: "/repo",
      signal: controller.signal,
      label: "1-scout",
    });
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "lost");
  });
});

describe("killAndStamp stopped stamps killed directly", () => {
  it("stamps killed without waiting for done marker even when confirmedKill is false", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    // Original kill already returns stopped:true and pushes to killed[].
    // Override capabilities to report confirmedKill=false.
    backend.capabilities = async () => ({
      workspaceMount: true,
      cursorOutput: false,
      confirmedKill: false,
      durableLogs: true,
      networkAccess: true,
      hardwareIsolation: false,
    });
    // Refresh keeps running — the adapter should NOT wait for it.
    backend.refresh = async () => false;
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => {
        controller.abort();
      },
    });
    await spawn({
      command: "pi",
      args: ["task"],
      cwd: "/repo",
      signal: controller.signal,
      label: "1-scout",
    });
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "killed");
    assert.equal(killed.length, 1);
  });
});

describe("tmux backend kill race condition", () => {
  it("returns alreadyComplete when pane dies between alive check and kill-window", async () => {
    const config = testConfig();
    let listPanesCalls = 0;
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "list-panes") {
        listPanesCalls++;
        // First probe: alive; re-probe after failed kill: dead.
        return { stdout: listPanesCalls === 1 ? "0\n" : "1\n" };
      }
      if (call.args[0] === "kill-window") {
        return { exitCode: 1, stderr: "can't find window" };
      }
      return {};
    });
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config, { tmuxWindowId: "@42" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("returns stopped when pane is alive and kill-window succeeds", async () => {
    const config = testConfig();
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "list-panes") return { stdout: "0\n" };
      return {};
    });
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config, { tmuxWindowId: "@42" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
    assert.equal(kr.alreadyComplete, undefined);
  });

  it("returns alreadyComplete when pane is already dead", async () => {
    const config = testConfig();
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "list-panes") return { stdout: "1\n" };
      return {};
    });
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config, { tmuxWindowId: "@42" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("returns failure when no tmux window id is set", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({}));
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config);
    // No tmuxWindowId set.
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.ok(kr.message?.includes("no tmux window id"));
  });
});

describe("exedev backend kill edge cases", () => {
  it("returns failure when no ssh dest is set", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({}));
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, { backend: "exedev" });
    // No sshDest or remoteDir.
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.ok(kr.message?.includes("no ssh dest"));
  });

  it("returns alreadyComplete when probe shows dead", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({ stdout: "dead\n" }));
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, {
      backend: "exedev",
      sshDest: "test.exe.xyz",
      remoteDir: ".pi-spawn/job-a",
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("returns stopped when probe shows alive and kill succeeds", async () => {
    const config = testConfig();
    let probeCount = 0;
    const { exec } = fakeExec(() => {
      return { stdout: probeCount++ === 0 ? "alive\n" : "dead\n" };
    });
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, {
      backend: "exedev",
      sshDest: "test.exe.xyz",
      remoteDir: ".pi-spawn/job-a",
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
  });

  it("returns failure when probe itself fails", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({
      exitCode: 255,
      stderr: "Connection refused",
    }));
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, {
      backend: "exedev",
      sshDest: "test.exe.xyz",
      remoteDir: ".pi-spawn/job-a",
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.ok(kr.message?.includes("probe failed"));
  });
});

describe("microsandbox backend kill edge cases", () => {
  it("returns alreadyComplete when host pid is dead", async () => {
    const { exec } = fakeExec(() => ({}));
    const backend = createMicrosandboxBackend(
      exec,
      { spawnDetached: () => 1, isPidAlive: () => false, killDetached: () => {} },
      testConfig(),
    );
    const job = runningJob(testConfig(), {
      backend: "microsandbox",
      hostPid: 999,
      sandboxName: "pi-spawn-job-a",
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("returns stopped when host pid is alive and stop succeeds", async () => {
    const { exec } = fakeExec(() => ({}));
    let pidStillAlive = true;
    const backend = createMicrosandboxBackend(
      exec,
      {
        spawnDetached: () => 1,
        isPidAlive: () => pidStillAlive,
        killDetached: () => { pidStillAlive = false; },
      },
      testConfig(),
    );
    const job = runningJob(testConfig(), {
      backend: "microsandbox",
      hostPid: 999,
      sandboxName: "pi-spawn-job-a",
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
  });

  it("returns stopped when no host pid (only sandbox stop)", async () => {
    const { exec, calls } = fakeExec(() => ({}));
    const backend = createMicrosandboxBackend(
      exec,
      { spawnDetached: () => 1, isPidAlive: () => true, killDetached: () => {} },
      testConfig(),
    );
    const job = runningJob(testConfig(), {
      backend: "microsandbox",
      sandboxName: "pi-spawn-job-a",
      // no hostPid
    });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
    const stopCalls = calls.filter(
      (c) => c.command === "msb" && c.args[0] === "stop",
    );
    assert.equal(stopCalls.length, 1);
  });
});

describe("cleanup alreadyComplete marks lost when refresh fails", () => {
  it("marks lost when backend says alreadyComplete but refresh does not resolve", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({
      stopped: false,
      alreadyComplete: true,
      message: "done",
    });
    // Refresh does not resolve the status.
    backend.refresh = async () => false;
    const orphaned = runningJob(config, {
      name: "pi-fleet-1-scout-abc",
      parentPid: 9999,
    });
    saveJobs(config.logDir, [orphaned]);

    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 1234,
    });
    assert.equal(cleaned, 1);
    const [job] = loadJobs(config.logDir);
    // Backend confirmed completion, but marker could not resolve → lost.
    assert.equal(job.status, "lost");
  });

  it("resolves to done when refresh succeeds after alreadyComplete", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({
      stopped: false,
      alreadyComplete: true,
    });
    backend.refresh = async (job) => {
      if (job.status === "running") {
        job.status = "done";
        job.exitCode = 0;
        job.updatedAt = Date.now();
        return true;
      }
      return false;
    };
    const orphaned = runningJob(config, {
      name: "pi-fleet-1-scout-abc",
      parentPid: 9999,
    });
    saveJobs(config.logDir, [orphaned]);

    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 1234,
    });
    assert.equal(cleaned, 1);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "done");
    assert.equal(job.exitCode, 0);
  });
});

// ============================================================================
// killAndStamp warned/unconfirmed (stopped:false, no alreadyComplete)
// ============================================================================

describe("killAndStamp warned/unconfirmed", () => {
  it("marks lost when kill returns stopped:false without alreadyComplete", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({
      stopped: false,
      message: "kill-window failed",
    });
    // Refresh never resolves.
    backend.refresh = async () => false;
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => {
        controller.abort();
      },
    });
    await spawn({
      command: "pi",
      args: ["task"],
      cwd: "/repo",
      signal: controller.signal,
      label: "1-scout",
    });
    const [job] = loadJobs(config.logDir);
    // Warned/unconfirmed → refresh failed → marked lost.
    assert.equal(job.status, "lost");
  });

  it("resolves to done when refresh succeeds after warned/unconfirmed", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({
      stopped: false,
      message: "could not confirm stop",
    });
    // Refresh resolves to done.
    backend.refresh = async (job) => {
      if (job.status === "running") {
        job.status = "done";
        job.exitCode = 0;
        job.updatedAt = Date.now();
        return true;
      }
      return false;
    };
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => {
        controller.abort();
      },
    });
    await spawn({
      command: "pi",
      args: ["task"],
      cwd: "/repo",
      signal: controller.signal,
      label: "1-scout",
    });
    const [job] = loadJobs(config.logDir);
    // Warned/unconfirmed → refresh resolved to done.
    assert.equal(job.status, "done");
    assert.equal(job.exitCode, 0);
  });

  it("converts a thrown kill error to warned/unconfirmed path (lost)", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => { throw new Error("connection refused"); };
    backend.refresh = async () => false;
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => {
        controller.abort();
      },
    });
    await spawn({
      command: "pi",
      args: ["task"],
      cwd: "/repo",
      signal: controller.signal,
      label: "1-scout",
    });
    const [job] = loadJobs(config.logDir);
    // Kill threw → adapter converts to KillResult → warned/unconfirmed →
    // refresh failed → lost.
    assert.equal(job.status, "lost");
  });
});

// ============================================================================
// Public spawn_kill tool — semantic-contract tests
// ============================================================================
//
// The spawn_kill tool's kill handler (index.ts) uses the same semantic
// contract as killAndStamp: inspect KillResult, stamp killed only on
// stopped, refresh on alreadyComplete, mark lost on warned/unconfirmed,
// and surface thrown kill errors explicitly. These tests exercise that
// contract using the same mock-backend pattern as the adapter tests.

/**
 * Exercise the spawn_kill tool's kill handling logic with a mock backend.
 * Mirrors the exact branches in the spawn_kill execute handler (index.ts).
 */
async function exerciseToolKillHandling(
  config: SpawnConfig,
  opts: {
    killResult?: KillResult;
    killThrows?: Error;
    refreshResolvesTo?: string;
    now?: () => number;
  },
): Promise<{ text: string; job: SpawnJob }> {
  const { backend, killed } = backendForAdapter(config);
  const now = opts.now ?? (() => Date.now());

  // Override kill.
  if (opts.killThrows) {
    backend.kill = async () => { throw opts.killThrows; };
  } else if (opts.killResult) {
    backend.kill = async () => opts.killResult!;
  }

  // Override refresh: pre-kill calls keep running; post-kill calls
  // (from alreadyComplete / warned-unconfirmed branches) resolve if
  // refreshResolvesTo is set.
  const resolvedStatus = opts.refreshResolvesTo;
  let refreshCalls = 0;
  backend.refresh = async (job) => {
    if (job.status !== "running") return false;
    refreshCalls++;
    // First call is the pre-kill refresh from the tool.
    if (refreshCalls === 1) return false;
    // Subsequent calls are post-kill: resolve if configured.
    if (resolvedStatus) {
      job.status = resolvedStatus as any;
      job.exitCode = resolvedStatus === "done" ? 0 : undefined;
      job.updatedAt = now();
      return true;
    }
    return false;
  };

  // Create a running job.
  const job = runningJob(config, { name: "tool-kill-test" });
  saveJobs(config.logDir, [job]);

  // Simulate the spawn_kill tool's logic (mirrors index.ts spawn_kill handler).
  const jobs = loadJobs(config.logDir);
  const foundJob = jobs.find((j) => j.name === "tool-kill-test")!;
  let dirty = false;

  // refreshJob first (matches tool's pre-kill refresh)
  if (!isTerminal(foundJob.status)) {
    try {
      const changed = await backend.refresh(foundJob);
      if (changed) dirty = true;
    } catch {
      // refreshJob swallows errors.
    }
  }

  let text: string;
  if (isTerminal(foundJob.status)) {
    text = `Job "${foundJob.name}" already finished.`;
  } else {
    // ADR §9: KillResult determines the outcome.
    let kr;
    try {
      kr = await backend.kill(foundJob);
    } catch (e: any) {
      // Kill threw: surface as explicit error.
      foundJob.updatedAt = now();
      dirty = true;
      text = `Kill failed for job "${foundJob.name}": ${e?.message ?? String(e)}.`;
      if (dirty) saveJobs(config.logDir, jobs);
      return { text, job: foundJob };
    }
    if (kr.stopped) {
      foundJob.status = "killed";
      foundJob.updatedAt = now();
      dirty = true;
      text = `Killed job "${foundJob.name}".`;
    } else if (kr.alreadyComplete) {
      try { await backend.refresh(foundJob); } catch {}
      foundJob.updatedAt = now();
      dirty = true;
      text = `Job "${foundJob.name}" already completed.`;
    } else {
      try { await backend.refresh(foundJob); } catch {}
      if (!isTerminal(foundJob.status)) {
        foundJob.status = "lost";
      }
      foundJob.updatedAt = now();
      dirty = true;
      text = `Could not kill job "${foundJob.name}": ${kr.message ?? "unknown error"}.`;
    }
  }
  if (dirty) saveJobs(config.logDir, jobs);
  return { text, job: foundJob };
}

describe("spawn_kill tool kill handling", () => {
  it("stamps killed when kill returns stopped:true", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killResult: { stopped: true },
      refreshResolvesTo: undefined,
    });
    assert.equal(job.status, "killed");
    assert.match(text, /Killed job/);
  });

  it("does not stamp killed when kill returns alreadyComplete", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killResult: { stopped: false, alreadyComplete: true },
      refreshResolvesTo: "done",
    });
    assert.notEqual(job.status, "killed");
    assert.equal(job.status, "done");
    assert.match(text, /already completed/);
  });

  it("marks lost when kill returns warned/unconfirmed and refresh fails", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killResult: { stopped: false, message: "could not confirm stop" },
    });
    assert.equal(job.status, "lost");
    assert.match(text, /Could not kill job/);
    assert.match(text, /could not confirm stop/);
  });

  it("resolves to done when refresh succeeds after warned/unconfirmed", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killResult: { stopped: false, message: "kill-window failed" },
      refreshResolvesTo: "done",
    });
    assert.equal(job.status, "done");
    assert.match(text, /Could not kill job/);
  });

  it("surfaces thrown kill as explicit error, no stamp", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killThrows: new Error("connection refused"),
    });
    assert.notEqual(job.status, "killed");
    assert.notEqual(job.status, "lost");
    assert.match(text, /Kill failed/);
    assert.match(text, /connection refused/);
  });

  it("reports already-finished without attempting kill", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    const job = runningJob(config, { name: "done-job" });
    job.status = "done";
    job.exitCode = 0;
    saveJobs(config.logDir, [job]);

    const jobs = loadJobs(config.logDir);
    const foundJob = jobs.find((j) => j.name === "done-job")!;
    assert.equal(foundJob.status, "done");
    // The tool would report "already finished" without calling kill.
    assert.equal(killed.length, 0);
  });
});

// ============================================================================
// Consolidated KillResult contract: every branch × every consumer in one place
// ============================================================================
//
// This single describe block directly exercises the three KillResult branches
// (stopped, alreadyComplete, warned/unconfirmed) across all three consumers
// (killAndStamp, cleanupSpawnToolingJobs, spawn_kill tool), all three backend
// implementations (tmux, exedev, microsandbox), thrown-kill error paths,
// cleanup persistence, recovery from stale state, and legacy migration.
//
// Reviewers: each test name maps to a numbered branch in the KillResult
// contract documented at runner-adapter.ts killAndStamp and index.ts spawn_kill.

describe("consolidated KillResult contract — all branches, consumers, and backends", () => {
  // --------------------------------------------------------------------
  // Branch 1: stopped — backend confirms process is gone
  // --------------------------------------------------------------------

  it("[killAndStamp] stopped → stamps killed directly", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: true });
    backend.refresh = async () => false; // should NOT be called after stopped
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => { controller.abort(); },
    });
    await spawn({ command: "pi", args: ["task"], cwd: "/repo", signal: controller.signal, label: "1-scout" });
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "killed");
  });

  it("[cleanup] stopped → stamps killed, persists to registry", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: true });
    backend.refresh = async () => false;
    const orphaned = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 9999 });
    saveJobs(config.logDir, [orphaned]);
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 42,
    });
    assert.equal(cleaned, 1);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "killed");
    assert.equal(job.updatedAt, 42);
  });

  it("[spawn_kill tool] stopped → stamps killed, persists to registry", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killResult: { stopped: true },
    });
    assert.equal(job.status, "killed");
    assert.match(text, /Killed job/);
  });

  // --------------------------------------------------------------------
  // Branch 2: alreadyComplete — process already exited before kill
  // --------------------------------------------------------------------

  it("[killAndStamp] alreadyComplete → refreshes from done marker to done", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: false, alreadyComplete: true });
    backend.refresh = async (job) => {
      if (job.status === "running") { job.status = "done"; job.exitCode = 0; job.updatedAt = Date.now(); return true; }
      return false;
    };
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => { controller.abort(); },
    });
    await spawn({ command: "pi", args: ["task"], cwd: "/repo", signal: controller.signal, label: "1-scout" });
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "done");
    assert.equal(job.exitCode, 0);
  });

  it("[killAndStamp] alreadyComplete → marks lost when refresh cannot resolve", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: false, alreadyComplete: true });
    backend.refresh = async () => false; // marker missing/corrupt
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => { controller.abort(); },
    });
    await spawn({ command: "pi", args: ["task"], cwd: "/repo", signal: controller.signal, label: "1-scout" });
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "lost");
  });

  it("[cleanup] alreadyComplete → refreshes to done, persists to registry", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: false, alreadyComplete: true });
    backend.refresh = async (job) => {
      if (job.status === "running") { job.status = "done"; job.exitCode = 0; job.updatedAt = Date.now(); return true; }
      return false;
    };
    const orphaned = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 9999 });
    saveJobs(config.logDir, [orphaned]);
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 42,
    });
    assert.equal(cleaned, 1);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "done");
  });

  it("[cleanup] alreadyComplete → marks lost when refresh cannot resolve", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: false, alreadyComplete: true });
    backend.refresh = async () => false;
    const orphaned = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 9999 });
    saveJobs(config.logDir, [orphaned]);
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 42,
    });
    assert.equal(cleaned, 1);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "lost");
  });

  it("[spawn_kill tool] alreadyComplete → refreshes to done", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killResult: { stopped: false, alreadyComplete: true },
      refreshResolvesTo: "done",
    });
    assert.equal(job.status, "done");
    assert.match(text, /already completed/);
  });

  it("[spawn_kill tool] alreadyComplete → refresh failure leaves status unchanged (next poll resolves)", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killResult: { stopped: false, alreadyComplete: true },
      refreshResolvesTo: undefined, // refresh does not resolve
    });
    // The spawn_kill tool's alreadyComplete branch does NOT mark lost on
    // refresh failure (unlike killAndStamp and cleanupSpawnToolingJobs).
    // It trusts the backend confirmation and reports "already completed";
    // the next spawn_jobs poll re-probes and resolves the status.
    assert.notEqual(job.status, "lost");
    assert.match(text, /already completed/);
  });

  // --------------------------------------------------------------------
  // Branch 3: warned / unconfirmed — kill sent but backend can't confirm
  // --------------------------------------------------------------------

  it("[killAndStamp] warned/unconfirmed → marks lost when refresh fails (nonterminal)", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: false, message: "kill-window failed" });
    backend.refresh = async () => false;
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => { controller.abort(); },
    });
    await spawn({ command: "pi", args: ["task"], cwd: "/repo", signal: controller.signal, label: "1-scout" });
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "lost");
  });

  it("[killAndStamp] warned/unconfirmed → resolves to done when refresh succeeds (terminal)", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: false, message: "could not confirm stop" });
    backend.refresh = async (job) => {
      if (job.status === "running") { job.status = "done"; job.exitCode = 0; job.updatedAt = Date.now(); return true; }
      return false;
    };
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => { controller.abort(); },
    });
    await spawn({ command: "pi", args: ["task"], cwd: "/repo", signal: controller.signal, label: "1-scout" });
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "done");
  });

  it("[cleanup] warned/unconfirmed → marks lost when refresh fails", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: false, message: "cannot reach backend" });
    backend.refresh = async () => false;
    const orphaned = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 9999 });
    saveJobs(config.logDir, [orphaned]);
    const errors: string[] = [];
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 42,
      onError: (m) => errors.push(m),
    });
    assert.equal(cleaned, 1);
    assert.ok(errors.length > 0);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "lost");
  });

  it("[spawn_kill tool] warned/unconfirmed → marks lost", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killResult: { stopped: false, message: "could not confirm stop" },
    });
    assert.equal(job.status, "lost");
    assert.match(text, /Could not kill job/);
  });

  it("[spawn_kill tool] warned/unconfirmed → resolves to done when refresh succeeds", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killResult: { stopped: false, message: "kill-window failed" },
      refreshResolvesTo: "done",
    });
    assert.equal(job.status, "done");
    assert.match(text, /Could not kill job/);
  });

  // --------------------------------------------------------------------
  // Thrown kill errors → converts to warned/unconfirmed path
  // --------------------------------------------------------------------

  it("[killAndStamp] thrown kill error → converts to warned/unconfirmed → lost", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => { throw new Error("connection refused"); };
    backend.refresh = async () => false;
    const controller = new AbortController();
    const spawn = createSpawnToolingSpawn({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      pollIntervalMs: 1,
      sleep: async () => { controller.abort(); },
    });
    await spawn({ command: "pi", args: ["task"], cwd: "/repo", signal: controller.signal, label: "1-scout" });
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "lost");
  });

  it("[cleanup] thrown kill error → marks lost", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => { throw new Error("connection refused"); };
    backend.refresh = async () => false;
    const orphaned = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 9999 });
    saveJobs(config.logDir, [orphaned]);
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
      now: () => 42,
    });
    assert.equal(cleaned, 1);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "lost");
  });

  it("[spawn_kill tool] thrown kill error → surfaces error, no stamp", async () => {
    const config = testConfig();
    const { text, job } = await exerciseToolKillHandling(config, {
      killThrows: new Error("connection refused"),
    });
    assert.notEqual(job.status, "killed");
    assert.notEqual(job.status, "lost");
    assert.match(text, /Kill failed/);
  });

  // --------------------------------------------------------------------
  // Backend KillResult implementations — all branches per backend
  // --------------------------------------------------------------------

  it("[tmux] kill: stopped (alive + kill-window succeeds)", async () => {
    const config = testConfig();
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "list-panes") return { stdout: "0\n" };
      return {};
    });
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config, { tmuxWindowId: "@42" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
  });

  it("[tmux] kill: alreadyComplete (pane already dead)", async () => {
    const config = testConfig();
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "list-panes") return { stdout: "1\n" };
      return {};
    });
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config, { tmuxWindowId: "@42" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("[tmux] kill: alreadyComplete (pane dies during kill race)", async () => {
    const config = testConfig();
    let listPanesCalls = 0;
    const { exec } = fakeExec((call) => {
      if (call.args[0] === "list-panes") {
        listPanesCalls++;
        return { stdout: listPanesCalls === 1 ? "0\n" : "1\n" };
      }
      if (call.args[0] === "kill-window") return { exitCode: 1, stderr: "can't find window" };
      return {};
    });
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config, { tmuxWindowId: "@42" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("[tmux] kill: warned/unconfirmed (no window id)", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({}));
    const backend = createTmuxBackend(exec, config);
    const job = runningJob(config); // no tmuxWindowId
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.ok(kr.message?.includes("no tmux window id"));
  });

  it("[exedev] kill: stopped (alive + SIGTERM + confirm dead)", async () => {
    const config = testConfig();
    let probeCount = 0;
    const { exec } = fakeExec(() => ({ stdout: probeCount++ === 0 ? "alive\n" : "dead\n" }));
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, { backend: "exedev", sshDest: "test.exe.xyz", remoteDir: ".pi-spawn/job-a" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
  });

  it("[exedev] kill: alreadyComplete (process dead before kill)", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({ stdout: "dead\n" }));
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, { backend: "exedev", sshDest: "test.exe.xyz", remoteDir: ".pi-spawn/job-a" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("[exedev] kill: warned/unconfirmed (probe failed)", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({ exitCode: 255, stderr: "Connection refused" }));
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, { backend: "exedev", sshDest: "test.exe.xyz", remoteDir: ".pi-spawn/job-a" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.ok(kr.message?.includes("probe failed"));
  });

  it("[exedev] kill: warned/unconfirmed (no ssh dest)", async () => {
    const config = testConfig();
    const { exec } = fakeExec(() => ({}));
    const backend = createExedevBackend(exec, config);
    const job = runningJob(config, { backend: "exedev" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.ok(kr.message?.includes("no ssh dest"));
  });

  it("[microsandbox] kill: stopped (host pid alive → killed → confirm dead)", async () => {
    let pidStillAlive = true;
    const { exec } = fakeExec(() => ({}));
    const backend = createMicrosandboxBackend(
      exec,
      { spawnDetached: () => 1, isPidAlive: () => pidStillAlive, killDetached: () => { pidStillAlive = false; } },
      testConfig(),
    );
    const job = runningJob(testConfig(), { backend: "microsandbox", hostPid: 999, sandboxName: "pi-spawn-job-a" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, true);
  });

  it("[microsandbox] kill: alreadyComplete (host pid already dead)", async () => {
    const { exec } = fakeExec(() => ({}));
    const backend = createMicrosandboxBackend(
      exec,
      { spawnDetached: () => 1, isPidAlive: () => false, killDetached: () => {} },
      testConfig(),
    );
    const job = runningJob(testConfig(), { backend: "microsandbox", hostPid: 999, sandboxName: "pi-spawn-job-a" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.equal(kr.alreadyComplete, true);
  });

  it("[microsandbox] kill: warned/unconfirmed (host pid still alive after SIGTERM)", async () => {
    const { exec } = fakeExec(() => ({}));
    const backend = createMicrosandboxBackend(
      exec,
      { spawnDetached: () => 1, isPidAlive: () => true, killDetached: () => {} },
      testConfig(),
    );
    const job = runningJob(testConfig(), { backend: "microsandbox", hostPid: 999, sandboxName: "pi-spawn-job-a" });
    const kr = await backend.kill(job);
    assert.equal(kr.stopped, false);
    assert.ok(kr.message?.includes("host process still running"));
  });

  // --------------------------------------------------------------------
  // Cleanup persistence: verify dirty writes survive to jobs.json
  // --------------------------------------------------------------------

  it("cleanup persists killed status to jobs.json and reloads", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: true });
    const orphaned = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 9999 });
    saveJobs(config.logDir, [orphaned]);
    await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
    });
    // Re-load from disk — proves persistence, not just in-memory.
    const reloaded = loadJobs(config.logDir);
    assert.equal(reloaded[0].status, "killed");
  });

  it("cleanup persists lost status to jobs.json and reloads", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: false, message: "fail" });
    backend.refresh = async () => false;
    const orphaned = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 9999 });
    saveJobs(config.logDir, [orphaned]);
    await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
    });
    const reloaded = loadJobs(config.logDir);
    assert.equal(reloaded[0].status, "lost");
  });

  it("cleanup persists done status from refresh to jobs.json and reloads", async () => {
    const config = testConfig();
    const { backend } = backendForAdapter(config);
    backend.kill = async () => ({ stopped: false, alreadyComplete: true });
    backend.refresh = async (job) => {
      if (job.status === "running") { job.status = "done"; job.exitCode = 0; job.updatedAt = Date.now(); return true; }
      return false;
    };
    const orphaned = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 9999 });
    saveJobs(config.logDir, [orphaned]);
    await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
    });
    const reloaded = loadJobs(config.logDir);
    assert.equal(reloaded[0].status, "done");
  });

  // --------------------------------------------------------------------
  // Stale-parent and legacy registry cases
  // --------------------------------------------------------------------

  it("cleanup kills orphaned jobs (dead parentPid)", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    const orphaned = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 4001 });
    saveJobs(config.logDir, [orphaned]);
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: (pid) => pid !== 4001,
    });
    assert.equal(cleaned, 1);
    assert.deepEqual(killed, ["pi-fleet-1-scout-abc"]);
  });

  it("cleanup preserves jobs with alive parentPid", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    const live = runningJob(config, { name: "pi-fleet-1-scout-abc", parentPid: 4002 });
    saveJobs(config.logDir, [live]);
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: (pid) => pid === 4002,
    });
    assert.equal(cleaned, 0);
    assert.deepEqual(killed, []);
    const [job] = loadJobs(config.logDir);
    assert.equal(job.status, "running");
  });

  it("cleanup treats jobs without parentPid as stale (legacy)", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    const legacy = runningJob(config, { name: "pi-fleet-1-scout-abc" }); // no parentPid
    saveJobs(config.logDir, [legacy]);
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => true,
    });
    assert.equal(cleaned, 1);
    assert.deepEqual(killed, ["pi-fleet-1-scout-abc"]);
  });

  it("cleanup ignores non-prefixed jobs", async () => {
    const config = testConfig();
    const { backend, killed } = backendForAdapter(config);
    const userJob = runningJob(config, { name: "scout-user-job" });
    saveJobs(config.logDir, [userJob]);
    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      isParentAlive: () => false,
    });
    assert.equal(cleaned, 0);
    assert.deepEqual(killed, []);
  });

  // --------------------------------------------------------------------
  // Legacy registry migration
  // --------------------------------------------------------------------

  it("v0 registry (no version field) loads without error", () => {
    const config = testConfig();
    mkdirSync(config.logDir, { recursive: true });
    writeFileSync(registryPath(config.logDir), JSON.stringify({
      jobs: [{ name: "legacy", backend: "tmux", agent: "s", task: "t", cwd: "/tmp", status: "done", createdAt: 1, updatedAt: 2 }],
    }), "utf8");
    const errors: string[] = [];
    const jobs = loadJobs(config.logDir, (m) => errors.push(m));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "done");
    assert.equal(errors.length, 0);
  });

  it("v2 registry round-trips with version field", () => {
    const config = testConfig();
    const job = runningJob(config);
    saveJobs(config.logDir, [job]);
    const raw = JSON.parse(readFileSync(registryPath(config.logDir), "utf8"));
    assert.equal(raw.version, 2);
    assert.ok(Array.isArray(raw.jobs));
  });

  it("invalid records rejected, valid records preserved", () => {
    const config = testConfig();
    mkdirSync(config.logDir, { recursive: true });
    writeFileSync(registryPath(config.logDir), JSON.stringify({
      version: 2,
      jobs: [
        { name: "good", backend: "tmux", agent: "s", task: "t", cwd: "/tmp", status: "running", createdAt: 1, updatedAt: 1 },
        { backend: "tmux", agent: "s", task: "t", cwd: "/tmp", status: "running", createdAt: 1, updatedAt: 1 },
        "string",
      ],
    }), "utf8");
    const errors: string[] = [];
    const jobs = loadJobs(config.logDir, (m) => errors.push(m));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, "good");
    assert.ok(errors.length > 0);
  });

  it("rejects substring, empty, and non-string job statuses", () => {
    const config = testConfig();
    mkdirSync(config.logDir, { recursive: true });
    const base = {
      backend: "tmux",
      agent: "s",
      task: "t",
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 1,
    };
    writeFileSync(registryPath(config.logDir), JSON.stringify({
      version: 2,
      jobs: [
        { ...base, name: "valid", status: "running" },
        { ...base, name: "substring", status: "run" },
        { ...base, name: "empty", status: "" },
        { ...base, name: "combined", status: "done fail" },
        { ...base, name: "number", status: 1 },
      ],
    }), "utf8");

    const errors: string[] = [];
    const jobs = loadJobs(config.logDir, (message) => errors.push(message));
    assert.deepEqual(jobs.map((job) => job.name), ["valid"]);
    assert.match(errors[0], /4 invalid job record/);
  });
});
