## Documentation

A docs server at `docs.erfi.io` serves 29030+ documentation pages across 18 sources as searchable markdown files over SSH. Always check docs before implementing features, debugging issues, or answering questions about these technologies.

**You have custom docs tools installed. Always use `docs_search`, `docs_read`, `docs_grep`, `docs_find`, `docs_summary`, and `docs_sources` instead of raw SSH commands.** Do not use `ssh` or `Bash` to access the docs server directly — the custom tools handle SSH, output capping, and structured parsing automatically.

### Available sources

astro, aws, cloudflare, cloudflare-blog, cloudflare-changelog, erfi-personal-blog, erfi-technical-blog, flyio, mcp, nextjs, postgres, rust-book, supabase, supabase-blog, tailwindcss, vercel, vercel-blog, vercel-changelog

### Recommended workflow

Use a **search -> summary -> targeted read** pattern to minimise token usage:

1. **Search** the index to find relevant files:
   `docs_search(query="RLS policies", source="postgres")`

2. **Get the outline** of a promising file:
   `docs_summary(path="/docs/postgres/row-security.md")`

3. **Read only the section you need** (e.g. lines 45-80):
   `docs_read(path="/docs/postgres/row-security.md", offset=45, lines=35)`

### Tool reference

| Tool | Purpose | When to use |
|------|---------|-------------|
| `docs_search` | Search titles+summaries across all sources | First step — find relevant files fast (~1MB index) |
| `docs_summary` | Get headings/outline of a file | Before reading — find the right section |
| `docs_read` | Read a file or line range | After summary — read only what you need |
| `docs_grep` | Regex search with context lines (rg --json) | When you need to find content within files |
| `docs_find` | Find files by name pattern | When you know part of the filename |
| `docs_sources` | List all sources with file counts | When you need to know what's available |

### Performance tips

- **Search the index first**: `docs_search` searches titles+summaries (~1MB) instead of all docs (~300MB).
- **Use `docs_summary` before `docs_read`**: Get headings first to find the right line range.
- **Use offset+lines**: `docs_read(path="...", offset=45, lines=35)` reads 35 lines starting at line 45 (~140 tokens vs ~2K for the full file).
- **Use `docs_grep` with a source path**: `docs_grep(query="RLS", path="/docs/postgres/")` is faster than searching all docs.
- **Use the `source` parameter**: `docs_search(query="auth", source="supabase")` filters to one source.
