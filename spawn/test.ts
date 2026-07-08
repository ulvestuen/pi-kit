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
  readLogTail,
  refreshFromLocalMarkers,
} from "./backends/local.ts";
import { buildTmuxRunScript, createTmuxBackend } from "./backends/tmux.ts";
import {
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
    });
    assert.ok(script.includes(`cd '/work dir' || { echo 127 > '/logs/j1/done'; exit 127; }`));
    assert.ok(
      script.includes(
        `{ 'pi' '-p' 'task'; echo $? > '/logs/j1/done'; } 2>&1 | tee '/logs/j1/job.log'`,
      ),
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
    assert.deepEqual(calls.at(-1)?.args, ["kill-window", "-t", "@7"]);
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
    assert.ok(
      script.includes(
        `{ 'pi' '-p' 'task'; echo $? > "$d/done"; } > "$d/job.log" 2>&1`,
      ),
    );

    const runnerScript = buildRemoteRunScript({
      jobName: "j2",
      piCommand: "'pi' '--mode' 'json' 'task'",
      remoteDir: ".pi-spawn/j2",
      envExports: [],
      cwd: "/remote/repo worktree",
    });
    assert.ok(
      runnerScript.includes(
        "cd '/remote/repo worktree' || { echo 127 > \"$d/done\"; exit 127; }",
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
    assert.ok(script.includes("cd /workspace || { echo 127 > /job/done; exit 127; }"));
    assert.ok(
      script.includes(`{ 'pi' '-p' 't'; echo $? > /job/done; } > /job/job.log 2>&1`),
    );
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

describe("spawn runner adapter", () => {
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
          ].join("\n"),
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
      async kill(job) {
        killed.push(job.name);
      },
    };
    return { backend, launched, killed };
  }

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
    const internal = runningJob(config, { name: "pi-fleet-1-scout-abc" });
    const userJob = runningJob(config, { name: "scout-user-job" });
    saveJobs(config.logDir, [internal, userJob]);

    const cleaned = await cleanupSpawnToolingJobs({
      config,
      backends: { tmux: backend, exedev: backend, microsandbox: backend },
      jobNamePrefix: "pi-fleet",
      now: () => 1234,
    });

    assert.equal(cleaned, 1);
    assert.deepEqual(killed, ["pi-fleet-1-scout-abc"]);
    const jobs = loadJobs(config.logDir);
    assert.equal(jobs[0].status, "killed");
    assert.equal(jobs[0].updatedAt, 1234);
    assert.equal(jobs[1].status, "running");
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
