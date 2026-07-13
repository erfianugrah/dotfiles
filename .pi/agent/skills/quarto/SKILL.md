---
name: quarto
description: Use when authoring, rendering, or publishing Quarto documents or projects — .qmd files, _quarto.yml configuration, multi-format output (HTML/PDF/Revealjs/Word/Typst/ePub), project types (website/book/blog/manuscript/dashboard), code execution with Python/R/Julia, freeze/cache management, cross-references, callouts, citations, and publishing to Quarto Pub / GitHub Pages / Netlify / Posit Connect. Also covers building and debugging Reveal.js presentations - slide layout/overflow, footnote-style source citations, mermaid theming, 2D section/vertical navigation, and self-verifying rendered slides via headless chromium/decktape screenshots.
---

# Quarto

Open-source scientific and technical publishing system built on Pandoc. Author `.qmd` files with executable code blocks (Python, R, Julia, Observable JS), render to 30+ output formats, publish to any static host.

## Core CLI

```bash
quarto render document.qmd             # render to default format
quarto render document.qmd --to pdf    # override format
quarto render                          # render whole project
quarto preview                         # live-reload server (random port 3000-8000)
quarto create project <type> <name>    # scaffold new project
quarto check                           # verify install + engines
quarto publish gh-pages                # publish to GitHub Pages
quarto publish netlify                 # publish to Netlify
quarto publish quarto-pub              # publish to quartopub.com
```

## Document anatomy

````qmd
---
title: "My Report"
author: "Erfi Anugrah"
date: last-modified
format:
  html:
    toc: true
    code-fold: true
    theme: cosmo
  pdf:
    documentclass: article
execute:
  echo: false
  warning: false
---

Normal markdown here.

```{python}
#| label: fig-scatter
#| fig-cap: "A scatterplot"
import matplotlib.pyplot as plt
plt.plot([1,2,3])
```

See @fig-scatter for results.
````

## Project types

| Type | `quarto create project` | Key config key |
|---|---|---|
| Default (multi-doc) | `default` | — |
| Website | `website` | `website:` |
| Blog | `blog` | `website:` with `listing` |
| Book | `book` | `book:` (chapters list) |
| Manuscript | `manuscript` | `manuscript:` |
| Dashboard (Shiny/Observable) | — | `format: dashboard` |

## `_quarto.yml` structure

```yaml
project:
  type: website           # default | website | blog | book | manuscript
  output-dir: _site
  pre-render: setup.py    # optional script before rendering
  post-render: deploy.sh  # optional script after rendering

# Shared options inherited by all docs
execute:
  freeze: auto            # re-render only when source changes
  cache: true

format:
  html:
    toc: true
    theme: cosmo
    css: styles.css
  pdf:
    documentclass: report

# Website-specific
website:
  title: "My Site"
  navbar:
    left:
      - href: index.qmd
        text: Home
      - about.qmd
  sidebar:
    - section: "Guide"
      contents:
        - intro.qmd
        - advanced.qmd
```

## Output formats (key ones)

| Format | `format:` key | Notes |
|---|---|---|
| HTML | `html` | Default for websites; theming via Bootswatch |
| PDF | `pdf` | Requires LaTeX (TinyTeX: `quarto install tinytex`) |
| Typst | `typst` | Faster than LaTeX; no install needed |
| MS Word | `docx` | Supports reference doc templates |
| Revealjs | `revealjs` | HTML presentations |
| PowerPoint | `pptx` | Requires Office; supports templates |
| Beamer | `beamer` | LaTeX presentations |
| ePub | `epub` | E-book |
| JATS | `jats` | Academic journal XML |
| GFM | `gfm` | GitHub Flavored Markdown |

## Code execution engines

**Python** — uses Jupyter kernel:
```yaml
---
jupyter: python3    # or path to venv: .venv/bin/python
---
```

**R** — uses Knitr:
```yaml
---
knitr:
  opts_chunk:
    collapse: true
---
```

**Julia** — two engines:
```yaml
engine: julia      # preferred (QuartoNotebookRunner, no Python needed)
# or
jupyter: julia-1.9 # IJulia kernel
```

