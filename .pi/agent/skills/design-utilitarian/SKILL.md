---
name: design-utilitarian
description: Use when laying out a page, picking UI components, writing CSS/Tailwind, choosing a typography/spacing scale, reviewing a design, writing copy that ships inside a product surface, or pushing back on glassmorphism / hero gradients / skeleton loaders. Fires on 'which shadcn components', 'design review', 'make it denser', 'too much whitespace', 'this looks like a template'. NOT for scaffolding a project (frontend-stack) or prose voice in replies and docs (erfi-voice).
---

# design-utilitarian - McMaster-Carr ethos for web UI

The user's default visual + interaction language is utilitarian, modelled on mcmaster.com. Stack-level opinion, not per-project negotiation. Override only when the user explicitly asks for marketing/landing visuals.

## Principles

1. **Information density over whitespace luxury.** Show specs, options, status, CTAs visible without scrolling. Tight scale (`gap-1.5 / gap-2 / gap-3`, not `gap-8 / gap-12`). Compact line-height (`leading-tight / leading-snug`).
2. **Server-rendered by default.** If a page can be a `.astro` file, it should be. React islands only where genuinely interactive.
3. **Tables for tabular data, not card grids.** Use `<table>` when data has columns (price, sku, status, qty). Cards are discovery-driven; tables are comparison-driven. Most utilitarian apps are comparison-driven.
4. **No animation tax.** Allowed: focus rings, hover background shifts, disclosure (≤200ms). Forbidden: scroll-jacking, parallax, autoplay carousels, glassmorphism, transitions on layout.
5. **No skeleton-loaders.** Load fast enough they're unnecessary (SSR + tanstack-query cache) or render a final-shape empty state. Skeletons trade visual stability for fake perceived speed.
6. **Search + navigation visible.** No hamburger on desktop. Categorical nav in header or sidebar. Search field always visible on data routes.
7. **Inline forms, inline errors.** Validation next to the field. Submit in-place. Modals only for genuinely modal interactions (destructive confirms, image lightbox).
8. **Pagination over infinite scroll** for data lists - users return to a page, deep-link, share.
9. **Two-color palette + neutrals.** Brand + accent + 5-7 neutrals. shadcn `neutral` base + a single brand color works.
10. **System font.** Keep Tailwind's default sans-serif stack; do not define a custom font family in `@theme`. Webfont only if brand identity demands; if added, subset + self-host.
11. **Print-friendly.** Tabular layouts print well; card grids don't. Test `Cmd-P` on data views.
12. **No marketing prose in product surfaces.** "Empower your team to seamlessly..." is for landing pages. Product pages should read like specs: nouns + numbers + states.

## Kill the AI copy tells (product prose)

Extends #12. Any prose that ships in a product surface - a finding card, an empty state, a tooltip, a generated report, a status line - must not read like default LLM output. The fingerprint is a *cluster* of habits, not one banned word (research: Kobak et al. 2024, *Science Advances*, on the post-ChatGPT vocabulary surge; Wikipedia "Signs of AI writing"). The two that bite specifically in product copy:

1. **Significance-inflation.** LLMs *tell you something matters* instead of showing the cost. "Left alone they inflate latency and CPU, pushing you toward a bigger, costlier tier" says nothing a number wouldn't say better. Show the mechanism or the cost; cut the "this is important because" scaffolding. **Participial closers** are the same tell wearing a gerund: "...highlighting the importance of X", "...ensuring optimal performance" - delete them; they add the *feeling* of a point without a point.
2. **Repetition across surfaces - the strongest smell in a generated report.** The SAME rationale paragraph under every card. If ten finding cards share one "why it matters", it's boilerplate: make it specific to each object, or drop it and let the item's own detail carry.

Vocabulary and sentence-shape tells (slop watchlist, filler openers, triplets, negative parallelism, rhetorical question-then-answer) are catalogued once in `erfi-voice`, "Structural AI tells" - apply that list here too; the `ai-tell-guard` hook hard-blocks the highest-precision subset in prose files.

**The test:** could this exact line sit under a different finding / product / topic unchanged? If yes, it's generic filler - rewrite it to name the actual object, number, or state (principle #12: nouns + numbers + states). Read it aloud; a phrase you'd never say gets cut.

Two caveats. These are probabilistic *tells, not proof* - the same words appear in fine human writing, and detectors false-positive on non-native English >60% of the time. The goal is concrete, specific copy, **not** passing a detector - chase specificity, not a score. And the punctuation tells (em-dash density, smart quotes, the tidy ellipsis) are already handled repo-side by the `ascii-punctuation-guard`, so the work left here is vocabulary + structure.

## Concrete Tailwind defaults

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

## Tailwind v4 `@theme` block

```css
@import "tailwindcss";

@theme {
  /* Two-color palette + neutrals */
  --color-brand: oklch(0.55 0.15 240);   /* one accent */

  /* Tight spacing default - override Tailwind's friendly defaults */
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

## shadcn component picks

When the user asks "what shadcn components do I need":

| Default in | Skip unless asked |
|---|---|
| `button`, `input`, `label`, `form` | `card` (only when discovery-driven) |
| `table`, `data-table` | fancy `combobox` if a plain `select` suffices |
| `select`, `checkbox`, `radio-group`, `switch` | `sheet` (drawer) unless mobile-only flow |
| `dialog`, `alert-dialog` (destructive confirms only) | `carousel` (almost never appropriate) |
| `tabs`, `accordion` | animated `command` palette unless real shortcut UX |
| `tooltip` (status hints), `toast` (state changes) | `progress` for non-determinate work - use a spinner |
| `badge`, `separator` | hero sections, marquees, notification centres and similar blocks from third-party registries |

For every shadcn component added, ask: *would McMaster-Carr ship this?* If no, replace with the table/button/inline equivalent.

## Forbidden by default

- Glassmorphism, neumorphism, frosted-glass headers
- Gradient hero text
- Above-the-fold giant CTAs that hide content
- Auto-rotating carousels
- Splash screens / intro animations
- Skeleton loaders longer than 300ms
- Confetti / celebration animations on form submit
- Hover-reveal navigation
- Background videos
- "Empower your team" / "Unlock seamless" marketing copy in app surfaces
- Sticky scroll-jacking sections
- Card grids when the data has columns

If the user explicitly opts in (e.g. marketing landing for the same SaaS), put it in a separate route/file. Don't let the marketing visuals bleed into the rest of the app.

## References

- **mcmaster.com** - canonical.
- **Stripe Dashboard** - dense data tables, dense forms.
- **GitHub** - issue lists, repo file browser.
- **Linear** - keyboard-driven, fast.

Avoid: Apple marketing pages, Stripe MARKETING (not dashboard), any Y-Combinator-startup-template-of-the-week.

## When to override this skill

- User explicitly requests "marketing site", "landing page", "hero with gradient", "vibrant".
- The route is genuinely a marketing surface (`/`, `/pricing`, `/blog`).
- Brand identity demands it AND user has confirmed.

Even when overriding, scope the deviation to that route. The product/app surfaces stay utilitarian.

## Pairs with

- `frontend-stack` - when scaffolding a new project (this skill ships as the default ethos for projects created with that scaffolding skill)
- `supabase` - backend choices that affect render strategy (RLS-aware, SSR cookies)
