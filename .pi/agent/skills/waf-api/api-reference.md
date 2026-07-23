# wafctl HTTP API reference

Server: Go stdlib `http.ServeMux` (Go 1.22 method+pattern routes), registered in
`wafctl/main.go` `runServe()`. ~94 API routes + static-UI catch-all. All JSON.
Middleware: `newCORSMiddleware(allowedOrigins)(authMiddleware(authToken)(mux))`.
Verified against source 2026-06 (caddy-compose main).

Conventions (apply to all routes):

- `writeJSON(w, status, v)` responses; errors are `ErrorResponse{error, details?}`
  (400 validation, 401 auth, 404 missing, 500 store).
- `decodeJSON` caps bodies at 5 MB (`http.MaxBytesReader`).
- Pagination is `limit`/`offset` only (no cursors). Defaults: events/logs/lookup/RL
  50 (max 1000), sessions 50 (max 200), analytics 50 (max 500), events export 10000.
- Time range: `?hours=N` (0=all, cap 2160) or absolute `?start=&end=` (RFC3339
  variants; wins over `hours`). Summary, events, analytics, lookup, logs support
  both; challenge/discovery/RL endpoints take `hours` only.
- fieldFilter pattern: `field=val&field_op=op`, ops `eq` (default) `neq` `contains`
  `in` (comma list) `regex` (invalid regex falls back to `contains`). Full 12-field
  set only on `/api/summary` + `/api/events`: `service, client, method, event_type,
  rule_name, uri, status_code, country, request_id, tag, blocked_by, ja4`.
  `neq` on `tag` = "tag absent". Single-value `eq` on `service`/`client`/`event_type`
  uses secondary indexes.
- Most read endpoints have a short-TTL (3-30s) response cache keyed on query +
  store generation counter.
- Auth: `Authorization: Bearer $WAF_AUTH_TOKEN` on every `/api/*` except
  `/api/health`. Empty token = auth disabled. CORS via `WAF_CORS_ORIGINS`
  (default `*` when no auth token; deny-all when token set).

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Auth-exempt. `HealthResponse{status, version, crs_version, uptime, stores{...}}`; stores report `{"status":"loading"}` via TryRLock while loading. |

## Events, summary, services

| Method | Path | Key params | Notes |
|---|---|---|---|
| GET | `/api/summary` | `hours`/`start`/`end` + 12 field filters | `SummaryResponse`: scalars (total_events, total_blocked, logged_events, rate_limited, policy_events, policy_blocked, detect_blocked, ddos_blocked, policy_allowed, policy_skipped, challenge_issued/passed/failed/bypassed, unique_clients, unique_services), tag_counts, events_by_hour (`HourCount`), top_services/top_clients/top_countries/top_uris, service_breakdown, recent_events. Fast path = incremental hourly counters when unfiltered. |
| GET | `/api/events` | filters + `blocked`, `limit`, `offset`, `export=true`, `id` | `EventsResponse{total, events}`. `id=<caddy request UUID>` fast path. `export=true` streams `total:-1` + `total_emitted` (still needs explicit `limit=10000`; `offset` ignored). 60s query timeout -> `total:-1` partial. Merges legacy WAF Store + AccessLogStore. |
| GET | `/api/services` | `hours` | `ServicesResponse{services: []ServiceDetail}`; zero-count services seeded from Caddyfile FQDN map. |

`Event` struct fields: id, timestamp, client_ip, service, method, uri, protocol,
is_blocked, response_status, user_agent, country, event_type, tags, blocked_by,
rule_id, rule_msg, severity, anomaly_score, outbound_anomaly_score, matched_data,
rule_tags, matched_rules, request_id, request_headers, request_body, request_args,
ja4, challenge_{bot_score, jti, difficulty, elapsed_ms, pre_score, fail_reason,
signals, algorithm}, ddos_{action, fingerprint, score}.

Event types: `detect_block, logged, rate_limited, policy_skip, policy_allow,
policy_block, ddos_blocked, ddos_jailed, challenge_issued, challenge_passed,
challenge_failed, challenge_bypassed`. Non-blocking set: `logged, policy_skip,
challenge_issued, challenge_passed, challenge_bypassed`.

## Analytics

