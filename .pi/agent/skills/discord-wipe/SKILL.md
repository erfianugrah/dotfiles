---
name: discord-wipe
description: Use when deleting Discord messages the user owns (purge a guild/channel/DM, "delete all my messages", rolling retention), driving the discord-wipe-go CLI or its production daemon, changing retention, redeploying the servarr container, recovering its .env, or handling Discord errors like 50083 (thread is archived). Repo ~/discord-wipe-go (Go); the Python discord-wipe is deprecated. Sibling to `composer` (deploy path), `tailscale-homelab` (ssh).
---

# discord-wipe

Drive the user's self-bot bulk deleter: repo `~/discord-wipe-go` (cobra CLI, image `ghcr.io/erfianugrah/discord-wipe-go`), prod = composer stack `discord-wipe` (checkout on router `/var/lib/composer/stacks/discord-wipe`, container on servarr via drawbridge). Deep operational corpus = the repo's own AGENTS.md (auto-loaded when cwd is the repo) - this skill is the cross-cwd subset.

## Hard rules (every violation has burned us)

- **Token NEVER enters the transcript.** Extract from the running container without printing:
  `DISCORD_TOKEN=$(ssh servarr 'docker inspect discord-wipe --format "{{range .Config.Env}}{{println .}}{{end}}" | sed -n "s/^DISCORD_TOKEN=//p" | tr -d "\r"') <cmd>`
  `docker exec ... printenv` FAILS (distroless, no printenv) and its error text gets captured as the "token" - real footgun. Never `--token` on the CLI (process list). Each pi bash call is a fresh shell - inline the extraction per call.
- **Only-my-messages is load-bearing** (author-filtered search, export-only-own, 403 terminal). Never add a code path enumerating others' messages.
- **`DELETE_DELAY` >= 0.3s floor** - account-level abuse heuristics, not just buckets.
- **Dry-run first**, then real run with a FRESH state file: dry-run still `Mark()`s, so reusing its state file makes the real run's no-progress guard exit having deleted nothing.
- **purge `--retention-days` defaults to 0 = delete EVERYTHING in scope** regardless of age. `run` defaults 14 (prod compose.yaml sets 7; the stack `.env` holds `DISCORD_TOKEN` + `RETENTION_OVERRIDES`).
- **Per-scope retention (v1.2.0+)**: `RETENTION_OVERRIDES` / `--retention-override` entries `guild:<id>:<days>` / `channel:<id>:<days>` pin one scope's window; `run` only, live catch-up phase only (export phase always uses the global window). Malformed entries are fatal. Values are confidential - they live in `.env` + container env only, never in the public repo.

## Purge a scope (one-shot)

1. Resolve ID type (snowflakes don't encode it): `discover`, or curl `guilds/<id>` vs `channels/<id>` and compare 200/404. Wrong scope = silently deletes nothing.
2. `purge --guild|--channel <id> --dry-run --state /tmp/x.json` - search `total=` is the true volume.
3. Real run via `bg_bash` (hours at ~2.5-4s/delete under 429 pacing) with a fresh dedicated `--state`. `bg_wait until_exit`.
4. Verify: re-search, expect `total_results: 0` (allow ~90s search-index lag before believing a non-zero).
- Archived threads (error 50083) are handled since v1.1.0: unarchive -> delete -> re-archive. Un-unarchivable threads leave messages unmarked for a later pass.
- Early exit with `ok << total` = search-index lag (two empty pages). Re-run; state resumes.

## Deploy / config change

This stack has `auto_sync=true` but **NO auto-deploy**: a push auto-syncs the checkout (and git-cleans it, wiping `.env`) but never recreates the container. Deploy sequence:

1. Commit + push `main` (release.yml rebuilds `:main`; tag `v*` for releases).
2. `pull` via composer API on router, key piped on stdin (one curl per pipe - stdin is consumed):
   `printf 'header = "X-API-Key: %s"\n' "$COMPOSER_API_KEY" | ssh router 'curl -s --config - -X POST "http://localhost:8080/api/v1/stacks/discord-wipe/pull?async=true"'`
3. **Recreate `.env`** - every git-sync (the push-triggered auto-sync, or a manual pull/up) git-cleans untracked files, wiping it; `up` then fails `.env not found`. Pipe BOTH keys container -> file cross-host, verify `grep -c '^DISCORD_TOKEN='` = 1:
   `ssh servarr 'docker inspect discord-wipe --format "{{range .Config.Env}}{{println .}}{{end}}" | grep -E "^(DISCORD_TOKEN|RETENTION_OVERRIDES)=" | tr -d "\r"' | ssh router 'cat > /var/lib/composer/stacks/discord-wipe/.env; chmod 600 /var/lib/composer/stacks/discord-wipe/.env'`
4. `up?async=true` same as pull, then poll `GET /api/v1/jobs/<id>`.
5. Verify: `ssh servarr 'docker inspect discord-wipe --format "{{index .Config.Labels \"org.opencontainers.image.revision\"}}"'` matches the pushed SHA; logs show `pass start cutoff=` ~RETENTION_DAYS ago, NOT "now".

## Logs & state

- Container logs: `GET /api/v1/containers/<id>/logs?tail=N&host=servarr` on the composer API (host= REQUIRED), or `ssh servarr 'docker logs discord-wipe'`.
- Daemon data on servarr `/mnt/user/discord-wipe/` (`state/` RW, `export/` RO), owned 99:100. `state.Deleted` is never GC'd by snowflake age (v0.3.0 footgun).
- State-loss recovery without a full re-grind: `seed-from-export` (only if a prior pass completed).

## Dev loop

`go test ./... -race` (~30 tests), `go vet ./...`, `gofmt -l cmd/ internal/`, `CGO_ENABLED=0 go build ./cmd/discord-wipe/`. Bump `version` in `cmd/discord-wipe/main.go` for behaviour changes, tag `vX.Y.Z`, add a `BugN` regression test per fixed bug.
