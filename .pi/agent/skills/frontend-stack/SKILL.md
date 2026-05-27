---
name: frontend-stack
description: 'Scaffold web frontend projects with the user''s preferred stack. Astro 6 default, React via create-tsrouter-app, or Next.js. Foundation = biome (lint+format), shadcn/ui CLI v4 + Tailwind v4 (UI), zod v4 (validation), tanstack-form (forms), tanstack-query (server state), tanstack-router (React routing). Use when starting a new frontend project or making integration-level decisions. Pairs with `design-utilitarian` for the default visual ethos.'
---

# frontend-stack — Astro 6 / React / shadcn / Tailwind v4 / zod 4

Scaffold-focused. For the visual + interaction ethos that ships by default with these scaffolds, see `design-utilitarian`.

## Framework decision tree

```
Content-heavy (marketing, blog, docs, landing) + occasional widget
  → Astro 6 + React islands  ← DEFAULT for "I need a website"

SaaS dashboard, heavy interactivity, lots of state, real-time
  → create-tsrouter-app   (no server logic in same repo)
  → Next.js app router    (need API routes / RSC / server actions)

Forms-heavy CRUD (admin panels, internal tools)
  → create-tsrouter-app with --add-ons tanstack-query
  → OR Astro+React if half the surface is content

SEO-critical + dynamic data → Astro SSR + React islands
Mobile / desktop / CLI       → out of scope
```

Default when user says "a website with some interactive bits" without elaborating: **Astro 6 + React islands**.

## Versions: verify before use

Do NOT trust pinned versions from training data. Before recommending or scaffolding:

```bash
# Single package latest:
webfetch https://registry.npmjs.org/<pkg>/latest | jq -r .version

# Container image versions:
oci_tags ghcr.io/<owner>/<repo> --semver

# Off-server library docs (e.g. biome):
context7_query_docs /biomejs/biome "<topic>"
```

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

## Common foundation steps

After framework scaffold, every project gets these:

```bash
# Biome
bun add -D @biomejs/biome
bunx biome init

# Tailwind v4 (Vite-based stacks — Astro, Vite, Next 15+)
bun add tailwindcss @tailwindcss/vite

# shadcn — pick template by framework: astro | vite | next
bunx shadcn@latest init -t <template>
bunx shadcn@latest add button input label form

# zod + tanstack-form/query if needed
bun add zod @tanstack/react-form @tanstack/react-query
```

## Biome config template

```json
{
  "$schema": "https://biomejs.dev/schemas/<verify-latest>/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": [".next/", "dist/", "node_modules/", ".astro/"] },
  "formatter": {
    "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true, "style": { "useNamingConvention": "off" } }
  },
  "javascript": {
    "formatter": { "quoteStyle": "double", "trailingCommas": "all", "semicolons": "always" }
  }
}
```

Look up the schema URL: `webfetch https://registry.npmjs.org/@biomejs/biome/latest | jq -r .version` → substitute.

## Scaffolds

### Astro 6 + React islands (DEFAULT)

```bash
# Interactive scaffold (uses bun if available)
bun create astro@latest my-app
cd my-app

# React integration
bun add @astrojs/react @astrojs/check react react-dom @types/react @types/react-dom
# (or combine the two steps: bun create astro@latest my-app -- --add react)
```

`astro.config.mjs`:

```ts
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
```

`src/styles/global.css` (import from `BaseLayout.astro`):

```css
@import "tailwindcss";
```

Then the **Common foundation steps** above (`shadcn init -t astro`, etc.).

#### Embedded into a Go binary (full-stack Go signature pattern)