| Method | Path | Params | Notes |
|---|---|---|---|
| GET | `/api/analytics/top-ips` | hours/start/end, limit (max 500) | Top blocked IPs. |
| GET | `/api/analytics/top-uris` | same | Top targeted URIs. |
| GET | `/api/analytics/top-countries` | same | Fast path via FastSummary. |
| GET | `/api/lookup/{ip}` | hours/start/end, limit (max 1000), offset, `skip_intel=true` | `net.ParseIP`-validated. `IPLookupResponse{ip, geoip, intelligence, total, total_blocked, first_seen, last_seen, services, events_by_hour, events, events_total}`. Intelligence: Team Cymru routing, RPKI ROA, network_type, reputation (ipsum, shodan). Enrichment skipped when offset>0 or skip_intel. |

## Rules / exclusions (unified rule store)

`/api/rules` is canonical; `/api/exclusions` is an identical alias (same handlers).

| Method | Path | Body/params | Mutates |
|---|---|---|---|
| GET | `/api/rules` | `?type=allow\|block\|challenge\|skip\|detect\|rate_limit\|response_header` | - |
| POST | `/api/rules` | `RuleExclusion` | store only (NO auto-deploy) |
| GET | `/api/rules/export` | - | - |
| POST | `/api/rules/import` | `ExclusionExport` | store |
| POST | `/api/rules/bulk` | `{ids:[...], action:"enable"\|"disable"\|"delete"}` (max 1000) | store |
| PUT | `/api/rules/reorder` | `{ids:[...]}` | store |
| GET | `/api/rules/hits` | `hours` (default 24, max 720) | `{"hits": {"<rule_name>": {total, sparkline[]}}}` |
| GET | `/api/rules/{id}` | - | - |
| PUT | `/api/rules/{id}` | partial JSON merge onto existing | store |
| DELETE | `/api/rules/{id}` | - -> 204 | store |

`RuleExclusion` common fields: name, description, type, phase (inbound|outbound),
conditions[] (`{field, operator, value, transforms[], negate, multi_match,
list_items[]}`), group_operator (and|or), service, priority, tags[], enabled,
expires_at, expires_in (duration, converted to expires_at on create).
Type-specific: skip -> `skip_targets{rules, phases, all_remaining}`; detect ->
`severity, detect_paranoia_level, detect_action`; rate_limit -> `rate_limit_key,
rate_limit_events, rate_limit_window, rate_limit_action`; challenge ->
`challenge_difficulty (1-16, dflt 4), challenge_min/max_difficulty,
challenge_algorithm (fast|slow), challenge_ttl (dflt 1h), challenge_bind_ip (dflt
true), challenge_bind_ja4 (dflt true), challenge_app_checks[]`; response_header ->
`header_set/header_add/header_default maps, header_remove[]`.

Condition operators: eq, neq, contains, not_contains, begins_with, ends_with, regex,
not_regex, ip_match, in, not_in, phrase_match, gt, ge, lt, le (+ not_ variants and
in_list/not_in_list per field allowlist; numeric gt/ge/lt/le accepted on any field).

## Rule templates

| Method | Path | Notes |
|---|---|---|
| GET | `/api/rules/templates` | List templates. |
| POST | `/api/rules/templates/{id}/apply` | Validates + creates rules in ExclusionStore. 201 `{template, created, rules}`. |

