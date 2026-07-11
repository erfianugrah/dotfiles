---
name: gocurl
description: Drive the user's `gocurl` CLI - a Go HTTP performance-measurement tool (curl-like flags + httptrace phase breakdown + load testing + streaming/buffering analysis). Use when measuring HTTP latency, breaking a request into DNS/TCP/TLS/server/transfer phases, load-testing an endpoint (percentiles, RPS, tail latency), comparing endpoints or environments, validating streaming/SSE endpoints in CI, or emitting HTTP-probe metrics as JSON/CSV/Prometheus for reports and automation. Fires on "test the latency of <url>", "load test", "TTFB / waterfall / phase breakdown", "PostgREST vs direct latency" (the HTTP side), "p95/p99 of this API", "gocurl". HTTP-only - for Postgres/TCP wire-protocol latency use psql/pgbench, not gocurl. Sibling to `sbperf` (Supabase perf), `fly`, `supabase`. Repo `~/gocurl`, binary `/usr/local/bin/gocurl` (built via `make build` to `./bin/gocurl`, `make install` copies to /usr/local/bin). Go 1.24+.
---

# gocurl - HTTP performance measurement

`gocurl` measures HTTP request timing (via Go's `httptrace`), runs concurrent
load tests, and analyzes streaming/buffering. It is **HTTP-only**: it cannot
speak the Postgres/Redis/raw-TCP wire protocol. For direct-DB latency reach for
`psql`/`pgbench` and compare against gocurl's PostgREST numbers.

Full reference (flag matrix, combination rules, recipes): `~/gocurl/docs/USAGE.md`.
Release history: `~/gocurl/CHANGELOG.md`.

## Execution model (decides what you get)

- **Single request** = `-n 1` (default) **and** exactly one URL. Keep-alive off,
  so you get the **per-phase breakdown** (DNS/TCP/TLS/server/transfer). Streaming
  analysis lives here.
- **Load test** = `-n > 1` **or** multiple URLs. Connection pooling on. You get
  **aggregate percentiles / RPS / status distribution**, no per-phase split.

`--warmup`, `--rps`, `--ramp-up`, `--export-csv` apply only to the load path.
`--streaming` / `--expect-streaming` apply only to the single-request path.

## Command patterns

```bash
# Single request, full phase breakdown (JSON, fractional ms)
gocurl -o json <url> | jq '{dns_lookup,tcp_connection,tls_handshake,server_processing,content_transfer,total,status_code}'

# Warm serial latency (connection reused, cold requests discarded) - isolates server+RTT
gocurl -o json -n 120 -c 1 --warmup 20 <url> \
  | jq '{min:.min_latency,p50:.p50,p95:.p95,p99:.p99,rps:.requests_per_second}'

# Concurrent load - tail latency + throughput
gocurl -o json -n 400 -c 20 <url> | jq '{p50,p95,p99,rps:.requests_per_second,failed:.failed_requests}'

# Auth header (e.g. PostgREST)
gocurl -o json -n 200 -c 1 --warmup 20 -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$URL"

# Human view (waterfall + phase %), histogram, CSV, Prometheus
gocurl <url>                                  # table (default)
gocurl -o graph -n 400 -c 20 <url>            # ASCII histogram
gocurl -n 400 -c 20 --export-csv out.csv <url>
gocurl -o prom  -n 200 -c 10 -q <url>         # Prometheus text exposition
```

## Output formats and units

| Format | Flag | Unit | Use |
|--------|------|------|-----|
| table | `-o table` (default) | ms | interactive |
| json | `-o json` | **fractional ms** | scripting/CI |
| graph | `-o graph` | ms | eyeball distribution |
| prom | `-o prom` | **seconds** | monitoring/reports |

Load-mode JSON/prom = aggregate `Stats` (no per-phase). Single-request = per-phase.
stdout is a clean data channel (notices go to stderr), so `| jq` and `> x.prom` are safe.

## Gotchas (post-v1.4.0)

- **Streaming is single-request only.** `--streaming`/`--expect-streaming` with
  `-n>1` or multiple URLs now **errors** (it used to false-pass in CI). Validate
  with one request: `gocurl --expect-streaming <url>`.
- **JSON is fractional ms**; shell integer compare breaks - use `jq -e '.p95 > 500'`.
- **prom is seconds**, not ms - don't mix json (ms) and prom (s) in one dashboard.
- **4xx/5xx count as failed** in load stats (`error_rate`/`failed_requests`), but a
  single-request 4xx/5xx still **exits 0** (curl semantics). Gate CI on `error_rate`.
- **`--warmup` must be `< -n`**; warmup requests are excluded from stats and CSV.
- **`--ramp-up` needs `-c>1`**; worker `i` activates at `t=(rampup/(c-1))*i`. If the
  queue drains before the ramp finishes, raise `-n`.
- **`--rps` is global**, not per-worker. **`--query-params`** Cartesian-multiplies URLs.
- **Region/distance dominates** any hosted-endpoint latency - warm `min_latency` is
  the RTT floor; compare same-region to isolate server-side cost.
- **Ctrl-C** cancels in-flight requests, prints partial stats, exits non-zero.

## Reports / automation

- **CSV** per-request rows (`--export-csv`), analyze with `mlr`.
- **Prometheus textfile**: `gocurl -o prom -q ... > /var/lib/node_exporter/textfile_collector/x.prom`
  (write to temp + `mv` for atomicity). Validate with `promtool check metrics`.
- **Pushgateway**: pipe `-o prom` output to `curl --data-binary @-`.
- **CI gate**: `gocurl -o json ... | jq -e '.p95 > N'`.

See `docs/USAGE.md` for the full recipe set.

## Build / release

```bash
cd ~/gocurl
make build            # -> ./bin/gocurl (ldflags inject version/commit/date)
make install          # sudo cp ./bin/gocurl /usr/local/bin/gocurl
make test             # go test ./...
go run golang.org/x/tools/cmd/deadcode@latest ./...   # dead-code audit
```

Releases are tag-driven via GoReleaser: `git tag -a vX.Y.Z -m ...; git push origin vX.Y.Z`.
Prometheus formatter lives in `internal/output/prom.go`; formats registered in
`internal/output/formatter.go` (`GetFormatter`).
