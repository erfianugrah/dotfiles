---
name: frontend-stack
description: Scaffold and architect web frontend projects using the user's preferred stack — Astro 6 (default), React (via create-tsrouter-app), or Next.js — with biome for lint/format, shadcn/ui CLI v4 + Tailwind v4 for UI, tanstack-form + zod v4 for forms, tanstack-query for server state, tanstack-router when not using Astro. Encodes a McMaster-Carr-style utilitarian design ethos by default (information-dense, server-rendered, no animation tax, two-color palette + neutrals, tables over card grids). Use when starting a new frontend project, picking a framework, scaffolding a foundational layout, or making integration-level decisions across shadcn/tailwind/zod/forms/routing/design. Slots into the superpowers methodology between `brainstorming` and `writing-plans`.
---

# Frontend stack — Astro 6 / React / shadcn / Tailwind v4 / zod 4

This skill encodes the user's opinionated frontend stack with verified-current versions and CLI commands. Use it when scaffolding, picking technologies, or stitching the integration layer together.

All versions and flags below were verified against npm registry and docs.erfi.io on 2026-05-21. Re-verify before committing if it's been >3 months.

## Slotting into superpowers

1. **`brainstorming`** — clarify intent (what are we building, who's the user, what scale)
2. **THIS skill** — pick framework + foundational dependencies based on intent
3. **`writing-plans`** — turn the choice into an ordered scaffold + feature plan
4. **`executing-plans`** — run the scaffold + first feature
5. **`test-driven-development`** — every feature thereafter

Do not skip step 1.

## Verified-current versions (today)

| Package | Version | Notes |
|---|---|---|
| `astro` | `6.3.6` | v6 stable; v5 already past EOL |
| `tailwindcss` + `@tailwindcss/vite` | `4.3.0` | v4 stable, CSS-first config |
| `zod` | `4.4.3` | v4 is flagship; v3 functionally EOL |
| `@biomejs/biome` | `2.4.15` | v2 stable |
| `@tanstack/react-form` | `1.32.0` | first-class zod integration |
| `@tanstack/react-query` | `5.100.11` | |
| `@tanstack/react-router` | `1.170.6` | |
| `create-tsrouter-app` | `0.54.32` | canonical TanStack scaffolder |
| `shadcn` CLI | v4 (Mar 2026) | NOT the deprecated `shadcn-ui` package |
| `next` (if used) | check `oci_tags` or npm | |

When recommending versions, run `oci_tags ghcr.io/<owner>/<repo>` or `webfetch https://registry.npmjs.org/<package>/latest` to confirm — don't trust this table forever.

## Framework decision tree

```
Content-heavy (marketing, blog, docs, landing) + occasional interactive widget
  → Astro 6 + React islands  ✓ DEFAULT for ambiguous "I need a website"

SaaS dashboard, heavy interactivity, lots of state, real-time
  → create-tsrouter-app (React + TanStack Router) — when no server logic in same repo
  → Next.js app router                            — when you need API routes / RSC / streaming

Forms-heavy CRUD app (admin panels, internal tools)
  → create-tsrouter-app with --add-ons tanstack-query
  → OR Astro+React if half the surface is content

SEO-critical + dynamic data
  → Astro (SSR mode) + React islands

Mobile / desktop / CLI → out of scope
```

When the user says **"a website with some interactive bits"** without elaborating, **default to Astro 6 + React islands**.

## Foundational stack (every new project)

| Concern | Pick | Reason |
|---|---|---|
| Lint/format | `@biomejs/biome` | One tool, fast |
| Type-checking | `typescript` w/ `strict: true` | Non-negotiable |
| UI components | `shadcn/ui` (NOT a package — see CLI section) | Owned components, Tailwind-styled |
| Styling | `tailwindcss@^4` | v4 is CSS-first config |
| Runtime validation | `zod@^4` | Pair with anything taking external input |
| Server state | `@tanstack/react-query` | When the app talks to APIs |
| Forms | `@tanstack/react-form` + `zod` | Headless, framework-agnostic, first-class zod |
| Client routing (React) | `@tanstack/react-router` | File-based, type-safe |
| Icons | `lucide-react` | What shadcn uses |
| Date/time | `date-fns` | Tree-shakeable; avoid moment |

## Lint/format — Biome

```bash
bun add -D @biomejs/biome
bunx biome init
```

`biome.json` template (verified-current schema URL):

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.15/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": [".next/", "dist/", "node_modules/", ".astro/"] },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
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

Bump the schema URL when biome releases (`webfetch https://registry.npmjs.org/@biomejs/biome/latest | jq .version`).

## Package manager — ask the user

bun is the natural default (fast install, native test runner). pnpm if monorepo or bun-compat issues. Ask once at scaffold time; don't decide silently.

## Scaffolds — verified commands

### Astro 6 + React islands + shadcn + Tailwind v4 (DEFAULT)

```bash
# 1. Scaffold (interactive prompts; uses bun if available, otherwise asks)
bun create astro@latest my-app

# 2. cd in and add React integration
cd my-app
bun add @astrojs/react @astrojs/check react react-dom @types/react @types/react-dom

# OR: combine 1+2 with the --add flag
# bun create astro@latest my-app -- --add react

# 3. Add Tailwind v4 via the Vite plugin (NOT @tailwindcss/postcss)
bun add tailwindcss @tailwindcss/vite

# Edit astro.config.mjs:
#   import { defineConfig } from 'astro/config'
#   import react from '@astrojs/react'
#   import tailwindcss from '@tailwindcss/vite'
#
#   export default defineConfig({
#     integrations: [react()],
#     vite: { plugins: [tailwindcss()] },
#   })

# 4. Create src/styles/global.css containing exactly:
#   @import "tailwindcss";
# Import it from your BaseLayout.astro.

# 5. shadcn CLI v4 — Astro is a first-class template
bunx shadcn@latest init -t astro
bunx shadcn@latest add button card input form dialog

# 6. Biome
bun add -D @biomejs/biome
bunx biome init
```

The `shadcn init -t astro` step writes `components.json` automatically with the correct paths — don't hand-author it.

### React SPA via create-tsrouter-app + shadcn + Tailwind v4

This is the canonical TanStack scaffold (verified at `create-tsrouter-app@0.54.32`). It bundles router + tailwind + shadcn + tanstack-query in one command:

```bash
bun create tsrouter-app@latest my-app \
  --template file-router \
  --tailwind \
  --add-ons shadcn,tanstack-query \
  --toolchain biome

cd my-app

# That's it. The CLI configured shadcn, tanstack-query, router, and biome already.
# For solid instead of react: append --framework solid

# Add more shadcn components as needed:
bunx shadcn@latest add input form dialog

# Add tanstack-form + zod (not included in --add-ons by default)
bun add @tanstack/react-form zod
```

`--list-add-ons` shows the full set of bundleable add-ons. The CLI also accepts a comma list, e.g. `--add-ons shadcn,tanstack-query,sentry`.

If the user prefers to NOT use the TanStack scaffolder (e.g. they want plain Vite without TanStack Router), fall back to:

```bash
bun create vite@latest my-app -- --template react-ts
cd my-app
bun add tailwindcss @tailwindcss/vite
bunx shadcn@latest init -t vite
bunx shadcn@latest add button card input form
bun add -D @biomejs/biome && bunx biome init
```

### Next.js app router + shadcn + Tailwind v4

Default to Next only when the user explicitly mentions Next or needs full-stack (API routes, RSC, server actions).

```bash
bun create next-app@latest my-app \
  --typescript --tailwind --app --no-src-dir --turbopack

cd my-app

# Swap eslint for biome (Next 14+ scaffolds eslint by default; biome is preferred)
bun remove eslint eslint-config-next
bun add -D @biomejs/biome
bunx biome init

# shadcn
bunx shadcn@latest init -t next
bunx shadcn@latest add button card input form
```

`--turbopack` is the default in Next 16+ (flag is redundant but harmless). All flags verified in `create-next-app` docs.

## Integration patterns

### shadcn + Astro 6 (React islands)

shadcn components are React + Tailwind — drop them into Astro as islands:

```astro
---
import { Button } from "@/components/ui/button";
---
<Button client:load>Click me</Button>
```

Hydration directives — pick by use case:
- `client:load` — hydrate immediately on page load (forms, anything interactive immediately)
- `client:idle` — hydrate when browser idle (non-critical bits)
- `client:visible` — hydrate when scrolled into view (below-fold widgets)
- `client:only="react"` — never SSR'd, pure SPA in this island

Default: `client:load` for forms, `client:visible` for everything else.

### Tailwind v4 differences from v3

- **No `tailwind.config.js` needed by default.** Config is in CSS via `@theme { --color-brand: oklch(...) }`. Old config files still work but the v4 path is CSS-first.
- **`@import "tailwindcss"`** replaces `@tailwind base/components/utilities`.
- **`@tailwindcss/vite` plugin** for Vite-based stacks (Astro, Vite, Next 15+). NOT `@tailwindcss/postcss` (that's the fallback path).
- **Plugins**: `@tailwindcss/typography` and `@tailwindcss/forms` have v4 releases. Most third-party v3 plugins haven't been ported yet.
- **shadcn CLI v4** is the v4-compatible CLI. Make sure it's `shadcn` not the deprecated `shadcn-ui` npm package.

### tanstack-form + zod (verified from docs)

The canonical pattern — replaces react-hook-form for new projects:

```tsx
import { useForm } from "@tanstack/react-form";
import { z } from "zod";

const schema = z.object({
  email: z.email(),                // zod v4: top-level z.email() (z.string().email() deprecated)
  password: z.string().min(8),
});

function LoginForm() {
  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: { onChange: schema },   // pass the whole schema
    onSubmit: async ({ value }) => {
      // value is z.infer<typeof schema> — type-safe
    },
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

When using with shadcn's `<Form>` component: tanstack-form doesn't ship a shadcn adapter yet — wrap each field manually as above. shadcn's `<FormField>` is built for react-hook-form; don't force a marriage.

### Zod v4 — boundary validation pattern

In v4, string formats are top-level (`z.email()`, `z.uuidv4()`, `z.ipv4()`). Method forms (`z.string().email()`) still work but are deprecated.

Use zod everywhere external input crosses a trust boundary:

- **API responses**: parse before trusting (`schema.parse(json)`)
- **URL params**: tanstack-router's `validateSearch` field
- **Form inputs**: tanstack-form `validators.onChange`
- **localStorage / sessionStorage reads**: parse; never trust shape
- **Environment vars**: `z.object({ DATABASE_URL: z.url() }).parse(import.meta.env)` at startup

### tanstack-query default config

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

### Supabase integration

If the project uses Supabase, defer to the `supabase` skill for client setup, RLS, SSR cookies, auth flow. Don't duplicate that content.

For frontend-only mention: install `@supabase/supabase-js` + `@supabase/ssr` for SSR-aware sessions. Then the supabase skill takes over.

## Common pitfalls

- **`bun create @tanstack/router` does not exist.** The canonical CLI is `create-tsrouter-app` (use `bun create tsrouter-app@latest …`).
- **`shadcn-ui` npm package is deprecated.** Use `shadcn@latest` (CLI v4 from March 2026).
- **Tailwind v3 `tailwind.config.ts` carried into v4**: doesn't migrate cleanly. Move config to CSS `@theme` blocks per the v4 migration guide.
- **`@tailwindcss/postcss` vs `@tailwindcss/vite`**: in Vite-based stacks, use the Vite plugin. PostCSS is for non-Vite tooling only.
- **tanstack-router file routes require codegen**. The `@tanstack/router-vite-plugin` (or `router-plugin` for Next) generates the route tree. `create-tsrouter-app` sets this up; if you scaffold manually, don't forget the plugin or routes will look untyped.
- **Astro `--typescript strict` flag was removed in v5** and remains gone in v6. Astro 6 sets strict TS by default; the flag throws an error.
- **Astro React islands ≠ React Server Components**. Don't try to use RSC patterns inside Astro islands — different model entirely.
- **Don't slap `client:load` on every island**. Measure. Use `client:visible` for below-fold, `client:idle` for non-critical, `client:only="react"` for islands with browser-only deps.
- **Mixing form libs**: pick tanstack-form OR react-hook-form, not both in the same project.
- **shadcn into monorepo**: the CLI assumes single-package. For monorepos, set up `components.json` per package or vendor the components manually. The CLI `--monorepo` flag (v4) helps for nx/turborepo layouts.
- **Biome + monorepo**: add `"root": true` to the workspace-root `biome.json` and per-package overrides only when needed.
- **Next 16 + Turbopack**: `--turbopack` is now default; passing the flag is redundant but harmless.

## Design ethos — McMaster-Carr utilitarian

The default visual + interaction language for projects scaffolded with this skill is **utilitarian / information-dense**, modelled on mcmaster.com. This is a stack-level opinion, not a per-project negotiation. If the user explicitly asks for "marketing site" or "landing page" with motion/hero/gradients, override; otherwise default to this ethos.

### Principles

1. **Information density over whitespace luxury.** A product/feature/data view should show specs, options, status, and CTAs all visible without scrolling. Tight spacing scale (`gap-1.5` / `gap-2` / `gap-3`, not `gap-8` / `gap-12`). Compact line-height (`leading-tight` / `leading-snug`).
2. **Server-rendered by default.** Astro routes ship near-zero JS; React islands only where genuinely interactive. If a page can be a `.astro` file, it should be.
3. **Tables for tabular data, not card grids.** When the data has columns (price, sku, status, qty), use `<table>`. Cards belong to discovery-driven layouts; lists/tables belong to comparison-driven layouts. Most utilitarian apps are comparison-driven.
4. **No animation tax.** Skip transitions on layout, fades on enter/leave, scroll-triggered reveals. Allowed: focus rings, hover background shifts, disclosure state changes (200ms max). Forbidden: scroll-jacking, parallax, autoplay carousels, glassmorphism.
5. **No skeleton-loaders.** Either load fast enough they're unnecessary (SSR + tanstack-query cache) or render a final-shape empty state. Skeletons trade visual stability for perceived speed and usually lose.
6. **Search and navigation visible, never hidden behind icons.** No hamburger menu on desktop. Categorical navigation exposed in the header or sidebar. Search field always visible on data-heavy routes.
7. **Inline forms, inline errors.** Validation messages next to the field. Confirmations and form submissions in-place where possible; modals only for genuinely modal interactions (destructive confirms, image lightbox).
8. **Pagination over infinite scroll** for data lists — users can return to a specific page, deep-link, share.
9. **Two-color palette + neutrals.** Brand + accent + 5-7 neutrals. No 12-color hand-tuned palette. shadcn's `neutral` base + a single brand color works.
10. **System font by default.** `font-sans` in Tailwind v4 resolves to the system stack — keep it. Add a webfont only if a brand identity demands it; if added, subset and self-host.
11. **Print-friendly.** Tabular layouts print well by accident; card-grid layouts don't. Test `Cmd-P` on any data view.
12. **No marketing prose in product surfaces.** "Empower your team to seamlessly..." is for landing pages. Product pages should read like specs: nouns + numbers + states.

### Concrete Tailwind defaults

For every new project, prefer these utility patterns:

```html
<!-- Container: max width, no centred hero padding -->
<main class="max-w-7xl mx-auto px-4 py-4">

<!-- Section: tight gap, no shadow, sharp border for separation -->
<section class="border border-neutral-200 dark:border-neutral-800 rounded-md">
  <header class="px-3 py-2 border-b font-medium text-sm">Section</header>
  <div class="p-3 space-y-2">...</div>
</section>

<!-- Data table: dense, monospace numbers, sticky header -->
<table class="w-full text-sm tabular-nums">
  <thead class="sticky top-0 bg-neutral-50 dark:bg-neutral-900 text-xs uppercase text-neutral-500">
    <tr><th class="text-left px-3 py-1.5">Name</th>...</tr>
  </thead>
  <tbody class="divide-y divide-neutral-200 dark:divide-neutral-800">...</tbody>
</table>

<!-- Button: minimal, no gradient, no shadow -->
<button class="px-3 py-1.5 text-sm border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900 rounded">
  Action
</button>

<!-- Form field: label + input + error inline, no floating labels -->
<label class="block space-y-1">
  <span class="text-sm text-neutral-700">Email</span>
  <input class="w-full px-2 py-1.5 border border-neutral-300 rounded text-sm focus:border-brand focus:outline-none" />
  <span class="text-xs text-red-600">{error}</span>
</label>
```

### Tailwind v4 `@theme` for this ethos

```css
@import "tailwindcss";

@theme {
  /* Two-color palette + neutrals */
  --color-brand: oklch(0.55 0.15 240);   /* one accent */

  /* Tight spacing default — override Tailwind's friendly defaults */
  --spacing-1: 4px;
  --spacing-2: 8px;
  --spacing-3: 12px;

  /* Sharp radii, no pillows */
  --radius-sm: 2px;
  --radius-md: 4px;
  --radius-lg: 6px;

  /* Mono for any tabular numbers */
  --font-mono: ui-monospace, "SFMono-Regular", Menlo, monospace;
}
```

### shadcn component picks for this ethos

When the user asks "what shadcn components do I need":

| Default in | Skip unless asked |
|---|---|
| `button`, `input`, `label`, `form` | `hero-section`, `marquee` |
| `table`, `data-table` | `card` (only when discovery-driven) |
| `select`, `checkbox`, `radio-group`, `switch` | fancy `combobox` if a plain `select` suffices |
| `dialog`, `alert-dialog` (destructive confirms only) | `sheet` (drawer) unless mobile-only flow |
| `tabs`, `accordion` | `carousel` (almost never appropriate) |
| `tooltip` (status hints) | animated `command palette` unless real shortcut UX |
| `toast` (state changes) | `notifications` when a toast suffices |
| `badge`, `separator`, `skeleton` (sparingly) | `progress` for non-determinate work — use a spinner |

For every shadcn component added, ask: *would McMaster-Carr ship this?* If the answer is no, replace it with the table/button/inline equivalent.

### Anti-patterns (forbidden by default)

- Glassmorphism, neumorphism, frosted-glass headers
- Gradient hero text
- Above-the-fold giant CTAs that hide content
- Auto-rotating carousels
- Splash screens / intro animations
- Skeleton loaders longer than 300ms (just load faster, or render the empty state)
- Confetti / celebration animations on form submit
- Hover-reveal navigation
- Background videos
- "Empower your team" / "Unlock seamless" marketing copy in app surfaces
- Sticky scroll-jacking sections
- Card grids when the data has columns

If the user explicitly opts in to one of these (marketing landing for a SaaS, etc.), do it well — but in a separate route/file, not bleeding into the rest of the app.

### Reference

McMaster-Carr (mcmaster.com) is the canonical example. Other utilitarian references the user respects: Stripe Dashboard (data tables, dense forms), GitHub (issue lists, repo file browser), Linear (keyboard-driven, fast). Avoid Apple-marketing-page / Stripe-marketing-page references when in product/app surfaces.

## When NOT to use this skill

- The user already has a project and is adding a feature → use the `supabase` / `tanstack-*` / `shadcn` docs sources directly, not the scaffold portion of this skill.
- The user wants something exotic (Solid, Svelte, Qwik, htmx-only) → defer to the relevant docs source, don't force this stack. (`create-tsrouter-app --framework solid` IS supported if Solid + TanStack Router is the goal.)
- The user wants a non-web frontend (mobile, desktop, CLI, embedded) → out of scope.

## Related skills and docs

- **`supabase`** — when backend includes Supabase
- **`supabase-postgres-best-practices`** — DB schema decisions
- **`mermaid-d2`** — when scaffolding includes architecture diagrams
- **`favicons-and-icons`** — when scaffolding includes a favicon set
- **`superpowers` (`brainstorming`, `writing-plans`, `test-driven-development`)** — methodology layer above this skill
- **Docs sources**: `astro`, `react`, `nextjs`, `tailwindcss`, `shadcn`, `zod`, `tanstack-form`, `tanstack-query`, `tanstack-router`, `tanstack-table`, `hono`, `vite`, `bun`, `biome` (off-server; use `context7_query_docs` for `/biomejs/biome`)

## Verification protocol

When recommending a specific version or scaffold command, verify it via the appropriate tool BEFORE asserting:

- Package latest version → `webfetch https://registry.npmjs.org/<package>/latest` (returns JSON with `.version`)
- CLI flag exists → `docs_grep` the relevant source (`/docs/astro/`, `/docs/nextjs/`, `/docs/shadcn/`, `/docs/tanstack-router/`)
- Off-server library docs (biome, etc.) → `context7_query_docs` with `/biomejs/biome` or similar
- Don't assert a version from training data — always check.
