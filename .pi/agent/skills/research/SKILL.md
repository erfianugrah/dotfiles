---
name: research
description: "Use when a task needs multi-engine web search, clean content extraction from JS-heavy pages, or OSINT lookups (domain DNS/subdomains, IP geo/ports, email platform registrations, username scans, phone metadata, URL scan history, VirusTotal reputation, CVE details). Fires on 'research X', 'whois/subdomains for', 'what runs on this IP', 'where is this email/username registered', 'CVE-...'. Backs onto three local services: SearXNG :8888, crawler :8889, OSINT :8890."
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

Slower and noisier than `/investigate/domain` — use when you want the broad sweep.

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
- **Wayback fallback**: not in this skill — see the whisper-transcribe bot
  scraper logic (commit 44da86c) for the 4-tier anti-bot pattern (Crawl4AI
  → FlareSolverr → Wayback `archive.org/wayback/available` + `id_` raw form
  → archive.ph).

## Related

- Repo: `~/infra/research`
- MCP wrapper: `~/infra/research/mcp/research-server.py`
- SearXNG instance is dockerised; check `~/infra/research/compose.yaml` for the stack.
