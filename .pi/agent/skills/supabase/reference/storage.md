# Storage (BFF upload pattern, policies, signed URLs)

Read when uploading through a Worker/Edge Function, writing `storage.objects`
policies, or serving private files.

For the Worker BFF stack (browser never sees the JWT), upload via the Worker:

```ts
// Worker (Hono / Bun / Edge Function) - accepts multipart, proxies to Storage
import { withSupabase } from '@supabase/server'

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    const { supabase, userClaims } = ctx
    const form = await req.formData()
    const file = form.get('file') as File

    // Path with user ID prefix - RLS policy enforces user can only write to own dir
    const path = `${userClaims.id}/${crypto.randomUUID()}-${file.name}`

    const { data, error } = await supabase
      .storage
      .from('uploads')
      .upload(path, file, { cacheControl: '3600', upsert: false })

    if (error) return Response.json({ error: error.message }, { status: 400 })
    return Response.json({ path: data.path })
  }),
}
```

**RLS policies on storage.objects** (enable in dashboard or migration):

```sql
-- Users can read/write only their own files
CREATE POLICY "user_owns_path" ON storage.objects
  FOR ALL TO authenticated
  USING ((storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK ((storage.foldername(name))[1] = auth.uid()::text);
```

**Upsert needs INSERT + SELECT + UPDATE policies.** INSERT alone means the
replacement silently fails.

**Public reads** for an avatar-style bucket: create the bucket as public, then
anyone can GET via
`https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<path>`. RLS
still gates writes.

**Signed URLs** for time-limited private downloads:

```ts
const { data } = await supabase.storage.from('private').createSignedUrl(path, 60)
// data.signedUrl is valid for 60s
```

**Render/transform path behaviour** (measured in supabase-lab): 400
InvalidRequest on an invalid source, SVG passes through unchanged, and the
plain URL always serves the original - never a 5xx. Fresh projects answer
`TenantNotFound` until the storage tenant provisions, then 429 SlowDown while
the pool settles; retry with backoff for the first minutes.
