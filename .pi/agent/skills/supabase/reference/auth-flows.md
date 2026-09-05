# Auth flows quick reference

Read when writing a sign-in / callback handler by hand. Which verifier to use
server-side (getClaims / getUser / getSession) is in SKILL.md.

```ts
// Magic link (passwordless email)
await supabase.auth.signInWithOtp({ email: 'user@example.com',
  options: { emailRedirectTo: 'https://<host>/auth/callback' } })

// OAuth (Google, GitHub, etc. - configured in Dashboard -> Authentication -> Providers)
await supabase.auth.signInWithOAuth({
  provider: 'github',
  options: { redirectTo: 'https://<host>/auth/callback' }
})

// Password
await supabase.auth.signInWithPassword({ email, password })

// MFA enrollment (TOTP)
const { data } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
// data.totp.qr_code -> show QR; user scans
await supabase.auth.mfa.challengeAndVerify({ factorId: data.id, code: userCode })

// SignOut
await supabase.auth.signOut({ scope: 'local' })   // or 'global' to revoke all sessions
```

**Callback handling for SSR/BFF**: the callback URL receives `?code=...`
(PKCE flow). Exchange via:

```ts
const { data, error } = await supabase.auth.exchangeCodeForSession(code)
// data.session has access_token + refresh_token. Set HttpOnly cookies on the response.
```

`@supabase/ssr` handles this automatically for Next.js / SvelteKit.
`@supabase/server` does not - you write the callback handler yourself (under
20 lines).

## Email templates and enumeration

- `{{ .EmailActionType }}` does NOT work in most email templates
  (confirmation, recovery, magic_link, invite, email_change) - renders empty.
  Hardcode `type=` per template (`type=signup`, `type=recovery`, ...) using
  the `token_hash` flow, then `auth.verifyOtp({ token_hash, type })`
  server-side.
- **Anti-enumeration on signup**: Supabase returns a success-shaped response
  with `user.identities = []` when the email already exists. Detect and
  convert to HTTP 409 `email_taken` when the threat model allows (public
  signup OK; medical/financial not).
- **Login error distinction**: `email_not_confirmed` (HTTP 403) is only
  returned on a correct password - anti-enumeration is preserved for
  wrong-password guesses. Distinguish from `invalid_credentials` (HTTP 401)
  in your UI.
