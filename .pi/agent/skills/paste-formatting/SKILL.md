---
name: paste-formatting
description: Use when text drafted in Markdown has to land in a destination that does not render raw Markdown - Gmail / Outlook, Google Docs, Notion, a WYSIWYG box, or a chat app (Slack, Discord, Telegram, WhatsApp). Fires on 'paste into email', 'copy to clipboard for Slack/Discord/Telegram/WhatsApp', 'the formatting got stripped', 'bold came out as raw asterisks', 'code looks janky in the email', or the mdclip tool. NOT for what the prose says (erfi-voice) or how a long doc is organised (writing-structure).
---

# Paste formatting

## The one fact that explains every "formatting got stripped" gripe

Gmail, Google Docs, Slack, and every WYSIWYG box are HTML rich-text fields. They are NOT Markdown-aware. What survives a paste depends entirely on **which format is on the clipboard**, not on what the source looked like:

- Copy from a terminal / editor / this agent's chat -> the clipboard holds **text/plain**. Gmail keeps line breaks and nothing else. `**bold**` shows literal asterisks, `- x` stays a dash, ``` fences become junk, tables collapse.
- Copy from a **browser** (or set the clipboard's **text/html** slot directly) -> Gmail preserves bold, bullets, headings, links, tables, and monospace code.

So the job is never "reformat the markdown". It is "render the markdown to HTML and get that HTML onto the clipboard's text/html slot", then paste.

## Primary path: `mdclip` (cross-OS)

`mdclip` (at `~/dotfiles/bin/mdclip`, symlinked into `~/.local/bin`) does the whole pipeline: Markdown -> HTML (via the pandoc bundled with the Quarto CLI) -> the OS clipboard as rich text. Then paste into Gmail (Ctrl+V, or Cmd+V on macOS) and the formatting is intact.

The render is `quarto pandoc -f gfm -t html --wrap=none`. The `--wrap=none` is load-bearing: pandoc's default `--wrap=auto` re-wraps every paragraph at 72 columns, and Gmail turns those baked-in newlines into hard line-breaks mid-sentence on paste (text wraps at ~65 chars with a wide empty right margin). Keeping the source unwrapped is not enough on its own - the renderer must not re-wrap either. Do not remove that flag.

The render step is portable; only the clipboard-set step is platform-specific, auto-detected at runtime (WSL is checked before Wayland/X11 because WSLg sets `WAYLAND_DISPLAY`/`DISPLAY` but the real clipboard is Windows'):

| Platform | Rich backend | Plain backend (chat flavours) |
|----------|--------------|-------------------------------|
| WSL      | `powershell.exe` .NET CF_HTML DataObject (sets HTML **and** plain fallback) | same, UnicodeText only |
| macOS    | `textutil` HTML->RTF \| `pbcopy` | `pbcopy` |
| Wayland  | `wl-copy --type text/html` | `wl-copy` |
| X11      | `xclip -selection clipboard -t text/html` | `xclip -selection clipboard` |

```bash
mdclip reply.md             # rich text (Gmail / Docs / any WYSIWYG box)
mdclip < reply.md           # or from stdin
mdclip --slack    reply.md  # Slack mrkdwn      (plain text)
mdclip --discord  reply.md  # Discord markdown  (plain text)
mdclip --telegram reply.md  # Telegram markdown (plain text)
mdclip --whatsapp reply.md  # WhatsApp markup   (plain text)
# short flags: -s -d -t -w

# auto-split for per-app message caps (chat flavours only):
mdclip --discord --split reply.md      # split into <=2000-char messages
mdclip --discord --split=4000 reply.md # custom cap (e.g. Discord Nitro)
```

`--split` does a CLEAN split: breaks only at blank-line block boundaries, never inside a fenced code block - a fence that alone exceeds the cap is closed at the break and reopened (with the language hint) on the next part, so Discord still syntax-highlights every chunk. Each part gets an `(N/M)` header that counts toward the cap. Default caps: discord 2000, telegram 4096, slack 40000, whatsapp 65536; `--split=N` overrides. Interactive TTY: part 1 goes on the clipboard, then each Enter loads the next part. Non-TTY (agent/pipe): part 1 on the clipboard, the rest written to `/tmp/mdclip-split-*/part-N.txt` with the paths printed - hand those to the user or copy them in sequence yourself. Without `--split` an over-cap message is copied whole and the app rejects it on send, so for Discord always pass `--split` unless the draft is known-short.

## Chat apps: Slack / Discord / Telegram / WhatsApp

Slack, Discord and WhatsApp read only the clipboard's **plain-text** slot and apply their *own* inline markup when the message is sent, so the rich (default) mode does nothing for them - use the app's plain-text dialect. Telegram Desktop is the one client that also honours the rich-text slot on paste (maintainer-confirmed, tdesktop#30827), so `mdclip`'s default rich mode works there; Telegram mobile clients are plain-text-only, so the Telegram flavour below remains the cross-client-safe path, and if a rich paste misbehaves, Ctrl+Shift+V (paste without formatting) then the Telegram-flavour markup is the fallback.

Each `mdclip` chat flavour converts a normal GFM draft into that dialect and sets plain text only:

| App | flag | bold | italic | strike | inline code | link | heading | bullets |
|---|---|---|---|---|---|---|---|---|
| Slack | `--slack` | `*b*` | `_i_` | `~s~` | `` `c` `` | `<url\|text>` | `*H*` | `• ` |
| Discord | `--discord` | `**b**` | `*i*` | `~~s~~` | `` `c` `` | `text (url)` | `# H` kept | `- ` |
| Telegram | `--telegram` | `**b**` | `__i__` | `~~s~~` | `` `c` `` | `[text](url)` kept | `**H**` | `• ` |
| WhatsApp | `--whatsapp` | `*b*` | `_i_` | `~s~` | `` `c` `` | `text (url)` | `*H*` | `- ` |

All four **drop GFM table delimiter rows** (`|---|`) and pass ` ``` ` code fences through verbatim (Discord/Telegram keep the language hint for syntax highlighting; Slack/WhatsApp render the block as monospace). Notes on the deliberate per-app choices:

- **Discord** is almost identical to standard GFM (`**bold**`, `# headers`, `- bullets`, ` ``` ` fences all native), so the transform is nearly identity - it only rewrites masked links to `text (url)` because Discord renders `[text](url)` only inside bot/webhook embeds, not in normal user messages.
- **Telegram** desktop/mobile parses `**bold**` / `__italic__` / `` `code` `` / `[text](url)` in the composed message on send. If pasted markers stay literal, the markdown-in-input setting is off - re-enable it, or select + Ctrl/Cmd+B. The composer reference is core.telegram.org/api/entities; the Bot API `parse_mode` dialects (MarkdownV2 / HTML) apply to bots only and are the wrong reference for user-composed messages. User messages have no native tables or headings. Messages cap at 4096 chars - Telegram Desktop auto-splits longer pastes on send.
- **WhatsApp** bold is a SINGLE `*` (so `**bold**` -> `*bold*`); it has no headings or masked links, so those degrade to bold and `text (url)`. Bulleted/numbered lists and block quotes (`- `, `1.`, `> `) and single-backtick inline code are native since the 2024 formatting update.
- **Tables** render in none of the four; the delimiter row is dropped and the `| a | b |` content rows are left as readable pipe-separated lines. For anything genuinely tabular, send a code-fenced block or a screenshot.

On WSL, bold, `code` (monospace), bullets, links, and tables all survive the paste into Gmail with no mid-paragraph line-breaks (see the pandoc no-wrap note above). Only WSL sets both a rich flavour and a plain-text fallback in one shot; macOS/Wayland/X11 single-flavour tools set the rich flavour only (every rich editor reads it; terminal paste won't). macOS goes through RTF via `textutil`, which preserves bold/bullets/headings/links/tables. On macOS/Linux install the backend tool if missing (`pbcopy`/`textutil` are built in; `wl-clipboard` or `xclip` via package manager); mdclip prints a per-platform hint when one is absent.

## Fallback (no tool, any OS): browser copy

If `mdclip` is unavailable, render the markdown to a standalone HTML file, open it in a browser, `Ctrl+A` `Ctrl+C`, paste. The browser puts real text/html on the clipboard and every rich-text target accepts it.

```bash
quarto pandoc -f gfm -t html -s reply.md -o /tmp/reply.html && wslview /tmp/reply.html
```

## Hard rule: keep the SOURCE unwrapped

Author paste-destined text with **one line per paragraph and one line per bullet** - no hard wrapping at 80 columns. Hard wraps become literal newlines in the clipboard, so a plain-text paste (and even some HTML paths) injects line breaks mid-sentence. Let the editor soft-wrap for display; never bake newlines into a paragraph. This is the mechanical companion to erfi-voice's ASCII-punctuation rule - see **`erfi-voice`**.

Internal reference docs that are read in an editor can stay hard-wrapped; only the block you intend to copy out must be unwrapped. Mark it so a later edit does not re-wrap it.

## Hard rule: author bullet lists TIGHT (no blank line between items)

A blank line between list items makes pandoc emit a **loose list** - each `<li>` is wrapped in `<p>`, and Gmail renders those with large top/bottom margins, so the bullets end up spaced far apart with a big gap before the first one. Write list items on consecutive lines with no blank line between them; pandoc then emits `<li>...</li>` (a tight list) and the bullets render compact. Blank lines are only for separating a list from surrounding paragraphs, never between items.

## Code snippets: be honest about the medium

- A short snippet pasted **as HTML** arrives as monospace (mdclip gives it a light grey box). It will NOT be syntax-highlighted - Gmail drops the colour classes.
- NEVER paste a fenced ``` block as **plain** text into Gmail - that is the "janky code" the gripe is about (the backticks show, indentation drifts, the proportional font mangles alignment).
- For anything longer than a few lines, or where highlighting matters: link a gist / repo permalink, or paste a screenshot (e.g. a carbon/silicon-style image). A link is almost always the right call for email.

## What survives which composer

| Target | Paste this | Survives | Notes |
|---|---|---|---|
| Gmail / Outlook web | HTML (mdclip / browser) | bold, italic, lists, headings, links, tables, monospace | no code syntax highlight; use a link/image for real code |
| Google Docs | HTML (mdclip / browser) | same as Gmail, cleaner | best rich-text fidelity of the lot |
| Slack | `mdclip --slack` (plain mrkdwn) | Slack markup | See the Chat apps section. `**bold**`->`*bold*`, `[t](u)`->`<u\|t>`, `# H`->`*H*`, bullets->`•`. A single `*word*` is markdown italic, so use `**word**` for bold. Do NOT use default HTML mode for Slack. |
| Discord | `mdclip --discord` (plain md) | Discord markdown | Near-identity GFM: `**bold**`, `*italic*`, `# headers`, `- bullets`, ` ``` `fences with lang highlight all native. Masked links -> `text (url)` (Discord masked links are embed-only). |
| Telegram | `mdclip --telegram` (plain md) | Telegram markdown | `**bold**` kept, italic -> `__i__`, `[text](url)` masked links kept, `# H` -> `**H**`. Parsed on send if input-markdown is enabled. Telegram Desktop also accepts the default rich (HTML) mode on paste; use the plain Telegram flavour for mobile/cross-client safety. 4096-char cap per message, desktop auto-splits. |
| WhatsApp | `mdclip --whatsapp` (plain markup) | WhatsApp markup | Single-asterisk bold `*b*`, `_i_`, `~s~`, `` `code` ``, `- `/`1.`/`> ` lists (2024+). No headings (->bold) or masked links (->`text (url)`). |
| Notion / most WYSIWYG | often accepts Markdown on paste | varies | many convert `**`/`-`/`#` on paste; try plain first, fall back to HTML |
| Terminal, code review, a `.md` file, GitHub comment | the raw Markdown | n/a | these ARE markdown-aware or want the source; do not render |

## ASCII punctuation still applies

Even on the HTML path, keep dashes/quotes/ellipsis ASCII (`-`, `'`, `"`, `...`). Arrows and emoji can mojibake through some clipboard encodings; ASCII punctuation is safe everywhere. Full rule in **`erfi-voice`**.
