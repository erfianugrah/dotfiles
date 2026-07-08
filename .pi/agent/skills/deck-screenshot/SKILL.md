---
name: deck-screenshot
description: Use when you need to SEE a reveal.js / Quarto revealjs deck as an image inside a pi session - screenshotting one slide, generating a whole-deck contact sheet to eyeball layout/overflow, or visually verifying a .qmd presentation after editing. Fires on "screenshot the deck", "show me slide N", "does this slide overflow", "render the pitch and look at it", mermaid-in-slides looking clipped, or any "let me look at how the deck renders" need. Not for rendering a deck to share (that's the quarto skill) - this is for the agent to view it.
---

# Deck Screenshot

Turn a reveal.js / Quarto revealjs deck into PNGs the agent can `read`, so you
can visually verify layout, overflow, and mermaid rendering without a browser.

The `~/bin/deck-shot` helper wraps the whole pipeline. Prefer it over hand-rolling
chromium/decktape commands.

## Quick reference

```bash
deck-shot pitch.qmd 14              # single slide 14 -> /tmp/deck-shot.png (fast)
deck-shot pitch.qmd                 # whole deck -> /tmp/deck-contact.png (contact sheet)
deck-shot pitch.html 2 -o /tmp/s.png    # skip re-render; use built HTML directly
deck-shot --faithful pitch.qmd 14  # single slide via decktape (faithful fonts/mermaid)
```

Then `read` the PNG path it prints on stdout.

`<deck>` may be a `.qmd` (rendered via `quarto render --to revealjs` first),
a built `.html`, or a `file://`/`http(s)://` URL. A slide arg is a 0-based
reveal.js horizontal index (`#/N`) or a slide id (`#/some-id`). Omit the slide
arg to get the whole-deck contact sheet.

Options: `-o FILE` output, `-s WxH` window size (default 1280x720), `-t MS`
virtual-time budget for the fast path (default 8000), `-r DPI` contact-sheet
resolution (default 52), `--tile CxR` montage layout (default 5x6),
`--pdf FILE` keep the decktape PDF, `--faithful` force decktape for one slide.

## Which mode

- **Single slide, quick check** -> `deck-shot deck N`. Raw headless chromium,
  ~1-2s. Good enough for text/layout.
- **Whole deck / catch overflow across all slides** -> `deck-shot deck`. decktape
  drives reveal.js's own step machinery and waits for render, so mermaid and web
  fonts are faithful. Slower (spins a browser per deck).
- **One slide but fonts/mermaid matter** -> `deck-shot --faithful deck N`. Uses
  decktape's `--slides` for that page.

## The font/mermaid caveat

Raw headless chromium can substitute a late-loading web font (e.g. Iosevka),
so **mermaid node text may look clipped in the fast screenshot even when the
real render is fine**. If a fast-path shot shows clipped diagram labels, re-run
with `--faithful` (or take the contact sheet) before concluding the slide is
actually broken. decktape is the source of truth.

## What deck-shot runs under the hood

Fast single slide:
```bash
chromium --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1280,720 \
  --virtual-time-budget=8000 --screenshot=/tmp/s.png \
  "file:///abs/pitch.html#/<slide>"
```

Whole deck contact sheet:
```bash
bunx decktape reveal --chrome-path /usr/sbin/chromium --size 1280x720 \
  file:///abs/pitch.html /tmp/deck.pdf
pdftoppm -png -r 52 /tmp/deck.pdf /tmp/s
montage /tmp/s-*.png -tile 5x6 -geometry 256x144+3+3 -label '%f' /tmp/contact.png
```

## Deps (all present on this box)

`quarto`, `/usr/sbin/chromium` + `google-chrome-stable`, `decktape` (via `bunx`),
`pdftoppm` (poppler), `montage` (imagemagick). If on another machine, check with
`which quarto chromium pdftoppm montage` and `bunx decktape --version`.

## Common mistakes

- **Re-rendering when the HTML already exists** - pass the built `.html` (or a
  `file://` URL) to skip the quarto render step. Only pass `.qmd` when the source
  changed.
- **Trusting a clipped fast-path shot** - see the font caveat; verify with
  `--faithful` or the contact sheet before reporting a rendering bug.
- **Wrong slide index** - index 0 is usually the title slide; slide "one" is
  `#/1`. decktape's `--faithful` path is 1-based instead.
