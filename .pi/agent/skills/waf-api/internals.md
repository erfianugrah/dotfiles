# wafctl internals reference

Package `main`, stdlib-only, Go 1.26+, under `~/ergo/caddy-compose/wafctl/`.
Verified against source 2026-06.

## Data pipeline - access log ingestion

One Caddy combined access log (`WAF_COMBINED_ACCESS_LOG`, default
`/var/log/combined-access.log`), three independent tailers:

1. **AccessLogStore** (`access_log_store.go`) - security events (`RateLimitEvent`).
2. **GeneralLogStore** (`general_logs.go`) - ALL requests (`GeneralLogEvent`), 2xx
   deterministically sampled (counter modulo; default 10% via
   `WAF_GENERAL_LOG_SAMPLE_RATE`), non-2xx always kept.
3. **SpikeDetector** (`spike_detector.go`) - EPS ring buffer; seeks to EOF at start
   (skips backlog); no offset persistence.

Tailing mechanics (AccessLogStore/GeneralLogStore): byte offset in `atomic.Int64`,
persisted via atomicWriteFile after each Load; `StartTailing(ctx, interval)` does a
sync Load then ticks (`WAF_TAIL_INTERVAL`, default 5s). Rotation detection:
`size < offset` (copytruncate) -> reset offset to 0, re-read (in-memory events NOT
cleared; TTL eviction ages them out). Parse: `bufio.Reader.ReadBytes('\n')` (no
Scanner length limit), per-line `json.Unmarshal`, malformed lines skipped.
`generation atomic.Int64` bumps per ingest/evict -> responseCache invalidation.

### Event classification (per log line, in Load)

From `AccessLogEntry` (log_append fields; `"None"` placeholders filtered via
`filterNone`; header fallbacks case-insensitive via `headerValueCI` because HTTP/2
lowercases headers):

| Condition | Source |
|---|---|
| `ddos_action` in {blocked, jailed} | `ddos_blocked` / `ddos_jailed` |
| status 429 + policy_action=rate_limit or X-RateLimit-Policy | `policy_rl` (rule-attributed) |
| status 403 + policy_action in {block, honeypot, detect_block} (or X-Blocked-By: policy-engine) | `policy` / `detect_block` |
| policy_action=skip | `policy_skip` |
| policy_action=challenge_* | verbatim (`challenge_issued/passed/failed/bypassed`) |
| policy_action in {block_logged, honeypot_logged} | `policy` + tag `detection_only` |
| policy_action=rate_limit_logged | `policy_rl` + tag `detection_only` |
| none of above + nonzero policy_score + detect matches | `logged` (below-threshold detect) |
| policy_action=session_beacon | NOT an event -> `SessionStore.IngestBeacon()` |

`challenge_failed` without explicit fail reason: `inferChallengeFailReason()`
replicates plugin `minSolveMs = 2^(diff*4)/(cores*50)*0.3` (cores est. 16; slow
algorithm = 10ms/iter) -> `timing_hard` / `timing_soft` / `bot_score` (>=70) /
`pre_signal` / `bad_pow`.

### RateLimitEvent -> Event (RateLimitEventToEvent)

| Source | Status | EventType |
|---|---|---|
| `policy`, `ipsum` (legacy, migrated) | 403 | policy_block |
| `detect_block` | 403 | detect_block |
| `policy_rl` | 429 | rate_limited |
| `ddos_blocked` / `ddos_jailed` | 403 | same |
| `policy_skip`, `challenge_issued/passed/bypassed`, `logged` | rle.Status | same |
| `challenge_failed` | 403 | challenge_failed |
| default (`""`) | 429 | rate_limited |

Non-blocking set: `{logged, policy_skip, challenge_issued, challenge_passed,
challenge_bypassed}`. detect_block/logged go through `parseDetectRulesDetail`
("id:severity:score[:log_only]") + `enrichMatchedRulesWithDetails` +
`enrichDetectBlockEvent` (CRS description lookup; lower severity number = more
severe). Challenge `algorithm` is enriched from rule config at query time (not in
the log).

### Retention / persistence (all three event stores, same pattern)

- Eviction each Load: TTL first (`WAF_EVENT_MAX_AGE` 2160h / `WAF_GENERAL_LOG_MAX_AGE`
  168h), then count cap -> evict down to 80% of maxItems to avoid churn.
- JSONL append + fsync per batch; compaction (temp+fsync+rename) only when eviction
  >10K events or >5% of total.
- Secondary indexes `idxSource/idxClient/idxService` (lowercased keys -> sorted
  indices) rebuilt on evict/restore.
