---
name: research
description: "Use when a task needs multi-engine web search, clean content extraction from JS-heavy pages, OSINT lookups (domain DNS/subdomains, IP geo/ports, email platform registrations, username scans, phone metadata, URL scan history, VirusTotal reputation, CVE details), or location scouting via street-level imagery (area-wide POI enumeration, pano sweeps, CLIP facade classification). Fires on 'research X', 'whois/subdomains for', 'what runs on this IP', 'where is this email/username registered', 'CVE-...', 'street view of', 'pano sweep', 'scout locations'. Backs onto four local services: SearXNG :8888, crawler :8889, OSINT :8890, CLIP sidecar (internal)."
---

# Research & OSINT

Local search + scraping + OSINT stack. Three services behind a unified set of
HTTP endpoints. The MCP wrapper at `~/infra/research/mcp/research-server.py` is the
canonical Python client; this skill documents the underlying HTTP API.

## Services

| Service | Port | Provides |
|---|---|---|
| SearXNG | `:8888` | Aggregator across 7+ search engines |
| Crawler | `:8889` | Trafilatura + Playwright clean-content extraction |
| OSINT   | `:8890` | Subfinder, Holehe, Sherlock, Maigret, urlscan, libphonenumber, VirusTotal, NVD |

URLs configurable: `SEARXNG_URL`, `CRAWLER_URL`, `OSINT_URL`.

### Public endpoints (default for off-box callers)

Production stack runs on `servarr` and is fronted by the edge Caddy
(MS-01) at three subdomains, gated by the `(research_auth)` snippet:
LAN + tailnet clients pass open, WAN clients need
`Authorization: Bearer $RESEARCH_TOKEN` (re-added 2026-08-01 after a
no-auth interval; llama.erfi.io is gated the same way):

| Service | Public URL                |
|---------|---------------------------|
| SearXNG | `https://searxng.erfi.io` |
| Crawler | `https://crawler.erfi.io` |
| OSINT   | `https://osint.erfi.io`   |

From any dev box (incl. WSL) prefer the public URLs over
`ssh servarr 'curl localhost:888x ...'` - the stack does NOT run on the
dev box, so `localhost:888x` from WSL always fails. The pi
`web_research` / `webfetch` / `osint_*` extensions and the opencode
`research` MCP server already default to the public URLs; they still
attach `Authorization: Bearer $RESEARCH_TOKEN` when that env var is set -
required from off-LAN, harmless on-LAN. Keep `RESEARCH_TOKEN` exported.
Do NOT override `*_URL` to
`http://localhost:888x` unless you are actually running the dockerised
stack locally.

## Search (SearXNG)

```bash
# General web search (default 10 results)
curl -s "http://localhost:8888/search?q=postgres+row+security&format=json&safesearch=0" | jq

# News (time-limited)
curl -s "http://localhost:8888/search?q=cve+vulnerability&format=json&categories=news&time_range=week" | jq

# Image / video / academic — categories: general,images,videos,news,science,it
```

SearXNG result shape: `{ results: [ {title, url, content, engine}, ... ] }`.

### Engine pool state (as of 2026-08-17)

The pool CHANGES over time - upstream engines rate-limit / CAPTCHA /
poison server-side, and SearXNG's reliability tracker self-suspends
failing engines. Check before trusting a result set:
`curl -s "https://searxng.erfi.io/config" | jq -r '.engines[] | select(.enabled) | .name'`
and look at `unresponsive_engines` in any `/search?format=json` response.

