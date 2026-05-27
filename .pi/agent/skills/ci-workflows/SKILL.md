---
name: ci-workflows
description: Set up CI/CD workflows for GitHub Actions or Gitea Actions (self-hosted) with verified-current action versions. Covers the .github/workflows/ and .gitea/workflows/ YAML, action pinning, Gitea-specific compatibility quirks (ignored fields, runner labels, default action source), Docker image build+push patterns, language setup (node/python/go/java/bun/deno), pages deployment, GitHub Releases, and the verification protocol for staying current. Use when adding or reviewing any workflow YAML, or migrating between GitHub and Gitea Actions.
---

# CI workflows — GitHub Actions + Gitea Actions

The Gitea Actions runtime (`act_runner`) is a deliberate compatibility layer over GitHub Actions YAML. Workflows mostly copy across, but several fields are silently ignored and the runner image model differs. This skill encodes both platforms with verified-current action versions and the gitea-specific gotchas.

All versions below were queried from `api.github.com/repos/<owner>/<action>/releases/latest` on 2026-05-21. Re-verify with `webfetch` before pinning in a new project if it's been >3 months.

## When to use what

- `.github/workflows/*.yml` for repos hosted on github.com
- `.gitea/workflows/*.yml` for repos on a self-hosted Gitea instance
- Both directories can co-exist; pick whichever runner is registered
- Filenames: `ci.yml`, `release.yml`, `deploy.yml` — concise, one workflow per concern

## Verified-current action versions (2026-05-21)

Pin to the **major version tag** (e.g. `@v6`) unless you have a specific reason to lock to a SHA. Major-tag pinning lets dependabot patch-bump automatically.

### Core actions (`actions/*`)

| Action | Version | Notes |
|---|---|---|
| `actions/checkout` | `v6` | v6.0.2; Node 24 runtime; v5/v4/v3 still on Node 20/16 |
| `actions/setup-node` | `v6` | v6.4.0 |
| `actions/setup-python` | `v6` | v6.2.0 |
| `actions/setup-go` | `v6` | v6.4.0 |
| `actions/setup-java` | `v5` | v5.2.0 |
| `actions/cache` | `v5` | v5.0.5 |
| `actions/upload-artifact` | `v7` | v7.0.1 |
| `actions/download-artifact` | `v8` | v8.0.1 — note: v8 is one major **ahead** of upload |
| `actions/configure-pages` | `v6` | v6.0.0 |
| `actions/deploy-pages` | `v5` | v5.0.0 |

### Language / package managers

| Action | Version | Notes |
|---|---|---|
| `oven-sh/setup-bun` | `v2` | v2.2.0 |
| `denoland/setup-deno` | `v2` | v2.0.4 |
| `pnpm/action-setup` | `v6` | v6.0.8 |
| `astral-sh/setup-uv` | `v8` | v8.1.0 — Python via uv (fast, replaces setup-python + pip flow) |

### Docker

| Action | Version | Notes |
|---|---|---|
| `docker/setup-buildx-action` | `v4` | v4.0.0; Node 24 runtime (requires Runner ≥ 2.327.1) |
| `docker/build-push-action` | `v7` | v7.2.0 |
| `docker/login-action` | `v4` | v4.1.0 |
| `docker/metadata-action` | `v6` | v6.0.0 |

### Release & misc

| Action | Version | Notes |
|---|---|---|
| `softprops/action-gh-release` | `v3` | v3.0.0; Node 24 — stay on v2.6.2 if Node 20 needed |

### Verification protocol — DON'T trust this table forever

Before pinning a version in a new project:

```bash
webfetch https://api.github.com/repos/actions/checkout/releases/latest | jq .tag_name
```

Replace `actions/checkout` with the action's `owner/repo`. The github API endpoint is the authoritative source — release notes don't live in docs.erfi.io.

If a major version is in active beta (e.g. `v7-beta`), stay on the previous stable major.

## Workflow templates — GitHub Actions

### Node + Bun + Biome + tests

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile
      - run: bunx biome check .
      - run: bun test