- Summary counters maintained incrementally and survive eviction (aggregates stay
  correct after raw events are gone).

## Stores

All stores: `sync.RWMutex`, JSON persistence via `atomicWriteFile` (temp -> fsync ->
chmod -> rename; util.go), rollback-on-error mutations (save old, apply, revert on
save failure), deep-copy getters.

| Store | File (env -> default) | Notes |
|---|---|---|
| ExclusionStore | `WAF_EXCLUSIONS_FILE` -> /data/exclusions.json | Versioned (`currentStoreVersion = 6`), legacy auto-migrate. UUID create, Update preserves ID/CreatedAt, DeleteExpired (TTL), EnabledExclusions (enabled + non-expired deep copies). Cheap getters: TagsByName, ChallengeAlgorithmByName. |
| ConfigStore | `WAF_CONFIG_FILE` -> /data/waf-config.json | WAFConfig; old flat formats migrated (rule_engine keys, service profiles strict/tuning/off -> thresholds). |
| JailStore | `WAF_DOS_JAIL_FILE` -> $WAF_DIR/jail.json | **Shared bidirectionally with ddos-mitigator plugin.** flock + atomic write; Reload every 5s; on reload failure keeps previous entries (never shows 0); expired skipped; whitelist synced INTO jail.json for plugin. |
| DosConfigStore | `WAF_DOS_CONFIG_FILE` -> /data/dos-config.json | Validated update + rollback. |
| SessionStore | `WAF_SESSION_FILE` -> /data/session.json; config `WAF_SESSION_CONFIG_FILE` -> /data/session-config.json | map[jti]*SessionEntry; TTL 1h; cap 10000 (evict oldest); save every 60s; UpdateConfig re-scores all. |
| SpikeDetector | stateless | 60x1s buckets -> EPS over 60s; spike on eps_trigger, exit below eps_cooldown sustained cooldown_delay (hysteresis); eps_history[60] at 5s cadence; onSpikeEnd -> forensic JSON in `WAF_DOS_SPIKE_REPORTS_DIR` (/data/spike-reports, cap 100). |
| ManagedListStore | `WAF_MANAGED_LISTS_FILE` -> /data/lists.json; `WAF_MANAGED_LISTS_DIR` -> /data/lists | >=1000 items -> separate item files (metadata keeps item_count only); URL sources SSRF-validated; SyncIPsum hook. |
| BlocklistStore | stateless (data in ipsum managed lists) | Groups IPsum by score 1-8; refreshing atomic.Bool guard; daily refresh. |
| DefaultRuleStore | read `/etc/caddy/waf/default-rules.json` (baked); write `WAF_DEFAULT_RULES_OVERRIDES_FILE` -> /data/default-rule-overrides.json | Accepts `rules` (legacy <=v6) or `default_rules` (v7+); overrides map[id]RawMessage. |
| CRSMetadata | `WAF_CRS_METADATA_FILE` -> /etc/caddy/waf/crs-metadata.json | **Fatal if missing.** atomic.Pointer global; IsValidPrefix, SeverityToNumeric, normalizeCRSCategory. |
| GeoIPStore | `WAF_GEOIP_DB` -> /data/geoip/country.mmdb | See GeoIP section. |
| IPIntelStore | stateless cache | 24h TTL, 10K cap; Team Cymru DNS, RIPEstat, GreyNoise, StopForumSpam, Shodan InternetDB, local IPsum. |
| CSPStore / SecurityHeaderStore / CORSStore | /data/csp-config.json, /data/security-headers.json, /data/cors.json | Same mutex + load/save pattern. |

### RuleExclusion condition fields (models_exclusions.go)

validExclusionTypes: `allow, block, challenge, skip, detect, rate_limit,
response_header`. Inbound fields: ip, path, host, method, user_agent, header,
query, country, cookie, body, body_json, body_form, args, uri_path, referer,
http_version, ja4, challenge_history; aggregates: all_args, all_args_values,
all_args_names, query_args_values/names, post_args_values/names, all_headers,
all_headers_names, all_cookies, all_cookies_names, request_combined; CRS body
fields: xml, files, files_names, multipart_part_headers, request_line,
request_basename, content_type, content_length. Outbound-only: response_header,
response_status, response_content_type, response_body. Aggregates usable with
`count:` prefix. Transforms: lowercase, urlDecode, urlDecodeUni, htmlEntityDecode,
normalizePath, normalizePathWin, removeNulls, compressWhitespace,
removeWhitespace, base64Decode, hexDecode, jsDecode, cssDecode, utf8toUnicode,
removeComments, trim, length.

