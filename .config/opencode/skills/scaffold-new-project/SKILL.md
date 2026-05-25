---
name: scaffold-new-project
description: Use when the user asks to start, scaffold, build, create, or bootstrap a new project, app, service, tool, site, dashboard, or repo. Orchestrates the user's concrete-tech skills (frontend-stack, infrastructure-stack, software-architecture, design-utilitarian, supabase, terraform, cloudflare, fly, ci-workflows, docker, composer) so the user's conventions are applied without re-asking. Replaces the brainstorming/writing-plans/executing-plans methodology chain for greenfield work — no design doc artifact, no plan doc, just scaffolded code with the right defaults baked in.
---

# scaffold-new-project — orchestrator for greenfield work

Use this when the user says: "let's build X", "scaffold a new Y", "start a project for Z", "I need a tool that does W", or any equivalent greenfield ask. The job is to produce a working skeleton with the user's conventions applied, **not** to write design docs.

## Operating principle

**Read the relevant concrete-tech skills first. Apply their defaults. Ask only what they don't already answer.**

The user has invested in skills that encode their preferences (Astro+shadcn+zod, compose+Caddy+bridge networks, Go DDD, McMaster-Carr UI, OpenTofu over Terraform, etc.). Those skills are the source of truth. This skill is the orchestrator — it routes work to them, not the other way around.

**Hard rules**:
- No `docs/specs/YYYY-MM-DD-X-design.md` artifact.
- No `docs/plans/YYYY-MM-DD-X.md` artifact.
- No question-by-question clarifying loop. At most **3 high-leverage questions** at the very start, batched in one message.
- Never re-ask what's already in a stack skill. If `frontend-stack` says Astro 6 is the default, don't ask "Astro or Next?".
- Produce the skeleton + start working. The user iterates from the working state, not from a design doc.

## Step 1 — Classify the project (silent, no user round-trip)

From the user's prompt, infer:

| Signal | Project type |
|---|---|
| "dashboard / status page / admin / internal tool / form" | **web app** |
| "API / service / endpoint / webhook / worker" | **backend service** |
| "CLI / command line / script / tool I run" | **CLI tool** |
| "library / SDK / package" | **library** |
| "static site / landing / docs / marketing" | **static site** |
| "homelab service / compose stack / container" | **self-hosted compose stack** |
| "Cloudflare Worker / Pages / D1 / KV / Queues" | **cloudflare worker** |

If the prompt is genuinely ambiguous after re-reading, that's question #1.

## Step 2 — Decide if you need to ask anything (one batch, max 3 questions)

Skip questions whose answer is implied by the project type or already locked by a stack skill.

| Project type | Ask only if not specified |
|---|---|
| web app | "Backend? (Supabase / Go service / serverless / none, just SPA)" |
| backend service | "Language? (Go default per software-architecture; alt: Bun, Python)" + "Where does it run? (compose stack on bare metal / Fly / Cloudflare Worker)" |
| CLI tool | "Language? (Go preferred for distributables; Bun for scripty things)" |
| library | "Language? Target (npm / Go module / Cargo)?" |
| static site | usually nothing — Astro 6 + shadcn + Tailwind is the default |
| compose stack | "What's the upstream image? (e.g. ghcr.io/foo/bar:tag) and which Caddy domain?" |
| cloudflare worker | "Bindings? (R2 / KV / D1 / Queues / Durable Objects)" |

Three is the absolute cap. If you find yourself wanting four, the fourth is something you can decide yourself with a defensible default — pick it, document it in the new repo's `AGENTS.md`, and let the user override later.

## Step 3 — Read the relevant skills

Always read `software-architecture` (DDD bounded contexts, interface-driven boundaries — applies to anything backend-y) and `design-utilitarian` (UI ethos — applies to anything user-facing, even CLIs).

Then route by project type:

| Project type | Skills to consult |
|---|---|
| web app | `frontend-stack`, `design-utilitarian`, plus backend skills below if applicable |
| backend service | `software-architecture`, `infrastructure-stack` (if compose) or `fly` (if Fly) or `cloudflare` (if Worker), `supabase` (if DB), `supabase-postgres-best-practices` (if Postgres) |
| CLI tool | `software-architecture` (lite — bounded contexts still help), language-specific patterns |
| library | `software-architecture`, no infra |
| static site | `frontend-stack` (Astro path), `design-utilitarian`, `cloudflare` (if Pages deploy) |
| compose stack | `infrastructure-stack`, `composer` (if registering with composerd), `docker` (if custom Dockerfile needed) |
| cloudflare worker | `cloudflare`, `terraform` (if IaC), language-specific |

CI is universal — read `ci-workflows` for any project that lands in a repo. Containers are common — read `docker` if a Dockerfile will be written.

