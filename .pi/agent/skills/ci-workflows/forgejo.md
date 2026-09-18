# ci-workflows: Forgejo runner, sources, tokens and operations

Supporting reference for the `ci-workflows` skill. The Forgejo-specific mechanics behind the differences table in SKILL.md: the user's runner labels, how relative `uses:` resolves, the forgejo/github contexts, FORGEJO_TOKEN limits, and the operational pitfalls seen on the self-hosted runner.

### Runner labels & images

Labels are whatever the runner was registered with; the image behind a label is set at registration, not by Forgejo. Without a mapping Forgejo Runner falls back to a Debian bookworm image with only node.js (differences page). The user's runner (`~/infra/forgejo-compose/docker-compose.router.yml`) registers:

| Label | Image |
|---|---|
| `ubuntu-latest` | `ghcr.io/catthehacker/ubuntu:act-22.04` |
| `ubuntu-22.04` | `ghcr.io/catthehacker/ubuntu:act-22.04` |

`ubuntu-24.04` is NOT registered; a job asking for it sits in pending. catthehacker also publishes `ubuntu:full-*` images with GitHub-runner tool parity (tens of GB, amd64 only); add a label for one only when a workflow needs it.

### Action source

A relative `uses:` is prefixed with the instance's `DEFAULT_ACTIONS_URL`, which defaults to `https://data.forgejo.org` (not github.com). So `uses: actions/checkout@v7` resolves to `https://data.forgejo.org/actions/checkout`. The user's instance overrides it: `~/infra/forgejo-compose/app.ini` sets `DEFAULT_ACTIONS_URL = github`, so bare `actions/checkout@v7` resolves to github.com there (which is why `~/infra/servarr/.forgejo/workflows/ci.yml` can use bare names). On an instance left at the data.forgejo.org default the same bare name resolves elsewhere. The Forgejo docs recommend fully qualified URLs because the prefix is admin-configurable:

```yaml
- uses: https://data.forgejo.org/actions/checkout@v7
- uses: https://github.com/docker/build-push-action@v7
- uses: https://your-forgejo.example.com/owner/action@v1
```

For an instance pointed at itself (`DEFAULT_ACTIONS_URL` = the Forgejo instance), relative names resolve against local repos and every external action needs its full URL.

### Context - github vs forgejo

`${{ github.* }}` and `${{ forgejo.* }}` both work, but the differences page says some `github` keys are missing. Use `forgejo.*` in `.forgejo/workflows/` files (the live servarr workflow does: `forgejo.event_name`, `forgejo.ref`). Use `github.*` only in a file that must also run on GitHub.

### FORGEJO_TOKEN limitations

Forgejo provides `FORGEJO_TOKEN` (env, `env.FORGEJO_TOKEN`, `secrets.FORGEJO_TOKEN`); `GITHUB_TOKEN` is an alias for the same value. `GITEA_TOKEN` is the pre-fork name.

- **Package registry auth**: the Forgejo packages docs say outright not to use `secrets.FORGEJO_TOKEN` for publishing; use the owner's Personal Access Token with `write:package` scope stored as a secret.
- **Cross-repo**: the token is scoped to the running repo. For cross-repo access use PATs. [unverified beyond the packages case]
- **Fork PRs**: read-only, and the docs warn that untrusted PR code can leak the token since every step sees it.

### gitleaks-action is now license-gated - use the bare binary

gitleaks-action (v2+) requires a `GITLEAKS_LICENSE` secret (free key via the gitleaks.io form; 1 free license covers 1 repo). It validates by querying the **GitHub API** for the repo owner, so on non-GitHub runners (Forgejo) the owner comes back as `unexpected type [undefined]` and the action hard-fails with "missing gitleaks license". The gitleaks **core stays MIT** with binaries on the releases page; the action is the only licensed part. Pattern, verified on a self-hosted Forgejo runner (2026-08-30):

```yaml
- name: gitleaks
  run: |
    set -euo pipefail
    ver=8.30.1
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${ver}/gitleaks_${ver}_linux_x64.tar.gz" -o /tmp/gl.tgz
    tar -xzf /tmp/gl.tgz -C /tmp
    /tmp/gitleaks git --no-banner
```

`gitleaks git` scans full history, redacts findings by default, and exits 1 on leaks. Verify the asset name and tarball layout against the release API before pinning - the naming changed to `gitleaks_<ver>_<os>_<arch>.tar.gz` with the binary at the tarball top level. On GitHub the action is a trap too: `@v2` (Node 20) stops working on GitHub-hosted runners after 2026-09-16, and `@v3` needs runner >= 2.327.1.

### Forgejo runner: stuck workers, and where run results live

