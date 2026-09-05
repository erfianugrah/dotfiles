# frontend-stack: scaffold commands and configs

Supporting reference for the `frontend-stack` skill. Copy-paste scaffolds for Astro, create-tsrouter-app, plain Vite and Next.js, plus the Biome config. Versions in here go stale: run the version checks in SKILL.md before pasting.

## Common foundation steps

After framework scaffold, every project gets these:

```bash
# Biome
bun add -D @biomejs/biome
bunx biome init

# Tailwind v4 via the Vite plugin (Astro, Vite, create-tsrouter-app)
bun add tailwindcss @tailwindcss/vite
# Next.js is not Vite-based: create-next-app --tailwind (on by default) wires
# tailwindcss + @tailwindcss/postcss for you. Do not add the Vite plugin there.

# shadcn - pick template by framework: astro | vite | next
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
  "files": { "includes": ["**", "!**/.next", "!**/dist", "!**/node_modules", "!**/.astro"] },
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

Look up the schema version: call the `webfetch` tool (WebFetch in Claude Code) on `https://registry.npmjs.org/@biomejs/biome/latest`, read `version`, and substitute it into the `$schema` URL.

Biome 2 has no `files.ignore`. Exclusions are negated globs inside `files.includes` (the `**` entry first, then `!` patterns); `vcs.useIgnoreFile` still honours `.gitignore`. A `files.ignore` key from a v1 config is rejected by the 2.x schema.

## Scaffolds

### Astro 7 + React islands (DEFAULT)

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
default for full-stack Go projects - see `~/bonkled/` and the
`software-architecture` skill's "Full-stack Go" layout), Astro is doubly
natural: `astro build` produces a static `dist/` directory that
`//go:embed all:web/dist` wraps directly into the Go binary, served by
`http.FileServer(http.FS(...))`. No nginx layer, no separate frontend container.

Layout: `web/` lives at the repo root next to `cmd/` and `internal/`; `web/dist/`
is gitignored and rebuilt by `make web-build` before `go build`. The Astro
config stays the same as above; the only Astro-side concern is that any
client-side routing must be SPA-mode (`output: 'static'`) so deep links resolve
on page refresh - the Go static handler serves `index.html` as the fallback.

Default to this shape for full-stack Go projects unless the frontend has
independent deploy needs (different cache TTLs, separate scale-out, multiple
frontends sharing one backend).

### React SPA via create-tsrouter-app

This bundles router + tailwind + shadcn + tanstack-query in one command:

```bash
bun create tsrouter-app@latest my-app \
  --template file-router \
  --add-ons shadcn,tanstack-query \
  --toolchain biome
cd my-app
# Tailwind is on by default (--no-tailwind to opt out).

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
  --ts --tailwind --app --no-src-dir --biome
cd my-app
# then Common foundation steps + shadcn init -t next
```

`--biome` writes a Biome config instead of ESLint, so there is nothing to swap out afterwards. Turbopack is on by default in Next 16 (`--turbopack` is accepted but redundant). `--no-<flag>` negates any default, hence `--no-src-dir`.
