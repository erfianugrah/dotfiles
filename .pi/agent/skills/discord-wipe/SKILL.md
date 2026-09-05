---
name: discord-wipe
description: "Use when deleting Discord messages the user owns (purge a guild, channel or DM, 'delete all my messages', rolling retention), driving the discord-wipe-go CLI or its production daemon, changing retention or per-scope overrides, redeploying the discord-wipe composer stack, or handling Discord errors such as 50083 (thread is archived). Fires on 'discord-wipe', 'purge my messages', 'RETENTION_OVERRIDES'. NOT for the composer API itself (composer) or ssh access (tailscale-homelab)."
---

# discord-wipe

Self-bot bulk deleter for the user's own Discord messages: repo `~/discord-wipe-go` (Go, cobra CLI, image `ghcr.io/erfianugrah/discord-wipe-go`; the Python `discord-wipe` is deprecated). Prod is the composer stack `discord-wipe`, container `discord-wipe` on `servarr`, driven by composer on the router over drawbridge. The repo's `AGENTS.md` is the deep operational corpus (auto-loads when cwd is the repo); this skill is the cross-cwd subset. Layout drift: the repo lives outside `~/infra/` where every other stack is - leave it, but expect `~/infra`-wide searches to miss it.

## Hard rules

- The token never enters the transcript. Never `--token` on the CLI (process list), never `docker exec ... printenv` (distroless: the error text lands on stdout and gets captured as the "token"), never extract it from `docker inspect ... Config.Env` to rebuild a file - that is exactly the copy-a-credential pattern the secret guard blocks. Credentials move only through `secretctl` and SOPS (`secret-handling` skill).
- Only-my-messages is load-bearing (author-filtered search, export-only-own, 403 terminal). Never add a code path that enumerates other people's messages.
- `DELETE_DELAY` has a 0.3s floor - Discord's account-level abuse heuristics watch overall frequency, separate from per-route buckets.
- Dry-run first, then the real run with a FRESH state file: dry-run still `Mark()`s, so reusing its state makes the real run's no-progress guard exit having deleted nothing.
- `purge --retention-days` defaults to 0 = delete EVERYTHING in scope regardless of age. `run` defaults to 14 days; prod `compose.yaml` sets `RETENTION_DAYS=7`.
- Per-scope retention: `RETENTION_OVERRIDES` / `--retention-override` entries `guild:<id>:<days>` / `channel:<id>:<days>` pin one scope's window - `run` only, live catch-up phase only (the export phase always uses the global window). Malformed entries are fatal. The values are confidential: `.env` + container env only, never the public repo.

## Purge a scope (one-shot)

1. Resolve the ID type (snowflakes do not encode it): `discover`, or `GET guilds/<id>` vs `channels/<id>` and compare 200/404. Wrong scope silently deletes nothing.
2. `purge --guild|--channel <id> --dry-run --state /tmp/x.json` - the search `total=` is the true volume.
3. Real run in the background (hours at 2.5-4s per delete under 429 pacing) with a fresh dedicated `--state`; wait for exit.
4. Verify: re-search and expect `total_results: 0` (allow ~90s of search-index lag before believing a non-zero).

Archived threads (error 50083) are handled: unarchive -> delete -> re-archive; threads that cannot be unarchived leave messages unmarked for a later pass. An early exit with `ok << total` is search-index lag (two empty pages) - re-run, state resumes.

## Deploy / config change

Two facts to check before touching prod, because the repo and the running stack have drifted:

- The repo `AGENTS.md` describes a git-backed composer stack (`auto_sync=true`, no auto-deploy, checkout `/var/lib/composer/stacks/discord-wipe` on the router, `env_file: .env`). The servarr-nixos appdata-tier log (`~/infra/servarr-nixos/docs/migration/2026-09-02-appdata-tier-consolidation.md`) records the stack as NON-git since 2026-09-03: its compose was updated in place via `PUT /api/v1/stacks/discord-wipe` (field `compose`) and the repo is disconnected from it. `GET /api/v1/stacks/discord-wipe` on the composer API tells you which is true today; do not assume a push reaches prod.
- Secrets are not yet converted: `~/discord-wipe-go/.env` is a plaintext file and the router-side `.env` was historically recreated by hand after every git-clean. Standing gap. The target state is a SOPS-encrypted `.env` committed with the stack (`sops-encrypt` skill) so composer decrypts at deploy and no re-creation step exists; `DISCORD_TOKEN` and `RETENTION_OVERRIDES` are set with `secretctl set` / `sops set`, never typed or piped from a running container.

Deploy sequence once the stack state is known:

1. Commit + push `main` (`release.yml` rebuilds `:main`; tag `v*` for releases).
2. Composer `pull` then `up` (`?async=true`, poll `GET /api/v1/jobs/<id>`), API key piped on stdin - one curl per pipe, the stdin config is consumed by the first curl:
   `printf 'header = "X-API-Key: %s"\n' "$COMPOSER_API_KEY" | ssh router 'curl -s --config - -X POST "http://localhost:8080/api/v1/stacks/discord-wipe/pull?async=true"'`
   For a non-git stack, `PUT /api/v1/stacks/discord-wipe` with the new compose replaces `pull`.
3. If `up` fails with `.env not found`, the stack is still on the plaintext-file model and the sync wiped it: restore it from the encrypted source of record (`sops -d` into place via `secretctl exec`, `secret-handling` skill) - never from the container.
4. Verify: `ssh servarr 'docker inspect discord-wipe --format "{{index .Config.Labels \"org.opencontainers.image.revision\"}}"'` matches the pushed SHA; logs show `pass start cutoff=` about `RETENTION_DAYS` ago, not "now".

## Logs & state

- Logs: `GET /api/v1/containers/<id>/logs?tail=N&host=servarr` on the composer API (`host=` required), or `ssh servarr 'docker logs discord-wipe'`.
- Data: `DISCORD_WIPE_DATA_DIR` with `state/` (RW) and `export/` (RO), owned `99:100` for the nonroot user. Live path since the 2026-09-03 tier consolidation is `/appdata/discord-wipe` (hot NVMe tier); the repo `compose.yaml` default still says `/tank/data/appdata/discord-wipe`, which was quarantined - fix the default when the repo and stack are reconnected.
- `state.Deleted` is never GC'd by snowflake age: the IDs in it are old by definition, so any "drop older than X" re-attempts all of them next pass (`TestStateHasNoGCMethod` guards this).
- State loss without a full re-grind: `seed-from-export` (token-less; only when a prior pass is known to have completed - it does not verify deletion). Stop the container, run once against the same mounts, bring the daemon back.

## Dev loop

`go test ./... -race`, `go vet ./...`, `gofmt -l cmd/ internal/`, `CGO_ENABLED=0 go build ./cmd/discord-wipe/`. Bump `version` in `cmd/discord-wipe/main.go` for behaviour changes, tag `vX.Y.Z`, add a `BugN` regression test per fixed bug.
