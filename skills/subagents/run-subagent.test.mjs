import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "run-subagent.mjs");

async function createFakePi() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
  const fakePi = path.join(dir, "fake-pi.mjs");
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function emit(event, splitMarker) {
  const bytes = Buffer.from(JSON.stringify(event) + "\\n");
  if (splitMarker) {
    const marker = Buffer.from(splitMarker);
    const markerIndex = bytes.indexOf(marker);
    const splitAt = markerIndex >= 0 ? markerIndex + 1 : Math.floor(bytes.length / 2);
    process.stdout.write(bytes.subarray(0, splitAt));
    await delay(10);
    process.stdout.write(bytes.subarray(splitAt));
  } else {
    process.stdout.write(bytes);
  }
  await delay(10);
}

await emit({ type: "agent_start" });
await emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
await emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "checking ✓" } }, "✓");
await emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
await emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "printf test" } });
await emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "discarded\\nalpha\\n" }] } });
await emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "alpha\\nbeta\\n" }] } });
await emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "alpha\\nbeta\\ngamma\\n" }] } });
await emit({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: { path: "example.txt" } });
await emit({ type: "tool_execution_end", toolCallId: "call-2", toolName: "read", isError: false, result: { content: [{ type: "text", text: "file contents" }] } });
await emit({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
await emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Final ✓" } }, "✓");
await emit({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
await delay(30);
await emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Final ✓" }], stopReason: "stop" } }, "✓");
await emit({ type: "agent_settled" });
`,
    { mode: 0o755 },
  );
  await chmod(fakePi, 0o755);
  return { dir, fakePi };
}

function runRunner(fakePi, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [runner, ...extraArgs, "--system-prompt", "Test agent", "test task"],
      { env: { ...process.env, PI_BINARY: fakePi }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let sawLiveOutputBeforeClose = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("[sub-agent] started")) sawLiveOutputBeforeClose = true;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, sawLiveOutputBeforeClose }));
  });
}

test("default mode keeps stderr quiet and prints only the final answer", async () => {
  const { dir, fakePi } = await createFakePi();
  try {
    const result = await runRunner(fakePi);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "Final ✓\n");
    assert.equal(result.stderr, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--stream emits live readable activity to stderr and keeps stdout clean", async () => {
  const { dir, fakePi } = await createFakePi();
  try {
    const result = await runRunner(fakePi, ["--stream"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "Final ✓\n");
    assert.equal(result.sawLiveOutputBeforeClose, true);
    assert.match(result.stderr, /\[sub-agent\] started/);
    assert.match(result.stderr, /\[sub-agent:thinking\] checking ✓/);
    assert.match(result.stderr, /\[sub-agent:tool\] \$ printf test/);
    assert.match(result.stderr, /\[sub-agent:bash\] discarded\n  alpha/);
    assert.match(result.stderr, /\[sub-agent:bash\] beta/);
    assert.match(result.stderr, /\[sub-agent:bash\] gamma/);
    assert.match(result.stderr, /\[sub-agent:tool\] bash finished/);
    assert.match(result.stderr, /\[sub-agent:tool\] read example\.txt/);
    assert.match(result.stderr, /\[sub-agent:read\] file contents/);
    assert.match(result.stderr, /\[sub-agent:tool\] read finished/);
    assert.match(result.stderr, /\[sub-agent:assistant\] Final ✓/);
    assert.match(result.stderr, /\[sub-agent\] completed/);
    assert.equal((result.stderr.match(/alpha/g) ?? []).length, 1);
    assert.equal((result.stderr.match(/beta/g) ?? []).length, 1);
    assert.equal((result.stderr.match(/gamma/g) ?? []).length, 1);
    assert.doesNotMatch(result.stderr, /"type":"message_update"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
