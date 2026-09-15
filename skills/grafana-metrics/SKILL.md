---
name: grafana-metrics
description: Queries Grafana Cloud Prometheus metrics and discovers names, labels, and metadata through the hosted MCP server using a Node.js proxy with OAuth login and token refresh. Use when inspecting rates, latency, trends, or service health in Grafana; no gcx CLI is needed.
---

# Grafana metrics

```diagram
┌─────────────────┐     ┌───────────────────┐     ┌────────────────────┐
│ Browser consent │────▶│ grafana.mjs       │────▶│ Grafana Cloud MCP  │
│ OAuth + PKCE    │     │ PromQL → MCP call │     │ Prometheus metrics │
└─────────────────┘     └───────────────────┘     └────────────────────┘
```

Run the bundled zero-dependency Node.js 22+ script at
`{baseDir}/grafana.mjs`. It proxies shell commands to
`https://mcp.grafana.com/mcp` using Streamable HTTP, not legacy SSE transport.
This skill directory is self-contained; no sibling directories are required.

## Configuration and login

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRAFANA_URL` | no | HTTPS stack origin, e.g. `https://your-stack.grafana.net`; sent as `X-Grafana-URL` and used to isolate cached logins |
| `GRAFANA_OAUTH_PORT` | no | Loopback callback port; default `8787` |
| `XDG_CONFIG_HOME` | no | Credential storage root; default `~/.config` (keep outside the repository) |

Run `node {baseDir}/grafana.mjs status` first. If needed, have the
user run `node {baseDir}/grafana.mjs login` and open the printed
authorization URL in a browser on the same computer. Select the intended stack
if prompted. The proxy handles public-client registration, OAuth authorization
code + PKCE/state validation, secure local storage, and automatic token refresh.
Only **Read access** is needed; leave **Query access** and **Write access** off.

For an orb, SSH session, or other remote shell, use this two-step Bash flow
in the user's terminal (not agent tool arguments):

```sh
node {baseDir}/grafana.mjs login --manual
# Open the printed Grafana URL. After consent, the loopback page may fail to load.
# Copy its complete address, including code and state. Within five minutes:
read -r -s -p 'Paste callback URL: ' callback; printf '\n'
printf '%s\n' "$callback" | node {baseDir}/grafana.mjs login --callback
unset callback
```

Never paste callback URLs, codes, or tokens into chat or command arguments.
The two skills share credentials when `GRAFANA_URL` is identical; no second login
is needed. Tokens live in owner-only files (0600) under
`~/.config/pi-kit/grafana/` (0700), or the corresponding XDG directory. They are
not encrypted. Run commands sequentially to avoid competing refreshes.
`status` is a local expiry check, not remote validation of the connection.
Ctrl-C stops new work and waits for any in-flight OAuth exchange/save before
releasing the lock; shutdown can take up to the request's 30-second timeout.

## Discover, then query

```sh
node {baseDir}/grafana.mjs tools list_datasources
node {baseDir}/grafana.mjs call list_datasources '{"type":"prometheus"}'
node {baseDir}/grafana.mjs tools list_prometheus_metric_names
node {baseDir}/grafana.mjs tools list_prometheus_metric_metadata
node {baseDir}/grafana.mjs tools list_prometheus_label_names
node {baseDir}/grafana.mjs tools list_prometheus_label_values
node {baseDir}/grafana.mjs tools query_prometheus
# Write arguments matching the discovered inputSchema, then execute:
node {baseDir}/grafana.mjs call query_prometheus --file /tmp/prometheus-query.json
```

Inspect the live `inputSchema` before each kind of call. Do not guess names,
time formats/units, query-type values, or step syntax from another CLI.
`tools [NAME]` follows tool-list pagination and returns only allowed read tools.
`call NAME 'JSON'` passes an object unchanged; `--file PATH` reads a JSON file,
and `--file -` reads stdin. Output preserves the complete MCP result, including
`content`, `structuredContent`, and `isError`; tool errors exit nonzero. Handle
pagination inside a tool's data result using that tool's schema. The proxy also
allows `query_prometheus_histogram`, `get_datasource`, and `generate_deeplink`.

1. Confirm stack, service, environment, symptom, and time window. Discover the
   Prometheus datasource and keep its UID consistent across calls; clarify
   ambiguous targets rather than choosing silently.
2. Discover metric names, type/help metadata, units, and actual label values
   before writing PromQL. Scope discovery by selectors/time when supported.
3. Use an instant query for a snapshot or a bounded range query for a trend.
   Specify the evaluation time or start/end plus a positive step using the
   schema's units. A larger step reduces evaluation points, not series count,
   and may hide short spikes. Aggregate unnecessary series instead.
4. Report stack/datasource, exact PromQL, time window/timezone, step, units, and
   relevant values or peaks. Convert local times to explicit offsets or UTC,
   accounting for daylight saving. Empty results are not zero; preserve gaps,
   `NaN`, and infinite values. Separate measurements from causal hypotheses.

PromQL examples (replace names and values with discovered ones):

```promql
up{job="checkout"}
sum by (job) (rate(http_requests_total{job="checkout"}[5m]))
histogram_quantile(0.95, sum by (le, job) (rate(http_request_duration_seconds_bucket{job="checkout"}[5m])))
```

Use `rate` for per-second counter rates, `increase` for estimated counter changes,
and neither for gauges. Apply them before aggregation to handle resets. Choose
a rate window containing enough scrapes (typically at least four intervals).
The `[5m]` lookback and query step serve different purposes. Retain `le` when
aggregating classic histogram buckets; do not average precomputed quantiles.

## Safety and failures

- The proxy requests only `grafana:read` and blocks raw SQL and write tools.
  Do not change datasources, recording rules, or alerts to investigate metrics.
- Redact sensitive label values, never print the token cache, and remove
  temporary query files after use. Report only the series/samples needed.
- Check target, names, labels, timezone, and scrape gaps before widening empty
  queries. Narrow selectors/ranges after HTTP 429, timeouts, or server errors;
  these failures are not automatically retried. HTTP 401 triggers one refresh
  retry; an expired MCP session is reopened once.
- HTTP 403: check Assistant terms, the **Assistant Cloud MCP User** role (or
  `grafana-assistant-app.cloud-mcp:access`), and read consent. Revoked refresh
  tokens or Grafana's 30-day refresh limit require a new browser login.
- `node {baseDir}/grafana.mjs logout` removes local credentials only.
  Revoke remote access in **Assistant → Settings → Connectors → MCP clients**.
  Cloud MCP access counts toward Grafana Assistant active-user usage.

Reference: [Grafana Cloud MCP server](https://grafana.com/docs/grafana-cloud/ai-tools/mcp-servers/cloud-mcp/).
