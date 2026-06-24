import type { KagiConfig } from "./config.ts";

export interface KagiSearchOptions {
  query: string;
  limit?: number;
}

/** A single search-result object from the Kagi /search endpoint (t: 0). */
export interface KagiSearchResult {
  t: 0;
  rank?: number;
  url: string;
  title?: string;
  snippet?: string | null;
  published?: string | null;
  thumbnail?: { url?: string } | null;
}

/** A "related searches" object from the Kagi /search endpoint (t: 1). */
export interface KagiRelatedSearches {
  t: 1;
  list: string[];
}

export type KagiSearchItem = KagiSearchResult | KagiRelatedSearches;

export interface KagiSearchResponse {
  meta?: {
    id?: string;
    node?: string;
    ms?: number;
    api_balance?: number;
  };
  data?: KagiSearchItem[];
  error?: Array<{ code?: number; msg?: string; ref?: string }>;
}

/**
 * Build the query-string parameters for the Kagi /search endpoint, merging
 * per-call options on top of the configured defaults.
 */
export function buildSearchParams(
  options: KagiSearchOptions,
  config: KagiConfig,
): URLSearchParams {
  const query = options.query.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }

  const limit = options.limit ?? config.limit;
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new Error(`limit must be between 1 and 100 (got: ${limit})`);
  }

  const params = new URLSearchParams({
    q: query,
    limit: String(Math.round(limit)),
  });
  return params;
}

function isSearchResult(item: KagiSearchItem): item is KagiSearchResult {
  return item.t === 0;
}

function isRelatedSearches(item: KagiSearchItem): item is KagiRelatedSearches {
  return item.t === 1;
}

/** Render a Kagi search response as readable text for the agent. */
export function formatResults(
  response: KagiSearchResponse,
  query: string,
  includeRelated: boolean,
): string {
  const items = response.data ?? [];
  const results = items.filter(isSearchResult);

  if (results.length === 0) {
    return `No Kagi results found for "${query}".`;
  }

  const blocks = results.map((r, i) => {
    const lines = [
      `${i + 1}. ${r.title?.trim() || "(untitled)"}`,
      `   ${r.url}`,
    ];
    if (r.published) lines.push(`   Published: ${r.published}`);
    const body = r.snippet?.trim();
    if (body) {
      lines.push("");
      lines.push(
        body
          .split("\n")
          .map((line) => `   ${line}`)
          .join("\n"),
      );
    }
    return lines.join("\n");
  });

  let output = `Kagi results for "${query}":\n\n${blocks.join("\n\n")}`;

  if (includeRelated) {
    const related = items
      .filter(isRelatedSearches)
      .flatMap((item) => item.list ?? [])
      .filter((s) => typeof s === "string" && s.trim());
    if (related.length > 0) {
      output += `\n\nRelated searches:\n${related
        .map((s) => `  - ${s}`)
        .join("\n")}`;
    }
  }

  return output;
}

export async function kagiSearch(
  options: KagiSearchOptions,
  config: KagiConfig,
): Promise<KagiSearchResponse> {
  const params = buildSearchParams(options, config);

  const resp = await fetch(`${config.baseUrl}/search?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bot ${config.apiKey}`,
    },
  });

  if (!resp.ok) {
    const errText = (await resp.text().catch(() => "")).trim();
    const suffix = errText ? `: ${errText}` : "";
    throw new Error(
      `Kagi API error ${resp.status} ${resp.statusText}${suffix}`,
    );
  }

  const json = (await resp.json()) as KagiSearchResponse;

  if (json.error && json.error.length > 0) {
    const msg = json.error
      .map((e) => e.msg || `code ${e.code}`)
      .join("; ");
    throw new Error(`Kagi API returned an error: ${msg}`);
  }

  return json;
}
