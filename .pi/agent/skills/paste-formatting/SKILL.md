---
name: paste-formatting
description: Use when text drafted in Markdown has to land in a rich-text destination that does not render Markdown - Gmail / Outlook compose, Google Docs, Slack, Notion, a CMS/WYSIWYG box, an issue tracker. Fires on "paste into email", "the formatting got stripped", "bullets/bold/code came out as raw asterisks or plain text", "code snippet looks janky in the email", or any copy-paste-loses-formatting gripe. Covers the mdclip tool (cross-OS Markdown -> HTML -> clipboard on WSL/macOS/Linux), the unwrapped-source hard rule, code-snippet handling, and what survives which composer. Pairs with erfi-voice (which drafts the prose) - this skill gets that prose into the target intact.
---

# Paste formatting

## The one fact that explains every "formatting got stripped" gripe

Gmail, Google Docs, Slack, and every WYSIWYG box are HTML rich-text fields. They are NOT Markdown-aware. What survives a paste depends entirely on **which format is on the clipboard**, not on what the source looked like:

- Copy from a terminal / editor / this agent's chat -> the clipboard holds **text/plain**. Gmail keeps line breaks and nothing else. `**bold**` shows literal asterisks, `- x` stays a dash, ``` fences become junk, tables collapse.
- Copy from a **browser** (or set the clipboard's **text/html** slot directly) -> Gmail preserves bold, bullets, headings, links, tables, and monospace code.

So the job is never "reformat the markdown". It is "render the markdown to HTML and get that HTML onto the clipboard's text/html slot", then paste.

## Primary path: `mdclip` (cross-OS)

`mdclip` (at `~/dotfiles/bin/mdclip`, symlinked into `~/.local/bin`) does the whole pipeline: Markdown -> HTML (via the pandoc bundled with the Quarto CLI) -> the OS clipboard as rich text. Then paste into Gmail (Ctrl+V, or Cmd+V on macOS) and the formatting is intact.

The render step is portable; only the clipboard-set step is platform-specific, auto-detected at runtime (WSL is checked before Wayland/X11 because WSLg sets `WAYLAND_DISPLAY`/`DISPLAY` but the real clipboard is Windows'):

| Platform | Rich backend | Plain backend (`--slack`) |
|----------|--------------|---------------------------|
| WSL      | `powershell.exe` .NET CF_HTML DataObject (sets HTML **and** plain fallback) | same, UnicodeText only |
| macOS    | `textutil` HTML->RTF \| `pbcopy` | `pbcopy` |
| Wayland  | `wl-copy --type text/html` | `wl-copy` |
| X11      | `xclip -selection clipboard -t text/html` | `xclip -selection clipboard` |

```bash
mdclip reply.md          # render a file (rich text for Gmail/Docs)
mdclip < reply.md        # or from stdin
mdclip --slack reply.md  # Slack mrkdwn as plain text (see Slack row below)
```

Verified 2026-07: bold, `code` (monospace), bullets, links, and tables all survive the paste into Gmail on WSL. Only WSL sets both a rich flavour and a plain-text fallback in one shot; macOS/Wayland/X11 single-flavour tools set the rich flavour only (every rich editor reads it; terminal paste won't). macOS RTF via `textutil` preserves bold/bullets/headings/links/tables; a true `public.html` flavour would need an `osascript` helper and isn't necessary. On macOS/Linux install the backend tool if missing (`pbcopy`/`textutil` are built in; `wl-clipboard` or `xclip` via package manager); mdclip prints a clear per-platform hint when one is absent.

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
| Slack | `mdclip --slack` (plain text mrkdwn) | Slack markup | Slack ignores pasted HTML and reads the plain-text slot. `mdclip --slack` converts a normal Markdown draft to mrkdwn: `**bold**`->`*bold*`, `*italic*`/`_italic_`->`_italic_`, `[t](u)`->`<u\|t>`, `# H`->`*H*`, `-`/`*`/`+` bullets->`•`; `` `code` `` and ``` fences pass through. In `--slack` a single `*word*` is markdown italic, so use `**word**` for Slack bold. (Hand-typing `*bold*` / `` `code` `` / a triple-backtick block still works if you prefer.) Do NOT use the default HTML mode for Slack. |
| Notion / most WYSIWYG | often accepts Markdown on paste | varies | many convert `**`/`-`/`#` on paste; try plain first, fall back to HTML |
| Terminal, code review, a `.md` file, GitHub comment | the raw Markdown | n/a | these ARE markdown-aware or want the source; do not render |

## ASCII punctuation still applies

Even on the HTML path, keep dashes/quotes/ellipsis ASCII (`-`, `'`, `"`, `...`). Arrows and emoji can mojibake through some clipboard encodings; ASCII punctuation is safe everywhere. Full rule in **`erfi-voice`**.
