---
name: research
description: "Use when a task needs multi-engine web search, clean extraction from JS-heavy pages, OSINT lookups (domain/subdomains, IP geo/ports, email or username registrations, phone metadata, URL scans, VirusTotal, CVEs), street-level location scouting (POI enumeration, pano sweeps, CLIP classification), or the SG rental suite. Fires on 'research X', 'subdomains for', 'what runs on this IP', 'CVE-...', 'pano sweep', 'rent comps'. NOT for the survey METHOD (open-ended-research) or transcription (whisper)."
---

# Research & OSINT

Local search + scraping + OSINT stack in `~/infra/research`, running on
`servarr`. Three HTTP services plus a CLIP sidecar. The MCP wrapper at
`~/infra/research/mcp/research-server.py` is the canonical Python client
(registered as `research` in `~/.pi/agent/mcp-servers.json`, bridged by
pi-mcp-bridge); this skill documents the underlying HTTP API. The Singapore
rental suite (comps, sun, nuisance, listings, dossier, flight noise, map UI)
is in `sg-rental.md` - read it when the task is SG housing.

## Services

| Service | Port | Provides |
|---|---|---|
| SearXNG | `:8888` | Aggregator across 7+ search engines |
| Crawler | `:8889` | Trafilatura + Playwright clean-content extraction; SG rental endpoints |
| OSINT   | `:8890` | Subfinder, Holehe, Sherlock, Maigret, urlscan, libphonenumber, VirusTotal, NVD, geo panos |

URLs configurable: `SEARXNG_URL`, `CRAWLER_URL`, `OSINT_URL`.

### Public endpoints (default for off-box callers)

The stack is fronted by the edge Caddy (MS-01) at three subdomains, gated by
the `(research_auth)` snippet: LAN + tailnet clients pass open, WAN clients
need `Authorization: Bearer $RESEARCH_TOKEN` (llama.erfi.io is gated the
same way):

| Service | Public URL                |
|---------|---------------------------|
| SearXNG | `https://searxng.erfi.io` |
| Crawler | `https://crawler.erfi.io` |
| OSINT   | `https://osint.erfi.io`   |

From any dev box (incl. WSL) use the public URLs - the stack does NOT run on
the dev box, so `localhost:888x` from WSL always fails, and `ssh servarr
'curl localhost:888x ...'` is the slow way round. The pi `web_research` /
`webfetch` / `osint_*` extensions and the `research` MCP server default to
the public URLs and attach `Authorization: Bearer $RESEARCH_TOKEN` when that
env var is set - required from off-LAN, harmless on-LAN. Keep
`RESEARCH_TOKEN` exported. Do NOT override `*_URL` to `http://localhost:888x`
unless you are actually running the dockerised stack locally. The curl
examples below use the container ports for brevity; substitute the public
URL.

## Search (SearXNG)

```bash
# General web search (default 10 results)
curl -s "http://localhost:8888/search?q=postgres+row+security&format=json&safesearch=0" | jq

# News (time-limited)
curl -s "http://localhost:8888/search?q=cve+vulnerability&format=json&categories=news&time_range=week" | jq

# Image / video / academic - categories: general,images,videos,news,science,it
```

SearXNG result shape: `{ results: [ {title, url, content, engine}, ... ] }`.

### Engine pool state (changes over time; last reviewed 2026-08-17)

Upstream engines rate-limit / CAPTCHA / poison server-side, and SearXNG's
reliability tracker self-suspends failing engines. Check before trusting a
result set:
`curl -s "https://searxng.erfi.io/config" | jq -r '.engines[] | select(.enabled) | .name'`
and look at `unresponsive_engines` in any `/search?format=json` response.

