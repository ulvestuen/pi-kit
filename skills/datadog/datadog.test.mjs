import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "datadog.mjs");
const fetchMock = `data:text/javascript,${encodeURIComponent(`
  import { appendFileSync } from "node:fs";

  globalThis.fetch = async (url, init) => {
    const target = new URL(url);
    const headers = Object.fromEntries(
      Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    appendFileSync(process.env.DATADOG_TEST_REQUESTS, JSON.stringify({
      method: init.method,
      hostname: target.hostname,
      url: target.pathname + target.search,
      headers,
      body: init.body ?? "",
      redirect: init.redirect,
    }) + "\\n");

    if (process.env.DATADOG_TEST_FETCH_MODE === "response-body-error") {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => { throw new Error("response terminated"); },
      };
    }
    if (process.env.DATADOG_TEST_FETCH_MODE === "api-error") {
      return new Response(JSON.stringify({ errors: [
        "Rejected " + process.env.DD_API_KEY + " / " + process.env.DD_APP_KEY,
      ] }), { status: 403, statusText: "Forbidden" });
    }

    const monitorId = target.pathname.match(/\\/monitor\\/(\\d+)$/)?.[1];
    return new Response(JSON.stringify(monitorId ? { id: Number(monitorId) } : { ok: true }), { status: 200 });
  };
`)}`;

async function withDatadog(run) {
  const requests = [];
  const invoke = (args, env = {}) => runCli(args, env, requests);
  await run({ requests, invoke });
}

