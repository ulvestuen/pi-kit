---
name: grafana-metrics
description: Queries Grafana Prometheus metrics with the GCX CLI and discovers metric names, labels, metadata, and series. Use when asked to fetch metrics, inspect rates or latency, compare trends, or investigate service health in Grafana.
---

# Grafana metrics

```diagram
┌──────────────────────┐     ┌─────────────┐     ┌────────────────────────────┐
│ PromQL + time window │────▶│ gcx metrics │────▶│ Grafana Prometheus metrics │
└──────────────────────┘     └─────────────┘     └────────────────────────────┘
```

Use the pre-installed, authenticated `gcx` CLI directly. No installation,
login, credentials, or bundled script is needed. Use the configured default
Prometheus datasource when unambiguous; otherwise discover and select its UID.
Use `grafana-logs` for Loki log events rather than Prometheus metrics.

## Workflow

1. Establish the service, environment, metric or symptom, and time window.
   Inspect `gcx config current-context`. If the target is ambiguous, clarify
   before querying. Add `--context NAME` for one invocation without changing
   the saved default. Discover datasources with
   `gcx --context NAME datasources list --type prometheus -o json`, replacing
   `NAME` with the confirmed context. Select with `--datasource UID`, not a
   display name; pass it explicitly if no default is configured. Keep the
   context and datasource consistent across discovery and queries.
2. Discover metric names, metadata, and labels before constructing PromQL.
   Confirm the metric type, units, and actual label values; replace the example
   metrics and labels below with ones present in the target datasource.
3. Choose an instant query for a snapshot or a range query for a trend. Start
   with narrow selectors and a short window; choose a positive `--step` to
   control evaluation density and aggregate away unnecessary series.
4. Report the context/datasource, exact PromQL, evaluation time or range and
   timezone, step, units, and relevant values or peaks. Separate measurements
   from causal hypotheses. Empty results are not zero; missing samples and
   `NaN`/infinite values must not be silently converted to zero.

## Commands

Check `gcx metrics <command> --help` if the installed version differs. Options
are command-specific; do not copy flags from `gcx logs` or another metrics CLI.

```sh
# Discover metric names, type/help metadata, labels, and matching series.
gcx metrics list-names --prefix http_ --limit 50 -o json
gcx metrics metadata --metric http_requests_total -o json
gcx metrics labels --metric http_requests_total -o json
gcx metrics labels --metric http_requests_total --label job -o json
gcx metrics series '{__name__="http_requests_total",job="checkout"}' --since 30m -o json

# Snapshot at an explicit instant; omit --time only when "now" is intended.
gcx metrics query 'up{job="checkout"}' --time '2026-09-10T10:15:00Z' -o json

# Request rate per second, grouped by job, over the last 30 minutes.
gcx metrics query 'sum by (job) (rate(http_requests_total{job="checkout"}[5m]))' \
  --since 30m --step 1m -o json

# Classic-histogram p95 latency in seconds during an exact incident window.
gcx --context prod metrics query --datasource PROMETHEUS_UID \
  'histogram_quantile(0.95, sum by (le, job) (rate(http_request_duration_seconds_bucket{job="checkout"}[5m])))' \
  --from '2026-09-10T10:00:00Z' --to '2026-09-10T10:15:00Z' \
  --step 1m -o json
```

| Option | Meaning |
| --- | --- |
| `query --time TIME` | Instant evaluation; incompatible with `--from`, `--to`, or `--since` |
| `query/series --since 30m` | Range ending now (or at `--to`); incompatible with `--from` |
| `query/series --from TIME --to TIME` | Explicit range; both required, preferably RFC3339 with timezone offsets |
| `query --step 1m` | Range evaluation interval, not the PromQL lookback window or scrape interval |
| `list-names --prefix TEXT --limit N` | Case-sensitive name filter and output cap; default 100, while 0 removes the cap |
| `labels --metric METRIC --label LABEL` | Values for a label on one metric; omit `--label` for label names |
| `list-names/labels/series --match SELECTOR` | Scope series lookup; repeated selectors form a union, not an intersection |
| `metadata --metric METRIC` | Type/help metadata for one metric, not sample values |
| `-o json` | Structured output for analysis; preserve timestamps, labels, and values |

Without time flags, `query` is instant and `series` is unbounded. Always bound
series discovery. `list-names`, `labels`, and `metadata` have no time-range
flags, so their results do not establish presence during an incident.
Only `list-names` has `--limit`; it and name filters apply after fetching names.
Prefer `--match` for server-side scoping. Queries, labels, metadata, and series
have no result-limit flag. A larger step reduces evaluation points, not series
cardinality, and can hide short spikes. Convert user-local times to explicit
offsets or UTC, accounting for daylight saving time.

Single-quote PromQL to preserve shell operators and quotes. Use `rate` for
per-second counter rates or `increase` for estimated counter changes over a
window; apply them before aggregation to handle resets. Do not apply `rate`
to gauges. Choose a rate window with enough scrapes (typically at least four
scrape intervals); `[5m]` and `--step 1m` serve different purposes. For classic
histogram quantiles, retain `le` when aggregating bucket rates, as above; do not
average precomputed quantiles. Preserve units and use the same selectors and
resolution for comparisons.

## Safety

- Keep this workflow read-only. Do not change contexts, datasources, recording
  rules, alerts, or Adaptive Metrics aggregation rules to investigate metrics.
- Labels may contain secrets or personal data. Redact sensitive values and
  report only the series and samples needed; never enable insecure HTTP logging.
- On empty results, check the target, names, labels, timezone, and scrape gaps
  before widening the query. On timeouts or rate limits, narrow selectors or
  ranges rather than repeatedly requesting larger results.
- Report permission, authentication, or missing-configuration errors without
  printing credentials or attempting login/setup; those are outside this skill.

Reference: [GCX metrics command reference](https://github.com/grafana/gcx/blob/main/docs/reference/cli/gcx_metrics.md).
