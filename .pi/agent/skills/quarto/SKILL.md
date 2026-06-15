---
name: quarto
description: Use when authoring, rendering, or publishing Quarto documents or projects — .qmd files, _quarto.yml configuration, multi-format output (HTML/PDF/Revealjs/Word/Typst/ePub), project types (website/book/blog/manuscript/dashboard), code execution with Python/R/Julia, freeze/cache management, cross-references, callouts, citations, and publishing to Quarto Pub / GitHub Pages / Netlify / Posit Connect.
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

## Extensions

```bash
quarto add <gh-user>/<repo>   # install from GitHub
quarto install extension <gh-user>/<repo>
quarto list extensions
```

Common extensions: `quarto-ext/fontawesome`, `quarto-ext/lightbox`, `quarto-journals/*` (JOSS, PLOS, etc.)
