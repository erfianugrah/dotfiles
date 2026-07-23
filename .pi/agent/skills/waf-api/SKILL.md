---
name: waf-api
description: Use when working with the wafctl WAF management API or waf-dashboard UI in ~/ergo/caddy-compose - querying or adding HTTP endpoints, exporting events, debugging rule/config changes that don't take effect (store-vs-deploy split), adding an event type / rule type / condition field / summary counter end-to-end, editing dashboard pages or the src/lib/api mapping layer, or checking wafctl env vars, auth, ports, stores, or the deploy pipeline.
---

# waf-api - wafctl API + waf-dashboard reference

## Overview

wafctl (`~/ergo/caddy-compose/wafctl/`, Go stdlib-only, single `package main`) is the
management plane for the custom Caddy WAF. It tails the Caddy access log, stores
events/rules/config in JSON files, and serves ~94 JSON API routes on `:8080` plus the
waf-dashboard static build (Astro 6 MPA + React 19 islands in
`~/ergo/caddy-compose/waf-dashboard/`). The policy-engine Caddy plugin is the data
plane; wafctl never touches traffic directly.

**Mental model - three invariants that explain most bugs:**

1. **Store mutation != deploy.** Every CRUD endpoint (`/api/rules`, `/api/config`,
   `/api/csp`, `/api/security-headers`, `/api/cors`, `/api/lists`, `/api/dos/config`,
   `/api/sessions/config`) only writes wafctl's JSON stores. Nothing reaches the WAF
   until a deploy endpoint regenerates `/data/waf/policy-rules.json`. "I changed X but
   traffic behavior didn't change" = missing deploy, 95% of the time.
2. **Two reload paths, don't confuse them.** (a) Plugin-facing: write
   `policy-rules.json` -> plugin hot-reloads on mtime (~5s). NO Caddy reload.
   (b) Caddyfile-facing (CF trusted proxies only): `reloadCaddy()` POSTs to admin
   `/load` with `Cache-Control: must-revalidate` to defeat Caddy's bytes.Equal no-op.
3. **One log, three tailers.** `AccessLogStore` (security events),
   `GeneralLogStore` (all requests, 2xx sampled at 10%), `SpikeDetector` (EPS) each
   tail `/var/log/combined-access.log` with independent offsets.

## Deploy-triggering endpoints (complete list)

Only these write `policy-rules.json`: `POST /api/deploy`, `POST /api/config/deploy`
(same handler), `POST /api/csp/deploy`, `POST /api/security-headers/deploy`,
`POST /api/blocklist/refresh` (indirect, via onDeploy callback). Background: boot
(`generateOnBoot`), 60s expired-rule cleanup, session auto-escalation. All serialized
by `deployMu`. `POST /api/config/generate` is preview-only. None reload Caddy.
`POST /api/cfproxy/refresh` is the ONLY endpoint that reloads Caddy (trusted proxies).

## Top gotchas

- **`/api/events?export=true` still needs `limit=10000`** - limit defaults to 50 and
  is only raised to the 10000 cap if `<=0` or `>10000`. Omitting it silently exports 50.
- **`offset` is ignored in export mode.** Over 10000 matches = truncated; narrow with
  `start`/`end` (RFC3339, wins over `hours`). Response has `total:-1` - use
  `total_emitted`; `== 10000` means assume truncation. 60s query timeout can also
  truncate mid-stream (JSON still closes cleanly).
- **Auth**: `WAF_AUTH_TOKEN` Bearer on all `/api/*` except `/api/health`. Empty token =
  unauthenticated. CORS default `*` without auth, deny-all with auth (`WAF_CORS_ORIGINS`).
- **`hours` cap**: 2160 (90d). `hours=0` = all time.
- **fieldFilter pattern**: `field=val&field_op=eq|neq|contains|in|regex` on
  `/api/summary`, `/api/events` (12 fields), `/api/logs` (8 fields + status buckets
  `2xx..5xx`). Bad regex silently falls back to `contains`. `service`/`client`/`event_type`
  single-value eq filters hit secondary indexes (fast).
