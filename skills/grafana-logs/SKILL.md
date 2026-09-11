---
name: grafana-logs
description: Queries Grafana Loki logs with the GCX CLI and discovers log labels and streams. Use when asked to search Grafana logs, investigate application errors, or correlate log events during an incident.
---

# Grafana logs

```diagram
┌──────────────────────┐     ┌──────────┐     ┌───────────────────┐
│ Labels + time window │────▶│ gcx logs │────▶│ Grafana Loki logs │
└──────────────────────┘     └──────────┘     └───────────────────┘
```

Use the pre-installed, authenticated `gcx` CLI directly. No installation,
login, credentials, or bundled script is needed. Use the configured default
Loki datasource when unambiguous; otherwise discover and select its UID.

## Workflow

1. Establish the target service, environment, and time window from the request.
   Inspect the configured context with `gcx config current-context`. If the
   target is ambiguous, clarify before querying. Add `--context NAME` to select a context for one invocation
   without changing the saved default; add `--datasource UID` to select a Loki
   datasource by UID, not display name. Discover available Loki datasources with
   `gcx --context NAME datasources list --type loki -o json`, replacing `NAME`
   with the confirmed context. Keep the context and datasource consistent across
   all discovery and query commands.
2. Discover indexed labels and their values before constructing a selector.
   Replace the example labels and values below with ones actually present.
3. Start with a narrow selector, a short time window, and an explicit line
   limit. Filter by error text or a request/trace ID, then inspect surrounding
   events in the same bounded interval to establish context.
4. Report the context/datasource used, exact LogQL expression, time window and
   timezone, relevant timestamps, and representative redacted lines. Separate
   observed errors from hypotheses about their cause. A capped sample is not a
   total count; no matches do not prove the absence of an incident.

## Commands

Check `gcx logs query --help`, `gcx logs labels --help`, or
`gcx logs series --help` if the installed version differs. Options are
command-specific; do not guess flags from another Loki CLI.

```sh
# Discover label names, values, and matching stream-label combinations.
gcx logs labels -o json
gcx logs labels --label service_name -o json
gcx logs series --match '{service_name="checkout"}' -o json

# Search recent errors or correlate an ID (replace example values).
gcx logs query '{service_name="checkout"} |= "error"' --since 30m --limit 100 -o json
gcx logs query '{service_name="checkout"} |= "request-id-here"' --since 30m --limit 100 -o json

# Inspect a capped sample of service events during an exact incident window.
gcx --context prod logs query --datasource LOKI_UID \
  '{service_name="checkout"}' \
  --from '2026-09-10T10:00:00Z' --to '2026-09-10T10:15:00Z' \
  --limit 200 -o json
```

| Option | Meaning |
| --- | --- |
| `query --since 30m` | Query a duration ending now (or at `--to`); incompatible with `--from` |
| `query --from TIME --to TIME` | Explicit range; use both, preferably RFC3339 timestamps with timezone offsets |
| `query --limit N` | Maximum log lines; default 50, while 0 removes the GCX cap—avoid 0 for investigations |
| `labels --label NAME` | Values for one indexed label; omit to list label names |
| `series --match SELECTOR` | Required stream selector; repeat for a union of selectors, not an intersection |
| `-o json` | Structured output; query JSON preserves timestamps, stream labels, and log bodies |

Always give queries a time range rather than relying on their instant-query
default. Convert user-local incident times to explicit offsets or UTC, accounting
for daylight saving time. `labels` and `series` have no time-range or limit flags;
they discover labels/streams, not events within the incident window. There is no
`--direction` flag; use `--from`/`--to`, not `--start`/`--end`.

Single-quote LogQL so the shell preserves its quotes and operators. `|=` matches
literal text case-sensitively; `|~ "(?i)error|exception"` is a case-insensitive
regex filter. Use `| json` only for JSON log bodies, for example
`'{service_name="checkout"} | json | __error__="" | level="error"'`.
Parsed fields are not necessarily indexed labels. Default table output may
transform JSON/logfmt bodies; prefer `-o json` for analysis, not `-o raw`, which
emits only line bodies.

## Safety

- Keep this workflow read-only. Do not change contexts, datasources, retention,
  or Adaptive Logs drop rules to investigate a log query.
- Logs may contain secrets or personal data. Redact sensitive values in reports
  and avoid dumping entire responses when a few lines answer the question.
- On empty results, check the target, labels, timezone, and filters before
  widening the window. On timeouts or rate limits, narrow queries rather than
  repeatedly requesting a larger result set.
- Report permission, authentication, or missing-configuration errors without
  printing credentials or attempting login/setup; those are outside this skill.

Reference: [GCX CLI command reference](https://github.com/grafana/gcx/tree/main/docs/reference/cli).
