---
name: validating-empirically
description: "Use when research (docs, web, reasoning, a subagent) produced a load-bearing claim about how an EXTERNAL system behaves at runtime and you are about to assert it, write it into a design note, or implement against it. Fires on 'per the docs, X does Y' about a third-party system, on calling a doc-read 'verified' or 'definitive', and when the claim is cheaply testable on disposable infra. NOT for your own code (verification-before-completion), recalled facts (epistemics), or PoV packaging (sa-pov)."
---

# Validating Empirically

## Overview

Documentation describes *intended* behaviour. The thing that bites you is the config
interaction, version-specific default, or edge case the docs never mention. A load-bearing
claim about how someone else's system behaves is a hypothesis until you have run it.

**Core principle: prove it live before you assert it.** When a claim about an external
system's runtime behaviour drives a decision or an implementation, and it is cheaply testable
on disposable infrastructure, spin up a scratch environment, run the exact flow, capture the
evidence, tear it down. A note that says "here is the output" is worth more than one that says
"per the docs, this should work."

This is one of three sibling disciplines: `verification-before-completion` proves your
OWN work, `epistemics` covers recalled FACTS (versions, flags, paths), and this skill covers
an EXTERNAL system's runtime behaviour. `sa-pov` packages a live validation as a customer
deliverable; this skill is the internal, no-deliverable reflex for research findings.

## The Iron Law

```
A DOC-DERIVED CLAIM ABOUT EXTERNAL BEHAVIOUR IS UNVERIFIED UNTIL RUN.
Do not launder a doc-read into "verified", "definitive", or "empirically proven".
```

If you have not run it, the honest label is `doc-cited-not-tested`, not `verified`.

## The three-gate trigger

Run the claim through these. All three "yes" -> validate live before asserting.
Any "no" -> label it honestly and move on (do NOT spin up infra).

1. **External?** Is the claim about a third-party / external system's actual runtime
   behaviour - not your own code, and not a settled spec fact you can cite exactly?
2. **Load-bearing?** Does a decision, an implementation, or a written assertion rest on it
   being true? (If it is idle trivia, skip.)
3. **Cheaply testable?** Is there a throwaway / disposable path to exercise it - a scratch
   project, a branch DB, a local container, an admin API on a test tenant - that is cheap and
   non-destructive relative to the stakes?

If you cannot test it (no disposable path, or the test is expensive/destructive and the stakes
are low), that is a legitimate stop: write `doc-cited-not-tested` and name what you would run.

## Claim labelling (say which one you mean)

The label table lives in the `epistemics` skill ("Labels"); use those exact words. The bar
this skill sets is `empirically-proven`: you ran it this session and pasted the output.
Anything less is `doc-verified` or `doc-cited-not-tested`. The `epistemic-guard` extension
accepts `doc-cited-not-tested` written next to a claim as a valid hedge label (hedge regex in
`~/.pi/agent/extensions/lib/epistemic-guard-core.ts`), so the honest label also clears the
write gate.

Mixing `doc-verified` up as `empirically-proven` in a commit message or a customer doc is the
exact overclaim this skill exists to stop.

## Validation playbook (when gates say yes)

1. **Parity.** Create the scratch environment in the region / tier / plan / version that
   actually matters, so the result transfers. A test in the wrong config proves nothing.
2. **Real fixtures, not reimplementations.** Exercise the real system with real inputs.
   Generating your own fixture with the same library you are testing, then checking it agrees
   with itself, proves nothing - use the genuine artifact (e.g. a hash produced by the actual
   upstream tool, a dump from the real source DB).
3. **Assert the specific claim, not a vibe.** Target the exact behaviour in question
   (the negative test, the propagation window, the edge case). Paste the real output.
4. **Provisioned != propagated.** Wait/poll for the observable (DNS, JWKS, cache, cert), not
   the API 200. Document the window.
5. **Isolate side effects.** Prefer admin/provisioning paths that do not trip rate limits or
   send real notifications.
6. **Tear down + scrub.** Scratch environments are billable and a data-hygiene risk. Delete
   them and remove keys/dumps/refs from disk. Keep scratch identifiers out of version control.

## Red flags - STOP and run the three-gate trigger

- Writing "per the docs, X does Y" / "the docs are definitive" / "I have a definitive answer"
  about a third-party system's runtime behaviour.
- About to label a doc-read as "verified" or "empirically verified".
- Recommending an implementation this afternoon whose correctness hinges on an untested
  external-behaviour assumption.
- The claim is an **absolute or a negative** ("X will not work", "the cap is fixed", "it is
  not replicated") - absolutes from docs are exactly what a five-minute live test overturns.
- You have API/admin access and the test is cheap, and you are skipping it anyway.

## Rationalizations

| Excuse | Reality |
| --- | --- |
| "I have a definitive answer from the docs." | Docs are intent, not runtime. Definitive = you ran it. |
| "It's in the official docs, that's verified." | `doc-verified` != `empirically-proven`. Label it correctly. |
| "The team is on a deadline, no time to test." | A scratch project + one flow is minutes; a wrong cutover is hours. Systematic beats a bad ship. |
| "It's obviously how it works." | The config-interaction trap makes "obvious" false in the real build. |
| "I doc-checked it, close enough to test." | Close enough is how the overclaim gets written. Run it or flag it. |
| "No disposable env handy." | Then the label is `doc-cited-not-tested` and you name the test - not silent assertion. |
| "I generated a fixture and it verified." | If the fixture came from the tool under test, you proved self-consistency, not correctness. |

## When NOT to use

- The claim is about **your own code** -> `verification-before-completion`.
- The claim is a **recalled fact** (a version, flag, path, citation) rather than runtime
  behaviour -> `epistemics` (one tool call verifies it; no infra needed).
- It is a **customer PoV/PoC deliverable** -> load `sa-pov` (this reflex + packaging).
- A doc genuinely settles it AND it is not load-bearing (a flag name, a documented default you
  can read). Do not spin up infra to confirm trivia - that is the annoying failure mode.
- Root-causing a bug that already reproduces -> `systematic-debugging`.

## Real-world impact

Live validation has repeatedly overturned confident doc/reasoning claims that would have
shipped:

- ASP.NET Identity V3 assumed PBKDF2-HMAC-SHA256; the real hash decoded to SHA-512/100k.
- A Cloudflare Durable Object hibernation/staleness claim was proven wrong by running it.
- A `sb_*` key was found to be silently ignored by Supabase Realtime (needs a JWT).
- A commit that claimed "verified empirically" was caught as only doc-checked and corrected.
- A `--size` provisioning flag was proven real (billing evidence), not cosmetic.

## Related skills

`verification-before-completion` (own-work claims), `epistemics` (recalled specifics and the
shared label table), `sa-pov` (customer packaging of a live validation), `systematic-debugging`
(post-reproduction root cause). Pair with the relevant
product skill (`supabase`, `cloudflare-ops`, `fly`, `terraform`, ...) for the technical depth of
the thing under test.