**Observable JS** — runs in-browser (no server needed):
```{ojs}
data = FileAttachment("data.csv").csv({ typed: true })
Plot.plot({ marks: [Plot.dot(data, {x: "x", y: "y"})] })
```

**Cell options** (prefix `#|` in code block):
```python
#| label: fig-myplot      # cross-reference ID
#| fig-cap: "Caption"     # figure caption
#| echo: false            # hide source code
#| warning: false         # suppress warnings
#| cache: true            # cache this cell only
#| eval: false            # don't run (just show code)
#| output: asis           # raw output (HTML/LaTeX)
```

## Freeze & cache

**Freeze** — skip re-execution on project render:
```yaml
# _quarto.yml (project-wide)
execute:
  freeze: auto    # re-render only when .qmd source changes
  # freeze: true  # never re-render

# Per-document override
execute:
  freeze: false
```

- Results stored in `_freeze/` — **commit this directory** to git so CI can render without re-executing
- Single doc (`quarto render doc.qmd`) always re-executes regardless of freeze
- Delete `_freeze/` to force full re-execution

**Cache** — per-cell Jupyter/Knitr cache (faster iteration):
```yaml
execute:
  cache: true    # cache individual cells, not whole doc
```

## Cross-references

```markdown
![Elephant](elephant.png){#fig-elephant}

See @fig-elephant for details.   <!-- → "Figure 1" -->
See @tbl-results.                <!-- → "Table 1" -->
See @eq-formula.                 <!-- → "Equation 1" -->
See @sec-intro.                  <!-- → "Section 1" -->
```

Prefixes: `fig-`, `tbl-`, `lst-`, `eq-`, `sec-`, `thm-`, `def-`, `tip-`, `nte-`, `wrn-`, `imp-`, `cau-`

Cross-reference lists in PDF: `lof: true`, `lot: true` in YAML front matter.

## Callouts

```markdown
::: {.callout-note}
This is a note.
:::

::: {.callout-tip title="Custom Title"}
## Optional heading
Tip content here.
:::

::: {.callout-warning collapse="true"}
Collapsible warning.
:::
```

Types: `callout-note`, `callout-tip`, `callout-warning`, `callout-important`, `callout-caution`

## Book project structure

```
_quarto.yml       # type: book + chapters list
index.qmd         # preface / landing
intro.qmd
part-one/
  chapter-1.qmd
  chapter-2.qmd
references.qmd    # bibliography
```

```yaml
# _quarto.yml
project:
  type: book
book:
  title: "My Book"
  author: "Erfi Anugrah"
  chapters:
    - index.qmd
    - part: "Part I"
      chapters:
        - intro.qmd
        - chapter-1.qmd
    - references.qmd
format:
  html:
    theme: cosmo
  pdf: default
  epub: default
```

## Publishing

**One-time setup (interactive):**
```bash
quarto publish gh-pages      # commits rendered site to gh-pages branch
quarto publish netlify
quarto publish quarto-pub
```

Creates `_publish.yml` in project root — commit this file.

**CI / headless publish (GitHub Actions):**
```yaml
# .github/workflows/publish.yml
on:
  push:
    branches: [main]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pip install jupyter
      - uses: quarto-dev/quarto-actions/setup@v2
      - name: Publish
        uses: quarto-dev/quarto-actions/publish@v2
        with:
          target: gh-pages
          render: false            # use committed _freeze/ output
```

**CI env vars for token-based publish:**
```bash
QUARTO_PUB_AUTH_TOKEN=...
NETLIFY_AUTH_TOKEN=...
CONNECT_SERVER=https://connect.example.com
CONNECT_API_KEY=...
```

## Reveal.js presentations

### Deck structure (2D navigation)

- `#` heading = a **horizontal** section (chapter); `##` slides after it stack **vertically** beneath it (arrow-down). `##` slides before the first `#` form the horizontal spine. Ideal for a linear talk + per-topic reference branches you jump into during Q&A.
- Set `navigation-mode: vertical` so up/down traverses everything.
- Per-slide attributes: `## Title {.smaller}` (shrink font), `{.scrollable}` (scrollbar only when content overflows), `{background-color="#1c1c1c"}` (section dividers), `{#my-id}` (hash-navigable at `deck.html#/my-id`).

