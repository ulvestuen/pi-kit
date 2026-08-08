import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSearchRequest,
  DEFAULT_BASE_URL,
} from "./kagi-search-request.mjs";

describe("Kagi search request", () => {
  it("uses the current v1 API by default", () => {
    assert.equal(DEFAULT_BASE_URL, "https://kagi.com/api/v1");

    const request = buildSearchRequest({
      apiKey: "test-key",
      query: "hello world",
      limit: 3,
    });

    assert.equal(request.url, "https://kagi.com/api/v1/search");
    assert.equal(request.init.method, "POST");
    assert.deepEqual(JSON.parse(request.init.body), {
      query: "hello world",
      limit: 3,
    });
    assert.equal(request.init.headers.Authorization, "Bot test-key");
  });

  it("normalizes trailing slashes on a v1 base URL", () => {
    const request = buildSearchRequest({
      baseUrl: "https://proxy.example/api/v1///",
      apiKey: "test-key",
      query: "query",
      limit: 10,
    });

    assert.equal(request.url, "https://proxy.example/api/v1/search");
    assert.equal(request.init.method, "POST");
  });

  it("retains GET query parameters for an explicitly configured legacy endpoint", () => {
    const request = buildSearchRequest({
      baseUrl: "https://kagi.com/api/v0/",
      apiKey: "legacy-key",
      query: "hello world",
      limit: 5,
    });

    const url = new URL(request.url);
    assert.equal(`${url.origin}${url.pathname}`, "https://kagi.com/api/v0/search");
    assert.equal(url.searchParams.get("q"), "hello world");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.headers.Authorization, "Bot legacy-key");
    assert.equal(request.init.body, undefined);
  });
});