## WAF config & deploy

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` | `WAFConfig{defaults, services{host->WAFServiceSettings}, rate_limit_global}`. |
| PUT | `/api/config` | Validate + store only. NOT live until deploy. |
| POST | `/api/config/generate` | Preview: returns `{policy_rules: <raw json>}`, writes nothing. |
| POST | `/api/config/deploy` | **Deploys** (same handler as `/api/deploy`). |
| POST | `/api/deploy` | **Deploys**. `DeployResponse{status:"deployed", message, reloaded:false, timestamp}`. |

`WAFServiceSettings`: paranoia_level (1-4), inbound_threshold / outbound_threshold
(0 = blocking disabled), disabled_categories[] (CRS prefixes), detection_only,
blocking_paranoia_level, detection_paranoia_level, early_blocking,
sampling_percentage, reporting_level, enforce_bodyproc_urlencoded, allowed_methods,
allowed_request_content_type, allowed_http_versions, restricted_extensions,
restricted_headers, max_num_args, arg_name_length, arg_length, total_arg_length,
max_file_size, combined_file_sizes, crs_exclusions[] (wordpress, nextcloud, ...).
No `mode` field; no `validWAFModes` (removed - thresholds + detection_only instead).
Per-service settings REPLACE (not merge) defaults list fields.

Deploy pipeline (`generatePolicyData`): EnabledExclusions ->
BuildServiceFQDNMap(Caddyfile) -> BuildPolicyResponseHeaders(csp, sec, cors) ->
BuildPolicyWafConfig -> GeneratePolicyRulesWithRL -> ApplyDefaultRuleOverrides ->
inject challenge HMAC key if challenge rules exist -> atomicWriteFile(
policy-rules.json). Plugin hot-reloads on mtime; no Caddy reload. Priority bands:
allow 50-99, block 100-149, challenge 150-199, skip 200-299, rate_limit 300-399,
detect 400-499, response_header 500-599 (rate_limit explicit priority capped at 99
to stay in band).

## Rate-limit analytics

| Method | Path | Params | Notes |
|---|---|---|---|
| GET | `/api/rate-rules/hits` | hours | Per-RL-rule hit counts. |
| GET | `/api/rate-rules/advisor` | window, service, path, method, limit (max 500) | Per-client classification (normal/suspicious/abusive, req/s, error_rate, path_diversity, burstiness, anomaly_score) + threshold recommendations. |
| GET | `/api/rate-limits/summary` | hours | `RLSummaryResponse{total_429s, unique_clients/services, events_by_hour, top_*, recent_events}`. |
| GET | `/api/rate-limits/events` | service, client, method (plain eq, NO _op), limit (max 1000), offset, hours | `RLEventsResponse{total, events: []RateLimitEvent}`. |

## Blocklist (IPsum)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/blocklist/stats` | `{blocked_ips, last_updated, source, min_score}`. |
| GET | `/api/blocklist/check/{ip}` | `{ip, blocked, source}`. |
| POST | `/api/blocklist/refresh` | Downloads IPsum -> syncs managed lists -> triggers deployAll. `{status, message, blocked_ips, min_score, last_updated, reloaded}`. Scheduled daily at `WAF_BLOCKLIST_REFRESH_HOUR` UTC (default 6). |

## CSP

| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/api/csp` | `CSPConfig`: global defaults + per-service overrides (mode, report_only, inherit, directives). PUT = store only. |
| POST | `/api/csp/deploy` | **Deploys** (regenerates policy-rules.json under deployMu). |
| GET | `/api/csp/preview` | `{services: {svc -> {mode, report_only, header}}}` incl. Caddyfile-discovered services. |

## Security headers

| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/api/security-headers` | `SecurityHeaderConfig`. PUT = store only. |
| GET | `/api/security-headers/profiles` | Named profiles. |
| POST | `/api/security-headers/deploy` | **Deploys**. |
| GET | `/api/security-headers/preview` | `{global, services}` resolved headers. |

## CORS (WAF-managed, per-service)

| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/api/cors` | `CORSConfig{enabled, per_service}`. Distinct from the server's own CORS middleware. |

## Cloudflare trusted proxies

| Method | Path | Notes |
|---|---|---|
| GET | `/api/cfproxy/stats` | `{cidr_count, last_updated, source, file_path}`. |
| POST | `/api/cfproxy/refresh` | Rewrites `cf_trusted_proxies.caddy` + **reloads Caddy** (only endpoint that does). Aborts if <5 CIDRs fetched. Weekly scheduled refresh (Mondays at blocklist refresh hour). |

## Managed lists

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api/lists` | `ManagedList{id, name, description, kind(ip\|hostname\|string\|asn), source(manual\|url\|ipsum), url, items[], item_count, ...}`. |
| GET/PUT/DELETE | `/api/lists/{id}` | PUT = partial merge; ipsum-sourced lists are read-only. |
| POST | `/api/lists/{id}/refresh` | Re-fetch URL-sourced list. |
| GET/POST | `/api/lists/export`, `/api/lists/import` | Bulk portability. |

## Default rules (baked-in CRS-derived)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/default-rules`, `/api/default-rules/{id}` | Catalog + detail. |
| PUT | `/api/default-rules/{id}` | Partial override (json.RawMessage). |
| DELETE | `/api/default-rules/{id}/override` | Reset override. |
| POST | `/api/default-rules/bulk` | `{ids[], action:"override"\|"reset", override?}` (max 1000). |

## CRS catalog

| Method | Path | Notes |
|---|---|---|
| GET | `/api/crs/rules` | `CRSCatalogResponse{categories[], rules[], total}` from default-rules.json + crs-metadata.json. |

## General logs

| Method | Path | Notes |
|---|---|---|
| GET | `/api/logs` | hours/start/end; fieldFilters: service, method, client, uri, level, country, user_agent, request_id (each with _op); `status` exact or buckets 2xx/3xx/4xx/5xx via status_op; `missing_header=csp\|hsts\|x-content-type-options\|x-frame-options\|referrer-policy\|cors\|permissions-policy`; limit (max 1000), offset. |
| GET | `/api/logs/summary` | hours/start/end, service(+_op). |