### Self-verify layout WITHOUT a human (headless render -> screenshot)

Render first: `quarto render deck.qmd --to revealjs --output-dir /tmp/dc`. Chrome path varies - find via `command -v chromium google-chrome-stable`.

Single slide (fast):
```bash
chromium --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1280,720 \
  --virtual-time-budget=8000 --screenshot=/tmp/s.png \
  "file:///tmp/dc/deck.html#/<slide-id-or-index>"
```

Whole-deck contact sheet (faithful: waits for reveal + mermaid JS):
```bash
bunx decktape reveal --chrome-path "$(command -v chromium)" --size 1280x720 \
  file:///tmp/dc/deck.html /tmp/deck.pdf
pdftoppm -png -r 52 /tmp/deck.pdf /tmp/s
montage /tmp/s-*.png -tile 5x6 -geometry 256x144+3+3 -label '%f' /tmp/contact.png
```
Then view the PNG. **Caveat:** raw headless chromium can load web fonts late, so mermaid node text may look clipped in the shot even when the real browser is fine - decktape is more faithful for diagrams.

### Layout / overflow debugging

| Symptom | Fix |
|---|---|
| Content bleeds into the footer / off the bottom | Add `.smaller`; then `.scrollable` as a safety net |
| Row-heavy table overflows | Cut cell padding in theme SCSS: `.reveal table th, td { padding: 0.28em 1em }` (biggest lever) |
| SCSS/theme edit not showing | **`quarto preview` does NOT recompile theme SCSS on change** - re-render or restart preview |

### Footnote-style source citations (size + position consistency)

Wrap each citation line in a fenced div, style it small + muted in the theme SCSS - keeps sources consistent and unobtrusive:
```markdown
::: {.src}
Sources: [RLS](https://...) · [Postgres](https://...)
:::
```

Getting them to look identical on EVERY slide has two non-obvious traps. Both
verified the hard way - measure with `getBoundingClientRect` (below), don't eyeball.

**1. Size - `em` compounds with `.smaller`, and the vertical-stack descendant trap.**
`.smaller` sets `section { font-size: 0.7em }`. If `.src` is sized in `em`, it
renders LARGER on non-`.smaller` slides. Cancel the 0.7 there - but use the
**child combinator `> .src`**: a *descendant* selector (`section:not(.smaller) .src`)
also matches `.src` through the outer `section.stack` wrapper of a vertical
branch (the stack is itself `:not(.smaller)`), shrinking it by an extra 0.7.
```scss
.reveal .src { font-size: 0.42em; color: #7d7d7d; border-top: 1px solid #2a2a2a; padding-top: 0.3em; }
.reveal .slides section:not(.smaller) > .src { font-size: calc(0.42em * 0.7); }  /* > not descendant */
```

**2. Position - `center: true` makes the footnote float.** With centering on,
an in-flow footnote rides the vertically-centered content block, so its Y
shifts with content length. Pin it: top-align every source slide, make it a
full-height flex column, push `.src` to the bottom with `margin-top: auto`. On
`.scrollable` slides whose content overflows, there's no free space for the
auto margin, so add `position: sticky; bottom: 0` + an **opaque background** so
the footnote stays glued to the visible bottom while content scrolls beneath
it. One `:has(> .src)` rule pins the whole deck to the same on-screen Y:
```scss
.reveal .slides section:has(> .src) {
  top: 16px !important; height: 688px !important;   /* fill slide; height < 720 so it fits above chrome */
  display: flex !important; flex-direction: column; overflow-y: auto;
}
.reveal .slides section:has(> .src) > .src {
  margin-top: auto;                 /* pin to bottom when content is short */
  position: sticky; bottom: 0;      /* stay visible when content scrolls */
  background: #0d0d0d;              /* MUST match $body-bg, opaque */
  padding-bottom: 6px;
}
```
Tradeoff: pinning **disables per-slide vertical centering** - sparse slides get
whitespace above the footnote. That's the cost of a fixed footnote position
under `center: true`; it's what you want for a reference-heavy deck.
`:has(> .src)` (child) is safe against the `section.stack` wrapper - the stack's
direct children are `<section>`s, not `.src`, so it never matches the wrapper.

