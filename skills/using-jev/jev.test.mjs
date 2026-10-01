import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate } from "./jev.mjs";

const apiKey = "test-jev-secret";
const request = {
  state: { message: "Duplicate charge", days: 3 },
  questions: {
    urgent: { type: "noul", instructions: "Is immediate action needed?" },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: "Bugs" } },
    severity: { type: "score", instructions: "How severe?", criteria: ["Low", "Medium", "High"] },
  },
};

test("sends an authenticated evaluation and preserves typed answers and usage", async () => {
  const result = {
    model: "jev-1.13.0",
    answers: {
      urgent: { type: "noul", noul: 0.23 },
      team: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.8 },
      severity: { type: "score", score: 1.7, legend: { 0: "Low", 1: "Medium", 2: "High" }, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 }, confidence: 0.6 },
    },
    usage: { input_tokens: 127, output_tokens: 33 },
  };
  let calls = 0;
  assert.deepEqual(await evaluate(request, {
    apiKey,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(options.method, "POST");
      assert.deepEqual(options.headers, { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
      assert.deepEqual(JSON.parse(options.body), { model: "jev-latest", ...request });
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(result);
    },
  }), result);
  assert.equal(calls, 1);
});

test("accepts the documented example and an explicitly pinned model", async () => {
  const skill = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");
  const example = JSON.parse(skill.match(/<<'JSON'\n([\s\S]*?)\nJSON/)[1]);
  assert.deepEqual(Object.values(example.questions).map((q) => q.type), ["noul", "choice", "score"]);
  await evaluate({ ...example, model: "jev-1.13.0" }, {
    apiKey,
    fetchImpl: async (_, options) => {
      assert.deepEqual(JSON.parse(options.body), { ...example, model: "jev-1.13.0" });
      return Response.json({ answers: {} });
    },
  });
});

test("rejects missing credentials and non-object requests before making a request", async () => {
  const fetchImpl = async () => assert.fail("must not call API");
  await assert.rejects(evaluate(request, { apiKey: "", fetchImpl }), /Missing TYPESAFE_API_KEY/);
  for (const invalid of [null, [], "text"]) {
    await assert.rejects(evaluate(invalid, { apiKey, fetchImpl }), /JSON object/);
  }
});

test("reports HTTP failures with retry guidance, redacts secrets, and never retries", async () => {
  for (const status of [401, 422, 429, 529]) {
    let calls = 0;
    await assert.rejects(evaluate(request, {
      apiKey,
      fetchImpl: async () => {
        calls++;
        return new Response(`problem ${apiKey}`, { status, headers: { "Retry-After": "7" } });
      },
    }), (error) => {
      assert.match(error.message, new RegExp(`JEV HTTP ${status}`));
      assert.match(error.message, /Retry-After: 7/);
      assert.match(error.message, /problem \[REDACTED\]/);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("CLI reads stdin and files and exits nonzero without credentials", () => {
  const script = fileURLToPath(new URL("./jev.mjs", import.meta.url));
  const env = { ...process.env, TYPESAFE_API_KEY: "" };
  for (const [args, input, message] of [
    [["-"], JSON.stringify(request), /Missing TYPESAFE_API_KEY/],
    [[fileURLToPath(new URL("../../package.json", import.meta.url))], undefined, /Missing TYPESAFE_API_KEY/],
    [["-"], "not json", /valid JSON/],
    [[], undefined, /Usage:/],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, input, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});
