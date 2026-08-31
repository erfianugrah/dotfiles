---
name: memledger
description: Use when searching past agent sessions across pi + opencode + claude (or anything older than the 30-day local retention, where memledger is the only copy), or working on the memledger system itself (ingester/prune CLI, compose stack, schema/migrations, edge Caddy gate). Fires on 'memledger', 'search all my sessions', 'session history across clients', 'prune old sessions', 'session store'. NOT for pi's built-in session_search (recent pi-only fast path) or the work ledger alone (ledger_search). Repo ~/infra/memledger.
---

# memledger - central agent session memory

**Project truth: `~/infra/memledger/AGENTS.md`** - read it first. This skill is the pattern layer.

## Shape

- **Store**: Postgres 18 + PostgREST v16, composer stack `memledger` on servarr (ssh `servarr`; git checkout lives on the router). DB on internal bridge `memledger_backend`; only exposure is `https://memledger.erfi.io` via edge Caddy -> servarr_lan IPs.
- **Ingester**: `memledger sync` (Go, `~/bin/memledger`) on the dev box, fired by the pi memledger-seed extension (10s-rate-limited --file fast path + 15-min full sweep on turn_end, both on session_shutdown) AND the Claude Code memledger-seed Stop hook (same 10s throttle via a tmpdir state file), with the 5-min systemd timer as Linux backstop; the CLI auto-loads ~/.config/memledger/env at startup so manual runs authenticate. Parses pi/opencode/claude session logs + pi ledger.db + memories.json; checkpoints per file in the `ingest_state` table so it's stateless locally. Fast path: `memledger sync --file <session.jsonl> --file-source pi|claude` syncs one session file (single checkpoint fetch, offset-incremental, measured 70-245ms per run), so the LIVE session is memledger-searchable within seconds. Concurrent with the timer is safe (idempotent upserts). Session jsonl is only consumed up to the last newline - a trailing partial line (client mid-write) is left for the next run, never checkpointed past.
- **Prune**: `memledger prune` (daily 04:30 timer) deletes local logs >30d old ONLY after DB-count verification + raw archive to Silo `s3://memledger/archive/`. `--dry-run` first when testing (skips preflight, works with no S3 creds). Preflight is a real `head-bucket`, NOT a key-length check - the scoped Silo account's key is 9 chars (MinIO service-account keys are 3-20). GOTCHA: the CLI auto-loads `~/.config/memledger/env` but PROCESS ENV WINS - stale `AWS_*` in the shell masks the file (403, not SignatureDoesNotMatch); and `systemctl --user is-enabled memledger-prune.timer` BEFORE diagnosing "prune runs but fails" - the timer was silently disabled for a stretch (2026-08-31) and no run happened at all.
- **Summariser**: `memledger summarise` (15min timer) LLM-summarises pi ledger.db `summary_pending` rows (raw shutdown transcripts): Postgres upsert FIRST, then local write-back incl. the `ledger_fts` index so pi's local `ledger_search` still sees them. OpenRouter `deepseek/deepseek-v4-flash` via `MEMLEDGER_LLM_*` in `~/.config/memledger/env`. Since 2026-08-11 pi's session-ledger extension has NO LLM path - the old summarise-on-session_start was a measured 50s-vs-7s startup tax with 2 pending rows. Upsert payloads MUST include the NOT NULL `source` column - PG checks constraints before the ON CONFLICT arbiter, partial payloads 23502 even when the row exists.
- **Backups**: daily pg_dump sidecar -> Silo `s3://memledger/pg-dumps/`, 30-day prune. Image `ghcr.io/erfianugrah/memledger-backup:vX.Y.Z` (backup/Dockerfile, aws-cli baked in - `backend` is `internal: true`: no external DNS, no LAN route, so runtime `apk add` can never work); the upload goes over a pinned `servarr_lan` leg to Silo's LAN address (`http://10.0.71.57:9000`). Health = `backup_log` table (postgres-exporter -> `MemledgerBackupStale` >36h alert in monitoring-compose), NOT container state - the sidecar once sat in a ~10s restart loop for months while the timer and the container both "looked healthy".
- **pi tools**: `memledger_search` + the 5 MCP-parity native tools (search_messages, semantic_search, search_ledger, search_memories, list_sessions) all live in the dotfiles memledger.ts extension (no pi-mcp-bridge since 2026-08-10 - the bearer token leaked into the shim argv; native tools read token-free over the tailnet). The Claude Code side runs the SAME core via `~/dotfiles/.claude/mcp/toolkit.ts`.
- **Self-hit pollution (fixed 2026-08-23, dotfiles 96a1340)**: a session searching for its own prior context otherwise sees ONLY its own echo - the querying session's synthesis messages repeat the full query vocabulary and out-rank the original sources, and `websearch_to_tsquery` ANDs all terms at message granularity so long queries match nobody but the synthesiser. The pi tools now pass `selfSession` (pi:HOST:uuid from ctx.sessionManager), drop self rows, retry at depth 50, then retry OR-broadened (toOrQuery); the result text says which happened. Claude Code + raw curl + web UI get none of this.
- **Query shape guidance**: FTS queries 2-3 terms max (AND at message granularity); "sessions about X" -> kind=sessions; concept questions -> semantic. If a search returns self-referential-looking hits or "no matches", suspect query shape first - verify the data is actually there (`select count(*) from messages where session_key=...`) before suspecting ingest.
- **claude.ai corpus**: the claude.ai web history is seeded (2026-08-09, 1673 conversations / ~23k messages, from the account data export zip in Windows Downloads) as source=claude host=claude.ai via `memledger import-claude-ai <export.zip|conversations.json>` (one-shot, idempotent; re-import newer exports to top up). Distinct from Claude Code's ~/.claude/projects jsonl (barely used, 1 session).
- **UI**: `https://memledger.erfi.io/ui/` - Astro static app (search/sessions/transcript/stats), bonkled-style theme (cream/ink/hairline/plex-mono/accent-red, three-state dark toggle). Built at image build time (two-stage web/Dockerfile: bun -> caddy with try_files; no ui-build one-shot anymore). The try_files Caddyfile is load-bearing: a bare file-server's directory 308 escapes the edge's /ui* handler and 404s (2026-08-29).

