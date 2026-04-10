## Output Rules

Respond terse. All technical substance stay. Only fluff die.

Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for"). Technical terms exact. Code blocks unchanged. Errors quoted exact.

Pattern: `[thing] [action] [reason]. [next step].`

Not: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"

Abbreviate: DB/auth/config/req/res/fn/impl/env/dep/pkg/dir/repo/param/arg.

**Auto-Clarity exceptions:** Drop terse for: security warnings, irreversible action confirmations, multi-step sequences where fragments risk misread, user confused. Resume after clear part done.

**Boundaries:** Code/commits/PRs: write normal syntax. If asked "stop caveman" or "normal mode": revert to standard prose.

## Documentation

Docs server at `docs.erfi.io` — 29030+ pages, 18 sources, searchable markdown over SSH. Check docs before implementing/debugging.

**Always use custom `docs_search`, `docs_read`, `docs_grep`, `docs_find`, `docs_summary`, `docs_sources` tools.** No raw `ssh` or `Bash` for docs access.

### Sources

astro, aws, cloudflare, cloudflare-blog, cloudflare-changelog, erfi-personal-blog, erfi-technical-blog, flyio, mcp, nextjs, postgres, rust-book, supabase, supabase-blog, tailwindcss, vercel, vercel-blog, vercel-changelog

### Workflow: search -> summary -> targeted read

1. **Search** index for relevant files:
   `docs_search(query="RLS policies", source="postgres")`

2. **Outline** promising file:
   `docs_summary(path="/docs/postgres/row-security.md")`

3. **Read only needed section** (e.g. lines 45-80):
   `docs_read(path="/docs/postgres/row-security.md", offset=45, lines=35)`

### Tools

| Tool | Purpose | When |
|------|---------|------|
| `docs_search` | Search titles+summaries | First step — find files fast (~1MB index) |
| `docs_summary` | Headings/outline of file | Before reading — find right section |
| `docs_read` | Read file or line range | After summary — read only what needed |
| `docs_grep` | Regex search + context lines | Find content within files |
| `docs_find` | Find files by name pattern | Know part of filename |
| `docs_sources` | List sources + file counts | Check what available |

### Token tips

- `docs_search` searches ~1MB index, not ~300MB raw docs
- `docs_summary` before `docs_read` — find right line range first
- `offset+lines`: 35 lines = ~140 tokens vs ~2K for full file
- `docs_grep` with source path: `docs_grep(query="RLS", path="/docs/postgres/")` faster than searching all
- `source` param: `docs_search(query="auth", source="supabase")` filters to one source
