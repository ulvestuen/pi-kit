import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSearchRequest, DEFAULT_BASE_URL } from "./exa-search-request.mjs";

describe("Exa search request", () => {
  it("shapes the default API request", () => {
    assert.equal(DEFAULT_BASE_URL, "https://api.exa.ai");
    const request = buildSearchRequest({
      apiKey: "test-key",
      query: "hello world",
      options: { type: "auto", limit: 5, maxChars: 1000 },
    });

    assert.equal(request.url, "https://api.exa.ai/search");
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.headers["x-api-key"], "test-key");
    assert.deepEqual(JSON.parse(request.init.body), {
      query: "hello world",
      type: "auto",
      numResults: 5,
      contents: { text: { maxCharacters: 1000 } },
    });
  });

  it("normalizes the base URL and maps all optional filters", () => {
    const request = buildSearchRequest({
      baseUrl: "https://exa.test///",
      apiKey: "key",
      query: "news",
      options: {
        type: "keyword",
        limit: 3,
        category: "news",
        includeDomains: ["example.com"],
        excludeDomains: ["spam.test"],
        startDate: "2026-01-01",
        endDate: "2026-08-01",
        maxChars: 0,
      },
    });

    assert.equal(request.url, "https://exa.test/search");
    assert.deepEqual(JSON.parse(request.init.body), {
      query: "news",
      type: "keyword",
      numResults: 3,
      category: "news",
      includeDomains: ["example.com"],
      excludeDomains: ["spam.test"],
      startPublishedDate: "2026-01-01",
      endPublishedDate: "2026-08-01",
    });
  });
});
