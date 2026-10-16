import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate } from "./decisions.mjs";

const script = fileURLToPath(new URL("./decisions.mjs", import.meta.url));
const apiKey = "test-decisions-secret";
const request = {
  state: { message: "Duplicate charge", days: 3 },
  questions: {
    urgent: { type: "noul", instructions: "Is immediate action needed?" },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: "Bugs" } },
    severity: { type: "score", instructions: "How severe?", criteria: ["Low", "Medium", "High"] },
  },
};
const openaiRequest = {
  input: [{ role: "user", content: [
    { type: "input_text", text: "Inspect the damaged item." },
    { type: "input_image", image_url: "data:image/png;base64,fixture" },
  ] }],
  questions: [
    { type: "predicate", name: "urgent", instructions: "Is immediate action needed?" },
    { type: "choice", name: "literal", instructions: "Is the label a boolean or a string?", choices: [{ value: true }, { value: "true" }] },
    { type: "score", name: "severity", instructions: "How severe?", levels: [{ label: "Low" }, { label: "Medium" }, { label: "High" }] },
    { type: "predicate", instructions: "A question the model may decline." },
  ],
  safety_identifier: "fixture-user",
};
const jevImageRequest = {
  state: { photo: "fixture-photo-reference" },
  assets: {
    "fixture-photo-reference": { type: "image", format: "png", data_base64: "cGhvdG8=" },
    "fixture-example-reference": { format: "jpeg", data_base64: "ZXhhbXBsZQ==" },
  },
  questions: {
    visible: { type: "noul", instructions: "Is there a mug in `photo` matching this example: fixture-example-reference?" },
    style: { type: "choice", instructions: "Which style is the mug in `photo`?", criteria: { example: { images: ["fixture-example-reference"] }, other: "Other or no mug" } },
    similarity: { type: "score", instructions: "How closely does the mug in `photo` match?", criteria: ["Not at all", "Exactly like fixture-example-reference"] },
    mug: { type: "box", instructions: "the mug nearest the sink in `photo`" },
  },
};
const jevImageResult = {
  model: "jev-1.14.0",
  answers: {
    visible: { type: "noul", noul: 0.03 },
    style: { type: "choice", choice: "other", probabilities: { example: 0.1, other: 0.9 }, confidence: 0.8 },
    similarity: { type: "score", score: 0.1, legend: { 0: "Not at all", 1: "Exactly like fixture-example-reference" }, probabilities: { 0: 0.9, 1: 0.1 }, confidence: 0.8 },
    mug: { type: "box", box: { top: 0.18, bottom: 0.74, left: 0.32, right: 0.83 }, confidence: 0.24 },
  },
  usage: { input_tokens: 490, output_tokens: 61 },
};

