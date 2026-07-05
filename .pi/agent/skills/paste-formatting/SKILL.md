---
name: paste-formatting
description: Use when text drafted in Markdown has to land in a rich-text destination that does not render Markdown - Gmail / Outlook compose, Google Docs, Slack, Notion, a CMS/WYSIWYG box, an issue tracker. Fires on "paste into email", "the formatting got stripped", "bullets/bold/code came out as raw asterisks or plain text", "code snippet looks janky in the email", or any copy-paste-loses-formatting gripe. Covers the mdclip tool (WSL, Markdown -> HTML -> Windows clipboard), the unwrapped-source hard rule, code-snippet handling, and what survives which composer. Pairs with erfi-voice (which drafts the prose) - this skill gets that prose into the target intact.
---

# Paste formatting

## The one fact that explains every "formatting got stripped" gripe

Gmail, Google Docs, Slack, and every WYSIWYG box are HTML rich-text fields. They are NOT Markdown-aware. What survives a paste depends entirely on **which format is on the clipboard**, not on what the source looked like:

- Copy from a terminal / editor / this agent's chat -> the clipboard holds **text/plain**. Gmail keeps line breaks and nothing else. `**bold**` shows literal asterisks, `- x` stays a dash, ``` fences become junk, tables collapse.
- Copy from a **browser** (or set the clipboard's **text/html** slot directly) -> Gmail preserves bold, bullets, headings, links, tables, and monospace code.

So the job is never "reformat the markdown". It is "render the markdown to HTML and get that HTML onto the clipboard's text/html slot", then paste.

## Primary path: `mdclip` (WSL)

`mdclip` (at `~/dotfiles/bin/mdclip`, symlinked into `~/.local/bin`) does the whole pipeline: Markdown -> HTML (via the pandoc bundled with the Quarto CLI) -> Windows clipboard as CF_HTML (via `.NET Clipboard.SetText(..., Html)`). Then paste into Gmail with Ctrl+V and the formatting is intact.

```bash
mdclip reply.md          # render a file
mdclip < reply.md        # or from stdin
```

Verified 2026-07: bold, `code` (monospace), bullets, links, and tables all survive the paste into Gmail. Windows PowerShell runs STA by default, which the clipboard API requires; `.NET` auto-prepends the CF_HTML descriptor header, so no offset math is needed.

## Fallback (no tool, any OS): browser copy

If `mdclip` is unavailable, render the markdown to a standalone HTML file, open it in a browser, `Ctrl+A` `Ctrl+C`, paste. The browser puts real text/html on the clipboard and every rich-text target accepts it.

```bash
quarto pandoc -f gfm -t html -s reply.md -o /tmp/reply.html && wslview /tmp/reply.html
```

## Hard rule: keep the SOURCE unwrapped

Author paste-destined text with **one line per paragraph and one line per bullet** - no hard wrapping at 80 columns. Hard wraps become literal newlines in the clipboard, so a plain-text paste (and even some HTML paths) injects line breaks mid-sentence. Let the editor soft-wrap for display; never bake newlines into a paragraph. This is the mechanical companion to erfi-voice's ASCII-punctuation rule - see **`erfi-voice`**.

Internal reference docs that are read in an editor can stay hard-wrapped; only the block you intend to copy out must be unwrapped. Mark it so a later edit does not re-wrap it.

## Code snippets: be honest about the medium

- A short snippet pasted **as HTML** arrives as monospace (mdclip gives it a light grey box). It will NOT be syntax-highlighted - Gmail drops the colour classes.
- NEVER paste a fenced ``` block as **plain** text into Gmail - that is the "janky code" the gripe is about (the backticks show, indentation drifts, the proportional font mangles alignment).
- For anything longer than a few lines, or where highlighting matters: link a gist / repo permalink, or paste a screenshot (e.g. a carbon/silicon-style image). A link is almost always the right call for email.

## What survives which composer

| Target | Paste this | Survives | Notes |
|---|---|---|---|
| Gmail / Outlook web | HTML (mdclip / browser) | bold, italic, lists, headings, links, tables, monospace | no code syntax highlight; use a link/image for real code |
| Google Docs | HTML (mdclip / browser) | same as Gmail, cleaner | best rich-text fidelity of the lot |
| Slack | plain text, then Slack's own syntax | Slack markup only | Slack ignores pasted HTML; type `*bold*` (single asterisk), `` `code` ``, triple-backtick block. Do NOT run it through mdclip |
| Notion / most WYSIWYG | often accepts Markdown on paste | varies | many convert `**`/`-`/`#` on paste; try plain first, fall back to HTML |
| Terminal, code review, a `.md` file, GitHub comment | the raw Markdown | n/a | these ARE markdown-aware or want the source; do not render |

## ASCII punctuation still applies

Even on the HTML path, keep dashes/quotes/ellipsis ASCII (`-`, `'`, `"`, `...`). Arrows and emoji can mojibake through some clipboard encodings; ASCII punctuation is safe everywhere. Full rule in **`erfi-voice`**.