```

### Astro / Vite SPA → GitHub Pages

```yaml
name: Deploy to Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

### Docker build + push to GHCR

```yaml
name: Build and Push

on:
  push:
    branches: [main]
    tags: ["v*"]

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: docker/setup-buildx-action@v4

      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - id: meta
        uses: docker/metadata-action@v6
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha

      - uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### GitHub Release on tag

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: softprops/action-gh-release@v3
        with:
          generate_release_notes: true
          files: dist/*
```

## Gitea Actions — what's different

Gitea Actions is **mostly drop-in compatible** with GitHub Actions YAML, but the following fields are **silently ignored** as of Gitea 1.26 / act_runner 0.2.11 (verified from `docs.gitea.com/usage/actions/comparison`):

| Field | Status |
|---|---|
| `jobs.<id>.timeout-minutes` | **IGNORED** (set timeout at runner level instead) |
| `jobs.<id>.continue-on-error` | **IGNORED** |
| `jobs.<id>.environment` | **IGNORED** (no environment protection rules) |
| `concurrency:` (groups) | **IGNORED** |
| `permissions:` | Different model — Gitea scopes (`code`, `releases`, `wiki`, `projects`); GitHub-only scopes (`statuses`, `checks`, `deployments`, `id-token`, `security-events`, `pages`) not supported |
| Problem Matchers | IGNORED |
| Error annotations | IGNORED |
| Expressions | Only `always()` supported (no `failure()`, `success()`, etc.) |
| `runs-on: [label_a, label_b]` | Required act_runner ≥ v0.2.11 |
| `id-token` (OIDC to cloud) | Not supported |

### Runner labels & images

Default labels in `act_runner` map to docker images:

| Label | Image | Notes |
|---|---|---|
| `ubuntu-latest` | `catthehacker/ubuntu:act-24.04` | "default" — most tools, recommended |
| `ubuntu-24.04` | `catthehacker/ubuntu:act-24.04` | |
| `ubuntu-22.04` | `catthehacker/ubuntu:act-22.04` | |
| `ubuntu-latest-slim` | `node:20-bookworm-slim` | "slim" — Node only, ~200MB |
| `ubuntu-latest-full` | `catthehacker/ubuntu:full-24.04` | "full" — all GH tools, ~70GB, **amd64 only** |

Use the `full` image only when you need GitHub-runner-parity (rare). Default `catthehacker/ubuntu:act-24.04` covers ~95% of workflows.

### Action source

Gitea downloads non-fully-qualified actions from **github.com** by default (since v1.21). So `uses: actions/checkout@v6` resolves to `https://github.com/actions/checkout.git`. To pin to a Gitea-hosted action, use the absolute URL:

```yaml
- uses: https://gitea.com/actions/checkout@v4
- uses: https://your-gitea.example.com/owner/action@v1
```

To restrict to self-only (air-gapped instance), set `[actions].DEFAULT_ACTIONS_URL = self` in `app.ini`. Then absolute URLs are still required for external actions.

### Context — github vs gitea

`${{ github.* }}` and `${{ gitea.* }}` both work. Prefer `gitea.*` for new workflows (future-proofing; Gitea may diverge). For shared workflows running on both platforms, stick with `github.*`.

### GITEA_TOKEN limitations

- **Package registry auth**: GITEA_TOKEN cannot publish to the repo's package registry. Workaround: use a Personal Access Token with `write:package` scope stored as a secret.
- **Cross-repo**: GITEA_TOKEN is clamped to the running repo. For cross-repo access use PATs.
- **Fork PRs**: GITEA_TOKEN is read-only for fork PRs (same as GitHub).

## Workflow templates — Gitea Actions

Same YAML as GitHub but in `.gitea/workflows/` and avoiding the ignored fields.

### Node + Bun + Biome + tests (Gitea)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest    # → catthehacker/ubuntu:act-24.04
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bunx biome check .
      - run: bun test
```

### Docker build + push to Gitea container registry

```yaml
name: Build and Push

