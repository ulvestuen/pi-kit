export const DEFAULT_BASE_URL = "https://api.exa.ai";

export function buildSearchRequest({ baseUrl = DEFAULT_BASE_URL, apiKey, query, options }) {
  const body = {
    query,
    type: options.type,
    numResults: Math.round(options.limit),
  };
  if (options.category) body.category = options.category;
  if (options.includeDomains?.length) body.includeDomains = options.includeDomains;
  if (options.excludeDomains?.length) body.excludeDomains = options.excludeDomains;
  if (options.startDate) body.startPublishedDate = options.startDate;
  if (options.endDate) body.endPublishedDate = options.endDate;
  if (options.maxChars !== 0) {
    body.contents = {
      text: options.maxChars > 0 ? { maxCharacters: options.maxChars } : true,
    };
  }

  return {
    url: `${baseUrl.replace(/\/+$/, "")}/search`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
    },
  };
}
