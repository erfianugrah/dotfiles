# research: Singapore rental suite (crawler service)

Supporting reference for the `research` skill. Read when the task is
Singapore housing - rental comps, nuisance/sun scoring, portal listings,
place reputation, flight noise, or the map UI. Everything here runs on the
crawler service (`https://crawler.erfi.io`, container port 8889) and has a pi
tool that is preferred over curl.

Contents: rental comps and keyed tiers; place reputation; sun scoring;
portal listings + churn; dossier; flight noise; map UI.

## SG rental comps (crawler service)

Official-data rental comparables, pre-compacted server-side (HDB
per-transaction rentals since 2021, URA per-project condo rent
percentiles, HDB block info). Data source survey + design:
`~/infra/research/docs/plans/2026-08-18-sg-rental-research-tooling.md`.

```bash
# Rebuild assets (monthly; ~1-2 min)
curl -sX POST http://localhost:8889/sg/refresh

# HDB radius comps for an address (degrades to town-level if the
# block-coords map is absent)
curl -sX POST http://localhost:8889/sg/rent-comps \
  -H 'content-type: application/json' \
  -d '{"address":"Blk 105 Ang Mo Kio Ave 4","flat_type":"4-ROOM","radius_m":800,"months":12}'

# Condo project percentile series
curl -sX POST http://localhost:8889/sg/rent-comps \
  -H 'content-type: application/json' -d '{"project":"18 WOODSVILLE"}'
```

pi tools (preferred): `sg_rent_comps`, `sg_nuisance`, `sg_refresh`. The
block-coords map (`sg-block-coords.json`, built by
`scripts/geocode_hdb_blocks.py`, a multi-hour Nominatim batch) and the
Master Plan zone grid (`sg-mp-grid.json`, built by
`scripts/build_mp_grid.py` via `uv run`) live in the crawler's DATASET_DIR
on servarr.

Keyed tiers (SOPS `.env`, degrade silently when unset): `ONEMAP_TOKEN`
(preferred SG geocoder; JWT expires ~3 days - set `ONEMAP_EMAIL` +
`ONEMAP_PASSWORD` and the service refreshes it via getToken) and
`LTA_DATAMALL_KEY` (bus-stops layer in /sg/nuisance, full stop set cached
7 days).

```bash
# Location hazards for a point (dengue / zoning / rail+expressway noise)
curl -sX POST http://localhost:8889/sg/nuisance \
  -H 'content-type: application/json' -d '{"lat":1.315,"lon":103.764}'
```

## Place reputation (crawler service)

Community-complaint digest for a named place: SearXNG discovery over
reddit/HardwareZone/Lemon8/web, in-process extraction (reddit stays
snippet-only - bot-walled), distilled to themes by gumshoe (local 9B on
servarr; unreachable = raw sources, no summary).

```bash
curl -sX POST http://localhost:8889/reputation \
  -H 'content-type: application/json' \
  -d '{"place":"Tampines GreenVines","max_sources":8}'
```

pi tool (preferred): `place_reputation`. Env: `SEARXNG_INTERNAL_URL`
(compose-internal), `GUMSHOE_URL` (default http://10.0.71.2:18080).

## Sun scoring (crawler service)

Direct-sun model for a unit: pysolar sun path vs a horizon built from
HDB `max_floor_lvl` (via the block-coords map, 500m) + OSM
`building:levels` (400m). Buildings spread across their angular width;
absent layers degrade with notes (unshaded-sky, NOT an unblocked window).

```bash
curl -sX POST http://localhost:8889/sg/sun \
  -H 'content-type: application/json' \
  -d '{"lat":1.315,"lon":103.764,"floor":8,"facing":270}'   # 0=N 90=E 180=S 270=W
```

pi tool (preferred): `sg_sun`. Returns monthly direct-sun hours, the
west-sun-after-3pm verdict, and the biggest obstructions in view.

## Portal listings + churn history (crawler service)

99.co newest island-wide rental listings via the v2 web search API
(keyword params do NOT filter it - local substring filter; CF-challenged
days fall back to FlareSolverr). Every fetch snapshots to
`sg-listings.jsonl`: same id at a lower price = price drop; same unit
under new ids = re-list (tenant churn). pi tools: `sg_listings`,
`sg_listings_history`.

```bash
curl -sX POST http://localhost:8889/sg/listings \
  -H 'content-type: application/json' -d '{"query":"ripple bay","limit":5}'
curl -sX POST http://localhost:8889/sg/listings-history \
  -H 'content-type: application/json' -d '{"query":"ripple bay"}'
```

## Dossier (crawler service)

One-call rental report - identity + comps + nuisance + sun + listings +
reputation, concurrent fan-out, each section degrades to a labelled
error/skip entry instead of failing the report.

```bash
curl -sX POST http://localhost:8889/sg/dossier \
  -H 'content-type: application/json' \
  -d '{"address":"Blk 105 Ang Mo Kio Ave 4","flat_type":"4-ROOM","floor":8,"facing":270}'
```

pi tool (preferred): `sg_dossier`. `include_reputation:false` skips the
slow harvest.

## Flight noise (crawler service)

Per-address aircraft noise from the stack's own ADS-B sampling (adsb.lol,
keyless): a composer pipeline (`research-sg-flight-sample`, every 5 min)
appends island-wide snapshots to `sg-flight-tracks.jsonl` (self-compacting
to trailing 14d past 64MB); the query answers low passes (<3000ft) within
radius, per-day rate, hour histogram, altitude band.

```bash
curl -sX POST http://localhost:8889/sg/flight-noise \
  -H 'content-type: application/json' -d '{"lat":1.315,"lon":103.764}'
```

pi tool (preferred): `sg_flight_noise`. Thin until the sampler has days
of accrual; Paya Lebar's move (~2030s) invalidates old windows.

## Map UI (crawler service)

`https://crawler.erfi.io/sg/map/` - Astro+Leaflet page over the SG layers
(dengue polygons, 99.co listing markers, low-flight cells), click-to-probe
a point for zoning/transport/flight stats. Same-origin API calls, so the
edge LAN/tailnet gate covers it; WAN browsers 401 by design. Data:
`GET /sg/map-data`. Source in `ui/` (bonkled conventions: Astro static,
React island for the map only, IBM Plex Mono cream/ink tokens).
