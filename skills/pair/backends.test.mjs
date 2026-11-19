import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  backendLaunchArgs,
  backendOf,
  createExternalChecker,
  isExternalBackend,
  parseAgyModels,
  readCodexConfiguredModel,
  resolveBackendBin,
} from "./backends.mjs";
import { cliModelsCommand, DONE, main, modelChecker, prepareBackendLaunch, resolveModels, runPair } from "./pair.mjs";
import { runReview } from "../pair-review/pair-review.mjs";
import { runWork } from "../pair-work/pair-work.mjs";

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pair-backends-test-"));
  dirs.push(d);
  return d;
};

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const fast = { sleep: async () => {}, now: () => 1_700_000_000_000 };

function makeBinDir() {
  const dir = tmp();
  const touch = (name) => {
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
    return p;
  };
  return {
    dir,
    agy: touch("agy"),
    claude: touch("claude"),
    codex: touch("codex"),
    pi: touch("pi"),
  };
}

describe("backend detection and argv shaping", () => {
  it("dispatches agy/, claude/, and codex/ prefixes while keeping Pi providers on pi", () => {
    assert.equal(backendOf("agy/gemini-4-neon:xhigh"), "agy");
    assert.equal(backendOf("claude/opus:high"), "claude");
    assert.equal(backendOf("codex/gpt-6.1-sol:xhigh"), "codex");
    assert.equal(backendOf("claude-code/claude-opus-5-5"), "pi");
    assert.equal(backendOf("openai-codex/gpt-5.4"), "pi");
    assert.equal(backendOf("openai/gpt-6.1-sol:xhigh"), "pi");
    assert.equal(backendOf("anthropic/claude-opus-5-5"), "pi");
    assert.equal(isExternalBackend("agy/gemini-4-neon"), true);
    assert.equal(isExternalBackend("openai/gpt-6.1-sol"), false);
  });

  it("builds interactive auto-approve launch arguments with --add-dir for each backend", () => {
    assert.deepEqual(
      backendLaunchArgs("agy", { spec: "agy/gemini-4-neon:xhigh", id: "gemini-4-neon", thinking: "xhigh", prompt: "Do X", runDir: "/tmp/run-1" }),
      ["--model", "gemini-4-neon", "--effort", "xhigh", "--dangerously-skip-permissions", "--add-dir", "/tmp/run-1", "--prompt-interactive=Do X"],
    );
    assert.deepEqual(
      backendLaunchArgs("claude", { spec: "claude/opus:high", id: "opus", thinking: "high", prompt: "Do X", runDir: "/tmp/run-1" }),
      ["--model", "opus", "--effort", "high", "--dangerously-skip-permissions", "--add-dir", "/tmp/run-1", "--", "Do X"],
    );
    assert.deepEqual(
      backendLaunchArgs("codex", { spec: "codex/gpt-6.1-sol:xhigh", id: "gpt-6.1-sol", thinking: "xhigh", prompt: "Do X", runDir: "/tmp/run-1" }),
      ["-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"', "--dangerously-bypass-approvals-and-sandbox", "--no-alt-screen", "--add-dir", "/tmp/run-1", "--", "Do X"],
    );
    assert.deepEqual(
      backendLaunchArgs("pi", { spec: "openai/gpt-6.1-sol:xhigh", id: "gpt-6.1-sol", thinking: "xhigh", prompt: "Do X", runDir: "/tmp/run-1" }),
      ["--model", "openai/gpt-6.1-sol:xhigh", "Do X"],
    );
  });

  it("parses agy models output, stripping spinners and deriving per-model effort maps", () => {
    const raw = [
      "\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-neon-high     Gemini 4 Neon (High)",
      "gemini-4-neon-xhigh    Gemini 4 Neon (XHigh)",
      "gemini-4-neon-low      Gemini 4 Neon (Low)",
      "gemini-3.8-flash-high  Gemini 3.8 Flash (High)",
      "gemini-3.8-flash-low   Gemini 3.8 Flash (Low)",
      "gpt-oss-120b-medium    GPT-OSS 120B (Medium)",
    ].join("\n");
    const { baseModels, concreteIds } = parseAgyModels(raw);
    assert.deepEqual(baseModels, [
      { id: "gemini-4-neon", baseId: "gemini-4-neon", name: "Gemini 4 Neon", levels: ["low", "high", "xhigh"] },
      { id: "gemini-3.8-flash", baseId: "gemini-3.8-flash", name: "Gemini 3.8 Flash", levels: ["low", "high"] },
      { id: "gpt-oss-120b-medium", baseId: "gpt-oss-120b", name: "GPT-OSS 120B", levels: ["medium"] },
    ]);
    assert.equal(concreteIds.has("gemini-4-neon-xhigh"), true);
  });

  it("reads only the top-level model key from Codex config.toml", () => {
    const home = tmp();
    writeFileSync(
      join(home, "config.toml"),
      '# comment\nmodel = "gpt-6.1-sol"\n[profiles.alt]\nmodel = "other-model"\n',
    );
    assert.equal(readCodexConfiguredModel({ env: { CODEX_HOME: home } }), "gpt-6.1-sol");
    assert.equal(readCodexConfiguredModel({ env: { CODEX_HOME: join(home, "missing") } }), null);
  });

  it("resolves Windows .cmd shims to their Node entry point for external CLIs", () => {
    const files = new Map([
      ["C:\\tools\\claude.cmd", '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\claude\\cli.js" %*\r\n'],
      ["C:\\tools\\node.exe", ""],
      ["C:\\tools\\node_modules\\claude\\cli.js", ""],
    ]);
    const resolved = resolveBackendBin("claude", {
      env: { Path: "C:\\tools", PathExt: ".CMD;.EXE" },
      cwd: "C:\\repo",
      platform: "win32",
      exists: (p) => files.has(p),
      readFile: (p) => files.get(p),
    });
    assert.ok(resolved);
    assert.equal(resolved.bin, "C:\\tools\\claude.cmd");
    assert.deepEqual(resolved.command, ["C:\\tools\\node.exe", "C:\\tools\\node_modules\\claude\\cli.js"]);
  });
});

describe("external backend readiness and cli-models discovery", () => {
  it("checks readiness for agy, claude, and codex and validates agy model + effort", async () => {
    const bins = makeBinDir();
    const codexHome = tmp();
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6.1-sol"\n');
    const env = { PATH: bins.dir, CODEX_HOME: codexHome };
    const exec = async (cmd, args) => {
      if (cmd === bins.agy && args[0] === "models") {
        return "gemini-4-neon-high   Gemini 4 Neon (High)\ngemini-4-neon-xhigh  Gemini 4 Neon (XHigh)\ngemini-3.8-flash-low Gemini 3.8 Flash (Low)\n";
      }
      if (cmd === bins.claude && args[0] === "auth") {
        return JSON.stringify({ loggedIn: true, subscriptionType: "pro" });
      }
      if (cmd === bins.codex && args[0] === "login") {
        // Real `codex login status` prints "Logged in ..." to stderr and exits 0 with empty stdout.
        return "";
      }
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    };

    const checker = modelChecker({ pi: null, env, cwd: tmp(), callerCwd: bins.dir, exec });

    assert.equal((await checker.check("agy/gemini-4-neon:xhigh")).ready, true);
    assert.equal((await checker.check("agy/gemini-4-neon-high")).ready, true);
    const badEffort = await checker.check("agy/gemini-3.8-flash:xhigh");
    assert.equal(badEffort.ready, false);
    assert.match(badEffort.detail, /supports efforts: low/);
    const missingAgy = await checker.check("agy/no-such-model");
    assert.equal(missingAgy.ready, false);
    assert.match(missingAgy.detail, /does not offer/);

    const claudeOk = await checker.check("claude/opus:max");
    assert.equal(claudeOk.ready, true);
    assert.match(claudeOk.detail, /claude pro/);

    const codexOk = await checker.check("codex/gpt-6.1-sol:xhigh");
    assert.equal(codexOk.ready, true);
    assert.match(codexOk.detail, /codex: logged in/);

    let json = "";
    assert.equal(await cliModelsCommand({ json: true }, { env, exec, log: (s) => (json = s), cwd: tmp(), callerCwd: bins.dir }), 0);
    const catalog = JSON.parse(json).models;
    assert.ok(catalog.some((m) => m.spec === "agy/gemini-4-neon" && m.levels.includes("xhigh")));
    assert.ok(catalog.some((m) => m.spec === "claude/opus" && m.levels.includes("max")));
    assert.ok(catalog.some((m) => m.spec === "codex/gpt-6.1-sol" && m.levels.includes("xhigh")));
  });

  it("reports unauthenticated CLIs cleanly and allows all-external runs without pi installed", async () => {
    const bins = makeBinDir();
    rmSync(bins.pi); // No `pi` binary on PATH!
    const env = { PATH: bins.dir };
    const exec = async (cmd, args) => {
      if (cmd === bins.claude && args[0] === "auth") {
        throw Object.assign(new Error("not logged in"), { stdout: '{"loggedIn":false}\n', code: 1 });
      }
      if (cmd === bins.agy && args[0] === "models") {
        return "gemini-4-neon-high Gemini 4 Neon (High)\n";
      }
      if (cmd === bins.codex && args[0] === "login") {
        // Real `codex login status` prints "Logged in ..." to stderr and exits 0 with empty stdout.
        return "";
      }
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    };

    const checker = createExternalChecker({ env, cwd: tmp(), callerCwd: bins.dir, exec });
    const badClaude = await checker.check({ spec: "claude/opus", model: "claude/opus", provider: "claude", id: "opus", thinking: null });
    assert.equal(badClaude.ready, false);
    assert.match(badClaude.detail, /claude auth login/);

    // Resolving purely external overrides succeeds even without `pi` on PATH.
    const choices = await resolveModels({
      roles: ["implementer", "auditor"],
      overrides: { implementer: "agy/gemini-4-neon:high", auditor: "codex/gpt-6.1-sol:xhigh" },
      env,
      cwd: tmp(),
      callerCwd: bins.dir,
      exec,
    });
    assert.equal(choices.implementer.ready, true);
    assert.equal(choices.auditor.ready, true);
  });
});

describe("mixed-backend pair, pair-review, and pair-work runs", () => {
  function fakeRexExec(splits, sent) {
    let nextId = 0;
    const writeReportFromPrompt = (prompt) => {
      const m = /read (\S+\.turn\.md)/.exec(prompt);
      if (!m) return;
      const turnText = readFileSync(m[1], "utf8");
      const r = /write your report as Markdown to:\n\n(\S+)/.exec(turnText);
      if (!r) return;
      const isVerify = turnText.includes("Verdict: accept");
      writeFileSync(r[1], `Report ok.\n${isVerify ? "Verdict: accept\n" : "Verdict: approve\n"}${DONE}\n`);
    };
    return async (cmd, args) => {
      if (cmd === "git") return "## main\n";
      if (cmd !== "rex") throw new Error(`unexpected cmd ${cmd}`);
      if (args[0] === "split") {
        const id = `b${++nextId}`;
        const sep = args.indexOf("--");
        const argv = args.slice(sep + 1);
        splits.push({ id, label: args[args.indexOf("--label") + 1], argv });
        writeReportFromPrompt(argv.at(-1) ?? "");
        return JSON.stringify({ block_ids: [id] });
      }
      if (args[0] === "send") {
        const id = args[args.indexOf("-b") + 1];
        const text = args.at(-1);
        sent.push({ id, text });
        writeReportFromPrompt(text);
        return "";
      }
      if (args[0] === "send-key" || args[0] === "capture") return "";
      throw new Error(`unexpected rex ${args.join(" ")}`);
    };
  }

  it("spawns claude and agy workers in pair with separate launchers and auto-approve flags", async () => {
    const bins = makeBinDir();
    rmSync(bins.pi); // Prove mixed claude + agy run does not require `pi`!
    const dir = tmp();
    const splits = [];
    const sent = [];
    const env = { PATH: bins.dir, REX_SESSION: "s1", REX_BLOCK: "b0", REX_BIN: "rex" };

    const result = await runPair({
      task: "Implement feature",
      mux: "rex",
      cwd: tmp(),
      dir,
      rounds: 1,
      implementerModel: "claude/opus:high",
      auditorModel: "agy/gemini-4-neon:xhigh",
      turnTimeout: "1m",
      env,
      exec: fakeRexExec(splits, sent),
      ...fast,
    });

    assert.equal(splits.length, 2);
    assert.match(splits[0].argv[0], /launch-claude\.sh$/);
    assert.deepEqual(splits[0].argv.slice(1, 8), ["--model", "opus", "--effort", "high", "--dangerously-skip-permissions", "--add-dir", dir]);
    assert.equal(splits[0].argv[8], "--");

    assert.match(splits[1].argv[0], /launch-agy\.sh$/);
    assert.deepEqual(splits[1].argv.slice(1, 8), ["--model", "gemini-4-neon", "--effort", "xhigh", "--dangerously-skip-permissions", "--add-dir", dir]);
    assert.match(splits[1].argv[8], /^--prompt-interactive=/);

    assert.equal(sent.length, 2);
    assert.equal(result.models.implementer, "claude/opus:high");
    assert.equal(result.models.auditor, "agy/gemini-4-neon:xhigh");
  });

  it("mixes Pi and Codex workers in pair-review and pair-work", async () => {
    const bins = makeBinDir();
    const env = { PATH: bins.dir, PAIR_PI_BIN: bins.pi, REX_SESSION: "s1", REX_BLOCK: "b0", REX_BIN: "rex" };

    const revSplits = [];
    const revSent = [];
    const revDir = tmp();
    await runReview({
      task: "Review PR",
      mux: "rex",
      cwd: tmp(),
      dir: revDir,
      rounds: 1,
      leadModel: "openai/gpt-6.1-sol:xhigh",
      peerModel: "codex/gpt-6.1-sol:xhigh",
      turnTimeout: "1m",
      env,
      exec: fakeRexExec(revSplits, revSent),
      ...fast,
    });
    assert.match(revSplits[0].argv[0], /launch\.sh$/);
    assert.deepEqual(revSplits[0].argv.slice(1, 3), ["--model", "openai/gpt-6.1-sol:xhigh"]);
    assert.match(revSplits[1].argv[0], /launch-codex\.sh$/);
    assert.deepEqual(revSplits[1].argv.slice(1, 9), [
      "-m",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "--dangerously-bypass-approvals-and-sandbox",
      "--no-alt-screen",
      "--add-dir",
      revDir,
    ]);

    const workSplits = [];
    const workSent = [];
    const workDir = tmp();
    const workRes = await runWork({
      task: "Research topic",
      mux: "rex",
      cwd: tmp(),
      dir: workDir,
      rounds: 2,
      doerModel: "agy/gemini-4-neon:high",
      verifierModel: "claude/sonnet:high",
      turnTimeout: "1m",
      env,
      exec: fakeRexExec(workSplits, workSent),
      ...fast,
    });
    assert.equal(workRes.accepted, true);
    assert.match(workSplits[0].argv[0], /launch-agy\.sh$/);
    assert.match(workSplits[1].argv[0], /launch-claude\.sh$/);
  });

  it("writes a valid backend launcher script pointing at the resolved binary", () => {
    const bins = makeBinDir();
    const dir = tmp();
    const b = prepareBackendLaunch("agy", { dir, env: { PATH: bins.dir }, mux: "herdr", cwd: bins.dir, workdir: dir });
    const script = readFileSync(b.launcher, "utf8");
    assert.match(script, new RegExp(bins.agy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(script, /launch\.exit/);
  });

  it("exposes cli-models through pair.mjs main()", async () => {
    const bins = makeBinDir();
    let out = "";
    const exec = async (cmd, args) => {
      if (cmd === bins.agy && args[0] === "models") {
        return "gemini-4-neon-high Gemini 4 Neon (High)\ngemini-4-neon-low Gemini 4 Neon (Low)\n";
      }
      throw new Error("not logged in");
    };
    const code = await main(["cli-models", "--json"], { env: { PATH: bins.dir }, exec, log: (s) => (out = s) });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.models.map((m) => m.spec), ["agy/gemini-4-neon"]);
  });
});
