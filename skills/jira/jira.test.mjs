import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "jira.mjs");
const fetchMock = `data:text/javascript,${encodeURIComponent(`
  import { appendFileSync } from "node:fs";

  globalThis.fetch = async (url, init) => {
    const target = new URL(url);
    const headers = Object.fromEntries(
      Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    appendFileSync(process.env.JIRA_TEST_REQUESTS, JSON.stringify({
      method: init.method,
      url: target.pathname + target.search,
      headers,
      body: init.body ?? "",
      redirect: init.redirect,
    }) + "\\n");

    if (process.env.JIRA_TEST_FETCH_MODE === "response-body-error") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => { throw new Error("response terminated"); },
      };
    }

    const comment = init.method === "POST" && target.pathname.endsWith("/comment");
    return new Response(
      JSON.stringify(comment ? { id: "10001" } : { key: "ABC-1" }),
      { status: comment ? 201 : 200 },
    );
  };
`)}`;

async function withJira(run) {
  const baseUrl = "https://jira-test.atlassian.net";
  const requests = [];
  const invoke = (args, env = {}) => runCli(baseUrl, args, env, requests);
  await run({ baseUrl, requests, invoke });
}

async function runCli(baseUrl, args, env = {}, requests) {
  const tempDir = requests ? await mkdtemp(path.join(os.tmpdir(), "jira-test-")) : undefined;
  const requestFile = tempDir && path.join(tempDir, "requests.jsonl");
  try {
    const nodeArgs = requestFile ? ["--import", fetchMock, cli, ...args] : [cli, ...args];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, nodeArgs, {
        env: {
          ...process.env,
          JIRA_BASE_URL: baseUrl,
          JIRA_EMAIL: "user@example.com",
          JIRA_AUTH_TOKEN: "secret-token",
          ...env,
          ...(requestFile && { JIRA_TEST_REQUESTS: requestFile }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    if (requestFile) {
      let source = "";
      try {
        source = await readFile(requestFile, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (source.trim()) requests.push(...source.trimEnd().split("\n").map(JSON.parse));
    }
    return result;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

test("uses Jira Cloud API v3 and API-token Basic authentication", async () => {
  await withJira(async ({ requests, invoke }) => {
    const result = await invoke(["issue", "ABC-1"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { key: "ABC-1" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/rest/api/3/issue/ABC-1");
    assert.equal(requests[0].redirect, "error");
    assert.equal(
      requests[0].headers.authorization,
      `Basic ${Buffer.from("user@example.com:secret-token").toString("base64")}`,
    );
  });
});

test("formats comments as Atlassian Document Format", async () => {
  await withJira(async ({ requests, invoke }) => {
    const result = await invoke(["comment", "ABC-1", "Hello\nworld"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[0].url, "/rest/api/3/issue/ABC-1/comment");
    assert.deepEqual(JSON.parse(requests[0].body), {
      body: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
          { type: "paragraph", content: [{ type: "text", text: "world" }] },
        ],
      },
    });
  });
});

test("request uses the provided Jira Cloud API path", async () => {
  await withJira(async ({ requests, invoke }) => {
    const result = await invoke(["request", "GET", "/rest/api/3/myself"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/rest/api/3/myself");
  });
});

test("search uses Jira Cloud pagination", async () => {
  await withJira(async ({ requests, invoke }) => {
    const result = await invoke([
      "search", "project = ABC", "--limit", "25", "--fields", "summary,status",
      "--next-page-token", "cloud-page",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[0].url, "/rest/api/3/search/jql");
    assert.deepEqual(JSON.parse(requests[0].body), {
      jql: "project = ABC",
      maxResults: 25,
      fields: ["summary", "status"],
      nextPageToken: "cloud-page",
    });
  });
});

test("supports site and scoped-token gateway base URLs", async () => {
  await withJira(async ({ baseUrl, requests }) => {
    const result = await runCli(
      `${baseUrl}/`,
      ["request", "GET", "/rest/api/3/myself"],
      {},
      requests,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[0].url, "/rest/api/3/myself");
  });

  await withJira(async ({ requests }) => {
    const result = await runCli(
      "https://api.atlassian.com/ex/jira/cloud-id/",
      ["issue", "ABC-1"],
      {},
      requests,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[0].url, "/ex/jira/cloud-id/rest/api/3/issue/ABC-1");
  });
});

test("validates Jira Cloud base URLs", async () => {
  const invalidUrls = [
    ["http://jira-test.atlassian.net", /must use HTTPS/],
    ["http://127.0.0.1", /must use HTTPS/],
    ["http://localhost", /must use HTTPS/],
    ["http://[::1]", /must use HTTPS/],
    ["https://attacker.example", /must be https:\/\/<site>\.atlassian\.net or https:\/\/api\.atlassian\.com/],
    ["https://api.atlassian.com", /must be https:\/\/<site>\.atlassian\.net or https:\/\/api\.atlassian\.com/],
    ["https://jira-test.atlassian.net/jira", /must be https:\/\/<site>\.atlassian\.net or https:\/\/api\.atlassian\.com/],
    ["https://jira-test.atlassian.net?tenant=one", /must not contain credentials, a query, or a fragment/],
    ["https://jira-test.atlassian.net#fragment", /must not contain credentials, a query, or a fragment/],
  ];
  const requests = [];
  for (const [baseUrl, message] of invalidUrls) {
    const result = await runCli(baseUrl, ["issue", "ABC-1"], {}, requests);
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
  }
  assert.equal(requests.length, 0);
});

test("rejects request paths that escape a scoped-token gateway", async () => {
  await withJira(async ({ requests }) => {
    for (const path of ["/../rest/api/3/myself", "/%2e%2e/rest/api/3/myself"]) {
      const result = await runCli(
        "https://api.atlassian.com/ex/jira/cloud-id",
        ["request", "GET", path],
        {},
        requests,
      );
      assert.equal(result.code, 1);
      assert.match(result.stderr, /request path must remain under JIRA_BASE_URL/);
    }
    assert.equal(requests.length, 0);
  });
});

test("rejects fragments in arbitrary request paths", async () => {
  const requests = [];
  const result = await runCli(
    "https://jira-test.atlassian.net",
    ["request", "GET", "/rest/api/3/myself#fragment"],
    {},
    requests,
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /request path must not contain a fragment/);
  assert.equal(requests.length, 0);
});

test("reports response-body failures without an uncaught stack trace", async () => {
  await withJira(async ({ invoke }) => {
    const result = await invoke(
      ["request", "GET", "/rest/api/3/myself"],
      { JIRA_TEST_FETCH_MODE: "response-body-error" },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Jira request failed:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });
});

test("accepts flag-like positional text after the option terminator", async () => {
  await withJira(async ({ requests, invoke }) => {
    const result = await invoke(["comment", "ABC-1", "--", "--help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(requests[0].body), {
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "--help" }] }],
      },
    });
  });
});

test("requires an Atlassian account email", async () => {
  const result = await runCli("https://jira-test.atlassian.net", ["issue", "ABC-1"], { JIRA_EMAIL: "" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /JIRA_EMAIL is not set/);
});

test("help does not require Jira credentials", async () => {
  const result = await runCli("", ["--help"], { JIRA_EMAIL: "", JIRA_AUTH_TOKEN: "" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage: node jira\.mjs/);
  assert.match(result.stdout, /--fields <names>\s+Search fields, comma-separated/);
  assert.match(result.stdout, /--fields <json\|@file>\s+Create\/update fields/);
  assert.match(result.stdout, /--limit <n>\s+Search page size/);
});
