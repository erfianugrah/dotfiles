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

## Fix #9 [HIGH] — Consistent fail-open policy across both repos

**Repos:** forminator + markov-mail

**Problem:** The two repos had contradictory failure modes during outages:

- **forminator**: Token reuse check was the only signal that failed *closed*
  (assumed reused on DB error → blocked all users). All other signals failed
  open (returned zero scores). This meant a DB outage simultaneously blocked
  everyone via false token-reuse detection AND let all fraud through at zero
  scores — the worst of both worlds.
- **markov-mail**: The outer middleware catch returned HTTP 500, completely
  blocking all traffic. The fraud block response was plain text `"Forbidden"`
  (not JSON), inconsistent with all other responses.

**Fixes:**
1. Changed `checkTokenReuse` to fail open (`return false` on error) — the
   Turnstile API still validates tokens cryptographically; replay detection
   degrades gracefully. (`forminator/src/lib/turnstile.ts:123-127`)
2. Changed markov-mail outer catch to fail open with degraded-mode headers
   (`X-Fraud-Degraded: true`, `X-Fraud-Decision: warn`) instead of HTTP 500.
   (`markov-mail/src/middleware/fraud-detection.ts:834-848`)
3. Changed fraud block response from plain text to JSON `{ error, message }`
   format. (`markov-mail/src/middleware/fraud-detection.ts:813-823`)
4. Updated `forminator/AGENTS.md` to document the unified fail-open policy.

---

## Fix #10 [MEDIUM] — Parallelize Phase 2 signal collection

**Repo:** forminator
**Files:** `src/routes/submissions.ts:355-445`, `src/lib/turnstile.ts:175-237`

**Problem:** All 7 signal collectors in Phase 2 ran sequentially despite having
no data dependencies on each other (they all depend only on Phase 1 outputs).
This created a waterfall of ~15-22 sequential D1 round-trips, adding 30-60ms
of unnecessary latency per request.

**Fixes:**
1. Wrapped all 7 collectors (email fraud RPC, ephemeral ID signals, JA4 signals,
   IP rate limit, email diversity, fingerprint signals, duplicate email check)
   in a single `Promise.all` call.
2. Within `collectEphemeralIdSignals`, parallelized the 3 sub-queries
   (submission count, validation count, IP diversity) with `Promise.all`.
3. Moved logging statements after the `Promise.all` resolves.

**Estimated improvement:** ~15-22 sequential D1 queries reduced to ~4
sequential phases. Phase 2 effective depth drops from 7+ round-trips to 1.

---

## Fix #11 [MEDIUM] — Cap weight redistribution normalization factor

**Repo:** forminator
**File:** `src/lib/scoring.ts:354`

**Problem:** When signals are inactive (tokenReplay=0, device signals at
baseline), their weights are redistributed via a multiplicative factor of
`1 / (1 - inactiveWeight)`. On every first-time submission, 60% of weight is
inactive (0.28 tokenReplay + 0.32 device signals), giving a **2.5x multiplier**
to the remaining 6 signals. No cap existed on this factor.

This meant that a moderate-risk email score (50/100) would be inflated to 125%
of its intended contribution. Combined with the corroboration bonus, this could
push borderline scores over the block threshold.

**Fix:** Added `MAX_NORMALIZATION_FACTOR = 2.0` cap. The raw factor is computed
as before but clamped via `Math.min(rawFactor, 2.0)`. This still allows
meaningful redistribution while preventing over-amplification.

---

## Fix #12 [MEDIUM] — Standardize error handling in markov-mail

**Repo:** markov-mail
**Files:** `src/errors.ts` (new), `src/routes/admin.ts`, `src/middleware/fraud-detection.ts`, `src/index.ts`

**Problem:** markov-mail had no error class hierarchy, no centralized error
handler, 8+ different response shapes, and leaked raw `error.message` to clients
in ~15 locations. This exposed internal details (DB error text, file paths,
stack traces) and made client-side error handling unreliable due to inconsistent
response formats.

**Fixes:**
1. Created `src/errors.ts` with error class hierarchy (`AppError`,
   `ValidationError`, `AuthError`, `ServiceUnavailableError`, `DatabaseError`)
   mirroring forminator's structure.
2. Added centralized `handleError(error, c)` that:
   - Never exposes raw `error.message` to clients
   - Uses `userMessage` for client-facing responses
   - Logs full error details server-side
   - Returns consistent `{ error, message }` JSON shape
3. Replaced all 15 `error.message` leaks in `admin.ts` with `handleError`.
4. Fixed body parse error leak in fraud-detection middleware.
5. Standardized `/validate` endpoint error responses to `{ error, message }`.

---

## Fix #14 [LOW] — Consolidate duplicate UNION ALL queries

**Repo:** forminator
**Files:** `src/lib/ja4-fraud-detection.ts`, `src/lib/database.ts`

**Problem:**
1. `analyzeJA4Clustering` and `analyzeJA4GlobalClustering` executed
   character-for-character identical SQL queries (UNION ALL of submissions +
   turnstile_validations). Layer 4a (1h window) and Layer 4c (1h window) hit
   the database with the exact same query.
2. `getRecentBlockedValidations` and `exportDetectionEvents` shared ~90% of
   their UNION ALL query structure with minor column alias differences.

**Fixes:**
1. **JA4 queries:** Extracted `queryJA4Activity(ja4, db, windowMinutes)` as a
   shared query function and `buildClusteringAnalysis` for result processing.
   `analyzeJA4Clustering` and `analyzeJA4GlobalClustering` are now synchronous
   functions that operate on pre-fetched rows. `collectJA4Signals` fetches once
   with the largest window, then filters in JavaScript for shorter windows.
   This reduces 3 identical DB queries to 1.
2. **Analytics queries:** Extracted `buildBlockedEventsQuery(tsAlias, filters)`
   as a shared SQL builder. Both `getRecentBlockedValidations` and
   `exportDetectionEvents` use it, eliminating ~50 lines of duplicated SQL.

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
