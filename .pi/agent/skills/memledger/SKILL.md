---
name: memledger
description: Use when searching past agent sessions across pi + opencode + claude (or anything older than the 30-day local retention, where memledger is the only copy), or working on the memledger system itself (ingester/prune CLI, compose stack, schema/migrations, edge Caddy gate). Fires on 'memledger', 'search all my sessions', 'session history across clients', 'prune old sessions', 'session store'. NOT for pi's built-in session_search (recent pi-only fast path) or the work ledger alone (ledger_search). Repo ~/infra/memledger.
---

# memledger - central agent session memory

**Project truth: `~/infra/memledger/AGENTS.md`** - read it first. This skill is the pattern layer.

## Shape

- **Store**: Postgres 18 + PostgREST v16, composer stack `memledger` on the MS-01 router (ssh `nixos`). DB on internal bridge; only exposure is `https://memledger.erfi.io` via edge Caddy.
- **Ingester**: `memledger sync` (Go, `~/bin/memledger`) on the dev box, systemd user timer every 5 min. Parses pi/opencode/claude session logs + pi ledger.db + memories.json; checkpoints per file in the `ingest_state` table so it's stateless locally. Fast path: `memledger sync --file <pi.jsonl>` syncs one session file (single checkpoint fetch, offset-incremental, measured 75-245ms per run); pi's `memledger-seed` extension (dotfiles `.pi/agent/extensions/memledger-seed.ts`) fires it detached on turn_end (10s rate-limit, single-flight) + session_shutdown, so the LIVE session is memledger-searchable within seconds instead of at the next 5-min tick. Concurrent with the timer is safe (idempotent upserts). pi jsonl is only consumed up to the last newline - a trailing partial line (pi mid-write) is left for the next run, never checkpointed past.
- **Prune**: `memledger prune` (daily 04:30 timer) deletes local logs >30d old ONLY after DB-count verification + raw archive to MinIO `s3://memledger/archive/`. `--dry-run` first when testing.
- **Summariser**: `memledger summarise` (15min timer) LLM-summarises pi ledger.db `summary_pending` rows (raw shutdown transcripts): Postgres upsert FIRST, then local write-back incl. the `ledger_fts` index so pi's local `ledger_search` still sees them. OpenRouter `deepseek/deepseek-v4-flash` via `MEMLEDGER_LLM_*` in `~/.config/memledger/env`. Since 2026-08-11 pi's session-ledger extension has NO LLM path - the old summarise-on-session_start was a measured 50s-vs-7s startup tax with 2 pending rows. Upsert payloads MUST include the NOT NULL `source` column - PG checks constraints before the ON CONFLICT arbiter, partial payloads 23502 even when the row exists.
- **Backups**: daily pg_dump sidecar -> MinIO `s3://memledger/pg-dumps/`, 30-day prune.
- **pi tool**: `memledger_search` extension (dotfiles `.pi/agent/extensions/memledger.ts`) - the canonical search for cross-client or >30d-old history. pi's built-in `session_search` also falls back to memledger automatically.
- **pi MCP tools**: pi ALSO gets the 6 MCP tools (search_messages, semantic_search, search_ledger, search_memories, search_sessions, list_sessions) in-session via pi-mcp-bridge + an `mcp-remote` stdio shim configured in `~/.pi/agent/mcp-bridge.json` (server `memledger`, bearer from `~/.config/memledger/env`; file is chmod 600). The bridge is stdio-only, so the shim fronts the remote endpoint; verified e2e 2026-08-09 (no-LLM acceptance test: `jq -r 'keys[]' ~/.pi/agent/mcp-bridge.cache.json` shows the discovered servers + tools, or `pi -p '/mcp-refresh'` re-runs discovery and rewrites that cache - the bridge exposes `/mcp-status` + `/mcp-refresh` as TUI slash commands, there is no pi-core `mcp` CLI subcommand; delete the memledger entry in that cache to force re-discovery after the tool schema changes).
- **claude.ai corpus**: the claude.ai web history is seeded (2026-08-09, 1673 conversations / ~23k messages, from the account data export zip in Windows Downloads) as source=claude host=claude.ai via `memledger import-claude-ai <export.zip|conversations.json>` (one-shot, idempotent; re-import newer exports to top up). Distinct from Claude Code's ~/.claude/projects jsonl (barely used, 1 session).
- **UI**: `https://memledger.erfi.io/ui/` - Astro static app (search/sessions/transcript/stats), bonkled-style theme (cream/ink/hairline/plex-mono/accent-red, three-state dark toggle). Built on the router by the one-shot `ui-build` service into /var/lib/memledger/ui-dist; the edge caddy serves it. REBUILD GOTCHA: `docker start memledger-ui-build` reuses the container rootfs - the build command `rm -rf /tmp/web` first or it builds stale code.

