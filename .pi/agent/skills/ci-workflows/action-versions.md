# ci-workflows: verified action versions

Supporting reference for the `ci-workflows` skill: latest release and floating-major-tag status per action, verified against api.github.com on 2026-09-05. Treat it as a snapshot - run the pinning check in SKILL.md before writing a `uses:` line.

### Core actions (`actions/*`)

| Action | Version | Notes |
|---|---|---|
| `actions/checkout` | `v7` | v7.0.1; Node 24 runtime |
| `actions/setup-node` | `v7` | v7.0.0 |
| `actions/setup-python` | `v7` | v7.0.0 |
| `actions/setup-go` | `v7` | v7.0.0 |
| `actions/setup-java` | `v6` | v6.0.0 |
| `actions/cache` | `v6` | v6.1.0 |
| `actions/upload-artifact` | `v7` | v7.0.1 |
| `actions/download-artifact` | `v8` | v8.0.1 - one major **ahead** of upload |
| `actions/configure-pages` | `v6` | v6.0.0 |
| `actions/deploy-pages` | `v5` | v5.0.1 |
| `actions/upload-pages-artifact` | `v5` | v5.0.0 |

### Language / package managers

| Action | Version | Notes |
|---|---|---|
| `oven-sh/setup-bun` | `v2` | v2.2.0 |
| `denoland/setup-deno` | `v2.0.5` | **Exact tag required.** denoland publishes no floating major tag: `v1`/`v2`/`v3` each resolve to zero refs, only point releases exist |
| `pnpm/action-setup` | `v6` | v6.0.10 |
| `astral-sh/setup-uv` | `v10.0.1` | **Exact tag required.** astral-sh publishes no floating major tags after v7, so `@v8`, `@v9` and `@v10` fail at "Set up job" with `unable to resolve action` |

### Docker

| Action | Version | Notes |
|---|---|---|
| `docker/setup-buildx-action` | `v4` | v4.3.0; Node 24 runtime (requires Runner >= 2.327.1) |
| `docker/build-push-action` | `v7` | v7.3.0 |
| `docker/login-action` | `v4` | v4.6.0 |
| `docker/metadata-action` | `v6` | v6.2.0 |

### Release & misc

| Action | Version | Notes |
|---|---|---|
| `softprops/action-gh-release` | `v3` | v3.0.3; Node 24 - stay on v2.6.2 if Node 20 needed |