## Project attribution (why project=X misses sessions)

`sessions.project` is `basename(startup cwd)` for every ingester, frozen at session start - pi's jsonl header cwd is never updated on cd. Sessions run from a container dir (`~/infra`) or the wrong repo are filed under THAT project even when all their work touched another (measured 2026-08-12: 27 sessions mentioned `hearth` in content, only 5 had `project='hearth'`). Tool-call args carry absolute paths into `messages.content`, so message FTS is the retroactive topic signal.

- "sessions about X" -> `memledger_search` kind=sessions (the `search_sessions` RPC, migration 009): unions attributed title/project/cwd ILIKE with message-FTS mentions, returns `match_kind` (attributed|mentions|both), `hits`, `last_hit`. The pi tool excludes the current session's rows and OR-broadens on empty.
- `list_sessions` (pi tool: `project=ilike`; MCP tool: EXACT match - semantics differ!) is the narrow attributed-browser only.
- **History-first is process, not fallback** (2026-08-25): before starting ANY non-trivial task, one `memledger_search` / `search_messages` with 2-3 terms from the task (component name, error text). The `history-first` extension (pi) / UserPromptSubmit hook (CC) enforces the reminder until a lookup fires.

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
- Self-hit pollution looks like a sync gap but never is one (2026-08-23): every "memledger only has this session's messages" report so far was the querying session's own echo out-ranking the sources under an over-constrained AND query - the data was always in the DB. Check message counts per session_key server-side before suspecting ingest; then fix the query, not the ingester.
- pgvector HNSW + selective WHERE filter = silently EMPTY results: the approximate index gathers candidates table-wide and post-filters, so `source=claude` (3 embedded rows in 635k) returned 0 while unfiltered worked. `_semantic_query` materializes the filtered subset (CTE) and runs exact cosine when `source` is given; unfiltered keeps the index path. Never trust "0 rows" from a filtered ANN query without checking `enable_indexscan=off`.
- Semantic search parity (2026-08-09): `/semantic/search` and MCP `semantic_search` both take `kind` (messages|memories|ledger_entries) + `source`; the web UI semantic mode passes its src filter through; pi's `memledger_search` extension forwards `source` for kind=semantic. New claude.ai rows embed newest-first in the background backfill - old-imported rows (2024-2025 ts) are embedded LAST, so semantic-over-claude is sparse until the backlog drains (~1 day for 600k).

## Ops

- Deploy: `make deploy` in the repo (push + composer sync -> build -> up - `up` does NOT build, the stack has a built `ui` image). Stack changes: the network is memledger_backend (internal) + servarr_lan macvlan on servarr; the router's dockerBridges no longer lists it.
- Timers: `systemctl --user list-timers 'memledger*'`; logs `journalctl --user -u memledger-sync.service`.
- Secrets: Vaultwarden item `memledger` (POSTGRES_PASSWORD, POSTGREST_PASSWORD, MEMLEDGER_TOKEN, Silo scoped service account `memledger` - root no longer in consumer envs); SOPS .env in the repo; dev-box env at `~/.config/memledger/env`.
- Verification: `make test` + `make test-e2e` (throwaway PG+PostgREST in docker); web: `cd web && bunx biome check src && bun test src && bun run check && bun run build`. The repo's `.pi/harness.json` self-correcting-loop manifest covers all of it - 12 sensors, canary-verified.
- PostgREST caches the schema: new views/RPCs in a migration need `docker restart memledger-postgrest` (or NOTIFY pgrst) or they 404.