RL key pattern: `client_ip | path | static | client_ip+path | client_ip+method |
challenge_cookie | header:X | cookie:X | body_json:.path | body_form:field`.

## Deploy pipeline (deploy.go, policy_generator.go)

`generatePolicyData(...)` is the single source of truth (used by generateOnBoot,
deployAll, handleDeploy, handleGenerateConfig preview):

1. `es.EnabledExclusions()` (enabled + non-expired)
2. `BuildServiceFQDNMap(CaddyfilePath)` - regex-parses site blocks; cached by
   path+mtime; `mapServiceBoth` writes short name AND FQDN keys.
3. `BuildPolicyResponseHeaders(csp, secHeaders, cors, svcMap)`
4. `BuildPolicyWafConfig(cs, svcMap)` -> `waf_config` key
5. `GeneratePolicyRulesWithRL(...)` -> PolicyRulesFile JSON
6. `ApplyDefaultRuleOverrides(data, ds)` - appends enabled overridden defaults,
   sets DisabledDefaultRules
7. Challenge HMAC injection if any challenge rule exists

Write: `atomicWriteFile(PolicyRulesFile)`. **No Caddy reload** - plugin hot-reloads
via mtime. `generateOnBoot` at startup guarantees fresh rules after stack restart.

Priority bands (`policyTypePriority`): allow 50, block 100, challenge 150, skip
200, rate_limit 300, detect 400, response_header 500; final = base + storeIndex
(cap 999); rate_limit explicit priority -> 300 + min(p, 99). Rules sorted by
(priority, ID). response_header rules forced to outbound phase. RateLimitConfig
only included when RL rules exist. Challenge generation defaults: difficulty 4,
algorithm fast, TTL 3600s, BindIP/BindJA4 true.

`reloadCaddy()` (only used by cfproxy refresh + CSP paths that need it): reads
Caddyfile, prepends SHA-256 fingerprint comment, POSTs to `{admin}/load` with
`Content-Type: text/caddyfile` and **`Cache-Control: must-revalidate`** (sets
forceReload, bypasses bytes.Equal no-op). 120s timeout.

HMAC key: `CHALLENGE_HMAC_KEY` env, else `loadOrGenerateChallengeKey(WAF_DATA_DIR)`
-> /data/challenge-hmac.key (32-byte crypto/rand hex, 0600; regenerated if
invalid).

## Config model (config.go)

`WAFConfig{defaults WAFServiceSettings, services map[string]WAFServiceSettings,
rate_limit_global RateLimitGlobalConfig}`. **No mode enum / validWAFModes** -
behavior = ParanoiaLevel (1-4) + Inbound/OutboundThreshold (0 = blocking disabled)
+ DetectionOnly (score+log, never 403). Defaults: PL1, thresholds 0/0.
Propagation: PUT /api/config -> store -> only live after deploy via
BuildPolicyWafConfig. Per-service overrides REPLACE defaults list fields.

## CLI (cli*.go)

