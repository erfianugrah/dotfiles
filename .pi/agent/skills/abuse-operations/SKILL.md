---
name: abuse-operations
description: Use when designing, building, or operating any anti-abuse / fraud-detection system — defending a free tier, signup flow, public form, upload endpoint, API, or "run-someone's-code" platform against spam, phishing, cryptomining, multi-account farming, fake reviews, credential harvesting, DDoS staging, or other monetization-of-free abuse. Fires when reasoning about risk scoring, indicator/signal design, blacklists, account bans, false-positive handling, actor tracking, campaign/pivot detection, or "is this activity abusive and what do we do about it". Pairs with `software-architecture` (system shape) and the fraud-detection project's scoring engine. Not for traditional vuln/exploit security (that's appsec) except the post-exploitation handoff.
---

# Abuse Operations — hunting wolves in sheep's clothing

Anti-abuse is the *twilight zone* of infosec: not red team, not blue team, not anti-fraud, not SRE — it overlaps all of them. This skill encodes a working framework for detecting and stopping **abuse**, defined as:

> **Abuse is the unintended monetization of anything.**

If you offer a free service, free trial, or any surface with an angle to extract value, someone is already trying to make money off it. The line between "a business getting off the ground" and "an abuser taking advantage" is thin and only resolvable *after the fact* by establishing **intent**.

Sources: Heroku abuse-ops (Cureton & Stojanovic, Black Hat) + the "Facets of Abuse / First Principles" doctrine. The fraud-detection project (`~/fraud-detection/forminator`) is the canonical local instantiation — its `src/lib/scoring.ts` is the per-submission scorer; this skill is the operating model around it.

## When to use

- Designing detection for a free tier / signup / form / upload / API / compute platform
- Choosing what signals to collect and how to combine them
- Deciding whether to auto-block, review, watch, or allow
- Handling banned actors who keep coming back
- Tracking an abuse *campaign* across many accounts/submissions
- Pushing back on "just block everything risky" (false-positive cost) or "we can predict bad actors" (pre-crime trap)

