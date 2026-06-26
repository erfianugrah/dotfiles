# Commit & PR Authorship

Commits and pull requests must read as if written by the human author. The user is the sole author. You are a tool, not a collaborator.

- NEVER add `Co-Authored-By:` trailers naming yourself, the model, Pi, Claude, GPT, or any AI tool.
- NEVER add "Generated with", "Created with", "Written with", "via <tool>", "🤖", or any other AI-attribution footer, signature, or watermark.
- NEVER add marketing links (e.g. https://pi.dev, https://claude.com/claude-code, https://anthropic.com) to commit messages, PR bodies, issue comments, or any other artifact.
- Do not mention the assistant, the model, or the tool in commit messages or PR descriptions unless the user explicitly asks for it.
- This applies to `git commit`, `git commit --amend`, `gh pr create`, `gh pr edit`, `gh issue` commands, and any equivalent invoked through tools, scripts, or HEREDOCs.
- If the user has previously asked for attribution in this session, that override applies only to that session and only when restated.
- **NEVER override the user's git author/committer identity via `-c user.name=...` / `-c user.email=...` / `--author="..."` / env-var injection (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`).** The user's `~/.gitconfig` is authoritative — it carries `Erfi Anugrah <erfi.anugrah@gmail.com>` plus a GPG signing key. Past sessions invented `erfi@erfi.io` as the author for new repos (`~/discord-wipe` has 7 such commits) and the pattern propagated because subsequent agents read the prior commits as precedent. Use plain `git commit` (or `git commit -F <file>`) and let the global config do its job. Only override when the user explicitly asks in the current session.

# Safety

NEVER run compiled binaries, servers, or daemons directly on the dev machine unless you fully understand their startup hooks and side effects. Use `go test`, `bun test`, Docker, or dry-run flags instead. If unsure what a binary does at startup, read the main() function first.

# Confidential identifiers in tracked files

Before persisting prose to a tracked file in a git repo that has a remote — plan docs, READMEs, design notes, commit messages, PR/issue bodies — you are the classifier for confidential third-party identifiers: customer / partner / client names, internal program or deal codenames, named individuals, and unreleased roadmap. There is no denylist to lean on; apply judgment to your own draft. The `confidential-write-guard` extension hard-blocks terms the user has already marked confidential and nudges once per repo, but catching NOVEL terms is on you.

For any identifier you are not certain is safe to publish, escalate in this order — do NOT jump straight to asking:

1. **Plainly public** — a well-known company, product, standard, or technology referenced in an ordinary public context (Cloudflare, Supabase, Postgres, OAuth) is fine. Write it.
2. **Web-check the specific claim, not the name** — if you are unsure, use `web_research` / `websearch` to test whether *the specific association or fact* is already public, not merely whether the name exists. A public company name inside a non-public business context is STILL confidential: "Acme Corp" is public, but "Acme Corp is our customer, doing X" is confidential unless that relationship is itself publicly documented. If the specific fact is already public, it's fine to write.
3. **Ask the user — final step only** — if the web turns up nothing confirming the specific fact is public, do NOT write the term. Ask the user via the `question` tool ("OK to commit these terms to `<file>`: X, Y?") and use a generic placeholder ("Customer", "the partner", "<redacted>") until they confirm.

When the user answers, record it via the `confidential_terms` tool (action `block` or `allow`, default repo scope) so you never re-ask and blocked terms stay enforced. Notes:

- A term the user marked `block` is hard-blocked by the guard — rephrase, don't fight it.
- **Public remotes especially**: a confidential name on a public repo's default branch is effectively disclosed; removing it needs a history rewrite + force-push + (with forks) a GitHub Support request to GC the fork-network object store. Asking first is far cheaper.
- Never echo a term you are redacting back into chat just to explain the redaction — refer to it obliquely.

# Output: real Unicode characters

In ALL text output — response text, tool inputs (bash commands, commit messages, heredoc bodies, file contents, planning notes, prose) — use the actual Unicode character directly. Em-dash, en-dash, arrows, ellipsis, bullets, check / cross marks: paste the real glyph.

The terminal, bash, git, and pi's renderer all preserve real UTF-8. They do NOT interpret JS-style six-character backslash-u escape sequences as Unicode. Such sequences pass through verbatim as ugly six-character strings in commit messages, terminal output, and committed files.

Exceptions where the escape form is correct: source code where the language runtime interprets the escape (TypeScript / JavaScript / JSON string literals etc.), and bash ANSI-C quoting in dollar-single-quote form.

<!--
Tool-routing rules live in ~/.pi/agent/AGENTS.md (everything BEFORE the
`## Documentation` heading) and are prepended to the system prompt by
~/.pi/agent/extensions/tool-routing.ts. Canonical edit target via the
symlink chain is ~/dotfiles/.config/opencode/AGENTS.md.
-->