## Step 4 — Produce the skeleton

The skeleton always includes:

```
project/
├── AGENTS.md                    # seeds the repo with relevant skill cross-refs
├── README.md                    # one screen of what / how to run
├── TODO.md                      # initial todo, never empty
├── .gitignore                   # scoped (no blanket *.md — see git-troubleshooting)
├── .editorconfig                # standard
└── (project-type-specific)
```

The `AGENTS.md` is the most important artifact. It should:
- Name the project's purpose in one sentence.
- List the stack with version pins (Astro 6, biome 2, Tailwind 4, etc.).
- Cross-reference the user-level skills used (`see ~/.pi/agent/skills/frontend-stack/SKILL.md for the full toolchain rationale`).
- Capture project-specific decisions you made (defaults you picked because no question was asked).
- List the local commands: `pnpm dev`, `pnpm test`, `compose up`, etc.

Do not copy the full content of the user-level skills into the repo's `AGENTS.md` — cross-reference instead. The user's skills evolve; copies stale.

## Project-type skeleton recipes

### Web app (Astro 6 + shadcn + Tailwind 4 + zod 4 default)

Defer to `frontend-stack/SKILL.md` for the toolchain. Skeleton:

```
src/
├── pages/                       # Astro pages, server-rendered
├── components/                  # shadcn-installed via CLI, no copy-paste
├── lib/
│   ├── env.ts                   # zod-validated env
│   └── api/                     # tanstack-query clients if backend
├── styles/global.css            # Tailwind 4 single source
└── content/                     # Astro content collections if applicable
biome.json
tailwind.config.ts (only if non-default)
astro.config.mjs
package.json                     # pnpm, exact versions
```

Run shadcn CLI to install primitives — `bunx shadcn@latest add button input form` etc. Do not hand-write component primitives.

### Backend service (Go DDD per bonkled pattern)

Defer to `software-architecture/SKILL.md`. Skeleton:

```
cmd/<svc>/main.go                # wires deps, starts server
internal/
├── <bounded-context-1>/
│   ├── service.go               # interface
│   ├── postgres.go              # impl
│   └── service_test.go
├── <bounded-context-2>/
│   └── ...
├── http/                        # API surface (REST + WS), correlation IDs
├── obs/                         # slog + Prometheus + request IDs
└── config/                      # env loading
go.mod (require ~latest)
Makefile                         # fmt / test / build / docker
Dockerfile                       # multi-stage, scratch base
compose.yml                      # if local dev or self-hosted
```

### Self-hosted compose stack

Defer to `infrastructure-stack/SKILL.md`. Skeleton:

```
compose.yml                      # bridge network + static IP per service
.env.example                     # PUID/PGID/TZ/UMASK
data/                            # bind-mounts (gitignored, .gitkeep'd)
config/                          # bind-mounts (gitignored, .gitkeep'd)
AGENTS.md                        # subnet allocation, Caddy domain, port map
Caddyfile.snippet                # the reverse-proxy block to add to host Caddy
README.md                        # how to bring up + first-run init
```

If the stack will be registered with composerd, read `composer/SKILL.md` and add the `composer.json` manifest.

### Cloudflare Worker

Defer to `cloudflare/SKILL.md`. Skeleton:

```
src/index.ts                     # Worker entry
wrangler.toml                    # bindings, name, compat date
package.json                     # @cloudflare/workers-types, vitest-pool-workers
test/                            # vitest with Miniflare
biome.json
```

If managed via IaC, also read `terraform/SKILL.md` and add a `terraform/` dir.

### CLI tool

Pick Go (preferred, single static binary) or Bun (faster iteration for scripty work). Skeleton:

```
cmd/<name>/main.go      OR      src/index.ts
internal/                       OR      src/lib/
go.mod / package.json
README.md (with install one-liner)
.github/workflows/release.yml   # cross-compile + release artifacts
```

### Library

Same as CLI minus the executable. If npm-published, set up changesets. If Go module, ensure `go.sum` is committed.

### Static site

Astro 6 default. Same as web app skeleton, no API. Deploy target is usually Cloudflare Pages — add a `wrangler.toml` if so.

## Step 5 — Initialize, don't just write files

After writing the skeleton, run the appropriate init commands:

```bash
git init
pnpm install        # or `bun install`, `go mod tidy`, etc.
pnpm exec biome check --write .   # immediate green-bar baseline
pnpm test                          # if tests exist, prove they pass
git add -A && git status --short   # show user what was created
```

Don't commit yet — let the user review and commit themselves.

If a domain / Cloudflare DNS / compose stack registration is needed, **list the manual steps** in a "Next steps" section of the response. Don't try to auto-create DNS records or register stacks unless the user explicitly asked.