- **Response `total:-1`** = partial results (timeout or export stream), not a bug.
- **Rule mutations return success without deploying** - the dashboard calls
  `POST /api/deploy` explicitly; API/CLI callers must too (`wafctl deploy`).
- **Doc figures corrected 2026-06** (previously stale in caddy-compose/AGENTS.md):
  "155 mux routes" -> actually 94 API routes + UI catch-all; `validWAFModes` was
  removed from the code (config is thresholds + `detection_only`;
  `inbound_threshold: 0` = blocking disabled); blocklist.go comments used to claim
  "reload Caddy" but it calls `deployAll` (no reload). If an old doc/memory
  disagrees with the skill, the skill (verified against source) wins.

## Adding things end-to-end

The authoritative per-layer checklists live in `~/ergo/caddy-compose/AGENTS.md`
("Adding a New Event Type", "Adding a New Rule Type", "Adding a New Condition Field") -
follow them; every layer missed = feature invisible somewhere. Summary-counter-only
additions (no new event type) touch: `models.go` HourCount + SummaryResponse ->
`summary_counters.go` (hourBucket, both classify fns, buildSummary, merge,
increment/decrement) -> `waf-events.ts` (TimelinePoint, RawSummary.events_by_hour,
fetchSummary timeline mapper) -> `analytics.ts` (raw type + mapper) ->
`utils.ts` (ACTION_LABELS + ACTION_COLORS) -> chart series in `OverviewDashboard.tsx`
-> fixtures in `waf-events.test.ts` + `analytics.test.ts`.
If the counter also surfaces in per-service/client panels: additionally the
`top_services`/`top_clients`/`service_breakdown` Raw types + mappers in
`waf-events.ts` and the ServiceStat/ClientStat/ServiceBreakdown interfaces.

## Reference files

Load these on demand - they are the complete ground truth:

| File | Contents |
|---|---|
| `api-reference.md` | Full route inventory (~94 routes) by domain: params, bodies, responses, mutates?, pagination/filter conventions, helpers, auth/CORS |
| `internals.md` | Stores + persistence files, log ingestion/classification, deploy pipeline internals, WAFConfig model, CLI subcommands, summary counters, GeoIP, challenge/session/discovery internals, ALL env vars with defaults |
| `frontend.md` | Dashboard pages, src/lib/api module->endpoint map, Raw->public field renames, EventType union, component inventory, constants (ACTION_*), conventions (SSR caveats, prefill), tests |

## Quick task routing

| Task | Start here |
|---|---|
| Call the API / build curl | `api-reference.md` (domain table) + auth gotchas above |
| "Change didn't take effect" | Invariant 1 above; `internals.md` §Deploy pipeline |
| Add endpoint to wafctl | `main.go` route block + `handlers_*.go`; mirror in `frontend.md` API module |
| Add dashboard page | `frontend.md` §Pages + conventions |
| Event classification wrong | `internals.md` §Data pipeline (source -> eventType table) |
| Env var / file path / port | `internals.md` §Environment variables |
| wafctl CLI usage | `internals.md` §CLI |

## Common mistakes

- Calling `POST /api/config/generate` and expecting a deploy (it's preview-only).
- Editing `policy-rules.json` by hand - next deploy overwrites it; change the stores.
- Assuming `PUT /api/config` is live - needs `POST /api/config/deploy`.
- Reading URL params in `useState` initializer in the dashboard (SSR - use `useEffect`).
- Adding an EventType to the Go side but forgetting `validEventTypes` in
  `waf-events.ts` `mapEvent` - events silently fall back to detect_block/logged.
- Trusting `total` in export/timeout responses - it's `-1`; use `total_emitted` / length.
- Using `make restart-caddy` for .env-affecting changes (SOPS bypass - see the `caddy`
  skill); unrelated to wafctl API but the #1 stack-level footgun.

Related: `caddy` skill (stack deploy, Caddyfile snippets, SOPS), `~/ergo/caddy-compose/AGENTS.md` (code style + add-feature checklists).
