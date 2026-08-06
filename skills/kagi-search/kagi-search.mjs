#!/usr/bin/env node
// Kagi web search CLI. Requires KAGI_API_KEY. No dependencies (Node 18+).
//
// Usage:
//   node kagi-search.mjs "query" [options]
//
// Options:
//   --limit <n>   Number of results, 1-100 (default 10)
//   --related     Include Kagi's "related searches" suggestions
//   --json        Print the raw JSON response instead of formatted text

const args = process.argv.slice(2);
const opts = { limit: 10, related: false, json: false };
const positional = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case "--limit": opts.limit = Number(args[++i]); break;
    case "--related": opts.related = true; break;
    case "--json": opts.json = true; break;
    default: positional.push(a);
  }
}

const query = positional.join(" ").trim();
const apiKey = process.env.KAGI_API_KEY;
const baseUrl = (process.env.KAGI_BASE_URL || "https://kagi.com/api/v0").replace(/\/$/, "");

if (!query) fail('usage: node kagi-search.mjs "query" [--limit 10] [--related] [--json]');
if (!apiKey) fail("KAGI_API_KEY is not set. Get a token from https://kagi.com/settings?p=api");
if (!Number.isFinite(opts.limit) || opts.limit < 1 || opts.limit > 100) fail(`--limit must be 1-100 (got: ${opts.limit})`);

// The v0 API is a GET with query params; the v1 API is a POST with a JSON body.
const isV1 = /\/api\/v1$/.test(baseUrl);
const limit = Math.round(opts.limit);
const resp = await fetch(
  isV1
    ? `${baseUrl}/search`
    : `${baseUrl}/search?${new URLSearchParams({ q: query, limit: String(limit) })}`,
  {
    method: isV1 ? "POST" : "GET",
    headers: {
      Authorization: `Bot ${apiKey}`,
      ...(isV1 ? { "Content-Type": "application/json", Accept: "application/json" } : {}),
    },
    body: isV1 ? JSON.stringify({ query, limit }) : undefined,
  },
);

if (!resp.ok) {
  const errText = (await resp.text().catch(() => "")).trim();
  fail(`Kagi API error ${resp.status} ${resp.statusText}${errText ? `: ${errText}` : ""}`);
}

const response = await resp.json();

const errors = response.error ?? response.errors;
if (errors?.length) {
  fail(`Kagi API returned an error: ${errors.map((e) => e.msg || e.message || `code ${e.code}`).join("; ")}`);
}

if (opts.json) {
  console.log(JSON.stringify(response, null, 2));
  process.exit(0);
}

// v0 returns data as an array of typed items (t:0 results, t:1 related
// searches); v1 returns { search: [...], related: [...] }.
const rawData = response.data;
const results = Array.isArray(rawData)
  ? rawData.filter((item) => item.t === 0)
  : (rawData?.search ?? []);

if (results.length === 0) {
  console.log(`No Kagi results found for "${query}".`);
  process.exit(0);
}

const blocks = results.map((r, i) => {
  const lines = [`${i + 1}. ${r.title?.trim() || "(untitled)"}`, `   ${r.url}`];
  if (r.published) lines.push(`   Published: ${r.published}`);
  const snippet = r.snippet?.trim();
  if (snippet) {
    lines.push("", snippet.split("\n").map((l) => `   ${l}`).join("\n"));
  }
  return lines.join("\n");
});
let output = `Kagi results for "${query}":\n\n${blocks.join("\n\n")}`;

if (opts.related) {
  const related = (Array.isArray(rawData)
    ? rawData.filter((item) => item.t === 1).flatMap((item) => item.list ?? [])
    : (rawData?.related ?? [])
  ).filter((s) => typeof s === "string" && s.trim());
  if (related.length > 0) {
    output += `\n\nRelated searches:\n${related.map((s) => `  - ${s}`).join("\n")}`;
  }
}
console.log(output);

function fail(message) {
  console.error(message);
  process.exit(1);
}
