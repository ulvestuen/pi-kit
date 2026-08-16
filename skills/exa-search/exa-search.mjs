#!/usr/bin/env node
import { buildSearchRequest, DEFAULT_BASE_URL } from "./exa-search-request.mjs";

// Exa web search CLI. Requires EXA_API_KEY. No dependencies (Node 18+).
//
// Usage:
//   node exa-search.mjs "query" [options]
//
// Options:
//   --limit <n>            Number of results, 1-100 (default 5)
//   --type <type>          auto | neural | keyword | fast | deep | deep-reasoning | instant (default auto)
//   --category <c>         Exa category filter, e.g. news, "research paper", github, company, pdf
//   --include-domains a,b  Only return results from these domains
//   --exclude-domains a,b  Never return results from these domains
//   --start-date <iso>     Only results published on/after this date
//   --end-date <iso>       Only results published on/before this date
//   --max-chars <n>        Max characters of page text per result, 0 = none (default 1000)
//   --json                 Print the raw JSON response instead of formatted text

const args = process.argv.slice(2);
const opts = { limit: 5, type: "auto", maxChars: 1000, json: false };
const positional = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case "--limit":
    case "--num": opts.limit = Number(args[++i]); break;
    case "--type": opts.type = args[++i]; break;
    case "--category": opts.category = args[++i]; break;
    case "--include-domains": opts.includeDomains = args[++i].split(",").filter(Boolean); break;
    case "--exclude-domains": opts.excludeDomains = args[++i].split(",").filter(Boolean); break;
    case "--start-date": opts.startDate = args[++i]; break;
    case "--end-date": opts.endDate = args[++i]; break;
    case "--max-chars": opts.maxChars = Number(args[++i]); break;
    case "--json": opts.json = true; break;
    default: positional.push(a);
  }
}

const query = positional.join(" ").trim();
const apiKey = process.env.EXA_API_KEY;
const baseUrl = process.env.EXA_BASE_URL || DEFAULT_BASE_URL;

if (!query) fail('usage: node exa-search.mjs "query" [--limit 5] [--type auto] [--json]');
if (!apiKey) fail("EXA_API_KEY is not set. Get a key from https://dashboard.exa.ai/api-keys");
if (!Number.isFinite(opts.limit) || opts.limit < 1 || opts.limit > 100) fail(`--limit must be 1-100 (got: ${opts.limit})`);

const request = buildSearchRequest({ baseUrl, apiKey, query, options: opts });
const resp = await fetch(request.url, request.init);

if (!resp.ok) {
  const errText = (await resp.text().catch(() => "")).trim();
  fail(`Exa API error ${resp.status} ${resp.statusText}${errText ? `: ${errText}` : ""}`);
}

const response = await resp.json();

if (opts.json) {
  console.log(JSON.stringify(response, null, 2));
  process.exit(0);
}

const results = response.results ?? [];
if (results.length === 0) {
  console.log(`No Exa results found for "${query}".`);
  process.exit(0);
}

const blocks = results.map((r, i) => {
  const lines = [`${i + 1}. ${r.title?.trim() || "(untitled)"}`, `   ${r.url}`];
  if (r.publishedDate) lines.push(`   Published: ${r.publishedDate}`);
  if (r.author) lines.push(`   Author: ${r.author}`);
  const text = (r.summary?.trim() || r.highlights?.join(" … ").trim() || r.text?.trim());
  if (text) {
    lines.push("", text.split("\n").map((l) => `   ${l}`).join("\n"));
  }
  return lines.join("\n");
});
console.log(`Exa results for "${query}":\n\n${blocks.join("\n\n")}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