on:
  push:
    branches: [main]
    tags: ["v*"]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: docker/setup-buildx-action@v4

      - uses: docker/login-action@v4
        with:
          registry: ${{ vars.REGISTRY }}        # e.g. gitea.example.com
          username: ${{ gitea.actor }}
          password: ${{ secrets.PACKAGE_TOKEN }}  # PAT, not GITEA_TOKEN
            # GITEA_TOKEN can't push packages (see Gitea quirks above)

      - id: meta
        uses: docker/metadata-action@v6
        with:
          images: ${{ vars.REGISTRY }}/${{ gitea.repository }}
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=sha

      - uses: docker/build-push-action@v7
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

Note the explicit `vars.REGISTRY` — Gitea has no equivalent of GitHub's `ghcr.io/${{ github.repository_owner }}` shortcut. Set `REGISTRY` as a repo or org variable.

## Cross-platform workflow (works on both)

Stick to GitHub-compatible syntax, avoid ignored Gitea fields:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun test
```

Copy this same file to both `.github/workflows/ci.yml` and `.gitea/workflows/ci.yml`.

## Common pitfalls

### Stale action versions

The single biggest LLM failure on CI YAML: pinning to `@v3` or `@v4` from training-data defaults when `@v6` is current. **ALWAYS check the action's latest release** via `webfetch https://api.github.com/repos/<owner>/<repo>/releases/latest | jq .tag_name` before writing the YAML. Don't trust memory.

### `actions/upload-artifact` v3 deprecation

GitHub deprecated v3 in 2024 and **breaks running workflows** when artifacts are involved. Migrate to v4+ (current: v7). Same applies to download-artifact (current: v8 — yes, ahead of upload).

### v6 actions need Node 24

`actions/checkout@v6`, `actions/setup-node@v6`, `docker/*@v4+`, `softprops/action-gh-release@v3` all use the Node 24 actions runtime. Self-hosted runners must be **Actions Runner ≥ 2.327.1**. Older self-hosted runners hang or fail on these. Either upgrade the runner or pin to the previous major (v5/v3/v2.6.2 respectively).

### Gitea `concurrency:` doesn't queue

If your repo relies on `concurrency:` groups to serialize deploys, Gitea will run them in parallel. Workaround: use a self-hosted runner with `--max-parallelism 1`, or implement file-locking in the workflow itself.

### Gitea `id-token` for cloud auth

OIDC trust to AWS/GCP/Azure is not supported. Fall back to long-lived access keys stored as secrets (rotate manually) or use a self-hosted runner with native cloud-instance credentials.

### Caching across runners

Gitea Actions has its own cache backend (`actions/cache` works), but cache scope is per-runner-group, not org-wide like GitHub. Cross-job cache hits work; cross-repo cache hits don't.

### `runs-on:` on Gitea must match a registered label

If your workflow says `runs-on: ubuntu-24.04` but the registered runner only has `ubuntu-22.04, ubuntu-latest` labels, the job sits in pending forever. Check with `act_runner list` on the runner host. The user's setup uses `ubuntu-latest` (→ `act-24.04`) by default.

### Matrix strategies

Both platforms support `strategy.matrix`. Verified working on Gitea since 1.21. Use it for multi-Node-version / multi-OS tests:

```yaml
strategy:
  matrix:
    node: [20, 22, 24]
runs-on: ubuntu-latest
steps:
  - uses: actions/setup-node@v6
    with:
      node-version: ${{ matrix.node }}
```

## When NOT to use this skill

- Setting up Drone / CircleCI / Jenkins / Woodpecker — different syntax, different ecosystem. Use the appropriate vendor docs.
- Migrating Bitbucket Pipelines / GitLab CI to GitHub — bigger migration than this skill covers; use GitHub's official migration docs.
- Anything involving GitHub Apps / fine-grained PATs / OIDC trust policies — those are *configuration of GitHub itself*, not workflow YAML.

## Related

- **Docs sources**: `github` (GitHub product docs incl. Actions YAML reference), `gitea` (self-hosted instance docs), `gitea-api`
- `frontend-stack` — when scaffolding a project that needs CI on day one
- `oci_tags` — query for current versions of container images you build/push
