import type { ExaConfig } from "./config.ts";

export interface ExaSearchOptions {
  query: string;
  numResults?: number;
  category?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
}

export interface ExaResult {
  title?: string | null;
  url: string;
  publishedDate?: string | null;
  author?: string | null;
  score?: number | null;
  id?: string;
  text?: string;
  highlights?: string[];
  summary?: string;
}

export interface ExaSearchResponse {
  requestId?: string;
  results: ExaResult[];
  searchType?: string;
  costDollars?: { total?: number };
}

/**
 * Build the JSON request body for the Exa /search endpoint, merging
 * per-call options on top of the configured defaults.
 */
export function buildSearchRequest(
  options: ExaSearchOptions,
  config: ExaConfig,
): Record<string, unknown> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }

  const numResults = options.numResults ?? config.numResults;
  if (!Number.isFinite(numResults) || numResults < 1 || numResults > 100) {
    throw new Error(`numResults must be between 1 and 100 (got: ${numResults})`);
  }

  const body: Record<string, unknown> = {
    query,
    type: config.searchType,
    numResults: Math.round(numResults),
  };

  const category = options.category ?? config.category;
  if (category) body.category = category;
  if (options.includeDomains?.length)
    body.includeDomains = options.includeDomains;
  if (options.excludeDomains?.length)
    body.excludeDomains = options.excludeDomains;
  if (options.startPublishedDate)
    body.startPublishedDate = options.startPublishedDate;
  if (options.endPublishedDate)
    body.endPublishedDate = options.endPublishedDate;

  if (config.includeText) {
    body.contents = {
      text:
        config.maxCharacters > 0
          ? { maxCharacters: config.maxCharacters }
          : true,
    };
  }

  return body;
}

/** Render an Exa search response as readable text for the agent. */
export function formatResults(
  response: ExaSearchResponse,
  query: string,
): string {
  const results = response.results ?? [];
  if (results.length === 0) {
    return `No Exa results found for "${query}".`;
  }

  const blocks = results.map((r, i) => {
    const lines = [`${i + 1}. ${r.title?.trim() || "(untitled)"}`, `   ${r.url}`];
    if (r.publishedDate) lines.push(`   Published: ${r.publishedDate}`);
    if (r.author) lines.push(`   Author: ${r.author}`);
    const body = (r.summary?.trim() ||
      r.highlights?.join(" … ").trim() ||
      r.text?.trim()) as string | undefined;
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

  return `Exa results for "${query}":\n\n${blocks.join("\n\n")}`;
}

export async function exaSearch(
  options: ExaSearchOptions,
  config: ExaConfig,
): Promise<ExaSearchResponse> {
  const body = buildSearchRequest(options, config);

  const resp = await fetch(`${config.baseUrl}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = (await resp.text().catch(() => "")).trim();
    const suffix = errText ? `: ${errText}` : "";
    throw new Error(
      `Exa API error ${resp.status} ${resp.statusText}${suffix}`,
    );
  }

  return (await resp.json()) as ExaSearchResponse;
}