A runner worker can hang after picking up a task: the log shows `task N repo is ...` and then nothing for minutes, no job container in `docker ps`. Fix: kill PID 1 inside the runner container (`docker compose exec -T runner sh -c 'kill 1'`); with `restart: unless-stopped` docker recreates it. Already-assigned orphaned tasks are NOT re-dispatched by Forgejo after the worker dies - retrigger with a fresh push. Job output does NOT appear in the runner's logs (it streams to the UI only). Read results from the Forgejo DB instead:

```bash
docker exec <forgejo-db> psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select id, status, updated from action_run order by id desc limit 5"
# per-job: same query on action_task (has log_filename)
```

Status codes: **1 = success, 2 = failure** (verify the mapping against a run whose outcome you know before trusting the numbers).

### Caching across runners

Forgejo Actions has its own cache backend (`actions/cache` works), but cache scope is per-runner-group, not org-wide like GitHub. Cross-job cache hits work; cross-repo cache hits don't.

On the user's runner, job containers cannot reach the runner's cache proxy port, so `docker/build-push-action` with `cache-from: type=gha` fails. Skip the gha cache and rely on Dockerfile `--mount=type=cache` (bun, go mod, go build), which persists in the daemon's BuildKit across runs. `~/infra/servarr/.forgejo/workflows/ci.yml` is the working example.

### Runner job containers can't reach Forgejo (per-workflow bridge isolation)

act (the runner's job executor) creates a per-workflow bridge network on a random subnet. Docker's inter-bridge isolation blocks traffic between this network and the Forgejo bridge, so `git fetch` against `http://forgejo:3000` times out. Fix: set `container.network: <forgejo-bridge>` in the runner's `config.yml` (joins job containers to the forgejo network directly) and optionally add `--add-host forgejo:<ip>` to `container.options`. See `~/infra/forgejo-compose/AGENTS.md` for the user's setup.

### knotea migration gotchas (2026-09-15, all verified on the router runner)

- **Tag-only push on an already-processed commit does NOT fire `on.push.tags`** (observed 2026-09-18, 3x incl. delete+re-push): a new tag pointing at a commit that already has a push run creates no action run - the post-receive hook runs and the push webhook is emitted (tag ops emit a `push` webhook per Gitea #35449), but the actions engine never creates a run. Mechanism inferred (commit-level dedupe), not confirmed. Working ritual: the release tag must go out WITH a new commit (same push is fine). A tag on an unprocessed commit is the only tag-push shape known to fire.
- **Secret names** (UI error, 2026-09-18): letters/digits/underscores only; may NOT start with `FORGEJO_`, `GITEA_` or `GITHUB_` (reserved for runner-injected env) or a digit; the UI auto-uppercases. `GITHUB_PUSH_TOKEN` is rejected - use e.g. `GH_PUSH_TOKEN`.
- **Watch runs via REST** (no psql needed): `GET /api/v1/repos/<owner>/<repo>/actions/runs?limit=N` with `Authorization: token <PAT>` → `workflow_runs[]` with `id`, `title` (commit subject even for tag-triggered runs), `event`, `status`, `conclusion`; single run at `.../runs/<id>` (404 `resource does not exist` for gaps). Poll this from an agent instead of attaching to the runner.

- **Never `git push --tags` to a fresh native repo.** Forgejo evaluates tag-push workflows against the DEFAULT BRANCH's workflow files, so pushing history's tags fires one release run PER TAG - those would rebuild old commits and re-push them as `:latest`. Push `main` only; tags live upstream. If it happens: stop the runner, kill FORGEJO-ACTIONS-* containers, cancel runs + their action_run_job rows + tasks in Postgres (cancel must hit all three levels - run status is re-aggregated from jobs). Full procedure: forgejo-compose AGENTS.md, "Convert a repo from mirror to native".
- **Repo secrets API**: `PUT /api/v1/repos/<owner>/<repo>/actions/secrets/<NAME>` with body `{"data": "<RAW value>"}` - raw string, NOT base64 (base64 gets stored literally and surfaces as registry "denied: denied"). Repo delete needs the `write:user` scope (MIRROR_CRON_TOKEN's write:repository is not enough).
- **act job containers run as root**: chmod-based read-only tests (expect 500 on write) succeed as root (CAP_DAC_OVERRIDE) and fail the suite. Guard with `os.Geteuid() == 0 -> t.Skip`.
- **Actions with internal cross-repo checkouts fail**: trivy-action syncs `aquasecurity/trivy` mid-step and that fetch dies on github.com auth from a self-hosted runner. Bare binary instead (trivy: `curl trivy_<ver>_Linux-64bit.tar.gz`, same pattern as gitleaks above).
- **Job logs**: `/var/lib/gitea/actions_log/<owner>/<repo>/<dir>/<task>.log.zst` (workpath root, not data/); the path is `action_task.log_filename`; zstd lives on the host, not in the container - `docker exec forgejo cat <path>` out and decompress locally.
