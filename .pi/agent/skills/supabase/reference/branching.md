# Branching (preview environments)

Read when creating, pushing to, or detaching a Supabase branch. Confirm every
flag with `supabase branches --help` / `supabase db push --help` first.

Supabase Branching creates ephemeral project clones for PR previews.
Per-branch:

- Fresh Postgres with the production schema (no data unless you opt in)
- Separate API keys, URL, JWT secret
- Auto-runs migrations from the branch's `supabase/migrations/`

```sh
supabase branches create feature-x --persistent
supabase branches list
supabase branches get feature-x          # URL + keys for the branch

# Push schema to a branch: there is no --branch flag. A branch is a project;
# target it by its own project ref (from `branches get`), or --db-url.
supabase db push --project-ref <branch-project-ref>
```

**GitHub integration**: enable in the dashboard; branches auto-create on PR
open and tear down on PR close/merge. Each PR gets its own Supabase project
with the PR's schema.

**Cost**: branches are full projects billed per hour ($0.01344/branch/hour
on Pro+; branching is not available on the Free plan - the Free "limit of 2"
is active projects, not branches). Persistent branches stay until manually
deleted; preview branches auto-expire.

**Detaching a persistent branch from its git branch without
delete/recreate**: `PATCH /v1/branches/{branch_id}` with `{"git_branch":""}`
clears the link - pushes to the git branch then produce a `Supabase Preview`
check run with conclusion `skipped` and leave the branch untouched. `null`
does NOT clear it (treated as field-absent, silently no-ops with a 200). CLI
equivalent: `supabase branches update <name> --git-branch "" --project-ref
<ref>`. Relink by setting the branch name back (validated against the
connected repo). Adjacent: `DELETE` on a persistent branch 400s - PATCH
`{"persistent":false}` first. Full guide:
https://erfi.dev/guides/supabase-branch-detach-git-link/