**Not for:** patching the vulnerability itself (that's appsec/eng). Abuse-ops cares about what happens *after* a compromise and whether other users tried the same thing.

## The three facets of abuse (easy → hard for the attacker)

```
Easy <───────────────────────────────────────────> Hard
Abuse In Place  <──>  Abuse of Business Logic  <──>  Abuse Post-Exploitation
```

| Facet | What it is | Example | Effort |
|---|---|---|---|
| **In place** | Using the service exactly as designed, for harm | Email service → phishing; hosting → malware landing pages; form → spam/lead poisoning | Little |
| **Business logic** | Exploiting gates implemented wrong + limits not enforced | Register N accounts to aggregate free quota instead of paying; mass-invite as a spam vector | Some (needs automation) |
| **Post-exploitation** | Abuse after exploiting a real vuln; ATO | Account takeover → cryptomining / outbound phishing / ransomware | A lot |

**Gate** = an action a user performs to unlock a function (verify email, add a card). **Limit** = a bound the tier imposes (vCPUs, monthly transfer). Abuse-of-business-logic is gates done wrong + limits not enforced.

⚠️ The difficulty ladder **only holds if** systems are reasonably hardened and custom code follows a security-aware SDLC. If exploitation is trivially easy, the ladder collapses.

## Aspects of intent (the *why* — use as a labelling taxonomy)

A single submission/account usually carries several. Tag detections by aspect — it routes, prioritizes, and explains far better than a lone 0–100 score:

- **Monetisation & rewards** — illicit money, or avoiding payment (multi-account quota farming, near-depleted prepaid cards, free swag/coupons)
- **Weaponisation** — service becomes malicious infrastructure (DDoS zombie, C2, phishing-loot backend DB)
- **Mis/disinformation** — false info (Mis = Mistake) vs deliberately misleading (Dis = Deliberate); impersonation, propaganda
- **Victimisation** — attacking *individuals*: doxing, sextortion, revenge porn, cyberbullying ("it's just a prank, bro")
- **Disruption** — chaos: flooding, defacement, resource exhaustion, edit-then-spotlight-the-upvoters
- **Reputation manipulation** — gaming karma/likes/stars/followers/verified status; black-hat SEO; "bragging rights" defacement/DDoS claims

The list is intentionally vague and **not exhaustive** — add a facet if it helps tool an actor's intent.

## The hunt loop (operational core)

Individual signals are deliberately **low-value** — none proves intent alone. Their *collection* becomes a strong signature.

```
suspicious indicator (high-CPU alarm, abuse report, artifact)
   → form a hypothesis about INTENT
   → "what else you got?" — gather corroborating indicators (internal + external)
   → establish intent → DECIDE → ACT (suspend / collect / delete  OR  watchlist / allowlist / ticket / FP-adjust)
   → investigate RETROACTIVELY for stragglers + missed indicators
   → distil into a FOOTPRINT → AUTOMATE collection+detection+action
   → log the action (answers "have we seen this before?")
   → repeat
```

Undetermined intent ≠ bad. Not-enough-indicators → back in the pool, reassessed when a new alert percolates it up. **Is it good, or just not-bad-yet?** Analyst discretion lives here.

### Footprint, not fingerprint
A **footprint** = a collection of indicators identifying a *campaign*. The word is deliberate: "fingerprint/profile" implies one unique human. A footprint may be one person, a bot, several specialized groups, or any combination. Individually weak indicators (face-rolled email, throwaway app name, Tor exit at signup, fraud-card sequence) become a strong footprint together.

> Face-rolled = made by hand (keyboard mashing); random = made by computer. A face-rolled email *plus* face-rolled app names *plus* failed card attempts landing on a card a known bad actor used = scrutiny-worthy.

### Threshold bands (N-of-M) — the key pattern Forminator is missing
For a footprint of M indicators, match the observed N:

| Match | Band | Action |
|---|---|---|
| **N = M** (e.g. 5/5) | full | **auto-action** |
| **floor ≤ N < M** (e.g. 3–4/5) | **pivot** | manual review → update footprint with the novel indicators |
| **N < floor** | none | back in the pool |

This is implemented in `footprint.ts` (this directory) as a zero-dep reference. Wire it in front of / alongside a weighted scorer: the **score** answers *how bad*; the **footprint** answers *which known campaign, and is this a pivot?*

### Actor evolution
- **Pivot** — returning actor changes one TTP at a time (they isolate variables to find what got them caught). Partial footprint match = pivot. Re-add the changed indicator → footprint stays current → cut them off before profit.
- **Splash** — multiple partial footprints at once = multiple actors sharing TTPs (same forum kit / YouTube tutorial). Find the *source* and pre-empt.
- **Retool** — actor rebuilds everything → indistinguishable from a new actor. **So what?** The only reason to link old↔new is law enforcement evidence (rare). Let retooled actors be new actors; thorough indicator collection re-catches them anyway.

## Strategy: go slow to go fast

| | Quicker response | Slower / study first |
|---|---|---|
| Pro | easier, less damage window | better situational awareness, accurate footprint |
| Con | false positives | actor stays active longer |

Switch deliberately. Going slow *first* lets you act fast *later* with accuracy. At cold-start you go fast just to surface; once footprints mature, automation lets you go fast *and* accurate.

## Endgame: demotivation > detection

Whack-a-mole is unsustainable and burns the team out. The business really wants the problem to *go away* — achieved by **devaluing loot** and **demotivating actors**, not infinite actioning:

- Devalue loot: report/reset stolen creds; cap CPU so mining yields nothing → kill ROI
- Notify the *other* providers in a distributed kit (front-end / back-end / distribution often span 3 services)
- Push left: feed business-logic gaps to engineering → harden the platform so it's too much trouble to abuse
- **Break spirits, not code.** Abuse is a *people* problem.

## Three guiding philosophies

1. **Relentless incrementalism** — break the problem into shippable steps; move fast and fix things.
2. **Non-repetition** — never see the same abuse pattern twice (the closest thing to prevention). Hard, but the goal.
3. **Hyperautomation** — every click is toil. Tools talk to tools (including the ticket system). Build detection *chains*, not just rules. Put the right info in front of an analyst.

> Got far on `sort` + basic SQL + descriptive stats long before any ML. Don't over-engineer the model before the fundamentals work.

## First principles (operating rules)

1. **To determine abuse you must determine intent** — does it violate law / ToS / AUP? How was it performed? Good faith?
2. **Intent can only be determined after the fact** — no pre-crime. BUT the abuse only has to have happened *once anywhere on the Internet* — externally-observed indicators (disposable email, known-bad IP, bulk/automated speed, return of a known actor) are fair to act on pre-emptively.
3. **Act as soon as *feasible*** after the actor "declares" intent (not as soon as *possible* — tactical/legal reasons may delay). The declaring act (e.g. malicious upload) is the trigger; blocking the download is the response.
4. **Malicious actors must not repeat with the same tooling** — tear down infra, make rebuild require exceptional effort; coordinate across providers.
5. **Banned actors must not return** — track return indicators even with no fresh abuse. ⚠️ Implication: you **cannot fully delete** actor data — it's needed to detect return (tension with #8).
6. **Evidence collection minimizes third-party impact** — to gather *criminal* (not just malicious) evidence you may let activity run; if you can't minimize impact, stopping wins.
7. **Outbound == inbound** — stopping outbound attacks protects reputation, partnerships, the desire of other services to protect yours, and the Internet. A flagged submission may make *you* the outbound infrastructure → notify downstream.
8. **Actions as non-destructive as possible** — FP rate is never zero. Soft-delete, reversible, appealable. (Escalating timeouts are inherently reversible — good.)
9. **All actions must be codifiable** — change state via a *command* that logs + guards, never a manual DB edit. Consistent, auditable, safeguarded, fast. Analysts analyze; tools execute.

## Quick reference

| Question | Answer |
|---|---|
| What is abuse? | Unintended monetization of anything |
| Can I block predicted bad actors? | No (pre-crime) — unless the indicator was seen abusive elsewhere first |
| One signal enough? | Almost never — collect a footprint |
| 5/5 footprint? | Auto-action |
| 3–4/5 footprint? | Pivot → review + update footprint |
| Actor retooled fully? | Treat as new actor; "so what?" |
| Default delete behavior? | Soft-delete (reversible); never purge return-detection data |
| How to change account state? | Codified command (logged, guarded), never manual DB edit |
| Endgame? | Devalue loot + demotivate, not infinite whack-a-mole |

## Common mistakes

- **Pre-crime**: scoring "this looks like it *will* be bad" and banning. Anchor on intent *declared* or *seen-elsewhere* indicators.
- **Single-signal blocks**: brittle + high FP. Require corroboration (Forminator's corroboration bonus + this skill's N-of-M).
- **Hard-delete on ban**: destroys the data you need to detect their return (#5) and is irreversible on a false positive (#8).
- **Manual DB edits to suspend**: unlogged, unguarded, unrepeatable (#9).
- **Ignoring outbound**: "it's not attacking *us*" — yes it is, via your reputation (#7).
- **Over-modeling early**: reaching for ML before `sort`/SQL/descriptive stats expose the indicators.
- **Whack-a-mole as the plan**: detection without devaluation/demotivation never ends.

## Files

- `footprint.ts` — zero-dependency reference: `matchFootprint`, `matchAll`, `detectSplash`, `suggestFootprintUpdate`. Framework-agnostic; adapt into any scorer. Forminator's copy lives at `forminator/src/lib/footprint.ts` with `tests/footprint.spec.ts`.
