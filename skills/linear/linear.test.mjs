import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOperation, requestLinear } from "./linear.mjs";

describe("Linear CLI operations", () => {
  it("builds a paginated team issue query", async () => {
    const operation = await buildOperation(["issues", "--team", "team-id", "--limit", "25", "--after", "cursor"]);

    assert.match(operation.query, /team\(id: \$teamId\)/);
    assert.deepEqual(operation.variables, {
      teamId: "team-id",
      first: 25,
      after: "cursor",
    });
  });

  it("rejects an explicitly empty team filter", async () => {
    await assert.rejects(() => buildOperation(["issues", "--team="]), /--team requires a non-empty value/);
  });

  it("merges explicit issue flags over JSON input", async () => {
    const operation = await buildOperation([
      "create-issue",
      "--input", '{"teamId":"team-id","title":"old","estimate":3}',
      "--title", "new",
      "--priority", "2",
      "--labels", "label-1,label-2",
    ]);

    assert.deepEqual(operation.variables.input, {
      teamId: "team-id",
      title: "new",
      estimate: 3,
      priority: 2,
      labelIds: ["label-1", "label-2"],
    });
    assert.equal(operation.mutationRoot, "issueCreate");
  });

  it("rejects an update without fields", async () => {
    await assert.rejects(() => buildOperation(["update-issue", "ENG-123"]), /at least one field/);
  });

  it("rejects unknown options and unexpected positional arguments", async () => {
    await assert.rejects(() => buildOperation(["teams", "--unknown="]), /does not accept --unknown/);
    await assert.rejects(() => buildOperation(["create-issue", "extra", "--team", "team-id", "--title", "title"]), /does not accept positional arguments/);
  });

  it("loads custom GraphQL and variables from files", async () => {
    const files = new Map([
      ["query.graphql", "query Me { viewer { id } }"],
      ["variables.json", '{"enabled":true}'],
    ]);
    const operation = await buildOperation(
      ["graphql", "--file", "query.graphql", "--variables-file", "variables.json"],
      async (path) => files.get(path),
    );

    assert.equal(operation.query, "query Me { viewer { id } }");
    assert.deepEqual(operation.variables, { enabled: true });
  });
});

describe("Linear API request", () => {
  it("authenticates a GraphQL request with the API key", async () => {
    let captured;
    const data = await requestLinear({
      query: "query Me { viewer { id } }",
      variables: { test: true },
      apiKey: "secret-test-key",
      apiUrl: "https://linear.test/graphql",
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response('{"data":{"viewer":{"id":"user-id"}}}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.deepEqual(data, { viewer: { id: "user-id" } });
    assert.equal(captured.url, "https://linear.test/graphql");
    assert.equal(captured.init.headers.Authorization, "secret-test-key");
    assert.deepEqual(JSON.parse(captured.init.body), {
      query: "query Me { viewer { id } }",
      variables: { test: true },
    });
  });

  it("turns GraphQL errors into failures", async () => {
    await assert.rejects(
      () => requestLinear({
        query: "query Broken { broken }",
        apiKey: "key",
        fetchImpl: async () => new Response('{"errors":[{"message":"Not authorized"}]}', { status: 200 }),
      }),
      /Linear GraphQL error: Not authorized/,
    );
  });

  it("redacts the API key from GraphQL and non-JSON errors", async () => {
    const apiKey = "secret-test-key";

    await assert.rejects(
      () => requestLinear({
        query: "query Broken { broken }",
        apiKey,
        fetchImpl: async () => new Response(`{"errors":[{"message":"Rejected ${apiKey}"}]}`, { status: 200 }),
      }),
      (error) => {
        assert.match(error.message, /Rejected \[REDACTED\]/);
        assert.doesNotMatch(error.message, new RegExp(apiKey));
        return true;
      },
    );

    await assert.rejects(
      () => requestLinear({
        query: "query Broken { broken }",
        apiKey,
        fetchImpl: async () => new Response(`Proxy reflected ${apiKey}${"x".repeat(600)}`, { status: 502 }),
      }),
      (error) => {
        assert.match(error.message, /Proxy reflected \[REDACTED\]/);
        assert.doesNotMatch(error.message, new RegExp(apiKey));
        assert.ok(error.message.length < 600);
        return true;
      },
    );
  });

  it("rejects false success for every built-in mutation", async () => {
    for (const mutationRoot of ["issueCreate", "issueUpdate", "commentCreate"]) {
      await assert.rejects(
        () => requestLinear({
          query: "mutation Test { test }",
          mutationRoot,
          apiKey: "key",
          fetchImpl: async () => new Response(JSON.stringify({ data: { [mutationRoot]: { success: false } } }), { status: 200 }),
        }),
        new RegExp(`Linear mutation ${mutationRoot} was not successful`),
      );
    }
  });

  it("rejects a successful HTTP response without a data envelope", async () => {
    await assert.rejects(
      () => requestLinear({
        query: "query Me { viewer { id } }",
        apiKey: "key",
        fetchImpl: async () => new Response("{}", { status: 200 }),
      }),
      /Linear API response is missing data/,
    );

    await assert.rejects(
      () => requestLinear({
        query: "query Me { viewer { id } }",
        apiKey: "key",
        fetchImpl: async () => new Response("null", { status: 200 }),
      }),
      /Linear API returned an invalid JSON envelope/,
    );
  });
});