`wafctl` bare (or `serve`) starts the server; everything else is an HTTP API
client. Flags: `--addr` (default `$WAFCTL_ADDR` or http://localhost:$WAFCTL_PORT),
`--json`, `--file/-f`.

| Command | API call |
|---|---|
| `version` / `health` | local / GET /api/health |
| `config get` / `config set` | GET / PUT /api/config |
| `rules list\|get\|create\|delete` | /api/exclusions |
| `deploy` | POST /api/config/deploy |
| `events [filters]` | GET /api/events |
| `ratelimit list\|get\|create\|delete` (alias `rl`) | /api/rules (client filters type=rate_limit) |
| `ratelimit deploy` / `ratelimit global` | POST /api/deploy / GET /api/config |
| `lists list\|get\|create\|delete\|refresh` (alias `ls`) | /api/lists |
| `csp get\|set\|deploy\|preview` | /api/csp* |
| `blocklist stats\|check <ip>\|refresh` | /api/blocklist/* |

## Summary counters (summary_counters.go)

`summaryCounters{hours map[hourKey]*hourBucket}`, key `"2006-01-02T15"`.
Incrementally maintained: increment/decrement on ingest/evict (RLE path avoids
Event allocation); init from JSONL on restore. `buildSummary` filters by cutoff,
aggregates scalars + maps; **Logged is derived**: Total - Blocked - RateLimited -
PolicyAllow - PolicySkip - ChallengeIssued - ChallengePassed - ChallengeBypassed
(clamped >=0). RecentEvents capped at 10/bucket. `FastSummary` = O(buckets) when
counters populated, O(N) fallback otherwise. `mergeSummaryResponses` merges the
legacy Store + AccessLogStore summaries.

## GeoIP (geoip.go, geoip_mmdb.go)

Three-tier `Resolve(ip, cfCountry)`: (1) `Cf-Ipcountry` header (XX/T1 rejected),
(2) MMDB, (3) online API (`WAF_GEOIP_API_URL` template `%s`, Bearer
`WAF_GEOIP_API_KEY`, 2s timeout). Source recorded as cf_header|mmdb|api.
`geoip_mmdb.go` is a hand-rolled pure-Go MMDB reader (whole file in memory,
metadata marker scan, binary-tree walk, country.iso_code only; handles IPv6 DBs by
caching the IPv4 subtree root; GeoLite2-Country + DB-IP Lite). Missing MMDB file =
header-only mode (non-fatal). Lookup cache: 24h TTL, 100K cap, evict-random.

## Challenge analytics (challenge_analytics.go, challenge_reputation.go)

Read-only aggregations over AccessLogStore snapshots. Stats: funnel with
Abandoned = issued - passed - failed; BypassRate = bypassed/(passed+bypassed);
TopClients UniqueTokens = distinct JTIs (high = repeated solves);
`expectedSolveMs(difficulty, algorithm, cores)`: median iters `2^(diff*4)/2`,
/cores; slow x10ms, fast x0.002ms; table for diff 1-8 x {fast,slow} x cores
{1,4,8,16}. Reputation: JA4 verdicts from fail rate + avg bot score; client flags
repeat_failure / cookie_harvesting / ja4_rotation; alert types incl. hostile_ja4.

## Endpoint discovery (endpoint_discovery.go)

Aggregates GeneralLogStore by (service, method, normalized path). `normalizePath`:
strip query -> replace ID-like segments with `/{id}` (UUIDs, YYYY-MM-DD, numeric,
hex >=8, base64/token >=16) -> collapse consecutive. Uploaded OpenAPI schemas
(v2/v3, paths object) override heuristics per service (`{param}` -> `[^/]+`).
Non-browser classification via known JA4s + UA substrings + API paths. Coverage:
only enabled challenge/rate_limit rules with path conditions; `begins_with /` =
catch-all; eq/contains = exact; prefix scan otherwise. Per endpoint: HasChallenge,
HasRateLimit; response has uncovered_pct.

## Sessions (session_store.go + main.go goroutines)

- Ingestion: session_beacon log lines carry `policy_session_beacon` JSON ([]beacon:
  ts, path, ref, dwell, type navigate|pm, vis, scr, clk, key) + jti + JA4 + host.
- Scoring (0-1, weighted): single_page +0.4, short_session +0.2, uniform_dwell
  (CV<0.2) +0.3, no_scroll +0.15, no_interaction +0.15, low_visible +0.2,
  organic_browsing -0.3. Only "pm" navigations feed scroll/interaction/visible
  metrics; helpers return -1 on insufficient data.
- jti denylist: 30s goroutine writes $WAF_DIR/jti-denylist.json when
  DenylistEnabled (default false, observe-only; threshold 0.6). Plugin reads it and
  rejects denied-JTI cookies. JSON always an array (never null).
- Auto-escalation (60s goroutine, AutoEscalateEnabled default false): (1)
  DeleteExpired rules -> deployAll if any removed; (2) IPs with >=
  AutoEscalateThreshold (5) suspicious sessions -> temp block rule
  `auto-session-block-<ip>` (ExpiresAt = now + AutoEscalateTTL 1h, tags
  auto-escalation/session-tracking) -> deploy. Local escalated map dedupes.

## Environment variables (complete)

| Env var | Default | Purpose |
|---|---|---|
| `WAFCTL_PORT` | 8080 | HTTP listen port |
| `WAFCTL_ADDR` | http://localhost:$WAFCTL_PORT | CLI target address |
| `WAF_AUTH_TOKEN` | (empty = unauthenticated) | Bearer token for /api/* |
| `WAF_CORS_ORIGINS` | `*` (no auth) / `` (auth set) | CORS allowlist (comma-sep) |
| `WAF_EXCLUSIONS_FILE` | /data/exclusions.json | Unified rule store |
| `WAF_CONFIG_FILE` | /data/waf-config.json | WAF config store |
| `WAF_COMBINED_ACCESS_LOG` | /var/log/combined-access.log | Tailed access log |
| `WAF_CSP_FILE` | /data/csp-config.json | CSP store |
| `WAF_SECURITY_HEADERS_FILE` | /data/security-headers.json | Security headers store |
| `WAF_CORS_FILE` | /data/cors.json | CORS store |
| `WAF_SESSION_FILE` | /data/session.json | Session data |
| `WAF_SESSION_CONFIG_FILE` | /data/session-config.json | Session scoring config |
| `WAF_MANAGED_LISTS_FILE` | /data/lists.json | Managed lists metadata |
| `WAF_MANAGED_LISTS_DIR` | /data/lists | Large-list item files |
| `WAF_POLICY_RULES_FILE` | /data/waf/policy-rules.json | Deploy target (plugin hot-reload) |
| `WAF_DEFAULT_RULES_FILE` | /etc/caddy/waf/default-rules.json | Baked-in CRS rules (read-only) |
| `WAF_DEFAULT_RULES_OVERRIDES_FILE` | /data/default-rule-overrides.json | User overrides |
| `WAF_CRS_METADATA_FILE` | /etc/caddy/waf/crs-metadata.json | CRS taxonomy (**fatal if missing**) |
| `CHALLENGE_HMAC_KEY` | (auto-generate) | Challenge cookie HMAC key |
| `WAF_DATA_DIR` | /data | Auto-generated HMAC key dir |
| `WAF_DIR` | /data/waf | jail.json, cf proxies, jti-denylist |
| `WAF_CADDYFILE_PATH` | /data/Caddyfile | Service discovery, reload |
| `WAF_CADDY_ADMIN_URL` | http://caddy:2020 | Caddy admin API |
| `WAF_EVENT_MAX_AGE` | 2160h | Security event retention (90d) |
| `WAF_GENERAL_LOG_MAX_AGE` | 168h | General log retention (7d) |
| `WAF_TAIL_INTERVAL` | 5s | Tail/eviction interval |
| `WAF_EVENT_MAX_ITEMS` | 100000 | WAF event store cap |
| `WAF_ACCESS_MAX_ITEMS` | 100000 | Access log store cap |
| `WAF_GENERAL_LOG_MAX_ITEMS` | 50000 | General log store cap |
| `WAF_EVENT_FILE` | /data/events.jsonl | WAF event JSONL |
| `WAF_ACCESS_EVENT_FILE` | /data/access-events.jsonl | Access event JSONL |
| `WAF_GENERAL_LOG_FILE` | /data/general-events.jsonl | General event JSONL |
| `WAF_ACCESS_OFFSET_FILE` | /data/.access-log-offset | Tail offset persistence |
| `WAF_GENERAL_LOG_OFFSET_FILE` | /data/.general-log-offset | Tail offset persistence |
| `WAF_GENERAL_LOG_SAMPLE_RATE` | 0.1 | 2xx sampling fraction |
| `WAF_GEOIP_DB` | /data/geoip/country.mmdb | MaxMind DB |
| `WAF_GEOIP_API_URL` | (empty = disabled) | GeoIP API fallback (`%s` = ip) |
| `WAF_GEOIP_API_KEY` | (empty) | GeoIP API Bearer key |
| `WAF_BLOCKLIST_REFRESH_HOUR` | 6 | UTC hour of daily IPsum refresh (CF proxies weekly same hour, Mondays) |
| `WAF_DOS_JAIL_FILE` | $WAF_DIR/jail.json | Shared jail file with plugin |
| `WAF_DOS_CONFIG_FILE` | /data/dos-config.json | DDoS config store |
| `WAF_DOS_SPIKE_REPORTS_DIR` | /data/spike-reports | Spike forensic reports |
| `WAF_UI_DIR` | /app/waf-ui | Dashboard static files (missing = API-only) |

Server: timeouts Read 10s / Write 150s / Idle 60s; graceful shutdown 30s.
Health/version: `var version = "dev"` in main.go, overridden via
`-ldflags "-X main.version=<tag>"` at build.

## Cross-cutting invariants

1. atomicWriteFile everywhere (temp + fsync + chmod + rename) - never partial JSON.
2. Rollback-on-error in every store mutation.
3. Deep copies from getters.
4. Dual reload model: plugin = file write + mtime; Caddyfile = reloadCaddy with
   must-revalidate.
5. Filter `"None"` placeholders before interpreting any log_append policy_* field.
6. HTTP/2 lowercases headers - use headerValueCI for header fallbacks.
7. Event caps evict to 80%; JSONL compaction only on >10K or >5% evictions.
8. deployMu serializes all deploys; refreshing atomic.Bool guards blocklist/CF
   refreshes.
