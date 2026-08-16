import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { renderHealthCheck } from "./doctor.mjs";

const doctor = fileURLToPath(new URL("./doctor.mjs", import.meta.url));

test("doctor reports configured and missing variables without exposing values", () => {
  const output = renderHealthCheck({
    EXA_API_KEY: "do-not-print-me",
    JIRA_BASE_URL: "https://jira.test",
    JIRA_AUTH_TOKEN: "token",
  });

  assert.match(output, /exa-search\s+\| EXA_API_KEY\s+\| ready/);
  assert.match(output, /jira\s+\| JIRA_BASE_URL, JIRA_AUTH_TOKEN\s+\| ready/);
  assert.match(output, /kagi-search\s+\| KAGI_API_KEY\s+\| missing KAGI_API_KEY/);
  assert.match(output, /pdca\s+\| —\s+\| ready/);
  assert.doesNotMatch(output, /do-not-print-me|https:\/\/jira\.test|token/);
});

test("doctor prints its table when invoked from a path containing spaces", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi doctor test-"));
  const nested = path.join(dir, "path with spaces");
  const copiedDoctor = path.join(nested, "doctor.mjs");
  await mkdir(nested);
  await copyFile(doctor, copiedDoctor);

  try {
    const result = await runNode(copiedDoctor);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Skill\s+\| Required environment\s+\| Status/m);
    assert.match(result.stdout, /exa-search/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {},
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