- **bing family DISABLED**: Bing serves degraded SERPs to SearXNG clients
  (first-token-only matching, CN/JP spam, NSFW junk - upstream
  searxng/searxng#4964). Do not re-enable without running the re-test
  protocol in `~/infra/research/docs/plans/2026-08-17-searxng-engine-resilience.md`.
  Tell-tale junk signature: top titles share no token with the query.
- **startpage via `startpage anubis`** (custom offline engine in the repo):
  stock startpage is Anubis-PoW-walled; the custom engine solves it
  in-process. Bang `!spa`.
- **mwmbl, wiby, marginalia**: indie crawls, low volume but on-topic.
- **duckduckgo + google cse**: the two main carriers.
- **brave / qwant / mojeek**: intermittently IP-blocked (429/CAPTCHA/403); the
  circuit breaker parks them automatically. qwant is a dead end (DataDome). A
  `braveapi` engine ships in the image but needs a Brave API key (none
  provisioned) - settings.yml has no env interpolation, so wiring it needs a
  key-in-settings decision.

Working general-web set when healthy: ddg, google cse, startpage anubis,
mwmbl, wiby, marginalia, wikipedia (+ API verticals: github, stackoverflow,
arxiv etc., unaffected by IP blocks).

### Silent-empty results: escalate, don't reword

SearXNG returns HTTP success with an empty/near-empty result set when
engines decline - there is NO error signal distinguishing "no results exist"
from "engines refused". On a long-tail local query (e.g. "<business>
<neighbourhood> review"), 0-2 results means: check `unresponsive_engines` in
the response once, then escalate to Exa (`web_research`) immediately.
Rewording the same query family is the failure mode - it has burned rounds
where Exa then delivered on the first try. This is the reverse of the
tool-routing rule (Exa 0-results -> SearXNG); both directions exist because
the two stacks fail on different query shapes.

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

# Raw HTML (debug only - prefer /extract for normal use)
curl -s -X POST http://localhost:8889/raw \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","timeout":10}' | jq -r .html
```

Cap is `max_chars` (default 8000, max 64000). Trafilatura is the fast path;
Playwright fallback for JS-heavy pages.

### Anti-bot fallback order

When a page will not render through the crawler, the order that works (the
same four tiers the whisper-transcribe bot's scraper implements): the
crawler's Crawl4AI/Playwright path -> FlareSolverr (crawler sidecar; solves
CF challenges only) -> Wayback (`https://archive.org/wayback/available?url=`
to find a snapshot, then the `id_` raw form of the snapshot URL for
unmodified content) -> archive.ph. From pi, `archive_lookup` covers the
Wayback tier. FlareSolverr is crawler-only: it does NOT fix SearXNG engine
walls (DataDome on qwant, Anubis on startpage) - engine unblocking lives in
custom engines like `startpage_anubis.py`, not the solver sidecar.

## API-driven pages (locator pattern)

A page that renders near-empty through the crawler - HTTP success but
footer-only, ~100 chars of markdown - is a SIGNAL, not a result: the content
loads via XHR after render. Do not retry renders or toggle `force_js`. Pull
the raw HTML (`/raw` or plain `curl`) and grep for the underlying REST
endpoint:

```bash
curl -s "https://<site>/<locator-page>/" | rg -o '(wp-json[^"]*|/api/[^"]*|[^"]*\.json[^"]*)' | sort -u
```

Then call the JSON endpoint directly - one call beats every render. Example:
a gym chain's SG locations page rendered footer-only; the raw HTML exposed a
`wp-json/.../map-locations` route that returned all 160+ clubs with
addresses, status and signup URLs in one request. Store locators, maps, and
"find a branch" pages are the usual suspects. The endpoint string usually
lives in embedded JS of the INITIAL HTML, so plain `curl` suffices; only if
the endpoint is injected post-render do you need the crawler's rendered path.

## OSINT - domain investigation

```bash
# Summary (top 15 subdomains, fast)
curl -sX POST http://localhost:8890/investigate/domain \
  -H 'content-type: application/json' \
  -d '{"domain":"example.com","mode":"summary"}' | jq

# Full mode (all subdomains, slower)
curl -sX POST http://localhost:8890/investigate/domain \
  -H 'content-type: application/json' \
  -d '{"domain":"example.com","mode":"full"}'

# Long-running -> returns { job_id }, poll /jobs/{id}
```

Aggregates DNS, certificate-transparency (crt.sh), subfinder, WHOIS.

## OSINT - IP

```bash
curl -sX POST http://localhost:8890/investigate/ip \
  -H 'content-type: application/json' \
  -d '{"ip":"1.2.3.4","include_shared_hosts":true}'
```

Returns geo (ipinfo.io), open ports + CVEs (Shodan InternetDB free tier),
reverse DNS, reverse-IP correlation (hackertarget + OTX passive DNS).
Set `include_shared_hosts:false` for fast geo-only.

## OSINT - email

```bash
curl -sX POST http://localhost:8890/investigate/email \
  -H 'content-type: application/json' \
  -d '{"email":"target@example.com","include_breach":true}'
```

Holehe (120+ services for platform registrations). HIBP breach check if
`HIBP_API_KEY` env is set on the OSINT service; without it the breach check
is skipped silently.

## OSINT - username

```bash
# fast (Sherlock, ~30s, 400 sites)
curl -sX POST http://localhost:8890/investigate/username \
  -d '{"username":"torvalds","mode":"fast"}'

# deep (Maigret, ~5min, 3000+ sites with metadata + pivots)
curl -sX POST http://localhost:8890/investigate/username \
  -d '{"username":"torvalds","mode":"deep","show_all":true}'
```

Default caps hits at 30 to stay token-cheap; `show_all:true` for the full
list (common usernames like `torvalds` return >100).

## OSINT - URL (urlscan.io)

```bash
# Query existing scans (fast)
curl -sX POST http://localhost:8890/investigate/url \
  -d '{"url":"https://suspicious.example/"}'

# Submit fresh scan (~30s)
curl -sX POST http://localhost:8890/investigate/url \
  -d '{"url":"https://suspicious.example/","submit":true}'
```

## OSINT - phone (libphonenumber)

```bash
curl -sX POST http://localhost:8890/investigate/phone \
  -d '{"phone":"+14155552671"}'
```

Returns country, region, carrier, line type (mobile/voip/toll-free), timezone,
validity. Google libphonenumber locally - instant, free, no API key.

## OSINT - VirusTotal reputation

```bash
curl -sX POST http://localhost:8890/investigate/threat \
  -d '{"target":"https://suspicious.example/"}'
# Auto-detects hash (MD5/SHA1/SHA256), URL (with scheme), IP, or domain
# Requires VT_API_KEY env on OSINT service (free tier: 500/day, 4/min - save shotgun queries)
```

## OSINT - CVE lookup

```bash
curl -sX POST http://localhost:8890/investigate/cve \
  -d '{"cve_id":"CVE-2021-44228"}'
```

NIST NVD free API. Returns description, CVSS, CWE weaknesses, top references.
Pass `NVD_API_KEY` env to bump the rate limit (5 -> 50 req/30s).

## OSINT - theHarvester (broader sweep)

```bash
curl -sX POST http://localhost:8890/investigate/harvest \
  -d '{"domain":"example.com","limit":500,"sources":"bing,duckduckgo,crtsh,hackertarget,otx,rapiddns,urlscan"}'
```

Slower and noisier than `/investigate/domain` - use when you want the broad
sweep.

## Geo pano pipeline (location scouting)

Street-level imagery senses on the osint service, backed by the keyless
`streetlevel` GSV wrapper. Artifacts persist on servarr under `GEO_DIR`
(`/data/geo` in the container; host bind `GEO_DIR_HOST` in compose.yaml) in
`<sweep_id>/` dirs. Design + calibration notes:
`~/infra/research/docs/plans/2026-08-15-geo-pano-pipeline.md`.

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

## Platform access walls (social)

- **Reddit: fully walled** (JSON API, old.reddit, the crawler, and jina.ai all
  blocked). This has been rediscovered from scratch in several sessions - do
  not re-probe the blocked paths; start at the top of the bypass order:
  1. **PullPush API** (`https://api.pullpush.io/reddit/search/submission/?subreddit=<sub>&q=<query>`,
     plus `/reddit/search/comment/`) - the reddit archive. It 429s agent
     traffic intermittently ("no free scraping resources for agents"). Try
     once; on 429 fall through.
  2. **redlib mirrors** (e.g. `https://safereddit.com/r/<sub>/comments/...`) -
     swap the host, keep the path. If a mirror returns an Anubis PoW
     interstitial ("Verifying your browser..."), retry through the crawler
     `/extract` with `force_js:true` - Playwright solves the PoW (plain
     fetches pass intermittently; it is rate/IP-based). Caveat: `/extract`
     on a redlib thread page may yield the OP body but drop the comment tree.
  3. Crawler on `www.reddit.com` as last resort only.
  Complement: SearXNG (`reddit r/<sub> <topic>` queries, ddg carries them) is
  good for discovering canonical thread URLs; pair it with the mirror for
  actual content.
- **TikTok / Instagram**: hard-blocked. Don't attempt; say so and move on.
- **Lemon8**: works via the plain static path (trafilatura, no `force_js`).
  Good source for SG-local reviews.

## Long-running jobs

Endpoints that may exceed inline wait (`osint_domain`, `osint_email`,
`osint_username`, `osint_url:submit`, `osint_harvest`) return `{ job_id }` if
not ready. Poll:

```bash
curl -s "http://localhost:8890/jobs/$JOB_ID"
# { status: queued|running|done|error, result: ..., elapsed: 12.5 }
```

## Tips

- **Token discipline**: the MCP wrapper caps results aggressively (usernames
  at 30 hits, search at 10). Pass `show_all:true` / `mode:"full"` only when
  needed; the formatters in `mcp/formatters/` own the budget.
- Paid keys (HIBP, Shodan, VT, urlscan, ipinfo, NVD, Brave) are opt-in env on
  the service and degrade silently when unset - a missing section in a result
  is usually a missing key, not a bug.

## Related

- Repo: `~/infra/research` (AGENTS.md has the bounded contexts and the
  no-mocks fixture rule); stack: `~/infra/research/compose.yaml`
- MCP wrapper: `~/infra/research/mcp/research-server.py`
- `sg-rental.md` - Singapore rental suite. Read when the task is SG housing.
- `open-ended-research` skill - the breadth-first survey method that uses
  these tools.
