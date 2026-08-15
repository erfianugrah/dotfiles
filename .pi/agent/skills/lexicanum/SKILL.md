---
name: lexicanum
description: Use when authoring, editing, or restructuring docs on the user's public docs site lexicanum (repo ~/lexicanum, published at erfi.dev) - adding a guide or reference doc, setting taxonomy frontmatter (category/group/featured/blurb/aliases), renaming or moving a doc, choosing guide vs reference, the IEEE-footnote citation convention, or debugging its build/tests. Fires on 'lexicanum', 'erfi.dev docs', 'add a doc to the docs site', 'docs taxonomy', 'starlight sidebar'. NOT for the docs.erfi.io server (that is a different system) or for prose voice in emails/replies (erfi-voice).
---

# lexicanum

Astro + Starlight docs site at `~/lexicanum`, published at https://erfi.dev. Two
doc types in two folders: `guides/` (Diataxis how-to, task-sequenced) and
`reference/` (explanation-led architecture, "which do I pick").

**The authoring contract is the repo's `~/lexicanum/AGENTS.md` - read it first
for any non-trivial doc work.** It owns doc skeletons, citation format, house
style, and the verify checklist. This skill is the operational layer around it.

## Adding or editing a doc

Everything navigational derives from frontmatter. Adding a doc = `bun run new`
(prompts for type/category/title, scaffolds the file) or write the doc + set
frontmatter; there is no other file to touch:

```yaml
---
title: ...
description: ...
author: Erfi Anugrah
category: supabase        # required; TAXONOMY in src/lib/taxonomy.mjs
group: tenancy            # required when the category has groups
featured: true            # optional: homepage card grid
blurb: "..."              # optional: card text (defaults to description)
aliases:                  # optional: old URLs -> redirects (on rename/move)
  - "/reference/old-slug"
---
```

- Sidebar, homepage cards, redirects are generated at config-load
  (`src/lib/taxonomy.mjs` + `src/components/TopicCards.astro`). Schema enums
  derive from the same TAXONOMY - unknown/missing values fail the build.
- Sidebar entries carry a Guide/Reference badge stamped from the folder.
- Rename/move = rename file + add old URL to `aliases`. Never edit
  `astro.config.mjs` redirects directly.
- New category = edit `TAXONOMY` only (deliberate; docs cannot invent one).
- Dev note: a watcher restarts the dev server automatically when a doc's
  frontmatter changes; prose edits keep hot reload.

## Commands

- `bun run new` - scaffold a doc (frontmatter + skeleton from prompts).
- `bun run build` - runs ALL doc tests then builds. The gate; must be green.
- `bun test` - checks without building. `bun run typecheck` - tsc.
- `bun run verify:docs:links` - external link check, opt-in, never gates.

## Traps (each has bitten before)

- Literal `$` in prose is parsed as math: escape as `\$`. Exempt: frontmatter,
  fences, inline code. Deliberate-math docs carry
  `{/* prose-dollar: math-intentional */}`.
- A `dist/` path can be a redirect stub from a doc's `aliases`, not a doc.
- Citations are IEEE-numbered GFM footnotes, never APA; every `[^slug]` def
  must be referenced inline at least once or it does not render.
- Headings sentence case; ASCII punctuation only; `->` for arrows, never
  ` -- ` in prose (SmartyPants en-dash).
- `dot` fences need the house boilerplate (`bgcolor="transparent"`, no
  colors) - `tests/docs.test.ts` fails otherwise.
- Pre-2026-07 docs predate the contract; exemplars are
  `reference/cloudflare-supabase-architecture.mdx` and
  `guides/usb4-10gbe-windows-tuning.mdx`.
