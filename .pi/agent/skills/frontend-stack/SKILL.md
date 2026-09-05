---
name: frontend-stack
description: Use when scaffolding a new web frontend project or making integration-level frontend decisions - Astro (default), React via create-tsrouter-app, or Next.js, with biome, shadcn/ui + Tailwind, zod, and the tanstack libraries. Fires on 'new frontend/app/site', 'scaffold a web app', 'Astro vs React vs Next', 'add shadcn', 'Tailwind setup', 'tanstack-form/query/router'. NOT for the visual/interaction ethos (design-utilitarian) or the favicon set (favicons-and-icons).
---

# frontend-stack - Astro 7 / React / shadcn / Tailwind v4 / zod 4

Scaffold-focused. For the visual + interaction ethos that ships by default with these scaffolds, see `design-utilitarian`.

## Framework decision tree

```
Content-heavy (marketing, blog, docs, landing) + occasional widget
  → Astro 7 + React islands  ← DEFAULT for "I need a website"

SaaS dashboard, heavy interactivity, lots of state, real-time
  → create-tsrouter-app   (no server logic in same repo)
  → Next.js app router    (need API routes / RSC / server actions)

Forms-heavy CRUD (admin panels, internal tools)
  → create-tsrouter-app with --add-ons tanstack-query
  → OR Astro+React if half the surface is content

SEO-critical + dynamic data → Astro SSR + React islands
Mobile / desktop / CLI       → out of scope
```

Default when user says "a website with some interactive bits" without elaborating: **Astro 7 + React islands**.

**Ship the least JS that solves the problem.** Astro-first: server-rendered HTML for content and read-only displays; React islands only where interactivity earns it (forms, live-updating widgets, sortable/actionable tables). Reach for `client:visible`/`client:idle` over `client:load`, and `client:load` over `client:only`. If a section can be a static table populated at build or a thin polling island, it is not a reason to SPA the page. Zero-JS pages are a feature, not a compromise.

## Versions: verify before use

Do NOT trust pinned versions from training data. Before recommending or scaffolding:

- npm package: call the `webfetch` tool (WebFetch in Claude Code) on `https://registry.npmjs.org/<pkg>/latest` and read the `version` field.
- Container image: call the `oci_tags` tool (erfi-toolkit `oci_tags` in Claude Code) on `ghcr.io/<owner>/<repo>` and pick the newest semver tag.
- Library docs not in the docs mirror (Biome is not): call the `context7_query_docs` tool with the library id (`/biomejs/biome`) and the topic. Astro, Tailwind, shadcn, zod, tanstack-* and Next.js ARE in the mirror - use the docs tool (`docs_search`/`docs_read` in pi; `docs` action=search|read in Claude Code) for those.

Quick-check these on any new project: `astro`, `tailwindcss`, `@tailwindcss/vite`, `zod`, `@biomejs/biome`, `@tanstack/{react-form,react-query,react-router}`, `create-tsrouter-app`, `shadcn` (the CLI, NOT the deprecated `shadcn-ui` npm package).

## Foundation (every new project)

| Concern | Pick |
|---|---|
| Lint / format | `@biomejs/biome` |
| Type-check | `typescript` strict |
| UI components | `shadcn` CLI (owned components, Tailwind-styled) |
| Styling | `tailwindcss@^4` (CSS-first config via `@theme`) |
| Validation | `zod@^4` |
| Server state | `@tanstack/react-query` (when app talks to APIs) |
| Forms | `@tanstack/react-form` + `zod` |
| Client routing (React) | `@tanstack/react-router` |
| Icons | `lucide-react` |
| Date/time | `date-fns` |

## Package manager: ask once

bun is the natural default (fast install, native test runner). pnpm if monorepo or bun-compat issues. Ask at scaffold time; don't decide silently.

## Supabase integration

If backend includes Supabase, defer to the `supabase` skill for client setup, RLS, SSR cookies, auth flow. For scaffold-only mention: install `@supabase/supabase-js` + `@supabase/ssr` for SSR-aware sessions. Then the `supabase` skill takes over.

## Common pitfalls

- `bun create @tanstack/router` does not exist - use `bun create tsrouter-app@latest ...`. (Also caught by the `create_tanstack_router_hallucinated` tool-guard rule.)
- `shadcn-ui` npm package is deprecated. Use `shadcn@latest` (CLI v4).
- Astro `--typescript strict` flag was removed in v5. Astro 6+ sets strict TS by default - the flag throws.
- React islands in Astro ≠ React Server Components. Different model.
- file-routes in tanstack-router require codegen via `@tanstack/router-plugin` (`import { tanstackRouter } from "@tanstack/router-plugin/vite"`). `create-tsrouter-app` sets this up; a manual scaffold must add the plugin. `@tanstack/router-vite-plugin` is the legacy package name and lags behind.
- Mixing form libs in one project: pick tanstack-form OR react-hook-form, not both.
- shadcn into monorepo: CLI assumes single package. Use the v4 `--monorepo` flag for nx/turborepo layouts.
- Biome + monorepo: `"root": true` on workspace `biome.json` + per-package overrides only when needed.

## Reference files (read when you get there)

- `scaffolds.md` - the exact scaffold commands (Astro, create-tsrouter-app, Vite, Next.js), the Go-embed layout, and the Biome config. Read when actually scaffolding.
- `patterns.md` - hydration directives, tanstack-form + zod, zod v4 boundary validation, tanstack-query defaults, Tailwind v4 gotchas. Read when wiring a form, a query client, or a Tailwind v3 migration.

## When NOT to use this skill

- Adding a feature to an existing project - go straight to `supabase` / `tanstack-*` / `shadcn` docs sources.
- Exotic stack (Svelte, Qwik, htmx-only) - defer to relevant docs source. `create-tsrouter-app --framework solid` IS supported if Solid + TanStack Router is the goal.
- Non-web frontend (mobile, desktop, CLI, embedded) - out of scope.

## Pairs with

- `design-utilitarian` - the visual + interaction ethos that ships by default with these scaffolds
- `supabase` - backend when included
- `supabase-postgres-best-practices` - DB schema decisions
- `favicons-and-icons` - favicon set after scaffold
- `writing-specs` / `writing-plans` - methodology layer above (explicit-ask-only)
