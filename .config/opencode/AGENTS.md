## Docs over SSH

Documentation, blogs, and changelogs for Supabase, Cloudflare, Vercel, PostgreSQL, and AWS are served over SSH at `docs.erfi.io`. Use standard Unix tools to search and read them.

```bash
# List available doc sets
ssh -p 2222 docs@docs.erfi.io "ls /docs/"
# → supabase  supabase-blog  cloudflare  cloudflare-blog  vercel  vercel-blog  vercel-changelog  postgres  aws

# Search across all docs
ssh -p 2222 docs@docs.erfi.io "grep -rl 'RLS' /docs/"

# Read a specific guide
ssh -p 2222 docs@docs.erfi.io "cat /docs/supabase/guides/auth.md"
ssh -p 2222 docs@docs.erfi.io "cat /docs/cloudflare/workers.md"
ssh -p 2222 docs@docs.erfi.io "head -50 /docs/aws/lambda/latest/dg/welcome.html"

# Find docs by path
ssh -p 2222 docs@docs.erfi.io "find /docs/vercel -name '*.md' | head -20"
ssh -p 2222 docs@docs.erfi.io "find /docs/postgres -name '*.md' -path '*index*'"

# Search with context
ssh -p 2222 docs@docs.erfi.io "grep -A5 'partial index' /docs/postgres/indexes-partial.md"

# Search blogs for recent features
ssh -p 2222 docs@docs.erfi.io "grep -rl 'launch week' /docs/supabase-blog/ | head -5"
ssh -p 2222 docs@docs.erfi.io "grep -rl 'Next.js' /docs/vercel-blog/ | head -5"
```

All docs live under `/docs/{source}/` as markdown or HTML files.
Use grep, find, cat, head, tail, and wc to search and read them.

For SSH options, add `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR` to suppress host key warnings.
