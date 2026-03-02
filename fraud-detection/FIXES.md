# Fraud Detection Code Review Fixes

Fixes identified during code review of the fraud detection logic across both
`forminator` and `markov-mail` repos. Each fix is on the `fraud-detection-fixes`
branch in both repos.

---

## Fix #1 [HIGH] — Strip internal error context from client responses

**Repo:** forminator
**File:** `src/lib/errors.ts:186-194`

**Problem:** `handleError` included `error.context` as a `details` field in JSON
responses sent to the client. Context objects can contain internal data such as
`tokenHash`, `email`, `existingSubmissionId`, service names, and stack details
that should never be exposed externally.

**Fix:** Removed `...(error.context && { details: error.context })` from the
response body. Context is still logged server-side via Pino for debugging.

---

## Fix #2 [HIGH] — Dashboard session HMAC signs/verifies wrong data

**Repo:** markov-mail
**File:** `src/index.ts:68-98`

**Problem:** `signSession` computed the HMAC over the API key (`secret`) instead
of the expiry payload, and `verifySession` verified against `secret` too. This
meant the HMAC did not cryptographically bind to the expiry timestamp — any
token with the correct HMAC of the API key would pass verification regardless of
expiry manipulation. The `Date.now() > expires` check was the only real guard.

**Fix:** Changed `signSession` to sign the base64-encoded expiry payload, and
`verifySession` to verify against the same payload. The HMAC now
cryptographically protects the expiry timestamp from tampering.

Before:
```typescript
// signSession
const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(apiKey));
// verifySession
return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(secret));
```

After:
```typescript
// signSession
const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
// verifySession
return await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(payload));
```

**Note:** This invalidates all existing dashboard sessions. Users will need to
re-authenticate after deployment.

---

## Fix #3 [MEDIUM] — Remove unused Node crypto import

**Repo:** forminator
**File:** `src/lib/email-fraud-detection.ts:3`

**Problem:** The file imported `crypto from 'crypto'` (Node.js built-in) but
only used `crypto.subtle` (Web Crypto API), which is a global in Cloudflare
Workers. The unused Node import adds unnecessary dependency resolution overhead.

**Fix:** Removed `import crypto from 'crypto'`.

---

## Fix #5 [CLARIFICATION] — Misleading comment on submission count

**Repo:** forminator
**File:** `src/lib/turnstile.ts:179-194`

**Problem:** The comment at line 180-181 stated "we do NOT add +1 here" but the
code at line 194 does add +1. After investigation, the code is correct: the
write-before-read pattern inserts into `turnstile_validations` (not
`submissions`), so querying the `submissions` table does NOT include the current
request and the +1 is needed. The comment was stale/contradictory.

**Fix:** Rewrote the comment to accurately explain the write-before-read pattern
and why +1 is applied to the submissions count but not the validations count.

---

## Fix #8 [LOW] — `predictForestScoreDetailed` ignores model maxDepth

**Repo:** markov-mail
**File:** `src/detectors/forest-engine.ts:121-145`

**Problem:** `predictForestScoreDetailed` called `traverseTree` without passing
the model's configured `maxDepth`, defaulting to 20. The primary function
`predictForestScore` correctly passes `model.meta.config?.max_depth`. This
inconsistency could produce different scores between the two functions for trees
deeper than 20 levels.

**Fix:** Added `maxDepth` calculation (matching `predictForestScore`) and passed
it to `traverseTree` in the detailed prediction loop.

---

## Review finding corrections

### Finding #5 (original "off-by-one") — Downgraded to comment fix

The original review flagged this as a logic bug. After deeper investigation, the
code logic is correct. The submission count queries the `submissions` table
(which does not yet contain the current request), so `+1` is the right
adjustment. The misleading comment was the real issue.

### Finding #13 (TLD database) — Retracted

The original review suggested trimming the hardcoded `TLD_RISK_PROFILES` map
since profiles are "loaded from KV." This was incorrect. The hardcoded map is
the **primary data source**; KV profiles are an optional full-replacement
override that is rarely populated. The 80+ entry map is necessary for correct
operation.