When the frontend is shipped inside a Go binary via `//go:embed` (the user's
default for full-stack Go projects — see `~/bonkled/` and the
`software-architecture` skill's "Full-stack Go" layout), Astro is doubly
natural: `astro build` produces a static `dist/` directory that
`//go:embed all:web/dist` wraps directly into the Go binary, served by
`http.FileServer(http.FS(...))`. No nginx layer, no separate frontend container.

Layout: `web/` lives at the repo root next to `cmd/` and `internal/`; `web/dist/`
is gitignored and rebuilt by `make web-build` before `go build`. The Astro
config stays the same as above; the only Astro-side concern is that any
client-side routing must be SPA-mode (`output: 'static'`) so deep links resolve
on page refresh — the Go static handler serves `index.html` as the fallback.

Default to this shape for full-stack Go projects unless the frontend has
independent deploy needs (different cache TTLs, separate scale-out, multiple
frontends sharing one backend).

### React SPA via create-tsrouter-app

This bundles router + tailwind + shadcn + tanstack-query in one command:

```bash
bun create tsrouter-app@latest my-app \
  --template file-router \
  --tailwind \
  --add-ons shadcn,tanstack-query \
  --toolchain biome
cd my-app

# Add more shadcn components:
bunx shadcn@latest add input form dialog

# Add tanstack-form + zod (not in --add-ons set by default)
bun add @tanstack/react-form zod
```

`--list-add-ons` lists the full set. `--framework solid` swaps React for Solid (TanStack Router supports both).

If user wants plain Vite without TanStack Router:

```bash
bun create vite@latest my-app -- --template react-ts
cd my-app
bun add tailwindcss @tailwindcss/vite
bunx shadcn@latest init -t vite
# then Common foundation steps
```

### Next.js app router

Default to Next only when user explicitly mentions Next or needs full-stack (API routes, RSC, server actions).

```bash
bun create next-app@latest my-app \
  --typescript --tailwind --app --no-src-dir --turbopack
cd my-app

# Swap eslint for biome (Next defaults to eslint)
bun remove eslint eslint-config-next
# then Common foundation steps + shadcn init -t next
```

`--turbopack` is default in Next 16+ (flag is redundant but harmless).

## Hydration directives (Astro)

For shadcn / React islands inside `.astro`:

- `client:load` — hydrate on page load. Forms, anything interactive immediately.
- `client:idle` — when browser is idle. Non-critical interactive bits.
- `client:visible` — when scrolled into view. Below-fold widgets.
- `client:only="react"` — never SSR'd. Pure SPA island (avoid unless necessary).

Default: `client:load` for forms, `client:visible` for the rest. Don't blanket-`client:load` everything.

## tanstack-form + zod (canonical pattern)

Replaces react-hook-form for new projects:

```tsx
import { useForm } from "@tanstack/react-form";
import { z } from "zod";

const schema = z.object({
  email: z.email(),               // zod v4: top-level z.email()
  password: z.string().min(8),
});

function LoginForm() {
  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: { onChange: schema },     // whole schema, not per-field
    onSubmit: async ({ value }) => { /* value: z.infer<typeof schema> */ },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); form.handleSubmit(); }}>
      <form.Field name="email">
        {(field) => (
          <input
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
            onBlur={field.handleBlur}
          />
        )}
      </form.Field>
      {/* ... */}
    </form>
  );
}
```

shadcn's `<FormField>` is built for react-hook-form. tanstack-form has no shadcn adapter — wrap fields manually as above.

## zod v4 — boundary validation pattern

String formats are top-level in v4: `z.email()`, `z.uuidv4()`, `z.ipv4()`. Method forms (`z.string().email()`) still work but are deprecated.

Use zod everywhere external input crosses a trust boundary:
- API responses → `schema.parse(json)` before trusting
- URL params → tanstack-router `validateSearch` field
- Form inputs → tanstack-form `validators.onChange`
- localStorage / sessionStorage reads → parse; never trust shape
- Environment vars → `z.object({ DATABASE_URL: z.url() }).parse(import.meta.env)` at startup

## tanstack-query defaults

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
```

## Tailwind v4 ≠ v3 — gotchas

- **No `tailwind.config.js` by default.** Config is in CSS via `@theme { --color-brand: oklch(...) }`. v3 configs don't migrate cleanly — move to `@theme` blocks.
- **`@import "tailwindcss"`** replaces `@tailwind base/components/utilities`.
- **`@tailwindcss/vite` plugin** for Vite-based stacks (Astro, Vite, Next 15+). NOT `@tailwindcss/postcss` (fallback only).
- **Plugins**: `@tailwindcss/typography` and `@tailwindcss/forms` have v4 releases. Most third-party v3 plugins haven't been ported.
- **shadcn CLI v4** is required for v4-compatible components. NOT the deprecated `shadcn-ui` npm package.

## Supabase integration

If backend includes Supabase, defer to the `supabase` skill for client setup, RLS, SSR cookies, auth flow. For scaffold-only mention: install `@supabase/supabase-js` + `@supabase/ssr` for SSR-aware sessions. Then the `supabase` skill takes over.

## Common pitfalls

- `bun create @tanstack/router` does not exist — use `bun create tsrouter-app@latest …`. (Also caught by the `create_tanstack_router_hallucinated` tool-guard rule.)
- `shadcn-ui` npm package is deprecated. Use `shadcn@latest` (CLI v4).
- Astro `--typescript strict` flag was removed in v5. Astro 6 sets strict TS by default — the flag throws.
- React islands in Astro ≠ React Server Components. Different model.
- file-routes in tanstack-router require codegen via `@tanstack/router-vite-plugin`. `create-tsrouter-app` sets this up; manual scaffold must add the plugin.
- Mixing form libs in one project: pick tanstack-form OR react-hook-form, not both.
- shadcn into monorepo: CLI assumes single package. Use the v4 `--monorepo` flag for nx/turborepo layouts.
- Biome + monorepo: `"root": true` on workspace `biome.json` + per-package overrides only when needed.

## When NOT to use this skill

- Adding a feature to an existing project — go straight to `supabase` / `tanstack-*` / `shadcn` docs sources.
- Exotic stack (Svelte, Qwik, htmx-only) — defer to relevant docs source. `create-tsrouter-app --framework solid` IS supported if Solid + TanStack Router is the goal.
- Non-web frontend (mobile, desktop, CLI, embedded) — out of scope.

## Pairs with

- `design-utilitarian` — the visual + interaction ethos that ships by default with these scaffolds
- `supabase` — backend when included
- `supabase-postgres-best-practices` — DB schema decisions
- `favicons-and-icons` — favicon set after scaffold
- `superpowers` (`brainstorming`, `writing-plans`) — methodology layer above
