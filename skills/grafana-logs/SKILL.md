---
name: grafana-logs
description: Queries Grafana Cloud Loki logs and discovers log labels through the hosted MCP server using a Node.js proxy with OAuth login and token refresh. Use when searching Grafana logs, investigating application errors, or correlating incident events; no gcx CLI is needed.
---

# Grafana logs

```diagram
┌─────────────────┐     ┌──────────────────┐     ┌───────────────────┐
│ Browser consent │────▶│ grafana.mjs      │────▶│ Grafana Cloud MCP │
│ OAuth + PKCE    │     │ LogQL → MCP call │     │ Loki logs         │
└─────────────────┘     └──────────────────┘     └───────────────────┘
```

Run the bundled zero-dependency Node.js 22+ script at
`{baseDir}/grafana.mjs`. It proxies shell commands to
`https://mcp.grafana.com/mcp` using Streamable HTTP, not legacy SSE transport.
This skill directory is self-contained; no sibling directories are required.
Use `grafana-metrics` for Prometheus metrics.

## Configuration and login

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRAFANA_URL` | no | HTTPS stack origin, e.g. `https://your-stack.grafana.net`; sent as `X-Grafana-URL` and used to isolate cached logins |
| `GRAFANA_OAUTH_PORT` | no | Loopback callback port; default `8787` |
| `XDG_CONFIG_HOME` | no | Credential storage root; default `~/.config` (keep outside the repository) |

Run `node {baseDir}/grafana.mjs status` first. If login is needed,
have the user run `node {baseDir}/grafana.mjs login` and open its
printed authorization URL in a browser on the same computer. The script
registers a public OAuth client, verifies state and PKCE, exchanges the code,
and saves tokens. Select the intended stack during consent if prompted.
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

Never paste the callback into chat, shell history, or command arguments.
Both skills share the same login when `GRAFANA_URL` is identical. Tokens are
stored in owner-only files (0600) under `~/.config/pi-kit/grafana/` (0700),
or the corresponding XDG directory. They are not encrypted; treat the directory
as secret. Run commands sequentially to avoid competing refresh-token rotations.
Expired access tokens refresh automatically, including one retry after HTTP 401.
`status` checks the local cache, not whether Grafana has revoked access.
Ctrl-C stops new work and waits for any in-flight OAuth exchange/save before
releasing the lock; shutdown can take up to the request's 30-second timeout.

## Discover, then query

```sh
node {baseDir}/grafana.mjs tools list_datasources
node {baseDir}/grafana.mjs call list_datasources '{"type":"loki"}'
node {baseDir}/grafana.mjs tools list_loki_label_names
node {baseDir}/grafana.mjs tools list_loki_label_values
node {baseDir}/grafana.mjs tools query_loki_logs
# Write arguments matching the discovered inputSchema, then execute:
node {baseDir}/grafana.mjs call query_loki_logs --file /tmp/loki-query.json
```

`tools [NAME]` returns live input schemas, following tool-list pagination and
filtering out unrelated/write tools. Inspect each tool's schema before calling:
do not translate old CLI flags or guess argument names, timestamp formats, or
units. `call NAME 'JSON'` and `call NAME --file PATH` pass an object unchanged;
`--file -` reads stdin. Output is the complete MCP result, preserving `content`,
`structuredContent`, and `isError`; tool errors exit nonzero. Tool-list pagination
is automatic, but pagination within a tool's data result must be handled using
that tool's schema. `query_loki_stats` and `query_loki_patterns` are also allowed.

1. Confirm stack, service, environment, and incident window. Discover the Loki
   datasource and use its UID consistently; never silently choose among matches.
2. Discover indexed labels and actual values, scoped by selector/time where the
   schema allows. Parsed JSON fields are not necessarily indexed labels.
3. Query a narrow selector with explicit start/end and a small positive line
   limit (initially 100). For example, `{service_name="checkout"} |= "error"`
   only after confirming that label/value exists. `|=` is case-sensitive;
   `|~ "(?i)error|exception"` is a case-insensitive regex. Use `| json` only for
   JSON bodies. Inspect surrounding events in the same bounded interval.
4. Report stack/datasource, exact LogQL, time window/timezone, timestamps, and
   representative redacted lines. Convert local times using explicit UTC offsets,
   including daylight saving. A capped sample is not a count; no matches do not
   prove there was no incident. Separate observations from causal hypotheses.

## Safety and failures

- The proxy requests only `grafana:read` and allowlists datasource, Loki, and
  Prometheus read tools. It cannot run raw SQL, writes, or arbitrary MCP methods.
- Redact secrets and personal data in logs/labels; remove temporary query files
  when finished. Never print the credential cache or enable HTTP token logging.
- On empty results, check datasource, labels, filters, and timezone before
  widening. On HTTP 429, timeouts, or server errors, narrow the query; these
  failures are not automatically retried. An expired MCP session is reopened once.
- HTTP 403: check Assistant terms acceptance, the **Assistant Cloud MCP User**
  role (or `grafana-assistant-app.cloud-mcp:access`), and read consent. Revoked
  refresh tokens or the end of Grafana's 30-day refresh period require login.
- `node {baseDir}/grafana.mjs logout` deletes only local credentials.
  Revoke the connection separately in **Assistant → Settings → Connectors → MCP
  clients**. Cloud MCP access counts toward Grafana Assistant active-user usage.

Reference: [Grafana Cloud MCP server](https://grafana.com/docs/grafana-cloud/ai-tools/mcp-servers/cloud-mcp/).
