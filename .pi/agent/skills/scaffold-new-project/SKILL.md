---
name: scaffold-new-project
description: "Use when the user asks to start, scaffold, bootstrap or create a new project, app, service, CLI, site or repo from nothing. NOT for adding to an existing codebase, frontend framework choices (frontend-stack) or backend module boundaries (software-architecture) - this skill routes to those."
---

# scaffold-new-project - router for greenfield work

Produce a working skeleton with the user's conventions applied. No design doc, no plan doc: the concrete-tech skills already hold the decisions; this skill picks which ones to read, applies the universal skeleton, and stops.

## Hard rules

- No `docs/specs/...` or `docs/plans/...` artifact. The skeleton plus the project's `AGENTS.md` is the design doc.
- At most 3 questions, batched in one message, at the start. A fourth is a default you pick yourself and record in `AGENTS.md`.
- Never re-ask what a stack skill already answers. `frontend-stack` makes Astro 7 the default website stack; do not ask "Astro or Next?".
- Scaffold and stop. Do not implement the first feature unless the prompt was about it.

## Step 1 - classify (silent, no round-trip)

| Signal in the prompt | Project type |
|---|---|
| dashboard / status page / admin / internal tool / form | web app |
| API / service / endpoint / webhook / worker | backend service |
| CLI / command line / script / tool I run | CLI tool |
| library / SDK / package | library |
| static site / landing / docs / marketing | static site |
| homelab service / compose stack / container | compose stack |
| Cloudflare Worker / Pages / D1 / KV / Queues | cloudflare worker |

Genuinely ambiguous after a re-read: that is question #1.

## Step 2 - the question budget

| Project type | Ask only if the prompt did not say |
|---|---|
| web app | Backend? (Supabase / Go service / none, just a SPA) |
| backend service | Language? (Go default per software-architecture; Bun or Python as alternatives) and where it runs (compose stack / Fly / Worker) |
| CLI tool | Language? (Go for distributables, Bun for scripty work) |
| library | Language and target registry (npm / Go module / crates.io) |
| static site | Package manager only - `frontend-stack` wants bun (default) vs pnpm (monorepos) asked once, never decided silently |
| compose stack | Upstream image tag and the Caddy domain |
| cloudflare worker | Bindings? (R2 / KV / D1 / Queues / Durable Objects) |

## Step 3 - route to the owning skills

Always: `software-architecture` for anything with a backend, `design-utilitarian` for anything user-facing (CLIs included), `ci-workflows` for anything that lands in a repo, `docker` if a Dockerfile will be written.

| Project type | Read | Skeleton tree lives in |
|---|---|---|
| web app, static site | `frontend-stack`, `cloudflare-ops` if deploying to Pages | `frontend-stack/scaffolds.md` (exact scaffold commands and configs) |
| backend service | `software-architecture`, then `infrastructure-stack` / `fly` / `cloudflare-ops` by deploy target, `supabase` if it is the database | `software-architecture/layouts.md` |
| CLI tool, library | `software-architecture` | `software-architecture/layouts.md` |
| compose stack | `infrastructure-stack`, `composer` to deploy it, `sops-encrypt` for the `.env` | `infrastructure-stack/templates.md` (compose.yaml, Caddyfile block, per-stack AGENTS.md outline) |
| cloudflare worker | `cloudflare-ops`, `terraform` if managed as IaC | `cloudflare-ops` (`wrangler.jsonc` sections) |

The per-type directory trees live in those files. Do not reproduce them here or in the new repo.

## Step 4 - universal skeleton

Every project gets `AGENTS.md`, `README.md` (one screen: what, how to run), `TODO.md` (never empty), a scoped `.gitignore` (no blanket `*.md` - see `git-troubleshooting`) and `.editorconfig`, plus whatever the owning skill's tree adds.

`AGENTS.md` is the artifact that matters: purpose in one sentence; the stack with version pins; cross-references to the user-level skills (`~/.pi/agent/skills/<name>/SKILL.md`), never copies of them; the defaults you picked because no question was asked; the local commands. The user's skills evolve; copies go stale.

Conventions that hold across every type, because agents keep getting them wrong:

- `compose.yaml`, not `compose.yml` or `docker-compose.yml`.
- `.env` is SOPS-encrypted and committed (`sops-encrypt`), then registered with secretctl. There is no `.env.example` placeholder in this fleet.
- Tailwind 4 is CSS-first: theme tokens go in the CSS `@theme` block; there is no `tailwind.config.ts`.
- Wrangler config is `wrangler.jsonc`, never `wrangler.toml`, for new projects.
- CI is GitHub Actions or Forgejo Actions (`ci-workflows`); the forge is Forgejo, not GitHub-only.
- A compose stack is registered with composer through its API or UI once the repo exists. There is no manifest file to add to the repo.

## Step 5 - initialise, do not just write files

Run `git init`, install with the chosen package manager (`bun install` by default; `go mod tidy` for Go), run the formatter (`bunx biome check --write .` on JS/TS projects), run the tests if any exist, and show `git status --short`. Do not commit - the user reviews and commits. Anything that touches the outside world (DNS, Cloudflare, composer registration, secrets) goes into a "Next steps" list, not into an action, unless the user asked for it explicitly.

## Step 6 - hand off

End with: what was created (tree of the project dir), what works now (formatter passes, tests pass), next steps for the user, and nothing else. Do not start on the first feature.

## Failure modes

- Underspecified prompt ("build me an app"): ask up to 3 questions once; one follow-up if still ambiguous; never a loop.
- Conflicting stack signals (user says Astro, the type wants Next): the user's explicit choice wins; note the trade-off in `AGENTS.md`.
- No matching type: pick the closest row, name the assumption in the response, proceed.

## See also

- `frontend-stack` - Astro 7 / React / Next defaults, shadcn CLI, Tailwind 4, zod, tanstack-*
- `software-architecture` - Go DDD bounded contexts, interface-driven dependencies, repo layouts
- `infrastructure-stack` - compose + Caddy + bridge networks + static IPs convention
- `design-utilitarian` - the UI ethos for anything user-facing
- `cloudflare-ops`, `fly`, `composer`, `terraform` - deploy targets and IaC
- `supabase` - auth, RLS, edge functions, client libraries
- `ci-workflows` - GitHub Actions / Forgejo Actions YAML templates
- `docker` - Dockerfile patterns, buildx, multi-arch
- `sops-encrypt`, `secret-handling` - the `.env` and where secrets live
- `git-troubleshooting` - sane `.gitignore` patterns to seed in new repos
