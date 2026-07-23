# waf-dashboard frontend reference

Root: `~/ergo/caddy-compose/waf-dashboard/` - Astro 6 static MPA (`output:
"static"`, `base: "/"`), React 19 islands (`client:load` per page), TS strict
(`astro/tsconfigs/strict`), shadcn/ui (Radix) + Tailwind CSS 4 (`@tailwindcss/vite`,
no tailwind.config), Recharts, lucide-react, dnd-kit. Verified against source
2026-06.

## API base mechanism

`src/lib/api/shared.ts`: `export const API_BASE = "/api"` - same-origin relative,
no env var, no Astro proxy/rewrites. Works because wafctl serves BOTH the dashboard
static files and the API on one port (Caddy site block reverse-proxies everything
to wafctl; long-cache for `/_astro/*`, no-store fallback). Helpers: `fetchJSON`
(throws `API error: <status> <statusText> - <sanitized body>`, handles 204),
`postJSON/putJSON/deleteJSON`. `applyFilterParams(sp, params)` serializes the 12
FilterableParams fields (each with optional `<field>_op`; `eq` omitted as default);
`start`/`end` (ISO) win over `hours`.

## Pages (src/pages/)

Every page: `DashboardLayout` (sidebar nav, health indicator polling /api/health
every 30s, `active` prop) + one React island with `client:load`.

| Route | Mounts | Shows |
|---|---|---|
| `/` | OverviewDashboard | Stat cards, timeline area chart (click-drag zoom, series toggle), donut, top services/clients bars, recent events inline expand |
| `/events` | EventsTable | Paginated security events, filter bar, JSON export (fetchAllEvents) |
| `/logs` | LogViewer | General logs: Log Stream / Summary / Header Compliance tabs |
| `/analytics` | AnalyticsDashboard | IP Lookup (?q=, ?tab=ip) + top IPs/URIs/countries panels |
| `/services` | ServicesList | Per-service cards: totals, block rate, top URIs/rules |
| `/dos` | DDoSPanel | Tabs: IP Jail, Profiles, Spike Reports, Configuration |
| `/challenge` | ChallengeAnalytics | PoW funnel, bot-score histogram, algorithm breakdown, Reputation + Endpoint Discovery tabs |
| `/sessions` | SessionsPanel | Stats/list/detail, alerts, scoring config |
| `/policy` | UnifiedPolicyPage | Tabs: WAF Rules (PolicyEngine) + Rate Limits (RateLimitsPanel); ?tab=rate-limits, ?from_event=1, ?action=; global export/import |
| `/rate-limits` | - | Meta-refresh redirect to /policy?tab=rate-limits (legacy) |
| `/rules` | RulesOverview | WAF settings: paranoia/sensitivity, categories, per-service, backup/restore |
| `/rules/crs` | RulesPanel | CRS default-rules catalog browser + overrides/bulk |
| `/lists` | ManagedListsPanel | Managed lists CRUD, refresh, import/export |
| `/csp` | CSPPanel | Directive editor + per-service preview |
| `/headers` | SecurityHeadersPanel | Profiles, per-service config, preview/deploy |
| `/cors` | CORSPanel | CORS settings editor |

## API layer (src/lib/api/) - module -> endpoints

snake_case identity: TS interfaces mirror Go JSON 1:1; only a few deliberate
renames via Raw* -> mapper (below). `index.ts` barrel-exports all 19 modules.

