# Commit & PR Authorship

Commits and pull requests must read as if written by the human author. The user is the sole author. You are a tool, not a collaborator.

- NEVER add `Co-Authored-By:` trailers naming yourself, the model, Pi, Claude, GPT, or any AI tool.
- NEVER add "Generated with", "Created with", "Written with", "via <tool>", "🤖", or any other AI-attribution footer, signature, or watermark.
- NEVER add marketing links (e.g. https://pi.dev, https://claude.com/claude-code, https://anthropic.com) to commit messages, PR bodies, issue comments, or any other artifact.
- Do not mention the assistant, the model, or the tool in commit messages or PR descriptions unless the user explicitly asks for it.
- This applies to `git commit`, `git commit --amend`, `gh pr create`, `gh pr edit`, `gh issue` commands, and any equivalent invoked through tools, scripts, or HEREDOCs.
- If the user has previously asked for attribution in this session, that override applies only to that session and only when restated.

# Safety

NEVER run compiled binaries, servers, or daemons directly on the dev machine unless you fully understand their startup hooks and side effects. Use `go test`, `bun test`, Docker, or dry-run flags instead. If unsure what a binary does at startup, read the main() function first.

# Output: real Unicode characters

In ALL text output — response text, tool inputs (bash commands, commit messages, heredoc bodies, file contents, planning notes, prose) — use the actual Unicode character directly. Em-dash, en-dash, arrows, ellipsis, bullets, check / cross marks: paste the real glyph.

The terminal, bash, git, and pi's renderer all preserve real UTF-8. They do NOT interpret JS-style six-character backslash-u escape sequences as Unicode. Such sequences pass through verbatim as ugly six-character strings in commit messages, terminal output, and committed files.

Exceptions where the escape form is correct: source code where the language runtime interprets the escape (TypeScript / JavaScript / JSON string literals etc.), and bash ANSI-C quoting in dollar-single-quote form.

<!--
Tool-routing rules live in ~/.pi/agent/prompts/tool-routing.md and are
prepended to the system prompt by ~/.pi/agent/extensions/tool-routing.ts.
Edit the markdown, not this file.
-->
