---
name: ci-workflows
description: "Use when adding or reviewing CI/CD workflow YAML for GitHub Actions or Forgejo Actions (self-hosted), pinning action versions, migrating workflows between GitHub and Forgejo, building/pushing Docker images in CI, setting up language toolchains (node/python/go/java/bun/deno), deploying Pages, or cutting GitHub Releases in CI. NOT for inspecting, re-running or cancelling runs (gh)."
---

# CI workflows - GitHub Actions + Forgejo Actions

The Forgejo Actions runtime is a deliberate compatibility layer over GitHub Actions YAML. Workflows mostly copy across, but several fields are silently ignored and the runner image model differs. This skill encodes both platforms with verified-current action versions and the Forgejo-specific gotchas.

The user's self-hosted forge is Forgejo 16.x at `git.erfi.io` (MS-01 router) with Forgejo Runner v13; the labels `ubuntu-latest`/`ubuntu-22.04` map to `ghcr.io/catthehacker/ubuntu:act-22.04`. Setup details: `~/infra/forgejo-compose/AGENTS.md`.

## When to use what

- `.github/workflows/*.yml` for repos hosted on github.com
- `.forgejo/workflows/*.yml` for repos on a self-hosted Forgejo instance
- Both directories can co-exist; pick whichever runner is registered
- Filenames: `ci.yml`, `release.yml`, `deploy.yml` - concise, one workflow per concern

## Pinning action versions

Pin to the floating major tag (`@v7`) unless you have a specific reason to lock to a SHA; major-tag pinning lets dependabot patch-bump automatically. The current major is usually several ahead of training-data defaults, and this skill's own table has been a major behind within three months, so run both checks before every `uses:` line you write:

```bash
gh api repos/<owner>/<action>/releases/latest --jq .tag_name        # latest release
gh api repos/<owner>/<action>/git/matching-refs/tags/v7 \
  --jq '[.[]|select(.ref=="refs/tags/v7")]|length'                  # 1 = floating v7 exists; 0 = pin the exact release
```

A release does not imply a floating tag. `actions/*` and `docker/*` publish moving majors; `astral-sh/setup-uv` (after v7) and `denoland/setup-deno` do not, and `@vN` on those fails before any step runs:

    ##[error]Unable to resolve action `astral-sh/setup-uv@v9`, unable to find version `v9`

If a major is in beta (`v7-beta`), stay on the previous stable major. `action-versions.md` holds the last verified snapshot - read it when pinning, after the checks above.

## Forgejo Actions - what's different

Forgejo's own docs say it aims for *familiarity, not compatibility* (`forgejo` docs source, `user/actions/github-actions.md`). Most YAML copies across; the table below is what the Forgejo reference (`user/actions/reference.md`) actually documents as of 2026-09-05:

| Field | Status on Forgejo |
|---|---|
| `jobs.<id>.timeout-minutes` | **Supported** per the 2026-09 reference (cancels the job after N minutes); step-level `timeout-minutes` also works. Third-party guides from early 2026 still say job-level is ignored, so on an older runner put the timeout on steps |
| `jobs.<id>.continue-on-error` | **IGNORED at job level** (listed in the known-differences page). Step-level `continue-on-error` works: `outcome` = failure, `conclusion` = success |
| `permissions:` | **IGNORED at job level**. The token scope is whatever the instance grants; there is no per-workflow scope narrowing |
| `id-token` / OIDC | Not via `permissions: id-token: write`. Forgejo uses a top-level `enable-openid-connect` workflow key instead (`user/actions/security-openid-connect`) |
| `concurrency:` | **Supported**, best-effort: `group` + `cancel-in-progress`. Without the key, Forgejo auto-cancels older runs of the same workflow on new `push` / `pull_request` events, which GitHub does not do |
| `jobs.<id>.environment` | Not in the Forgejo reference; treat as unsupported (no environment protection rules) |
| Expressions | `success()`, `failure()`, `always()` documented (`user/actions/basic-concepts.md`) |
| `github.*` context | Works, but "some keys are missing" per the differences page; `forgejo.*` is the native context |
| `runs-on:` | Must match a label the runner registered with; an unmatched job waits forever |
| Problem matchers, `::error::` / `::warning::` annotations | **Not implemented.** `::add-matcher` has no runner or API path: open feature request forgejo/forgejo#3801 ("add support for Workflow Commands"); upstream go-gitea/gitea#29777 shipped only log-viewer styling for `::group::` and `##[error]` lines and left add-matcher undesigned. Nothing surfaces as an annotation; the text just lands in the log |