**Verify to the pixel** (screenshots show it; computed geometry proves it):
```js
// playwright/puppeteer: page.evaluate over the built deck
[...document.querySelectorAll('.slides section .src')].map(el => ({
  id: el.closest('section').id,
  bottom: Math.round(el.getBoundingClientRect().bottom),   // want all equal
  fontPx: getComputedStyle(el).fontSize,                   // want all equal
}))
```

### Mermaid inside reveal

- **Per-diagram colors** via an init directive on the first line of the code block: `%%{init: {'themeVariables': {...}}}%%`.
  - Mindmap section colors use `cScale0..N` fills + `cScaleLabel0..N` text. **Off-by-one gotcha:** `cScale0` styles the *root* section, so the first branch is `cScale1` - set `cScale1..4` for a 4-branch map.
  - Flowcharts: use `classDef name fill:...,color:#fff;` + `class NodeA,NodeB name;` for full, reliable control.
- **Center a diagram** via theme SCSS: `.reveal .cell-output-display { text-align: center; } .reveal .cell-output-display svg { margin-left: auto; margin-right: auto; }`
- Emoji (✅/❌) can render as tofu on machines lacking an emoji font (projectors!) - prefer `✓`/`✗` or text for portability.

### Deterministic diagrams: prefer `{dot}` for layout-sensitive graphs

