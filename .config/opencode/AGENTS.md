## Documentation

A docs server at `docs.erfi.io` serves 29,000+ documentation pages across 18 sources as searchable markdown files over SSH. Always check docs before implementing features, debugging issues, or answering questions about these technologies.

### SSH connection

All commands use: `ssh -p 2222 docs@docs.erfi.io "<command>"`

To suppress host key warnings (recommended for automation), add these SSH options:
`-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`

Or add to `~/.ssh/config`:

```
Host docs.erfi.io
  User docs
  Port 2222
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
```

### Available sources

astro, aws, cloudflare, cloudflare-blog, cloudflare-changelog, erfi-personal-blog, erfi-technical-blog, flyio, mcp, nextjs, postgres, rust-book, supabase, supabase-blog, tailwindcss, vercel, vercel-blog, vercel-changelog

All docs live under `/docs/{source}/` as markdown files.

### Recommended workflow

Use a **search -> summary -> targeted read** pattern to minimise token usage:

1. **Search** the index to find relevant files:
   ```bash
   ssh -p 2222 docs@docs.erfi.io "rg -i 'RLS policies' /docs/_index.tsv"
   ```

2. **Get the outline** of a promising file:
   ```bash
   ssh -p 2222 docs@docs.erfi.io "rg '^#' /docs/supabase/guides/auth.md"
   ```

3. **Read only the section you need** (e.g. lines 45-80):
   ```bash
   ssh -p 2222 docs@docs.erfi.io "bat --plain --paging=never --color=never --line-range=45:80 /docs/supabase/guides/auth.md"
   ```

### Available tools

| Tool | Purpose | Example |
|------|---------|---------|
| `rg` (ripgrep) | Fast regex search across files | `rg -i 'pattern' /docs/supabase/` |
| `rg --json` | Structured search with exact line numbers | `rg --json 'auth' /docs/supabase/` |
| `grep` | Basic text search | `grep -rl 'query' /docs/` |
| `bat` | Read files with line numbers | `bat --plain --paging=never /docs/file.md` |
| `bat --line-range` | Read specific line ranges | `bat --plain --paging=never --line-range=10:50 /docs/file.md` |
| `cat` | Read entire files (no line numbers) | `cat /docs/file.md` |
| `head`/`tail` | Read start/end of files | `head -30 /docs/file.md` |
| `find` | Find files by name pattern | `find /docs/aws -name '*lambda*'` |
| `tree` | Browse directory structure | `tree /docs/cloudflare/ -L 2` |
| `wc` | Count lines/words/files | `find /docs/vercel -name '*.md' \| wc -l` |
| `less` | Page through large files (interactive) | `less /docs/file.md` |

### Common patterns

```bash
# Search across ALL docs for a topic
ssh -p 2222 docs@docs.erfi.io "rg -il 'edge functions' /docs/"

# Search within a specific source
ssh -p 2222 docs@docs.erfi.io "rg -i 'deploy' /docs/cloudflare/"

# Search with context lines around matches
ssh -p 2222 docs@docs.erfi.io "rg -i -C3 'CREATE POLICY' /docs/postgres/"

# Get structured JSON results with exact line numbers
ssh -p 2222 docs@docs.erfi.io "rg --json 'partial index' /docs/postgres/"

# Browse what's available in a source
ssh -p 2222 docs@docs.erfi.io "tree /docs/nextjs/ -L 2"

# Read a file with line numbers for precise references
ssh -p 2222 docs@docs.erfi.io "bat --plain --paging=never --color=never /docs/postgres/indexes.md"

# Read only lines 10-40 of a file
ssh -p 2222 docs@docs.erfi.io "bat --plain --paging=never --color=never --line-range=10:40 /docs/postgres/indexes.md"

# Search the pre-built index (fastest -- searches titles and summaries)
ssh -p 2222 docs@docs.erfi.io "rg -i 'authentication' /docs/_index.tsv | head -10"

# Search index filtered to one source
ssh -p 2222 docs@docs.erfi.io "rg -i 'auth' /docs/_index.tsv | rg '^supabase/'"

# Get all headings in a file (document outline)
ssh -p 2222 docs@docs.erfi.io "rg '^#' /docs/supabase/guides/auth.md"

# Pipe and combine commands
ssh -p 2222 docs@docs.erfi.io "rg -il 'cron' /docs/ | head -5 | while read f; do echo \"--- \$f ---\"; head -3 \"\$f\"; done"
```

### Performance tips

- **Search the index first**: `rg -i 'query' /docs/_index.tsv` searches titles+summaries (~1MB) instead of all docs (~300MB).
- **Use `rg` over `grep`**: ripgrep is 10-50x faster for large directory searches.
- **Limit output**: Pipe through `head -N` when searching broadly to avoid overwhelming context.
- **Use `--line-range`**: Read specific sections instead of entire files (30 lines ~120 tokens vs 500 lines ~2K tokens).
- **Use `-l` for file lists**: `rg -il 'pattern'` returns only filenames, not content.
- **Get structure first**: `rg '^#' /docs/file.md` shows headings before reading full file.
