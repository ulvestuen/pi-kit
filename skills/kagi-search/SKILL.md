---
name: kagi-search
description: Search the web with the Kagi Search API from the command line. Use when the user asks to search the web, look something up, or verify facts online — and Kagi is the preferred or available search backend (KAGI_API_KEY is set).
---

# Kagi web search

Run a web search through the Kagi Search API using the bundled zero-dependency
Node script. Requires the `KAGI_API_KEY` environment variable (get a token at
https://kagi.com/settings?p=api). `KAGI_BASE_URL` optionally overrides the API
endpoint (default `https://kagi.com/api/v0`; a URL ending in `/api/v1` switches
to the v1 request format automatically).

## Usage

```sh
node {baseDir}/kagi-search.mjs "your search query"
```

Options:

| Flag | Meaning |
| --- | --- |
| `--limit <n>` | number of results, 1-100 (default 10) |
| `--related` | include Kagi's "related searches" suggestions |
| `--json` | raw JSON response instead of formatted text |

Example:

```sh
node {baseDir}/kagi-search.mjs "postgres logical replication pitfalls" --limit 5
```

## Notes

- Kagi returns titles, URLs, and short snippets; fetch a result page yourself
  when you need more than the snippet.
- Cite result URLs when reporting findings to the user.
- If the script exits with an API error, report it plainly; do not retry more
  than once.
