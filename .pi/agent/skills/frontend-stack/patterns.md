# frontend-stack: integration patterns

Supporting reference for the `frontend-stack` skill. Canonical code for the libraries the scaffolds pull in: Astro hydration directives, tanstack-form with zod, zod v4 boundary validation, tanstack-query defaults, and the Tailwind v4 differences.

## Hydration directives (Astro)

For shadcn / React islands inside `.astro`:

- `client:load` - hydrate on page load. Forms, anything interactive immediately.
- `client:idle` - when browser is idle. Non-critical interactive bits.
- `client:visible` - when scrolled into view. Below-fold widgets.
- `client:only="react"` - never SSR'd. Pure SPA island (avoid unless necessary).

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

shadcn's `<FormField>` is built for react-hook-form. tanstack-form has no shadcn adapter - wrap fields manually as above.

## zod v4 - boundary validation pattern

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

## Tailwind v4 ≠ v3 - gotchas

- **No `tailwind.config.js` by default.** Config is in CSS via `@theme { --color-brand: oklch(...) }`. v3 configs don't migrate cleanly - move to `@theme` blocks.
- **`@import "tailwindcss"`** replaces `@tailwind base/components/utilities`.
- **`@tailwindcss/vite` plugin** for Vite-based stacks (Astro, Vite, create-tsrouter-app). Next.js is not Vite-based: `create-next-app --tailwind` wires `@tailwindcss/postcss` (the v4 PostCSS plugin lives in that separate package - `/docs/tailwindcss/docs/upgrade-guide.md`, `/docs/nextjs/css.md`); do not add the Vite plugin to a Next project.
- **Plugins**: `@tailwindcss/typography` and `@tailwindcss/forms` have v4 releases. Most third-party v3 plugins haven't been ported.
- **shadcn CLI v4** is required for v4-compatible components. NOT the deprecated `shadcn-ui` npm package.