## Project attribution (why project=X misses sessions)

`sessions.project` is `basename(startup cwd)` for every ingester, frozen at session start - pi's jsonl header cwd is never updated on cd. Sessions run from a container dir (`~/infra`) or the wrong repo are filed under THAT project even when all their work touched another (measured 2026-08-12: 27 sessions mentioned `hearth` in content, only 5 had `project='hearth'`). Tool-call args carry absolute paths into `messages.content`, so message FTS is the retroactive topic signal.

- "sessions about X" -> `memledger_search` kind=sessions (the `search_sessions` RPC, migration 009): unions attributed title/project/cwd ILIKE with message-FTS mentions, returns `match_kind` (attributed|mentions|both), `hits`, `last_hit`. The MCP `search_sessions` tool is the same function.
- `list_sessions` (pi tool: `project=ilike`; MCP tool: EXACT match - semantics differ!) is the narrow attributed-browser only.

## Querying (any client, reads are LAN/tailnet-open)

```bash
curl -s "https://memledger.erfi.io/rpc/search_messages?q=<terms>&lim=10" | jq   # FTS, ranked headlines
curl -s "https://memledger.erfi.io/rpc/search_messages?q=X&src=opencode" | jq   # per-client filter
curl -s "https://memledger.erfi.io/semantic/search?q=X&kind=messages&source=claude" | jq  # semantic, all kinds support source
curl -s "https://memledger.erfi.io/rpc/search_ledger?q=X" | jq                  # work-ledger summaries
curl -s "https://memledger.erfi.io/rpc/search_sessions?q=X&lim=10" | jq         # sessions by topic (match_kind provenance)
curl -s "https://memledger.erfi.io/sessions?project=eq.<p>&order=started_at.desc" | jq  # attributed only: startup-cwd basename
```

Writes need `Authorization: Bearer $MEMLEDGER_TOKEN` (Vaultwarden item `memledger`).

## The bugs this system already taught us (don't reintroduce)

- pi session jsonl: event-level `timestamp` is RFC3339 string, `message.timestamp` is EPOCH MILLIS - the parser needs FlexTime for both. Fixtures must be sampled from real files, never invented.
- Postgres `text` rejects NUL bytes (22P05) - session logs have them; content is sanitized on ingest.
- `offset` is a reserved word - the checkpoint column is `byte_offset`.
- PG timestamptz is microsecond precision - checkpoint mtimes must be truncated to micros or whole-file sources re-sync every run.
- A failing source file must not abort the whole sync - per-file errors are logged and skipped.
- `search_ledger` (RPC + MCP) indexes the `summary` column ONLY, not project/cwd - a query for a project NAME (e.g. "composer") returns empty even when the row's project is /home/erfi/composer. True negative, not a sync gap: cross-check with `sqlite3 ~/.pi/agent/ledger.db 'select count(*) from ledger'` before suspecting the ingester.
- pgvector HNSW + selective WHERE filter = silently EMPTY results: the approximate index gathers candidates table-wide and post-filters, so `source=claude` (3 embedded rows in 635k) returned 0 while unfiltered worked. `_semantic_query` materializes the filtered subset (CTE) and runs exact cosine when `source` is given; unfiltered keeps the index path. Never trust "0 rows" from a filtered ANN query without checking `enable_indexscan=off`.
- Semantic search parity (2026-08-09): `/semantic/search` and MCP `semantic_search` both take `kind` (messages|memories|ledger_entries) + `source`; the web UI semantic mode passes its src filter through; pi's `memledger_search` extension forwards `source` for kind=semantic. New claude.ai rows embed newest-first in the background backfill - old-imported rows (2024-2025 ts) are embedded LAST, so semantic-over-claude is sparse until the backlog drains (~1 day for 600k).

## Ops

- Deploy: `make deploy` in the repo (push + composer sync), or the composer API. Stack changes: the router's `dockerBridges` whitelist is already set for memledger0/memledgerb0 - don't rename the bridges.
- Timers: `systemctl --user list-timers 'memledger*'`; logs `journalctl --user -u memledger-sync.service`.
- Secrets: Vaultwarden item `memledger` (POSTGRES_PASSWORD, POSTGREST_PASSWORD, MEMLEDGER_TOKEN, MINIO_*); SOPS .env in the repo; dev-box env at `~/.config/memledger/env`.
- Verification: `make test` + `make test-e2e` (throwaway PG+PostgREST in docker); web: `cd web && bunx biome check src && bun test src && bun run check && bun run build`. The repo's `.pi/harness.json` self-correcting-loop manifest covers all of it - 12 sensors, canary-verified.
- PostgREST caches the schema: new views/RPCs in a migration need `docker restart memledger-postgrest` (or NOTIFY pgrst) or they 404.
