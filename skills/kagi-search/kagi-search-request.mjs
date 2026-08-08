// Request construction shared by the Kagi search CLI and its tests.

// New Kagi API keys use v1. Keep v0 support for legacy endpoints supplied via
// KAGI_BASE_URL, but do not send modern keys to the legacy API by default.
export const DEFAULT_BASE_URL = "https://kagi.com/api/v1";

export function buildSearchRequest({ baseUrl = DEFAULT_BASE_URL, apiKey, query, limit }) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const isV1 = /\/api\/v1$/.test(normalizedBaseUrl);

  if (isV1) {
    return {
      url: `${normalizedBaseUrl}/search`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bot ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, limit }),
      },
    };
  }

  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return {
    url: `${normalizedBaseUrl}/search?${params}`,
    init: {
      method: "GET",
      headers: { Authorization: `Bot ${apiKey}` },
    },
  };
}