async function runCli(args, env = {}, requests) {
  const tempDir = requests ? await mkdtemp(path.join(os.tmpdir(), "datadog-test-")) : undefined;
  const requestFile = tempDir && path.join(tempDir, "requests.jsonl");
  try {
    const nodeArgs = requestFile ? ["--import", fetchMock, cli, ...args] : [cli, ...args];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, nodeArgs, {
        env: {
          ...process.env,
          DD_API_KEY: "secret-api-key",
          DD_APP_KEY: "secret-app-key",
          DD_SITE: "datadoghq.com",
          ...env,
          ...(requestFile && { DATADOG_TEST_REQUESTS: requestFile }),
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

test("gets a monitor from the selected site with Datadog authentication", async () => {
  await withDatadog(async ({ requests, invoke }) => {
    const result = await invoke(["monitor", "12345678"], { DD_SITE: "ap1.datadoghq.com" });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { id: 12345678 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].hostname, "api.ap1.datadoghq.com");
    assert.equal(requests[0].url, "/api/v1/monitor/12345678");
    assert.equal(requests[0].headers["dd-api-key"], "secret-api-key");
    assert.equal(requests[0].headers["dd-application-key"], "secret-app-key");
    assert.equal(requests[0].redirect, "error");
  });
});

test("lists and searches monitors with bounded pagination and filters", async () => {
  await withDatadog(async ({ requests, invoke }) => {
    const list = await invoke([
      "monitors", "--limit", "25", "--page", "2", "--monitor-tags", "team:checkout,env:prod",
      "--group-states", "alert,warn", "--with-downtimes", "true",
    ]);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(
      requests[0].url,
      "/api/v1/monitor?page=2&page_size=25&monitor_tags=team%3Acheckout%2Cenv%3Aprod&group_states=alert%2Cwarn&with_downtimes=true",
    );

    const search = await invoke(["search-monitors", "type:metric status:alert", "--limit", "10", "--sort", "status,desc"]);
    assert.equal(search.code, 0, search.stderr);
    assert.equal(
      requests[1].url,
      "/api/v1/monitor/search?query=type%3Ametric+status%3Aalert&page=0&per_page=10&sort=status%2Cdesc",
    );
  });
});

test("builds and validates monitor definitions", async () => {
  await withDatadog(async ({ requests, invoke }) => {
    const result = await invoke([
      "validate-monitor",
      "High CPU",
      "metric alert",
      "avg(last_5m):avg:system.cpu.user{env:prod} > 90",
      "--message", "Notify @ops",
      "--tags", "team:ops,env:prod",
      "--options", '{"thresholds":{"critical":90}}',
      "--data", '{"priority":1,"name":"overridden"}',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/api/v1/monitor/validate");
    assert.deepEqual(JSON.parse(requests[0].body), {
      priority: 1,
      name: "High CPU",
      type: "metric alert",
      query: "avg(last_5m):avg:system.cpu.user{env:prod} > 90",
      message: "Notify @ops",
      tags: ["team:ops", "env:prod"],
      options: { thresholds: { critical: 90 } },
    });

    const create = await invoke([
      "create-monitor", "High CPU", "metric alert",
      "avg(last_5m):avg:system.cpu.user{env:prod} > 90",
    ]);
    assert.equal(create.code, 0, create.stderr);
    assert.equal(requests[1].method, "POST");
    assert.equal(requests[1].url, "/api/v1/monitor");
  });
});

test("updates monitors and supports arbitrary same-origin API requests", async () => {
  await withDatadog(async ({ requests, invoke }) => {
    const update = await invoke(["update-monitor", "12345678", "--data", '{"message":"Updated"}']);
    assert.equal(update.code, 0, update.stderr);
    assert.equal(requests[0].method, "PUT");
    assert.equal(requests[0].url, "/api/v1/monitor/12345678");
    assert.deepEqual(JSON.parse(requests[0].body), { message: "Updated" });

    const custom = await invoke(["request", "POST", "/api/v2/logs/events/search", "--data", '{"page":{"limit":25}}']);
    assert.equal(custom.code, 0, custom.stderr);
    assert.equal(requests[1].method, "POST");
    assert.equal(requests[1].url, "/api/v2/logs/events/search");
    assert.deepEqual(JSON.parse(requests[1].body), { page: { limit: 25 } });
  });
});

test("rejects unsupported sites and cross-origin request paths", async () => {
  await withDatadog(async ({ requests, invoke }) => {
    const site = await invoke(["monitor", "1"], { DD_SITE: "attacker.example" });
    assert.equal(site.code, 1);
    assert.match(site.stderr, /DD_SITE must be one of/);

    const path = await invoke(["request", "GET", "//attacker.example/api/v1/monitor"]);
    assert.equal(path.code, 1);
    assert.match(path.stderr, /must remain under the configured API origin/);

    const fragment = await invoke(["request", "GET", "/api/v1/monitor#fragment"]);
    assert.equal(fragment.code, 1);
    assert.match(fragment.stderr, /must not contain a fragment/);
    assert.equal(requests.length, 0);
  });
});

test("normalizes request failures and redacts credentials", async () => {
  await withDatadog(async ({ invoke }) => {
    const bodyFailure = await invoke(
      ["request", "GET", "/api/v1/validate"],
      { DATADOG_TEST_FETCH_MODE: "response-body-error" },
    );
    assert.equal(bodyFailure.code, 1);
    assert.match(bodyFailure.stderr, /^Datadog request failed:/);
    assert.doesNotMatch(bodyFailure.stderr, /\n\s+at /);

    const apiFailure = await invoke(
      ["request", "GET", "/api/v1/validate"],
      { DATADOG_TEST_FETCH_MODE: "api-error" },
    );
    assert.equal(apiFailure.code, 1);
    assert.match(apiFailure.stderr, /Rejected \[REDACTED\] \/ \[REDACTED\]/);
    assert.doesNotMatch(apiFailure.stderr, /secret-(api|app)-key/);

    const overlapFailure = await invoke(
      ["request", "GET", "/api/v1/validate"],
      {
        DATADOG_TEST_FETCH_MODE: "api-error",
        DD_API_KEY: "shared-key",
        DD_APP_KEY: "shared-key-suffix",
      },
    );
    assert.equal(overlapFailure.code, 1);
    assert.match(overlapFailure.stderr, /Rejected \[REDACTED\] \/ \[REDACTED\]/);
    assert.doesNotMatch(overlapFailure.stderr, /shared-key|suffix/);
  });
});

test("validates command input before sending requests", async () => {
  await withDatadog(async ({ requests, invoke }) => {
    const id = await invoke(["monitor", "not-an-id"]);
    assert.equal(id.code, 1);
    assert.match(id.stderr, /monitor ID must be a positive integer/);

    const boolean = await invoke(["monitors", "--with-downtimes", "yes"]);
    assert.equal(boolean.code, 1);
    assert.match(boolean.stderr, /--with-downtimes must be true or false/);

    const update = await invoke(["update-monitor", "1", "--data", "{}"]);
    assert.equal(update.code, 1);
    assert.match(update.stderr, /must contain at least one monitor field/);
    assert.equal(requests.length, 0);
  });
});

test("help does not require Datadog credentials", async () => {
  const result = await runCli(["--help"], { DD_API_KEY: "", DD_APP_KEY: "", DD_SITE: "" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Usage: node datadog\.mjs/);
  assert.match(result.stdout, /DD_API_KEY/);
  assert.match(result.stdout, /DD_APP_KEY/);
});