Quarto renders `{mermaid}` **client-side** (a `<pre class="mermaid">` laid out by mermaid.js in the *viewer's* browser) - so the same file can lay out differently machine-to-machine (font-load timing, viewport, mermaid version), and mermaid's radial `mindmap` has no overlap/crossing control (15+ nodes collide, branch colors interleave). Quarto renders `{dot}` (Graphviz) **at build time** into an inline SVG - byte-identical for every viewer. For any diagram whose exact layout matters, reach for `{dot}`.

- **Radial hub / "mindmap" look → Graphviz `{dot}` with `layout=twopi`**, not mermaid `mindmap`. Needs the `dot` binary on PATH (`sudo pacman -S graphviz`); Quarto shells out to it, honors the in-graph `layout=twopi`, and bakes the SVG inline. Recipe:
  ````
  ```{dot}
  graph G {
    layout=twopi; root=hub; overlap=prism; sep="+9"; bgcolor="transparent";
    node [shape=box style="filled,rounded" fontname="DejaVu Sans" fontcolor=white penwidth=0];
    hub [label="Core" shape=circle fillcolor="#3ecf8e" fontcolor="#0d0d0d"];
    hub -- b1; b1 [label="Branch" fillcolor="#2f6f4e"];
    b1 -- leafA; leafA [label="Leaf\nwrapped" fillcolor="#2f6f4e"];  // fillcolor per branch groups colors
  }
  ```
  ````
  Size on the slide via SCSS: wrap the cell in `::: {.myhub}` and `.reveal .myhub svg { max-height: 480px; width: auto; }`. `bgcolor="transparent"` blends with a dark theme. Fonts: graphviz uses *system* fonts at build (NOT the deck's web font) - pick one `fc-list` shows (e.g. DejaVu Sans); label boxes have padding so a font mismatch won't clip.
  - **Make it pretty, not sparse:** plain twopi = thin uniform-grey straight spokes (looks bare). For a mindmap feel, add `splines=curved`, bump `edge [penwidth=3]`, and **colour each edge to its branch** (`sb -- b1 [color="#2f6f4e"]; b1 -- leaf [color="#2f6f4e"]`). Colour-matched curved edges group branches visually and read as intentional.
  - **twopi allocates angular space by leaf count**, so a lopsided tree (one branch with 7 children, another with 1) skews off-centre. There's no clean fix - `overlap=prism` + `sep="+12"` and the per-branch edge colours mask it well enough; if it still bothers, rebalance by merging leaves.
- **Only if `dot` is genuinely unavailable** (no sudo/pacman): pre-bake the mermaid to a static SVG via mermaid-cli / `render_diagram`, then embed as `<img>`. Two non-obvious gotchas: (1) set `htmlLabels:false` in the init - mermaid's default label `<foreignObject>` does NOT render when an SVG is loaded via `<img>` (secure static mode), so labels vanish; `htmlLabels:false` emits native `<text>`. (2) strip mermaid-cli's injected `style="...background-color: white;"`. This fragments the diagram across qmd + scss + a generated SVG, so commit the `.mmd` source + a `make` target that regenerates it - never hand-patch and commit an orphan SVG with no source of truth.

### Deck YAML essentials
```yaml
format:
  revealjs:
    theme: [default, custom.scss]
    width: 1280
    height: 720
    slide-number: true
    navigation-mode: vertical
    center: true
    footer: "..."
    mermaid:
      theme: dark
```

## Common pitfalls

| Problem | Fix |
|---|---|
| `No such kernel 'python3'` | `quarto check` to verify Jupyter; set `jupyter: /path/to/.venv/bin/python` |
| PDF fails with LaTeX errors | `quarto install tinytex` then `tlmgr install <pkg>` |
| `freeze: auto` not re-rendering after data change | Delete `_freeze/<doc>` or `rm -rf _freeze/` |
| Cross-ref ID not found | Confirm label starts with correct prefix (`fig-`, `tbl-`, etc.) |
| `format` key not merging from `_quarto.yml` | Listing `format:` in a doc overrides — must re-list all formats |
| Website missing page | Add to `_quarto.yml` navbar/sidebar OR `render:` list under `project:` |
| `_publish.yml` not found in CI | Commit `_publish.yml` generated by initial `quarto publish` |
| Revealjs / HTML collision (same `.html` ext) | Add `output-file: slides.html` to one format |
| Reveal SCSS/theme edits not visible in preview | `quarto preview` doesn't recompile theme SCSS - re-render or restart preview |
| Dense slide overflows into footer | `.smaller` + `.scrollable`; tighten table cell padding in theme SCSS |
| Mermaid mindmap section colors muddy/wrong | Set `cScale1..N` themeVariables (cScale0 = root section, off-by-one) |
| Mermaid diagram lays out differently across machines / overlaps | It renders client-side; for layout-sensitive or radial graphs use a build-time `{dot}` (Graphviz) cell - `layout=twopi` + `overlap=prism` for a clean deterministic hub |
| Baked mermaid SVG shows empty boxes when embedded as `<img>` | mermaid label `<foreignObject>` doesn't render in `<img>` secure-static mode; re-render with `htmlLabels:false` (native `<text>`), or inline the SVG instead of `<img>` |
| Heading renders as literal text / slide boundary lost | A paragraph (or fenced-div content) directly above a `#`/`##` heading with NO blank line gets absorbed into that paragraph by Pandoc - always leave a blank line before every heading |
| Footnote size differs `.smaller` vs plain slides | `.src` in `em` compounds with `.smaller`'s 0.7em; cancel with `section:not(.smaller) > .src` (child `>`, not descendant - else it matches through `section.stack`) |
| Footnote Y jumps slide-to-slide | `center: true` floats it; pin via `section:has(> .src)` flex + `margin-top:auto` (+ `position:sticky;bottom:0` for scrollable) |
| Em-dashes / smart quotes / mixed `x` vs `×` in slides | Pandoc won't smarten spaced hyphens and these mojibake on paste; normalize to ASCII (`-`, `"`, `'`, `...`) and standardize multipliers |

## Extensions

```bash
quarto add <gh-user>/<repo>   # install from GitHub
quarto install extension <gh-user>/<repo>
quarto list extensions
```

Common extensions: `quarto-ext/fontawesome`, `quarto-ext/lightbox`, `quarto-journals/*` (JOSS, PLOS, etc.)
