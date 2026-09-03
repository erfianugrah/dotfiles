# lsp-servers

A skills-directory plugin (`lsp-servers@skills-dir`) that gives Claude Code's
`LSP` tool a language server for the file types the official `*-lsp` plugins
do not cover. TypeScript, Go, Python, Rust, Lua and C/C++ come from the
official `claude-plugins-official` marketplace plugins and are not repeated
here; two plugins declaring the same extension would conflict (first wins).

The same servers back the pi `lsp` extension (`.pi/agent/extensions/lsp/`),
and nvim runs them through Mason. One binary per language, three consumers.

## Where the binaries come from

Claude Code resolves `command` from PATH. `.zshrc` appends
`~/.local/share/nvim/mason/bin` so anything Mason installed for nvim is
visible; bun-global and cargo copies of the same servers come first on PATH
and keep winning.

| Server | Files | Provided by |
|---|---|---|
| bash-language-server | .sh .bash .zsh | bun -g |
| yaml-language-server | .yaml .yml | bun -g |
| vscode-json-language-server | .json .jsonc | bun -g (vscode-langservers-extracted) |
| vscode-css-language-server | .css .scss .less | bun -g (vscode-langservers-extracted) |
| vscode-html-language-server | .html .htm | bun -g (vscode-langservers-extracted) |
| taplo | .toml | cargo |
| terraform-ls | .tf .tfvars .hcl | Mason |
| astro-ls | .astro | Mason |
| markdown-oxide | .md | Mason |
| docker-langserver | .dockerfile | Mason |
| sql-language-server | .sql | Mason |
| graphql-lsp | .graphql .gql | Mason |

## Notes

- `astro-ls` needs a TypeScript SDK; `initializationOptions.typescript.tsdk`
  points at the bun-global `typescript` that `typescript-language-server`
  already depends on.
- `diagnostics` is off for markdown and SQL. markdown-oxide treats the
  workspace as a wiki and reports unresolved links; sql-language-server's
  parser rejects Postgres-specific syntax. Symbols and references still work.
- `extensionToLanguage` is keyed by extension, so a bare `Dockerfile` has no
  server here. Only `*.dockerfile` is covered.
- After editing this file: `/reload-plugins` in a running session, or start a
  new one. Failures to start show in `/plugin` under Errors, usually as
  `Executable not found in $PATH`.
- Validate: `claude plugin validate ~/.claude/skills/lsp-servers`.
