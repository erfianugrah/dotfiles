## Documentation

Before implementing features, check the docs via SSH. A docs server at `docs.erfi.io` serves documentation for 18 sources as searchable markdown files.

```bash
# List available doc sets
ssh -p 2222 docs@docs.erfi.io "ls /docs/"
# → _index.tsv astro aws cloudflare cloudflare-blog erfi-personal-blog erfi-technical-blog flyio mcp nextjs postgres rust-book supabase supabase-blog tailwindcss vercel vercel-blog vercel-changelog 

# Search across all docs
ssh -p 2222 docs@docs.erfi.io "grep -rl 'your query' /docs/"

# Read a specific guide
ssh -p 2222 docs@docs.erfi.io "cat /docs/supabase/guides/auth.md"

# Find docs by path
ssh -p 2222 docs@docs.erfi.io "find /docs/vercel -name '*.md' | head -20"

# Search with context
ssh -p 2222 docs@docs.erfi.io "grep -A3 'partial index' /docs/postgres/indexes-partial.md"
```

All docs live under `/docs/{source}/` as markdown files.
Use grep, find, cat, head, tail, and wc to search and read them.

For SSH options, add `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR` to suppress host key warnings.