| Module | Functions -> endpoints |
|---|---|
| shared | fetchJSON/postJSON/putJSON/deleteJSON; API_BASE="/api"; FilterOp, TimeRangeParams, FilterableParams, SummaryParams |
| waf-events | fetchSummary -> GET /api/summary; fetchEvents -> GET /api/events (page/per_page -> offset/limit; total=-1 -> always allow Next); fetchAllEvents -> GET /api/events?export=true (10K cap, {events,totalEmitted,truncated}); fetchServices -> GET /api/services (30s module cache, clearServicesCache for tests); fetchServiceDetail -> GET /api/services/{service}; mapEvent (exported) |
| analytics | lookupIP -> /api/lookup/{ip}; fetchTopBlockedIPs -> /api/analytics/top-ips; fetchTopTargetedURIs -> /api/analytics/top-uris; fetchTopCountries -> /api/analytics/top-countries |
| exclusions | CRUD -> /api/exclusions[/{id}]; deployConfig -> POST /api/deploy; export/import -> /api/exclusions/export\|import; fetchExclusionHits -> /api/exclusions/hits; reorder -> PUT /api/exclusions/reorder; bulk -> POST /api/exclusions/bulk; fetchCRSRules -> /api/crs/rules |
| rate-limits | getRLRules -> /api/rules?type=rate_limit; CRUD -> /api/rules[/{id}]; deployRLRules -> POST /api/deploy; getRLGlobal/updateRLGlobal -> GET/PUT /api/config (rate_limit_global key, PUTs whole config); export/import/reorder; getRLRuleHits -> /api/rate-rules/hits; getRLSummary -> /api/rate-limits/summary; getRLEvents -> /api/rate-limits/events; getRateAdvisor -> /api/rate-rules/advisor |
| config | getConfig/updateConfig -> GET/PUT /api/config (+ presetToSettings/settingsToPreset) |
| default-rules | list/get -> /api/default-rules[/{id}]; override -> PUT; reset -> DELETE .../override; bulkOverride/bulkReset -> POST /api/default-rules/bulk; refreshCRSCategories -> /api/crs/rules |
| challenge | fetchChallengeStats -> /api/challenge/stats; fetchChallengeReputation -> /api/challenge/reputation; fetchEndpointDiscovery -> /api/discovery/endpoints; fetchOpenAPISchemas -> /api/discovery/schemas; upload/deleteOpenAPISchema -> PUT/DELETE /api/discovery/schemas/{service} (raw fetch, not helper) |
| sessions | fetchSessionStats/Config/List/Detail/Alerts -> /api/sessions/*; updateSessionConfig -> PUT /api/sessions/config |
| dos | fetchDosStatus -> /api/dos/status; fetchJail/addJail/removeJail -> /api/dos/jail[/{ip}]; getDosConfig/updateDosConfig -> /api/dos/config; fetchProfiles -> /api/dos/profiles; fetchSpikeReports/Report -> /api/dos/reports[/{id}] |
| general-logs | fetchGeneralLogs -> /api/logs; fetchGeneralLogsSummary -> /api/logs/summary |
| managed-lists | CRUD + refresh + export/import -> /api/lists* |
| security-headers | GET/PUT /api/security-headers; profiles; deploy; preview |
| csp | GET/PUT /api/csp; deploy; preview |
| cors | GET/PUT /api/cors |
| blocklist | stats; check/{ip}; refresh |
| backup | fetchBackup -> GET /api/backup; downloadBackup (browser); restoreBackup -> POST /api/backup/restore |
| templates | listTemplates -> /api/rules/templates; applyTemplate -> POST .../{id}/apply |
| health | fetchHealth -> /api/health |

### waf-events.ts - the one real Raw->public transform

Renames: RawSummary.logged_events -> SummaryData.logged; events_by_hour[].count ->
TimelinePoint.total; top_services[].count -> ServiceStat.total (+ computed
block_rate); top_clients[].client -> ClientStat.client_ip, count -> total;
RawEvent.is_blocked -> WAFEvent.blocked; RawEvent.response_status ->
WAFEvent.status. fetchServices: total -> total_events, rule_id number -> string.

**EventType union** (= validEventTypes in mapEvent): `detect_block | logged |
rate_limited | policy_skip | policy_allow | policy_block | ddos_blocked |
ddos_jailed | challenge_issued | challenge_passed | challenge_failed |
challenge_bypassed`. Fallback in mapEvent: `is_blocked ? "detect_block" : "logged"`.

**SummaryData**: total_events, total_blocked, logged, rate_limited, policy_events,
policy_blocked, detect_blocked, ddos_blocked, policy_allowed, policy_skipped,
challenge_issued/passed/failed/bypassed, unique_clients, unique_services,
tag_counts[], timeline[], top_services[], top_clients[], top_countries[],
recent_events[], service_breakdown[].

**TimelinePoint**: hour, total, total_blocked, logged, rate_limited, policy_block,
detect_block, ddos_blocked, policy_allow, policy_skip, challenge_issued/passed/
failed/bypassed. ServiceStat = same minus hour, plus service + block_rate.
ClientStat: client_ip, country?, total + same counters (NO logged).
ServiceBreakdown: same counters WITH logged + service.

**WAFEvent**: id, timestamp, service, method, uri, client_ip, country?, status,
blocked, event_type, rule_id, rule_msg, severity, anomaly_score,
outbound_anomaly_score, blocked_by?, matched_data?, rule_tags?[], user_agent?,
matched_rules?: MatchedRuleInfo[], request_headers?, request_body?, request_args?,
request_id?, tags?[], ja4?, challenge_* (bot_score, jti, difficulty, elapsed_ms,
pre_score, fail_reason, signals, algorithm), ddos_* (action, fingerprint, score).
MatchedRuleInfo: id, name?, msg, severity, matched_data?, file?, tags?[],
matches?: [{field, var_name, value?, matched_data?, operator?}].

exclusions.ts: ExclusionType = allow|block|challenge|skip|detect|rate_limit|
response_header; typeToGo/typeFromGo identity maps (legacy); mapExclusionFromGo
coerces unions + falsy->undefined; mapExclusionToGo = generic defined-keys-only
loop (partial updates). ConditionField union ~45 values (incl. aggregates,
count:*, CRS body fields, ja4, challenge_history, response-phase).
ConditionOperator = 24 ops. VALID_TRANSFORMS = 17.

## Components (src/components/)

Page mounts (top-level): OverviewDashboard (~1000 lines), EventsTable, LogViewer,
AnalyticsDashboard (re-exports panels from analytics/), ServicesList, DDoSPanel
(~900), ChallengeAnalytics (~760), SessionsPanel, UnifiedPolicyPage, PolicyEngine
(~1000), RateLimitsPanel (~870), RateAdvisorPanel, AdvisorCharts, RulesOverview,
RulesPanel, ManagedListsPanel (~580), CSPPanel, CORSPanel, SecurityHeadersPanel.

Shared: DashboardFilterBar (generic `<F extends string>`; barrel over filters/),
TimeRangePicker (+rangeToParams), TablePagination (+paginateArray),
SortableTableHead/Row, StatCard, Sparkline, EventTypeBadge, EventDetailModal.

Feature subdirs (~500-line split convention): policy/ (PolicyForms ~1400 lines:
QuickActionsForm + AdvancedBuilderForm; constants, ConditionBuilder, TagInputs,
CRSRulePicker, exclusionHelpers, eventPrefill), ratelimits/, csp/, filters/,
events/ (EventDetailPanel - pure render, action row: View in Events / Create
Exception / IP Lookup / Export JSON), logs/, analytics/ (+ip-lookup/), overview/,
rules/, settings/, ui/ (shadcn primitives).

Key flows:
- PolicyEngine: full rule CRUD + dnd-kit reorder + bulk + deploy status +
  QuickActions/AdvancedBuilder dialogs + event prefill (consumePrefillEvent ||
  consumeURLPrefill).
- Event -> rule handoff: sessionStorage["waf:prefill-event"] + /policy?from_event=1.
- OverviewDashboard: fetchSummary + fetchEvents + getExclusions (autocomplete);
  Recharts AreaChart with ReferenceArea zoom + legend toggle; URL filters read in
  useEffect then stripped via history.replaceState.

## Constants

- `src/lib/utils.ts`: cn() = twMerge(clsx). ACTION_LABELS / ACTION_BADGE_CLASSES /
  ACTION_COLORS keyed by the 12 event actions (+ total_blocked in COLORS/LABELS).
  Labels are the single source of truth for human-readable action names.
- `filters/constants.ts`: EVENT_TYPE_OPTIONS = 10 (all EventTypes EXCEPT
  ddos_blocked/ddos_jailed); METHOD/LEVEL/STATUS_BUCKET/MISSING_HEADER/BLOCKED_BY
  options; WAF_FILTER_CONFIG (service, client, event_type, blocked_by, tag, ja4,
  method, rule_name, uri, status_code, country) + LOG_FILTER_CONFIG.
- `policy/constants.ts`: QUICK_ACTIONS = 5 (allow, block, challenge, skip, detect);
  ALL_EXCLUSION_TYPES = 6 (same 5 + response_header; rate_limit deliberately
  excluded - own panel); CONDITION_FIELDS ~40 FieldDefs; AdvancedFormState +
  emptyAdvancedForm; INBOUND/OUTBOUND_FIELD_DEFS.

## Conventions

- Path alias `@/* -> ./src/*` (tsconfig baseUrl ".", mirrored in vitest.config).
- SSR caveat: read URL params in useEffect, never useState initializer.
- Cross-page links: native `<a href>` (MPA full navigation).
- cn() for className composition; typography tokens `@/lib/typography`; formatters
  `@/lib/format` (formatNumber, formatTime, countryFlag); downloadJSON in
  `@/lib/download`.
- Hooks in src/hooks/: useTableSort, useRuleReorder, useRuleSelection,
  useStaleSafeRequest, useCRSCategories, useCountUp.
- astro.config.mjs: output static, base /, react() integration, tailwindcss()
  vite plugin. No rewrites/proxy/env.

## Tests

Vitest 4, `environment: "node"`, colocated `*.test.ts` (14 in src/lib/api/, 5+ in
components/). Mock pattern (`src/lib/api/__test-helpers.ts`):
`mockFetchResponse(body, status)` -> vi.fn() minimal Response;
`setupMockFetch()` = beforeEach stubGlobal fetch + clearServicesCache, afterEach
restoreAllMocks. Assert fetch called with expected URL/params + verify Raw->
public mapping. Run: `npx vitest run` (single: `-t "substring"`), `npx tsc --noEmit`.

## Editing reminders

- Adding a summary counter: HourCount + hourBucket + both classify fns +
  buildSummary + mergeSummaryResponses (Go) -> TimelinePoint +
  RawSummary.events_by_hour + fetchSummary timeline mapper + analytics.ts raw type
  + mapper (TS) -> ACTION_LABELS + ACTION_COLORS -> chart series ->
  waf-events.test.ts + analytics.test.ts fixtures.
- Adding an EventType: also validEventTypes in mapEvent (forgetting it = silent
  fallback to detect_block/logged), EVENT_TYPE_OPTIONS, STAT_CARD_DEFS, donut,
  EventDetailPanel branch.
- Adding a rule type: exclusions.ts + policy/constants.ts (ALL_EXCLUSION_TYPES,
  AdvancedFormState, emptyAdvancedForm) + PolicyForms.tsx (section, handleTypeChange
  resets, handleSubmit serialization) + PolicyEngine.tsx editFormState.
- Full per-layer checklists (backend + frontend + tests): caddy-compose/AGENTS.md
  "Adding a New Event Type" / "Adding a New Rule Type" / "Adding a New Condition
  Field".