2xx responses sampled (default 10%, `WAF_GENERAL_LOG_SAMPLE_RATE`); non-2xx always kept.

## Challenge analytics & reputation

| Method | Path | Notes |
|---|---|---|
| GET | `/api/challenge/stats` | hours (dflt 24), service, client. Funnel (issued/passed/failed/bypassed/abandoned=issued-passed-failed), rates, avg_solve_ms[/_passed/_failed], avg_difficulty, score_buckets, hourly timeline, top_clients (max 20, unique token counts), top_services (max 20, fail rates), top_ja4s (max 15), fail_reasons, algorithm_breakdown (fast/slow), solve_time_estimates reference table. |
| GET | `/api/challenge/reputation` | hours, service. JA4 verdicts (trusted/suspicious/hostile), per-IP history with flags (repeat_failure, cookie_harvesting, ja4_rotation), severity-ranked alerts. |

## Sessions

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sessions/stats` | Aggregate stats. |
| GET | `/api/sessions/list` | offset, limit (max 200), min_score, ip, service. |
| GET | `/api/sessions/{jti}` | Detail: navigations, score, flags. |
| GET | `/api/sessions/alerts` | Suspicious-IP alerts. |
| GET/PUT | `/api/sessions/config` | `SessionScoringConfig{denylist_enabled, denylist_threshold(0.6), weight_*, organic_bonus, alert_ip_threshold, auto_escalate_enabled(false), auto_escalate_threshold(5), auto_escalate_ttl(1h)}`. |

## Endpoint discovery

| Method | Path | Notes |
|---|---|---|
| GET | `/api/discovery/endpoints` | hours, service. Aggregates GeneralLogStore by (service, method, normalized path) with challenge/RL coverage flags + uncovered_pct. |
| GET | `/api/discovery/schemas` | List uploaded OpenAPI schemas. |
| PUT/DELETE | `/api/discovery/schemas/{service}` | Upload (raw OpenAPI JSON, 5 MB) / delete. Schema route templates override heuristic path normalization. |

## DDoS mitigation

| Method | Path | Notes |
|---|---|---|
| GET | `/api/dos/status` | `DosStatus{mode, eps, peak_eps, jail_count, rate_jail_count, behav_jail_count, kernel_drop, strategy, eps_history[60], ddos_events, updated_at}`. |
| GET/POST | `/api/dos/jail` | POST `{ip, ttl(dflt 1h), reason(dflt manual)}` writes jail.json (plugin file-syncs). |
| DELETE | `/api/dos/jail/{ip}` | Remove. |
| GET/PUT | `/api/dos/config` | `DosConfig{enabled, threshold(0.65), base_penalty(60s), max_penalty(24h), eps_trigger(50), eps_cooldown(10), cooldown_delay(30s), whitelist[], kernel_drop, strategy, global_rate_threshold, min_host_exculpation, profile_ttl}`. PUT also syncs whitelist into jail.json + live-updates spike detector. |
| GET | `/api/dos/reports`, `/api/dos/reports/{id}` | Spike forensic reports. |
| GET | `/api/dos/profiles` | `[]IPProfile{ip, is_jailed, infractions, jail_reason, anomaly_score, recent_events, blocked_reqs, jailed_reqs, hosts, top_paths, ttl}`. |

## Backup / restore

| Method | Path | Notes |
|---|---|---|
| GET | `/api/backup` | `FullBackup{version:1, exported_at, waf_config, csp_config, security_headers, exclusions[], lists[], default_rule_overrides}` as download. |
| POST | `/api/backup/restore` | Two-pass validate-then-apply across all stores; rejects whole payload on any pre-validation failure. Does NOT auto-deploy (response recommends deploy). Status `restored\|partial`. |

## Static UI

| Method | Path | Notes |
|---|---|---|
| * | `/` | Serves dashboard build from `WAF_UI_DIR` (/app/waf-ui); missing dir = API-only mode. |

## Example: export challenge_failed events for one service, last 48h

```bash
curl -sS -H "Authorization: Bearer $WAF_AUTH_TOKEN" \
  'http://localhost:8080/api/events?export=true&event_type=challenge_failed&service=gitea.erfi.io&hours=48&limit=10000'
```

Gotchas: explicit `limit=10000` required (default 50 even in export mode); `offset`
ignored in export mode; `total` is `-1`, use `total_emitted` (`== 10000` = assume
truncated, split the window with start/end); service must match the stored string
exactly (FQDN as logged) unless `service_op=contains`; 60s query timeout can
truncate mid-stream.