## Common pitfalls

### `actions/upload-artifact` v3 deprecation

GitHub deprecated v3 in 2024 and **breaks running workflows** when artifacts are involved. Migrate to v4+ (current: v7). Same applies to download-artifact (current: v8 - yes, ahead of upload).

### Current majors need Node 24

`actions/checkout@v7`, `actions/setup-node@v7`, `docker/*@v4+`, `softprops/action-gh-release@v3` all use the Node 24 actions runtime. Self-hosted runners must be **Actions Runner >= 2.327.1**. Older self-hosted runners hang or fail on these. Either upgrade the runner or pin to the previous major (v5/v3/v2.6.2 respectively).

### Forgejo `concurrency:` is best-effort, and the default differs from GitHub

`concurrency.group` + `cancel-in-progress` are supported. With `cancel-in-progress: false` runs in the same group queue behind each other, ordering not strictly guaranteed. Omitting `concurrency` entirely is NOT the GitHub behaviour: Forgejo auto-cancels older `push` / `pull_request` runs of the same workflow when a new event arrives. For a release or deploy workflow that must finish, set `concurrency: { group: deploy, cancel-in-progress: false }` explicitly.

### Forgejo OIDC uses `enable-openid-connect`, not `permissions: id-token`

`permissions:` is ignored at job level, so `id-token: write` does nothing. Forgejo issues OIDC ID tokens through the top-level `enable-openid-connect` workflow key (`forgejo` docs: `user/actions/security-openid-connect`). Whether AWS/GCP/Azure accept the instance as an identity provider is trust-policy work on the cloud side; if that is not set up, fall back to long-lived keys stored as secrets or a runner with native cloud-instance credentials.

### `runs-on:` on Forgejo must match a registered label

If your workflow says `runs-on: ubuntu-24.04` but the registered runner only has `ubuntu-22.04, ubuntu-latest` labels, the job sits in pending forever. Check the runner's registered labels in Forgejo admin > Actions > Runners. The user's setup uses `ubuntu-latest` (-> `act-22.04`) by default.

### Matrix strategies

Both platforms support `strategy.matrix`. Use it for multi-Node-version / multi-OS tests:

```yaml
strategy:
  matrix:
    node: [20, 22, 24]
runs-on: ubuntu-latest
steps:
  - uses: actions/setup-node@v7
    with:
      node-version: ${{ matrix.node }}
```

## Reference files (read when you get there)

- `action-versions.md` - the per-action version table (2026-09-05 snapshot). Read when pinning, after running the checks above.
- `templates.md` - copy-paste workflows for GitHub and Forgejo (tests, Pages, Docker push, Release). Read when writing a workflow file.
- `forgejo.md` - runner labels, DEFAULT_ACTIONS_URL resolution, contexts, FORGEJO_TOKEN limits, stuck-worker and job-network fixes, gitleaks bare binary, gha cache caveat. Read when a Forgejo job misbehaves.

## When NOT to use this skill

- Setting up Drone / CircleCI / Jenkins / Woodpecker - different syntax, different ecosystem. Use the appropriate vendor docs.
- Migrating Bitbucket Pipelines / GitLab CI to GitHub - bigger migration than this skill covers; use GitHub's official migration docs.
- Anything involving GitHub Apps / fine-grained PATs / OIDC trust policies - those are *configuration of GitHub itself*, not workflow YAML.
- Inspecting, re-running, cancelling or downloading artifacts from a run - `gh` skill.

## Related

- **Docs sources**: `github` (GitHub product docs incl. Actions YAML reference), `forgejo` (Forgejo docs mirror: `user/actions/reference.md` is the workflow YAML reference, `user/actions/github-actions.md` the known-differences list), `gitea` / `gitea-api` (legacy, pre-fork).
- `frontend-stack` - when scaffolding a project that needs CI on day one
- the `oci_tags` tool (pi tool; erfi-toolkit MCP in Claude Code) - current tags of container images you build from or push
