import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseNumber,
  parseBoolean,
  loadConfig,
  DEFAULT_LIMIT,
  DEFAULT_BASE_URL,
  DEFAULT_INCLUDE_RELATED,
} from "./config.ts";
import {
  buildSearchParams,
  formatResults,
  getSearchResults,
  type KagiSearchResponse,
} from "./search.ts";
import type { KagiConfig } from "./config.ts";

const baseConfig: KagiConfig = {
  apiKey: "test-key",
  baseUrl: DEFAULT_BASE_URL,
  limit: 10,
  includeRelated: false,
};

// Point config resolution at a path that never exists so loadConfig falls
// back to environment variables instead of any real config file on disk.
const NONEXISTENT_CONFIG = path.join(
  os.tmpdir(),
  `kagi-test-no-such-config-${process.pid}.json`,
);

function clearKagiEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("KAGI_")) delete process.env[key];
  }
  process.env.KAGI_CONFIG_PATH = NONEXISTENT_CONFIG;
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

describe("buildSearchParams", () => {
  it("builds a minimal request from config defaults", () => {
    const params = buildSearchParams({ query: "hello world" }, baseConfig);
    assert.strictEqual(params.get("q"), "hello world");
    assert.strictEqual(params.get("limit"), "10");
  });

  it("trims the query", () => {
    const params = buildSearchParams({ query: "  spaced  " }, baseConfig);
    assert.strictEqual(params.get("q"), "spaced");
  });

  it("throws on empty query", () => {
    assert.throws(
      () => buildSearchParams({ query: "   " }, baseConfig),
      /query must not be empty/,
    );
  });

  it("lets per-call limit override config", () => {
    const params = buildSearchParams({ query: "x", limit: 20 }, baseConfig);
    assert.strictEqual(params.get("limit"), "20");
  });

  it("rejects out-of-range limit", () => {
    assert.throws(
      () => buildSearchParams({ query: "x", limit: 0 }, baseConfig),
      /limit must be between 1 and 100/,
    );
    assert.throws(
      () => buildSearchParams({ query: "x", limit: 101 }, baseConfig),
      /limit must be between 1 and 100/,
    );
  });
});

describe("formatResults", () => {
  it("reports when there are no results", () => {
    const out = formatResults({ data: [] }, "nothing", false);
    assert.match(out, /No Kagi results found for "nothing"/);
  });

  it("renders title, url and metadata", () => {
    const resp: KagiSearchResponse = {
      data: [
        {
          t: 0,
          rank: 1,
          title: "Example",
          url: "https://example.com",
          published: "2024-05-01",
          snippet: "Some body text",
        },
      ],
    };
    const out = formatResults(resp, "q", false);
    assert.match(out, /1\. Example/);
    assert.match(out, /https:\/\/example\.com/);
    assert.match(out, /Published: 2024-05-01/);
    assert.match(out, /Some body text/);
  });

  it("ignores non-result items (related searches) in the result list", () => {
    const resp: KagiSearchResponse = {
      data: [
        { t: 0, url: "https://a.com", title: "A" },
        { t: 1, list: ["related one", "related two"] },
      ],
    };
    const out = formatResults(resp, "q", false);
    assert.match(out, /1\. A/);
    assert.doesNotMatch(out, /2\./);
    assert.doesNotMatch(out, /related one/);
  });

  it("appends related searches when includeRelated is true", () => {
    const resp: KagiSearchResponse = {
      data: [
        { t: 0, url: "https://a.com", title: "A" },
        { t: 1, list: ["related one", "related two"] },
      ],
    };
    const out = formatResults(resp, "q", true);
    assert.match(out, /Related searches:/);
    assert.match(out, /related one/);
    assert.match(out, /related two/);
  });

  it("falls back to untitled", () => {
    const out = formatResults(
      { data: [{ t: 0, url: "https://x.com" }] },
      "q",
      false,
    );
    assert.match(out, /\(untitled\)/);
  });

  it("renders v1 object-shaped data.search responses", () => {
    const resp: KagiSearchResponse = {
      data: {
        search: [{ url: "https://v1.example.com", title: "V1 Result" }],
        related: ["v1 related"],
      },
    };
    const out = formatResults(resp, "q", true);
    assert.match(out, /1\. V1 Result/);
    assert.match(out, /https:\/\/v1\.example\.com/);
    assert.match(out, /v1 related/);
  });
});

describe("getSearchResults", () => {
  it("counts array-shaped current API responses", () => {
    assert.strictEqual(
      getSearchResults({
        data: [
          { t: 0, url: "https://a.com" },
          { t: 1, list: ["related"] },
        ],
      }).length,
      1,
    );
  });

  it("counts object-shaped v1 API responses without calling .filter on an object", () => {
    assert.strictEqual(
      getSearchResults({
        data: { search: [{ url: "https://v1.example.com" }] },
      }).length,
      1,
    );
  });
});

describe("loadConfig", () => {
  beforeEach(clearKagiEnv);

  it("throws when no apiKey is configured", () => {
    assert.throws(() => loadConfig(), /Missing Kagi config/);
  });

  it("loads defaults from KAGI_API_KEY alone", () => {
    process.env.KAGI_API_KEY = "abc123";
    const cfg = loadConfig();
    assert.strictEqual(cfg.apiKey, "abc123");
    assert.strictEqual(cfg.baseUrl, DEFAULT_BASE_URL);
    assert.strictEqual(cfg.limit, DEFAULT_LIMIT);
    assert.strictEqual(cfg.includeRelated, DEFAULT_INCLUDE_RELATED);
    assert.strictEqual(cfg.configPath, undefined);
  });

  it("reads overrides from environment", () => {
    process.env.KAGI_API_KEY = "abc123";
    process.env.KAGI_LIMIT = "25";
    process.env.KAGI_INCLUDE_RELATED = "true";
    process.env.KAGI_BASE_URL = "https://proxy.example.com/";
    const cfg = loadConfig();
    assert.strictEqual(cfg.limit, 25);
    assert.strictEqual(cfg.includeRelated, true);
    assert.strictEqual(cfg.baseUrl, "https://proxy.example.com");
  });

  it("rejects out-of-range limit", () => {
    process.env.KAGI_API_KEY = "abc123";
    process.env.KAGI_LIMIT = "0";
    assert.throws(() => loadConfig(), /limit must be between 1 and 100/);
  });
});
