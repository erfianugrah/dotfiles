# session-ledger

A queryable, cross-session **work ledger** that turns the manual
`quit → session_search → re-explain` loop into automatic context
carry-forward. New sessions in a project start already knowing where the last
one left off.

## Why

Letting a session's context grow is expensive (every turn re-sends the whole
conversation; only partly mitigated by prompt caching). The cheaper habit is to
quit early and start fresh — but then you lose the thread and re-explain it by
hand. This extension keeps the cheap habit and removes the re-explaining: it
captures a structured summary of each session and silently re-injects the
relevant ones when you come back.

It is **complementary** to pi's built-in compaction, not a replacement:
- Compaction = automatic summarise-in-place when context nears the window limit.
- session-ledger = persist those summaries (plus short un-compacted sessions)
  and surface them in *future* sessions.

For durable facts (preferences, conventions) keep using the `memory` tool — the
ledger is for *what was done*, memory is for *what's always true*.

## How it works

Three surfaces, all on verified pi hooks:

1. **Capture (zero effort)**
   - `session_compact` → persists the LLM-written structured summary pi
     generates for free on every compaction / `/compact`. Degenerate
     summaries (the `(No conversation content…)` skeletons compaction emits on
     empty / split-turn spans) are filtered out.
   - `session_shutdown` → catches short sessions you quit *before* compaction
     ever fires. It writes the serialized transcript **raw** (a synchronous
     SQLite insert — no network call on the quit path, so quit never hangs)
     marked `summary_pending = 1`.

2. **Lazy summarise**
   - The next `session_start` summarises any pending raw rows via a one-shot
     `complete()` call (cheap model, bounded count, timeout) — off the quit
     path, where there's time and a model. If the model returns `SKIP` or a
     too-thin summary, the row is dropped.

3. **Retrieve (seamless)**
   - `session_start` loads the latest summaries for the current project into a
     `context` hook that prepends them as a system block — cached in the
     system-prompt region, so ~zero per-turn cost under Anthropic prompt
     caching. The block carries a staleness warning ("re-read named files
     before acting") so summaries are treated as hints, not gospel.

## Tools & command

| Surface | What |
|---|---|
| `ledger_search` | FTS5 keyword search over summaries (`query`, optional `project`, `limit`). |
| `ledger_sql` | Read-only SQL (`SELECT` / `WITH` only — double-guarded by a keyword check *and* a `readonly` connection). For arbitrary history queries. |
| `/ledger` | `status` \| `on` \| `off` \| `summarize` (force-summarise pending rows). |

## Config

| Env | Default | Effect |
|---|---|---|
| `LEDGER_OFF=1` | unset | Disable injection (capture still runs). |
| `LEDGER_SUMMARY_MODEL` | active model | `provider/id` to use for lazy summarisation (e.g. a cheap fast model). |
| `LEDGER_INJECT_MAX_ROWS` | `2` | Max summaries injected per session. |
| `LEDGER_INJECT_MAX_BYTES` | `6000` | Byte budget for the injected block. |
| `LEDGER_INJECT_MAX_AGE_DAYS` | `21` | Only inject summaries newer than this. |
| `LEDGER_SUMMARISE_TIMEOUT_MS` | `30000` | Per-row lazy-summarise timeout. |

## Storage

- `~/.pi/agent/ledger.db` (SQLite, WAL). **Not version-controlled** —
  per-machine work history, like `memories.json`.
- Project scope = `git rev-parse --show-toplevel`, falling back to cwd.
- Schema carries a nullable `embedding` BLOB so `sqlite-vec` semantic search
  can be layered on later with no migration.

```
ledger(id, session_file, project, cwd, git_branch, created_at INTEGER ms,
       kind, summary, raw_text, read_files JSON, modified_files JSON,
       tokens_before, summary_pending, embedding)
ledger_fts(summary, project)   -- FTS5, porter unicode61
```

## Tests

- Pure-helper unit tests: `.pi/agent/tests/extensions.test.ts`
  (degenerate detection, FTS query, injection block, read-only SQL guard,
  transcript serialiser, completion extractor).
- Full-lifecycle e2e: `.pi/agent/tests/integration/session-ledger.e2e.test.ts`
  drives the real hooks + tools through a fake pi runtime
  (compact → inject → search → shutdown → lazy-summarise).
- Run both: `./.pi/agent/tests/run.sh`.

## Caveats

- A new extension file needs a **pi restart** to load (`/reload` won't pick it
  up).
- The near-zero-cost injection claim assumes the model provider forwards
  Anthropic `cache_control`. Confirm via `cache_read_input_tokens` in a
  response; if it doesn't cache, injection still works but costs the block's
  (byte-capped) tokens each turn.