test("sends a JEV evaluation and preserves typed answers and usage", async () => {
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
    provider: "jev",
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

test("sends native JEV images and boxes, preserves answers, and only defaults box requests to Jev 1.14", async () => {
  const { mug, ...imageQuestions } = jevImageRequest.questions;
  const imageOnly = { ...jevImageRequest, questions: imageQuestions };
  for (const [native, model, images] of [
    [imageOnly, "jev-latest", true],
    [{ ...imageOnly, model: "jev-1.13.0" }, "jev-1.13.0", true],
    [jevImageRequest, "jev-1.14.0", true],
    [{ ...jevImageRequest, model: "jev-preview" }, "jev-preview", true],
    [{ ...request, assets: {} }, "jev-latest", false],
  ]) {
    const answers = Object.fromEntries(Object.entries(jevImageResult.answers).filter(([id]) => Object.hasOwn(native.questions, id)));
    const result = { ...jevImageResult, model, answers };
    assert.deepEqual(await evaluate(native, {
      provider: "jev",
      apiKey,
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        assert.deepEqual(options.headers, {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(images ? { "TypeSafe-Danger-Zone-Images": "true" } : {}),
        });
        assert.deepEqual(JSON.parse(options.body), { model, ...native });
        return Response.json(result);
      },
    }), result);
  }
});

test("sends native OpenAI inputs and preserves booleans, distributions, refusals, and usage", async () => {
  const result = {
    model: "gpt-6-luna",
    answers: [
      { type: "predicate", name: "urgent", probability: 0.23 },
      { type: "choice", name: "literal", choice: true, probabilities: [{ value: true, probability: 0.82 }, { value: "true", probability: 0.18 }], confidence: 0.64 },
      { type: "score", name: "severity", score: 1.7, probabilities: [{ value: 0, label: "Low", probability: 0.1 }, { value: 1, label: "Medium", probability: 0.1 }, { value: 2, label: "High", probability: 0.8 }], confidence: 0.55 },
      { type: "refusal", name: null },
    ],
    usage: { input_tokens: 127, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 127 },
  };
  assert.deepEqual(await evaluate(openaiRequest, {
    provider: "openai",
    apiKey,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/decisions");
      assert.equal(options.method, "POST");
      assert.deepEqual(options.headers, { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
      assert.deepEqual(JSON.parse(options.body), { model: "gpt-6-luna", ...openaiRequest });
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(result);
    },
  }), result);
});

test("accepts both documented examples and explicit model overrides", async () => {
  const skill = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");
  const examples = [...skill.matchAll(/decisions\.mjs (jev|openai) - <<'JSON'\n([\s\S]*?)\nJSON/g)];
  assert.equal(examples.length, 2);
  for (const [, provider, json] of examples) {
    const example = JSON.parse(json);
    assert.deepEqual(Object.values(example.questions).map((q) => q.type), [provider === "jev" ? "noul" : "predicate", "choice", "score"]);
    await evaluate({ ...example, model: "explicit-test-model" }, {
      provider,
      apiKey,
      fetchImpl: async (_, options) => {
        assert.deepEqual(JSON.parse(options.body), { ...example, model: "explicit-test-model" });
        return Response.json({ answers: provider === "jev" ? {} : [] });
      },
    });
  }
});

test("rejects unknown providers, missing credentials, and incompatible request envelopes before sending", async () => {
  const fetchImpl = async () => assert.fail("must not call API");
  for (const provider of [undefined, "other", "constructor", "__proto__"]) {
    await assert.rejects(evaluate(request, { provider, apiKey, fetchImpl }), /Provider must be jev or openai/);
  }
  for (const [provider, native, other, keyEnv] of [
    ["jev", request, openaiRequest, "TYPESAFE_API_KEY"],
    ["openai", openaiRequest, request, "OPENAI_API_KEY"],
  ]) {
    await assert.rejects(evaluate(native, { provider, apiKey: "", fetchImpl }), new RegExp(`Missing ${keyEnv}`));
    for (const invalid of [null, [], "text"]) {
      await assert.rejects(evaluate(invalid, { provider, apiKey, fetchImpl }), /JSON object/);
    }
    for (const invalid of [{}, other, { ...native, questions: other.questions }, { ...native, questions: null }]) {
      await assert.rejects(evaluate(invalid, { provider, apiKey, fetchImpl }), /requires .* and a questions/);
    }
  }
});

test("reports HTTP failures with retry guidance, redacts secrets, and never retries", async () => {
  for (const [provider, native, name] of [["jev", request, "JEV"], ["openai", openaiRequest, "OpenAI Decisions"]]) {
    for (const status of [400, 401, 422, 429, 500, 529]) {
      let calls = 0;
      await assert.rejects(evaluate(native, {
        provider,
        apiKey,
        fetchImpl: async () => {
          calls++;
          return new Response(`problem ${apiKey}`, { status, headers: { "Retry-After": "7" } });
        },
      }), (error) => {
        assert.match(error.message, new RegExp(`${name} HTTP ${status}`));
        assert.match(error.message, /Retry-After: 7/);
        assert.match(error.message, /problem \[REDACTED\]/);
        assert.ok(!error.message.includes(apiKey));
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test("CLI reads stdin and files, selecting only the chosen provider's environment key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "decisions-test-"));
  try {
    for (const [provider, native, url, model, keyEnv] of [
      ["jev", request, "https://api.typesafe.ai/v1/systemone", "jev-latest", "TYPESAFE_API_KEY"],
      ["jev", jevImageRequest, "https://api.typesafe.ai/v1/systemone", "jev-1.14.0", "TYPESAFE_API_KEY"],
      ["openai", openaiRequest, "https://api.openai.com/v1/decisions", "gpt-6-luna", "OPENAI_API_KEY"],
    ]) {
      const key = `fixture-${provider}-key`;
      const response = native === jevImageRequest ? jevImageResult : { model, answers: provider === "jev" ? { urgent: { type: "noul", noul: 0.23 } } : [{ type: "predicate", name: "urgent", probability: 0.23 }] };
      const fetchMock = `data:text/javascript,${encodeURIComponent(`
        import assert from "node:assert/strict";
        globalThis.fetch = async (url, options) => {
          assert.equal(url, ${JSON.stringify(url)});
          assert.equal(options.headers.Authorization, ${JSON.stringify(`Bearer ${key}`)});
          assert.equal(options.headers["TypeSafe-Danger-Zone-Images"], ${native === jevImageRequest ? '"true"' : "undefined"});
          assert.deepEqual(JSON.parse(options.body), ${JSON.stringify({ model, ...native })});
          return Response.json(${JSON.stringify(response)});
        };
      `)}`;
      const source = path.join(dir, "request with spaces.json");
      await writeFile(source, JSON.stringify(native));
      for (const inputPath of ["-", source]) {
        for (const otherKey of ["", "fixture-other-key"]) {
          const env = { ...process.env, TYPESAFE_API_KEY: otherKey, OPENAI_API_KEY: otherKey, [keyEnv]: key };
          const result = spawnSync(process.execPath, ["--import", fetchMock, script, provider, inputPath], {
            env, input: inputPath === "-" ? JSON.stringify(native) : undefined, encoding: "utf8",
          });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, "");
          assert.deepEqual(JSON.parse(result.stdout), response);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI selects a provider before building requests: explicit choice, default, sole key, or ask", () => {
  const fetchMock = `data:text/javascript,${encodeURIComponent(`
    globalThis.fetch = async () => { throw new Error("provider selection must not call an API"); };
  `)}`;
  const both = { TYPESAFE_API_KEY: "fixture-typesafe-key", OPENAI_API_KEY: "fixture-openai-key" };
  for (const [args, config, provider, error] of [
    [["jev"], { ...both, DECISIONS_PROVIDER: "openai" }, "jev"],
    [["openai"], { ...both, DECISIONS_PROVIDER: "jev" }, "openai"],
    [["openai"], { ...both, DECISIONS_PROVIDER: "invalid-preference" }, "openai"],
    [[], { ...both, DECISIONS_PROVIDER: "jev" }, "jev"],
    [[], { ...both, DECISIONS_PROVIDER: "openai" }, "openai"],
    [[], { TYPESAFE_API_KEY: both.TYPESAFE_API_KEY }, "jev"],
    [[], { OPENAI_API_KEY: both.OPENAI_API_KEY }, "openai"],
    [[], both, undefined, /Both providers are configured.*Ask the user/],
    [[], {}, undefined, /No provider is configured.*TYPESAFE_API_KEY.*OPENAI_API_KEY/],
    [[], { ...both, DECISIONS_PROVIDER: "invalid-preference" }, undefined, /Provider must be jev or openai/],
    [["invalid-choice"], both, undefined, /Provider must be jev or openai/],
    [["constructor"], both, undefined, /Provider must be jev or openai/],
    [[], { OPENAI_API_KEY: both.OPENAI_API_KEY, DECISIONS_PROVIDER: "jev" }, undefined, /Missing TYPESAFE_API_KEY/],
    [[], { TYPESAFE_API_KEY: both.TYPESAFE_API_KEY, DECISIONS_PROVIDER: "openai" }, undefined, /Missing OPENAI_API_KEY/],
    [["jev"], { OPENAI_API_KEY: both.OPENAI_API_KEY, DECISIONS_PROVIDER: "openai" }, undefined, /Missing TYPESAFE_API_KEY/],
    [["openai"], { TYPESAFE_API_KEY: both.TYPESAFE_API_KEY, DECISIONS_PROVIDER: "jev" }, undefined, /Missing OPENAI_API_KEY/],
    [["jev", "extra"], both, undefined, /Usage:/],
  ]) {
    const result = spawnSync(process.execPath, ["--import", fetchMock, script, "provider", ...args], {
      env: { ...process.env, TYPESAFE_API_KEY: "", OPENAI_API_KEY: "", DECISIONS_PROVIDER: "", ...config },
      encoding: "utf8",
    });
    assert.equal(result.status, error ? 1 : 0, result.stderr);
    assert.equal(result.stdout, provider ? `${provider}\n` : "");
    if (error) assert.match(result.stderr, error);
    else assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-typesafe-key|fixture-openai-key|invalid-preference|invalid-choice/);
  }
});

test("CLI rejects missing selected credentials and invalid input without falling back", () => {
  const env = { ...process.env, TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" };
  for (const [args, input, message] of [
    [["jev", "-"], JSON.stringify(request), /Missing TYPESAFE_API_KEY/],
    [["openai", "-"], JSON.stringify(openaiRequest), /Missing OPENAI_API_KEY/],
    [["jev", "-"], "not json", /valid JSON/],
    [["openai", "-"], "not json", /valid JSON/],
    [["other", "-"], "{}", /Usage:/],
    [["-"], "{}", /Usage:/],
    [[], undefined, /Usage:/],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, input, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
  const fetchMock = `data:text/javascript,${encodeURIComponent(`
    globalThis.fetch = async () => { throw new Error("must not call API"); };
  `)}`;
  for (const [provider, native, otherKey, missingKey] of [
    ["jev", request, "OPENAI_API_KEY", "TYPESAFE_API_KEY"],
    ["openai", openaiRequest, "TYPESAFE_API_KEY", "OPENAI_API_KEY"],
  ]) {
    const result = spawnSync(process.execPath, ["--import", fetchMock, script, provider, "-"], {
      env: { ...env, [otherKey]: "fixture-other-key" }, input: JSON.stringify(native), encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`Missing ${missingKey}`));
  }
});