## Step 6 — Hand off

End the response with:

1. **What was created** (tree command output, scoped to the project dir).
2. **What's working now** (e.g. "biome check passes, tests pass with placeholder fixture").
3. **Next steps** (manual things the user should do — DNS, secrets, infra, deploy).
4. **No further action** unless the user asks. Don't preemptively start "implementing the first feature" unless the prompt was specifically about the first feature.

## Examples

### Example 1 — minimal info, defaults handle everything

User: *"scaffold a small web app for tracking my coffee orders"*

Decision: web app, no backend specified → SPA + localStorage default. No questions needed; localStorage is the obvious default for a personal coffee tracker.

Read: `frontend-stack`, `design-utilitarian`, `ci-workflows`.

Produce: Astro 6 SPA skeleton, shadcn-installed table + form, zod-validated localStorage schema, Tailwind utilitarian dense layout, biome configured, GH Actions deploy-to-Pages workflow stub.

Hand off: tree, `pnpm dev` works, table empty but functional.

### Example 2 — needs one question

User: *"new compose stack for self-hosting Karakeep"*

Decision: compose stack. Need: upstream image tag, Caddy domain.

Ask one batched message:
- "Image tag pin? (latest, or a specific version like `ghcr.io/karakeep-app/karakeep:0.20.0`?)"
- "Caddy domain? (e.g. `karakeep.erfi.io`)"

Read: `infrastructure-stack`, `composer`, `docker` (only if a wrap-Dockerfile is needed).

Produce: `compose.yml` with bridge network + static IP, `.env.example`, `Caddyfile.snippet`, project `AGENTS.md` documenting subnet/IP/port choices, README with first-run instructions.

Hand off: tree, listed manual next steps (add the Caddy snippet to host config, register the stack with composerd if desired, set secrets in env).

### Example 3 — backend service with database

User: *"I need a Go service that ingests Stripe webhooks and writes to Supabase"*

Decision: backend service. Language locked (Go). DB locked (Supabase). Deploy not specified → ask once.

Ask:
- "Deploy target? (Fly / compose stack on bare metal / Cloudflare Worker — note Workers can't be Go natively)"

Read: `software-architecture`, `supabase`, `fly` or `infrastructure-stack` based on answer, `ci-workflows`.

Produce: bonkled-pattern Go skeleton with `internal/webhooks/` bounded context, signature verification, idempotency table migration, supabase client wired via service-role key, structured logging, Prometheus metrics, deploy config for chosen target.

Hand off: tree, tests pass with mock Stripe events, manual next steps (Supabase project setup, secret config, Stripe webhook URL).

## Anti-patterns this skill replaces

- **Brainstorming question-by-question loop**: don't. Read the skills, batch the maximum 3 questions in one message, move on.
- **`docs/specs/<date>-<topic>-design.md`**: don't write one. The skeleton + project-level `AGENTS.md` is the design doc.
- **`docs/plans/<date>-<topic>.md`**: don't write one. The user can iterate from a working skeleton faster than from a plan.
- **Implementing the first feature before the user asks**: don't. Scaffold and stop. Let the user direct what comes next.
- **Copy-pasting skill content into the project's `AGENTS.md`**: don't. Cross-reference user-level skills; the skill is the canonical source of truth that evolves over time.

## Failure modes

- **Underspecified prompt** ("build me an app"): you genuinely need more info. Ask up to 3 questions in one message. If still ambiguous after answers, ask one follow-up. Don't loop indefinitely.
- **Conflicting stack signals** (user says "Astro" but the project type really wants Next): default to user's explicit choice, note the trade-off in the project's `AGENTS.md`.
- **No matching project type**: the table above is not exhaustive. If genuinely novel, pick the closest fit, name your assumption in the response, and proceed.

## See also

- `frontend-stack` — Astro 6 / React / Next defaults, shadcn CLI, Tailwind 4, zod, tanstack-*
- `infrastructure-stack` — compose + Caddy + bridge networks + static IPs convention
- `software-architecture` — Go DDD bounded contexts, interface-driven dependencies
- `design-utilitarian` — McMaster-Carr UI ethos
- `supabase` — auth, RLS, edge functions, client libraries
- `terraform` — OpenTofu IaC patterns
- `cloudflare` — DNS / Workers / Pages / R2 / D1
- `fly` — managed deploy with anycast and auto-scale
- `composer` — your self-hosted compose stack management platform
- `ci-workflows` — GitHub Actions / Gitea Actions YAML templates
- `docker` — Dockerfile patterns, buildx, multi-arch
- `git-troubleshooting` — sane `.gitignore` patterns to seed in new repos
