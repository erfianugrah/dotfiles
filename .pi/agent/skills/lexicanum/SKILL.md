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

## Cross-referencing and exemplars (do this before writing)

Two checks that are easy to skip and were skipped (2026-08-27, three new docs
shipped with zero cross-links and prose pattern-matched off recent AI-written
docs):

- **Calibrate voice off the two named exemplars, not off whatever is newest.**
  The baseline is `reference/cloudflare-supabase-architecture.mdx` and
  `guides/usb4-10gbe-windows-tuning.mdx`, full stop. Docs written since the
  AI-assisted era began are NOT a style source - several carry AI prose tells
  (decorative bold, mystery-tease, participle tails) that must not propagate.
  Read one exemplar end-to-end before drafting; match its density, its
  measured-vs-asserted labelling, and its section skeleton.
- **Cross-link to the older docs.** Every new doc should link inline (and/or in
  a closing `## Related docs` list) to the 2-4 existing docs it depends on,
  supersedes, or sits beside - the corpus convention is inline links like
  `[Magic WAN interop](/guides/magic-wan-interop/)`. Before drafting, grep the
  corpus for the systems the new doc touches (`rg -il '<system>' src/content/docs`)
  and read the matches - they are frequently the older human-written docs and
  the only place a relationship is recorded. A new doc that duplicates or
  silently contradicts an older one is worse than no doc. The build checks
  that links are *valid*; it does not check that you *made* any - that part
  is on you.

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
- Pins are for corrections, not content. `tests/pins.test.ts` guards claims a
  review round PROVED wrong; pinning every new fact makes legitimate rephrases
  break the build (the 2026-08-17 pin inflation). When a review corrects the
  doc, pin the correction - and when a build fails on a pin, ask whether the
  pin earned its place before rewriting prose to fit it.
- Deployed HTML can be stale per-PoP: the Workers assets platform serves
  `cf-cache-status: HIT` on HTML even at `max-age=0, must-revalidate`.
  `bun run deploy` purges the zone after `wrangler deploy` (see
  scripts/purge-cache.ts); verify a fresh deploy by content, not by 200.
- A `dist/` path can be a redirect stub from a doc's `aliases`, not a doc.
- Citations are IEEE-numbered GFM footnotes, never APA; every `[^slug]` def
  must be referenced inline at least once or it does not render.
- Headings sentence case; ASCII punctuation only; `->` for arrows, never
  ` -- ` in prose (SmartyPants en-dash).
- `dot` fences need the house boilerplate (`bgcolor="transparent"`, no
  colors) - `tests/docs.test.ts` fails otherwise.
- Pre-2026-07 docs predate the contract; exemplars are
  `reference/cloudflare-supabase-architecture.mdx` and
  `guides/usb4-10gbe-windows-tuning.mdx`. Equally: post-contract docs are often
  AI-assisted - do not pattern-match prose off them either. Match the two named
  exemplars only.