- **bing family DISABLED** (2026-08-17): Bing serves degraded SERPs to
  SearXNG clients (first-token-only matching, CN/JP spam, NSFW junk -
  upstream searxng/searxng#4964). Do not re-enable without running the
  re-test protocol in `~/infra/research/docs/plans/2026-08-17-searxng-engine-resilience.md`.
  Tell-tale junk signature: top titles share no token with the query.
- **startpage via `startpage anubis`** (custom offline engine in the
  repo): stock startpage is Anubis-PoW-walled; the custom engine solves
  it in-process. Bang `!spa`.
- **mwmbl, wiby, marginalia**: indie crawls, low volume but on-topic.
- **duckduckgo + google cse**: the two main carriers.
- **brave / qwant / mojeek**: intermittently IP-blocked (429/CAPTCHA/
  403); the circuit breaker parks them automatically. qwant is a dead
  end (DataDome). A `braveapi` engine ships in the image but needs a
  Brave API key (not in the vault as of 2026-08-17) - settings.yml has
  no env interpolation, so wiring it needs a key-in-settings decision.

Working general-web set when healthy: ddg, google cse, startpage anubis,
mwmbl, wiby, marginalia, wikipedia (+ API verticals: github, stackoverflow,
arxiv etc., unaffected by IP blocks).

## Fetch clean content

Endpoint is `POST /extract`; response field is `markdown`.

```bash
# Boilerplate-stripped markdown (default)
curl -s -X POST http://localhost:8889/extract \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","max_chars":8000}' | jq -r .markdown

# Force Playwright (JS-rendered SPAs)
curl -s -X POST http://localhost:8889/extract \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","force_js":true,"timeout":30}' | jq

# Raw HTML (debug only — prefer /extract for normal use)
curl -s -X POST http://localhost:8889/raw \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","timeout":10}' | jq -r .html
```

Cap is `max_chars` (default 8000, max 64000). Trafilatura is fast path;
Playwright fallback for JS-heavy pages.

## OSINT — domain investigation

```bash
# Summary (top 15 subdomains, fast)
curl -sX POST http://localhost:8890/investigate/domain \
  -H 'content-type: application/json' \
  -d '{"domain":"example.com","mode":"summary"}' | jq

# Full mode (all subdomains, slower)
curl -sX POST http://localhost:8890/investigate/domain \
  -H 'content-type: application/json' \
  -d '{"domain":"example.com","mode":"full"}'

# Long-running → returns { job_id }, poll /jobs/{id}
```

Aggregates DNS, certificate-transparency (crt.sh), subfinder, WHOIS.

## OSINT — IP

```bash
curl -sX POST http://localhost:8890/investigate/ip \
  -H 'content-type: application/json' \
  -d '{"ip":"1.2.3.4","include_shared_hosts":true}'
```

Returns geo (ipinfo.io), open ports + CVEs (Shodan InternetDB free tier),
reverse DNS, reverse-IP correlation (hackertarget + OTX passive DNS).
Set `include_shared_hosts:false` for fast geo-only.

## OSINT — email

```bash
curl -sX POST http://localhost:8890/investigate/email \
  -H 'content-type: application/json' \
  -d '{"email":"target@example.com","include_breach":true}'
```

Holehe (120+ services for platform registrations). HIBP breach check if
`HIBP_API_KEY` env is set on the OSINT service.

## OSINT — username

```bash
# fast (Sherlock, ~30s, 400 sites)
curl -sX POST http://localhost:8890/investigate/username \
  -d '{"username":"torvalds","mode":"fast"}'

# deep (Maigret, ~5min, 3000+ sites with metadata + pivots)
curl -sX POST http://localhost:8890/investigate/username \
  -d '{"username":"torvalds","mode":"deep","show_all":true}'
```

Default caps hits at 30 to stay token-cheap; `show_all:true` for full list
(common usernames like `torvalds` return >100).

## OSINT — URL (urlscan.io)

```bash
# Query existing scans (fast)
curl -sX POST http://localhost:8890/investigate/url \
  -d '{"url":"https://suspicious.example/"}'

# Submit fresh scan (~30s)
curl -sX POST http://localhost:8890/investigate/url \
  -d '{"url":"https://suspicious.example/","submit":true}'
```

## OSINT — phone (libphonenumber)

```bash
curl -sX POST http://localhost:8890/investigate/phone \
  -d '{"phone":"+14155552671"}'
```

Returns country, region, carrier, line type (mobile/voip/toll-free), timezone, validity.
Uses Google libphonenumber locally — instant, free, no API key.

## OSINT — VirusTotal reputation

```bash
curl -sX POST http://localhost:8890/investigate/threat \
  -d '{"target":"https://suspicious.example/"}'
# Auto-detects hash (MD5/SHA1/SHA256), URL (with scheme), IP, or domain
# Requires VT_API_KEY env on OSINT service (free tier: 500/day, 4/min)
```

## OSINT — CVE lookup

```bash
curl -sX POST http://localhost:8890/investigate/cve \
  -d '{"cve_id":"CVE-2021-44228"}'
```

NIST NVD free API. Returns description, CVSS, CWE weaknesses, top references.
Pass `NVD_API_KEY` env to bump rate limit (5 → 50 req/30s).

## OSINT — theHarvester (broader sweep)

```bash
curl -sX POST http://localhost:8890/investigate/harvest \
  -d '{"domain":"example.com","limit":500,"sources":"bing,duckduckgo,crtsh,hackertarget,otx,rapiddns,urlscan"}'
```

Slower and noisier than `/investigate/domain` - use when you want the broad sweep.

## Geo pano pipeline (location scouting)

Street-level imagery senses on the osint service (`https://osint.erfi.io`),
backed by the keyless `streetlevel` GSV wrapper. Artifacts persist on servarr
under `GEO_DIR` (`/mnt/user/appdata/research/geo`) in `<sweep_id>/` dirs.

```bash
# 1. Enumerate candidates across a whole area (Overpass; regex is POSIX, ,i applied)
curl -sX POST http://localhost:8890/geo/area \
  -H 'content-type: application/json' \
  -d '{"area":"Singapore","tags":{"amenity":"marketplace"},"name_regex":"food centre|hawker","limit":200}'

# 2. Sweep: point or candidate list -> panos + manifest + contact sheets
#    Directional 5-seed sampling (centre+N/S/E/W) is deliberate - single-seed
#    misses rear facades. ~190 candidates ~= 8 min.
curl -sX POST http://localhost:8890/geo/panos \
  -H 'content-type: application/json' \
  -d '{"candidates":[{"name":"Sim Lim Square","lat":1.3030332,"lon":103.8530255}],"cap":8,"zoom":2}'
# -> { "sweep_id": "YYYYMMDD-HHMMSS-<hash>", "n_panos": ..., "n_sheets": ... }

# 3. CLIP-classify a sweep (research-clip sidecar, torch CPU)
#    reference_b64 = "more like this image"; positive/negatives = zero-shot.
#    granularity sheets (fast triage, default) | panos (slower, localises).
curl -sX POST http://localhost:8890/geo/classify \
  -H 'content-type: application/json' \
  -d '{"sweep_id":"<id>","granularity":"sheets","top_n":20}'
# verdicts.json persists in the sweep dir

curl -s http://localhost:8890/geo/sweeps                     # list sweep ids
curl -s http://localhost:8890/geo/file/<sweep_id>/sheets/<slug>.jpg -O   # pull artifacts
```

pi tools (preferred over curl): `osint_geo_area`, `osint_geo_panos`,
`osint_geo_sheet` (pulls a sheet to `~/.cache/geo-sheets/` and returns the
LOCAL path for `read`), `osint_geo_classify` (takes `reference_path` for a
local reference image).

Gotchas: negatives mean "not visible from street coverage", never proof of
absence; small podium ducts sit below sheet resolution. CLIP triage is a
filter, not a verdict - eyeball top hits before asserting them. Reference
mode with a tight crop beats zero-shot text for specific visual features.

## Long-running jobs

Endpoints that may exceed inline wait (`osint_domain`, `osint_email`,
`osint_username`, `osint_url:submit`, `osint_harvest`) return `{ job_id }` if
not ready. Poll:

```bash
curl -s "http://localhost:8890/jobs/$JOB_ID"
# { status: queued|running|done|error, result: ..., elapsed: 12.5 }
```

## Tips

- **Token discipline**: for OSINT, the wrapper caps results aggressively
  (e.g. usernames capped at 30 hits). Pass `show_all:true` only when needed.
- **VirusTotal**: free tier is 500/day, 4/min. Save shotgun queries for paid plan.
- **HIBP**: requires `HIBP_API_KEY` env on OSINT service. Without it, email
  endpoint skips breach check silently.
- **Wayback fallback**: not in this skill - see the whisper-transcribe bot
  scraper logic (commit 44da86c) for the 4-tier anti-bot pattern (Crawl4AI
  -> FlareSolverr -> Wayback `archive.org/wayback/available` + `id_` raw form
  -> archive.ph).
- **FlareSolverr scope**: crawler-only. It does NOT fix SearXNG engine
  walls (proven 2026-08-17: DataDome on qwant unsolvable, Anubis on
  startpage not waited-out) - engine unblocking lives in custom engines
  like `startpage_anubis.py`, not the solver sidecar.

## Related

- Repo: `~/infra/research`
- MCP wrapper: `~/infra/research/mcp/research-server.py`
- SearXNG instance is dockerised; check `~/infra/research/compose.yaml` for the stack.
- Geo pipeline design + calibration notes: `~/infra/research/docs/plans/2026-08-15-geo-pano-pipeline.md`
