import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, "run-in-herdr-tab.sh");

test("Herdr helper survives shell reparsing and preserves exact arguments", async () => {
  const fixture = await createFixture();
  const marker = path.join(fixture.dir, "injected");
  const task = `What's; $(touch ${marker}) and "quotes"`;
  try {
    const result = await run(helper, [
      "--role", "scout",
      "--cwd", fixture.cwd,
      "--timeout", "08",
      task,
    ], fixture.env());

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Herdr result\n");
    const childArgs = JSON.parse(await readFile(fixture.argsLog, "utf8"));
    assert.equal(childArgs.at(-1), task);
    assert.match(result.stderr, /\[sub-agent\] started/);
    await assert.rejects(() => readFile(marker));
    assert.deepEqual(await readdir(fixture.tempRoot), []);

    const commands = await readFile(fixture.herdrLog, "utf8");
    assert.match(commands, /tab create .*--workspace workspace-1 .*--no-focus/);
    assert.match(commands, /--label subagent:.*scout/);
    assert.match(commands, /pane run pane-1 bash/);
    assert.match(commands, /tab close tab-1/);
  } finally {
    await fixture.remove();
  }
});

test("Herdr helper closes a partially created tab when the pane ID is missing", async () => {
  const fixture = await createFixture("partial-create");
  try {
    const result = await run(helper, ["--role", "scout", "inspect"], fixture.env());
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no root pane ID/);
    assert.match(await readFile(fixture.herdrLog, "utf8"), /tab close tab-1/);
  } finally {
    await fixture.remove();
  }
});

test("Herdr helper bounds an acknowledged command that never starts", async () => {
  const fixture = await createFixture("acknowledge-only");
  try {
    const result = await run(
      helper,
      ["--timeout", "0", "--role", "scout", "inspect"],
      fixture.env({ HERDR_STATUS_GRACE_SECONDS: "0" }),
    );
    assert.equal(result.code, 124);
    assert.match(result.stderr, /did not publish completion status/);
    assert.match(await readFile(fixture.herdrLog, "utf8"), /tab close tab-1/);
    assert.deepEqual(await readdir(fixture.tempRoot), []);
  } finally {
    await fixture.remove();
  }
});

test("Herdr helper waits for an asynchronous fractional timeout", async () => {
  const fixture = await createFixture("async-status");
  try {
    const result = await run(
      helper,
      ["--timeout", "0.5", "--role", "scout", "inspect"],
      fixture.env({ HERDR_STATUS_GRACE_SECONDS: "0" }),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Herdr result\n");
    assert.deepEqual(await readdir(fixture.tempRoot), []);
  } finally {
    await fixture.remove();
  }
});

async function createFixture(mode = "run") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-test-"));
  const herdr = path.join(dir, "herdr");
  const fakePi = path.join(dir, "fake-pi.mjs");
  const herdrLog = path.join(dir, "herdr.log");
  const argsLog = path.join(dir, "args.json");
  const tempRoot = path.join(dir, "temporary files");
  const cwd = path.join(dir, "working directory");
  await mkdir(tempRoot);
  await mkdir(cwd);
  await writeFile(herdr, `#!/usr/bin/env bash
printf '%q ' "$@" >>"$HERDR_TEST_LOG"
printf '\n' >>"$HERDR_TEST_LOG"
if [[ "$1 $2" == "tab create" ]]; then
  if [[ "$HERDR_TEST_MODE" == "partial-create" ]]; then
    printf '{"result":{"tab":{"tab_id":"tab-1"}}}\n'
  else
    printf '{"result":{"tab":{"tab_id":"tab-1"},"root_pane":{"pane_id":"pane-1"}}}\n'
  fi
elif [[ "$1 $2" == "pane run" ]]; then
  if [[ "$HERDR_TEST_MODE" == "acknowledge-only" ]]; then
    exit 0
  fi
  shift 3
  if [[ "$HERDR_TEST_MODE" == "async-status" ]]; then
    eval "set -- $*"
    eval "$(sed -n '/^result_file=/p; /^status_file=/p' "$2")"
    (
      sleep 0.25
      printf 'Herdr result\n' >"$result_file"
      printf '0\n' >"$status_file"
    ) >/dev/null 2>&1 &
    exit 0
  fi
  bash -c "$*"
fi
`);
  await writeFile(fakePi, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PI_ARGS_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "Herdr result" }], stopReason: "stop" }
}) + "\\n");
`);
  await chmod(herdr, 0o755);
  await chmod(fakePi, 0o755);

  return {
    dir,
    cwd,
    herdrLog,
    argsLog,
    tempRoot,
    env(extra = {}) {
      return {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        PI_BINARY: fakePi,
        PI_ARGS_LOG: argsLog,
        TMPDIR: tempRoot,
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "workspace-1",
        HERDR_TEST_LOG: herdrLog,
        HERDR_TEST_MODE: mode,
        ...extra,
      };
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [command, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
