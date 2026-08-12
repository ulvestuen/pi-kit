import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "jira.mjs");

async function withJira(deploymentType, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/rest/api/2/serverInfo") {
      response.end(JSON.stringify({ deploymentType }));
    } else if (request.method === "POST" && request.url.endsWith("/comment")) {
      response.statusCode = 201;
      response.end(JSON.stringify({ id: "10001" }));
    } else {
      response.end(JSON.stringify({ key: "ABC-1" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await run({ baseUrl: `http://127.0.0.1:${port}`, requests });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function runCli(baseUrl, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        JIRA_BASE_URL: baseUrl,
        JIRA_AUTH_TOKEN: "secret-token",
        JIRA_EMAIL: "",
        JIRA_API_VERSION: "",
        ...env,
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
}

test("uses Jira Cloud API v3 and API-token Basic authentication", async () => {
  await withJira("Cloud", async ({ baseUrl, requests }) => {
    const result = await runCli(baseUrl, ["issue", "ABC-1"], { JIRA_EMAIL: "user@example.com" });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { key: "ABC-1" });
    assert.equal(requests[1].url, "/rest/api/3/issue/ABC-1");
    assert.equal(
      requests[1].headers.authorization,
      `Basic ${Buffer.from("user@example.com:secret-token").toString("base64")}`,
    );
  });
});

test("uses Jira Server/Data Center API v2 and plain-text comments", async () => {
  await withJira("Data Center", async ({ baseUrl, requests }) => {
    const result = await runCli(baseUrl, ["comment", "ABC-1", "First line\nSecond line"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[1].url, "/rest/api/2/issue/ABC-1/comment");
    assert.deepEqual(JSON.parse(requests[1].body), { body: "First line\nSecond line" });
  });
});

test("formats Jira Cloud comments as Atlassian Document Format", async () => {
  await withJira("Cloud", async ({ baseUrl, requests }) => {
    const result = await runCli(
      baseUrl,
      ["comment", "ABC-1", "Hello\nworld"],
      { JIRA_EMAIL: "user@example.com" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(requests[1].body), {
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

test("request supports Basic auth and does not perform version detection", async () => {
  await withJira("Cloud", async ({ baseUrl, requests }) => {
    const result = await runCli(
      baseUrl,
      ["request", "GET", "/rest/api/2/myself"],
      { JIRA_EMAIL: "user@example.com" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/rest/api/2/myself");
    assert.equal(
      requests[0].headers.authorization,
      `Basic ${Buffer.from("user@example.com:secret-token").toString("base64")}`,
    );
  });
});

test("uses platform-specific search endpoints and pagination", async () => {
  await withJira("Cloud", async ({ baseUrl, requests }) => {
    const result = await runCli(baseUrl, [
      "search", "project = ABC", "--limit", "25", "--fields", "summary,status",
      "--next-page-token", "cloud-page",
    ], { JIRA_EMAIL: "user@example.com" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[1].url, "/rest/api/3/search/jql");
    assert.deepEqual(JSON.parse(requests[1].body), {
      jql: "project = ABC",
      maxResults: 25,
      fields: ["summary", "status"],
      nextPageToken: "cloud-page",
    });
  });

  await withJira("Data Center", async ({ baseUrl, requests }) => {
    const result = await runCli(baseUrl, ["search", "project = ABC", "--start-at", "50"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[1].url, "/rest/api/2/search");
    assert.deepEqual(JSON.parse(requests[1].body), {
      jql: "project = ABC",
      maxResults: 50,
      startAt: 50,
    });
  });
});

test("preserves a Jira context path and rejects unsafe base URL components", async () => {
  await withJira("Cloud", async ({ baseUrl, requests }) => {
    const result = await runCli(`${baseUrl}/jira/`, ["request", "GET", "/rest/api/2/myself"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[0].url, "/jira/rest/api/2/myself");
  });

  for (const suffix of ["?tenant=one", "#fragment"]) {
    const result = await runCli(`https://jira.example${suffix}`, ["issue", "ABC-1"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must not contain credentials, a query, or a fragment/);
  }
});

test("rejects fragments in arbitrary request paths", async () => {
  const result = await runCli("https://jira.example", ["request", "GET", "/rest/api/2/myself#fragment"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /request path must not contain a fragment/);
});

test("accepts flag-like positional text after the option terminator", async () => {
  await withJira("Data Center", async ({ baseUrl, requests }) => {
    const result = await runCli(baseUrl, ["comment", "ABC-1", "--", "--help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(requests[1].body), { body: "--help" });
  });
});

test("help does not require Jira credentials", async () => {
  const result = await runCli("", ["--help"], { JIRA_AUTH_TOKEN: "" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage: node jira\.mjs/);
});
