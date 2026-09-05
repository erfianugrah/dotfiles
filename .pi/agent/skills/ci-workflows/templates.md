# ci-workflows: workflow templates

Supporting reference for the `ci-workflows` skill. Copy-paste workflows for GitHub Actions and Forgejo Actions: Bun + Biome tests, Pages deploy, Docker build + push (GHCR and the Forgejo registry), GitHub Release on tag, and the cross-platform file.

## Workflow templates - GitHub Actions

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
      - uses: actions/checkout@v7

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
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
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
      - uses: actions/checkout@v7

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
      - uses: actions/checkout@v7
      - uses: softprops/action-gh-release@v3
        with:
          generate_release_notes: true
          files: dist/*
```

## Workflow templates - Forgejo Actions

Same YAML as GitHub but in `.forgejo/workflows/` and avoiding the ignored fields.

### Node + Bun + Biome + tests (Forgejo)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest    # → catthehacker/ubuntu:act-22.04
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bunx biome check .
      - run: bun test
```

### Docker build + push to Forgejo container registry

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
      - uses: actions/checkout@v7

      - uses: docker/setup-buildx-action@v4

      - uses: docker/login-action@v4
        with:
          registry: ${{ vars.REGISTRY }}        # e.g. git.erfi.io
          username: ${{ forgejo.actor }}
          password: ${{ secrets.PACKAGE_TOKEN }}  # PAT, not FORGEJO_TOKEN
            # FORGEJO_TOKEN can't push packages (see forgejo.md)

      - id: meta
        uses: docker/metadata-action@v6
        with:
          images: ${{ vars.REGISTRY }}/<owner>/<repo>   # literal, e.g. git.erfi.io/erfi/servarr
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

Keep the image path literal. The Forgejo `github` context is missing keys, so do not assume `github.repository_owner` or `github.repository` resolve; the user's live workflow (`~/infra/servarr/.forgejo/workflows/ci.yml`) hardcodes `git.erfi.io/erfi/servarr` for this reason.

## Cross-platform workflow (works on both)

Stick to GitHub-compatible syntax, avoid ignored Forgejo fields:

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
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun test
```

Copy this same file to both `.github/workflows/ci.yml` and `.forgejo/workflows/ci.yml`.
