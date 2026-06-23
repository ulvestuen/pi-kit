import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseNumber,
  parseBoolean,
  parseSearchType,
  loadConfig,
  DEFAULT_NUM_RESULTS,
  DEFAULT_SEARCH_TYPE,
  DEFAULT_MAX_CHARACTERS,
  DEFAULT_BASE_URL,
} from "./config.ts";
import {
  buildSearchRequest,
  formatResults,
  type ExaSearchResponse,
} from "./search.ts";
import type { ExaConfig } from "./config.ts";

const baseConfig: ExaConfig = {
  apiKey: "test-key",
  baseUrl: DEFAULT_BASE_URL,
  numResults: 5,
  searchType: "auto",
  includeText: true,
  maxCharacters: 1000,
};

// Point config resolution at a path that never exists so loadConfig falls
// back to environment variables instead of any real config file on disk.
const NONEXISTENT_CONFIG = path.join(
  os.tmpdir(),
  `exa-test-no-such-config-${process.pid}.json`,
);

function clearExaEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("EXA_")) delete process.env[key];
  }
  process.env.EXA_CONFIG_PATH = NONEXISTENT_CONFIG;
}

describe("parseNumber", () => {
  it("returns fallback for undefined", () => {
    assert.strictEqual(parseNumber(undefined, 7, "x"), 7);
  });

  it("returns fallback for empty string", () => {
    assert.strictEqual(parseNumber("", 7, "x"), 7);
  });

  it("parses numeric strings", () => {
    assert.strictEqual(parseNumber("42", 0, "x"), 42);
  });

  it("passes through numbers", () => {
    assert.strictEqual(parseNumber(3, 0, "x"), 3);
  });

  it("throws on non-numeric", () => {
    assert.throws(() => parseNumber("abc", 0, "x"), /must be a number/);
  });
});

describe("parseBoolean", () => {
  it("returns fallback for undefined", () => {
    assert.strictEqual(parseBoolean(undefined, true), true);
    assert.strictEqual(parseBoolean(undefined, false), false);
  });

  it("passes through booleans", () => {
    assert.strictEqual(parseBoolean(true, false), true);
  });

  it("parses truthy strings", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
      assert.strictEqual(parseBoolean(v, false), true, v);
    }
  });

  it("parses falsy strings", () => {
    for (const v of ["0", "false", "no", "off", "OFF"]) {
      assert.strictEqual(parseBoolean(v, true), false, v);
    }
  });

  it("returns fallback for unrecognized strings", () => {
    assert.strictEqual(parseBoolean("maybe", true), true);
  });
});

describe("parseSearchType", () => {
  it("defaults when undefined", () => {
    assert.strictEqual(parseSearchType(undefined), DEFAULT_SEARCH_TYPE);
  });

  it("defaults for empty string", () => {
    assert.strictEqual(parseSearchType("  "), DEFAULT_SEARCH_TYPE);
  });

  it("accepts valid types case-insensitively", () => {
    assert.strictEqual(parseSearchType("NEURAL"), "neural");
    assert.strictEqual(parseSearchType("keyword"), "keyword");
    assert.strictEqual(parseSearchType("fast"), "fast");
  });

  it("throws on invalid type", () => {
    assert.throws(() => parseSearchType("magic"), /searchType must be one of/);
  });
});

describe("buildSearchRequest", () => {
  it("builds a minimal request from config defaults", () => {
    const body = buildSearchRequest({ query: "hello world" }, baseConfig);
    assert.strictEqual(body.query, "hello world");
    assert.strictEqual(body.type, "auto");
    assert.strictEqual(body.numResults, 5);
    assert.deepStrictEqual(body.contents, {
      text: { maxCharacters: 1000 },
    });
  });

  it("trims the query", () => {
    const body = buildSearchRequest({ query: "  spaced  " }, baseConfig);
    assert.strictEqual(body.query, "spaced");
  });

  it("throws on empty query", () => {
    assert.throws(
      () => buildSearchRequest({ query: "   " }, baseConfig),
      /query must not be empty/,
    );
  });

  it("lets per-call numResults override config", () => {
    const body = buildSearchRequest(
      { query: "x", numResults: 20 },
      baseConfig,
    );
    assert.strictEqual(body.numResults, 20);
  });

  it("rejects out-of-range numResults", () => {
    assert.throws(
      () => buildSearchRequest({ query: "x", numResults: 0 }, baseConfig),
      /numResults must be between 1 and 100/,
    );
    assert.throws(
      () => buildSearchRequest({ query: "x", numResults: 101 }, baseConfig),
      /numResults must be between 1 and 100/,
    );
  });

  it("omits contents when includeText is false", () => {
    const body = buildSearchRequest(
      { query: "x" },
      { ...baseConfig, includeText: false },
    );
    assert.strictEqual(body.contents, undefined);
  });

  it("uses text: true when maxCharacters is 0", () => {
    const body = buildSearchRequest(
      { query: "x" },
      { ...baseConfig, maxCharacters: 0 },
    );
    assert.deepStrictEqual(body.contents, { text: true });
  });

  it("includes optional filters when provided", () => {
    const body = buildSearchRequest(
      {
        query: "x",
        category: "news",
        includeDomains: ["a.com"],
        excludeDomains: ["b.com"],
        startPublishedDate: "2024-01-01",
        endPublishedDate: "2024-12-31",
      },
      baseConfig,
    );
    assert.strictEqual(body.category, "news");
    assert.deepStrictEqual(body.includeDomains, ["a.com"]);
    assert.deepStrictEqual(body.excludeDomains, ["b.com"]);
    assert.strictEqual(body.startPublishedDate, "2024-01-01");
    assert.strictEqual(body.endPublishedDate, "2024-12-31");
  });

  it("falls back to config category", () => {
    const body = buildSearchRequest(
      { query: "x" },
      { ...baseConfig, category: "github" },
    );
    assert.strictEqual(body.category, "github");
  });

  it("omits empty domain arrays", () => {
    const body = buildSearchRequest(
      { query: "x", includeDomains: [], excludeDomains: [] },
      baseConfig,
    );
    assert.strictEqual(body.includeDomains, undefined);
    assert.strictEqual(body.excludeDomains, undefined);
  });
});

