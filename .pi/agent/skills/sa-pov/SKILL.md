---
name: sa-pov
description: Use when running a Solutions-Architect Proof-of-Value (PoV) or Proof-of-Concept (PoC) for a prospect/customer on ANY product - scoping and negotiating success criteria, writing a customer-facing kickoff doc, validating each criterion live on a throwaway environment (not asserting it from docs), producing a solution runbook with real test evidence, and packaging the deliverable for how the customer consumes it (usually Google Docs). Product-agnostic methodology; pair with the relevant product skill (`supabase`, `cloudflare`, `fly`, etc.) for the technical depth of the thing under test. Fires on "PoV", "PoC", "proof of value/concept", "kickoff doc", "success criteria", "solution runbook", "customer evaluation".
---

# sa-pov - Solutions-Architect Proof-of-Value / Proof-of-Concept engagements

## Overview

Running a PoV/PoC as a Solutions Architect: turn a customer's success-criteria list into
(1) a customer-facing kickoff doc, (2) a solution runbook where **every criterion is proven
live on a throwaway environment**, not asserted from docs, and (3) a single deliverable
packaged for how the customer actually consumes it (usually Google Docs).

**Core principle: validate, then write.** Spin up a scratch environment, run the flow,
capture the evidence, tear it down. A runbook that says "this works, here is the exact
output" closes evaluations; one that says "per the docs, this should work" does not.

This skill is the **methodology + packaging**. For the technical depth of whatever is under
test, pair it with the product skill (`supabase`, `cloudflare`, `fly`, `terraform`, ...).

## Deliverables (three artifacts)

1. **Kickoff doc** - customer-facing scope/criteria/timeline/roles/risks. Template:
   `harness/pov-kickoff-template.md` (this skill). Criteria table + per-criterion links to
   the vendor's real, HTTP-200-verified doc pages.
2. **Solution runbook** - per-criterion how-to with working code and pasted live test
   evidence, plus a "gotchas found while validating" section. This is the differentiator -
   it proves the criteria on the customer's actual shape, not in the abstract.
3. **Combined doc** - kickoff (body) + runbook (Appendix A) merged into ONE markdown file
   for a single Google Docs handoff. See Packaging below.

## Live validation methodology

1. **Environment parity** - create the scratch environment in the customer's target region /
   tier / plan so latency, residency, and plan-gating claims actually transfer. A PoV run on
   a free tier in the wrong region proves nothing about the paid tier in the right one.
2. **Provision programmatically** where the vendor exposes an API (project/tenant creation,
   config, teardown). Poll to a healthy/ready state before testing; scripted setup is
   repeatable and cite-able in the runbook.
3. **Isolate side effects.** Prefer admin/provisioning paths that don't trip
   rate limits or send real notifications (email/SMS caps, webhooks). Prove enforcement
   (e.g. "unconfirmed sign-in is rejected") from config + a targeted negative test, not by
   burning a live quota mid-suite.
4. **Separate programmatically-provable from human-in-the-loop.** Most criteria are fully
   scriptable. Some (a real IdP SSO assertion, a hardware step, a third-party approval) need
   a human at the far end - prove those up to the boundary you control (e.g. redirect reaches
   the IdP login page) and finish them live during the PoV with the customer present.
5. **Tear down.** Scratch environments are usually billable and always a data-hygiene risk;
   delete once evidence is captured. Never leave keys/dumps on disk.

## PoV gotchas (product-agnostic)

| Gotcha | Fix |
| --- | --- |
| **"Works per the docs" is not evidence.** The failure that bites the customer is almost always a config interaction (permissions, defaults that fail open, ordering) invisible in the docs. | Run it. Paste the real output into the runbook. If you can't run it, say so explicitly and mark it human-in-the-loop. |
| **Plan/tier gating discovered late.** A criterion needs a plan the customer isn't on; found on readout day. | Enumerate plan/tier requirements per criterion at scoping; confirm the org's plan before promising anything gated. |
| **Rate/throttle limits on setup APIs** (key rotation, email send, project create) stall a scripted suite with opaque "wait until <ts>" errors. | Budget for them; don't tight-loop retry; note them in the runbook so the customer's own automation accounts for them. |
| **Provisioned != propagated.** A resource returns `created` but the change (DNS, JWKS/cert discovery, cache) hasn't reached the edge yet, so an immediate test fails spuriously. | Wait/poll for the observable, not the API 200. Document the propagation window. |
| **Region/residency mismatch** silently invalidates latency + data-residency claims. | Create the scratch env in the customer's actual target region. |
| **Scratch env left running** (billable) or its keys left on disk (exposure). | Teardown is a checklist item, not an afterthought. Delete keys after capture. |

## Packaging for Google Docs (hard-won)

- **Markdown CANNOT create Google Docs internal jump links.** `[text](#anchor)` becomes a
  dead *web* link on both paste and import. Do NOT ship `#slug` cross-links in a gdocs
  deliverable. Use plain-text cross-refs ("Appendix A #6") + tell the customer to use
  **View > Show outline** or **Insert > Table of contents** (Google auto-wires those).
- **Absolute `https://...` links DO work** on paste/import - keep those.
- **Paste vs import:** "Paste from Markdown" supports headings, bold/italic, tables, external
  links. Importing the `.md` (File > Open > Upload) uses a fuller converter. Neither resolves
  internal anchors.
- **Combine** kickoff + runbook into one file: append the runbook as `## Appendix A`, demote
  its headings one level (`##`->`###`, `###`->`####`), strip any `<a id>` anchors (gdocs
  ignores HTML). One file = one clean paste.
- **ASCII punctuation only** (no em-dash/smart-quotes/ellipsis) - survives non-UTF-8 paste.
- **Verify every external doc URL** (`curl -s -o /dev/null -w '%{http_code}' -L <url>` == 200)
  before shipping - vendors reorganize doc slugs.

## Confidentiality + safety

- Customer names, the vendor-customer relationship, internal deal codenames, and named
  individuals are **confidential**. Keep PoV docs in a **private** repo. Use generic
  scratch-environment names (`<slug>-pov-test`), never the customer's real identifiers.
- Never commit credentials (API keys, tokens, service secrets). Delete local key dumps after
  teardown.
- Always **tear down** the scratch environment - it is billable and holds test data.

## Common mistakes

- Asserting a criterion "works per docs" without running it - the config-interaction trap
  will make that claim false in the customer's own build.
- Shipping `#anchor` cross-links into Google Docs (they render as dead web links).
- Leaving the scratch environment running (billable) or its keys on disk.
- Tripping a rate/quota limit (email, key rotation) mid-suite because setup used live paths.
- Promising a plan-gated feature on a tier the customer's org isn't on.

## Related skills

Pair with the product skill for the technical depth of the thing under test - `supabase`
(and `sbperf` / `sbshift` for its perf/migration angles), `cloudflare`, `fly`, `terraform`,
etc. Also `paste-formatting` (mdclip for non-gdocs rich-text targets) and `erfi-voice`
(customer-facing prose).