describe("formatResults", () => {
  it("reports when there are no results", () => {
    const out = formatResults({ results: [] }, "nothing");
    assert.match(out, /No Exa results found for "nothing"/);
  });

  it("renders title, url and metadata", () => {
    const resp: ExaSearchResponse = {
      results: [
        {
          title: "Example",
          url: "https://example.com",
          publishedDate: "2024-05-01",
          author: "Jane",
          text: "Some body text",
        },
      ],
    };
    const out = formatResults(resp, "q");
    assert.match(out, /1\. Example/);
    assert.match(out, /https:\/\/example\.com/);
    assert.match(out, /Published: 2024-05-01/);
    assert.match(out, /Author: Jane/);
    assert.match(out, /Some body text/);
  });

  it("prefers summary over highlights over text", () => {
    const resp: ExaSearchResponse = {
      results: [
        {
          url: "https://example.com",
          summary: "THE SUMMARY",
          highlights: ["a highlight"],
          text: "the full text",
        },
      ],
    };
    const out = formatResults(resp, "q");
    assert.match(out, /THE SUMMARY/);
    assert.doesNotMatch(out, /a highlight/);
  });

  it("falls back to untitled", () => {
    const out = formatResults(
      { results: [{ url: "https://x.com" }] },
      "q",
    );
    assert.match(out, /\(untitled\)/);
  });
});

describe("loadConfig", () => {
  beforeEach(clearExaEnv);

  it("throws when no apiKey is configured", () => {
    assert.throws(() => loadConfig(), /Missing Exa config/);
  });

  it("loads defaults from EXA_API_KEY alone", () => {
    process.env.EXA_API_KEY = "abc123";
    const cfg = loadConfig();
    assert.strictEqual(cfg.apiKey, "abc123");
    assert.strictEqual(cfg.baseUrl, DEFAULT_BASE_URL);
    assert.strictEqual(cfg.numResults, DEFAULT_NUM_RESULTS);
    assert.strictEqual(cfg.searchType, DEFAULT_SEARCH_TYPE);
    assert.strictEqual(cfg.includeText, true);
    assert.strictEqual(cfg.maxCharacters, DEFAULT_MAX_CHARACTERS);
    assert.strictEqual(cfg.configPath, undefined);
  });

  it("reads overrides from environment", () => {
    process.env.EXA_API_KEY = "abc123";
    process.env.EXA_NUM_RESULTS = "12";
    process.env.EXA_SEARCH_TYPE = "neural";
    process.env.EXA_INCLUDE_TEXT = "false";
    process.env.EXA_MAX_CHARACTERS = "2000";
    process.env.EXA_BASE_URL = "https://proxy.example.com/";
    process.env.EXA_CATEGORY = "news";
    const cfg = loadConfig();
    assert.strictEqual(cfg.numResults, 12);
    assert.strictEqual(cfg.searchType, "neural");
    assert.strictEqual(cfg.includeText, false);
    assert.strictEqual(cfg.maxCharacters, 2000);
    assert.strictEqual(cfg.baseUrl, "https://proxy.example.com");
    assert.strictEqual(cfg.category, "news");
  });

  it("rejects out-of-range numResults", () => {
    process.env.EXA_API_KEY = "abc123";
    process.env.EXA_NUM_RESULTS = "0";
    assert.throws(() => loadConfig(), /numResults must be between 1 and 100/);
  });

  it("rejects invalid searchType", () => {
    process.env.EXA_API_KEY = "abc123";
    process.env.EXA_SEARCH_TYPE = "bogus";
    assert.throws(() => loadConfig(), /searchType must be one of/);
  });
});
