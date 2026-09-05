---
name: open-ended-research
description: "Use when a research task's answer is a SET of candidates to be narrowed rather than a single lookup - comparing or buying products, picking vendors/services/tools, visa or relocation options, scouting locations, 'what are my options', 'alternatives to X', 'best X for Y', 'should I buy'. Also fires on 'tunnel visioning' or 'are there no other options?' mid-task. NOT for single-answer lookups (just look it up) or the search/crawl/OSINT tooling itself (research)."
---

# Open-ended research: don't take the first answer

## Overview

A bad researcher takes the first plausible answer and spends the rest of the
task confirming it. The mechanical failure: once a candidate is named, every
follow-up query becomes `"<candidate> review"` instead of
`"alternatives to <candidate>"`, negatives get skimmed past, and user pushback
gets treated as a challenge to defend against instead of evidence the search
was too narrow. The output then reads as a verdict with citations, not a
survey.

This skill is the protocol that prevents it. It applies to any question whose
answer is a *set to be narrowed*: products, vendors, services, visa routes,
locations, tools. A lookup question ("what port does X use") has one answer -
look it up, done. If you catch yourself three queries deep into one candidate
before you have a longlist, you are already in the failure mode.

The second failure mode is epistemic: prices, stock, availability, specs and
"is it still sold" are perishable, and training memory serves them stale with
full confidence. The `epistemics` skill owns the general rule; the purchase
section below has the purchase-specific routing.

## The Iron Law

```
BREADTH BEFORE DEPTH. ELIMINATE, DON'T SELECT. DEFEND NOTHING.
```

- **Breadth before depth** - map the candidate space before researching any
  candidate in it. The first hit is a lead, not a conclusion.
- **Eliminate, don't select** - cutting options against constraints is
  structurally broad; picking a favourite and justifying it is structurally
  narrow. Tunnel vision is selection-first.
- **Defend nothing** - you own no candidate. User pushback is never a debate
  to win; it is a signal about the search.

## The protocol

### 0. Constraint sheet

Write down the hard constraints FIRST, in the reply, so they anchor everything
after: budget, geography/shipping, must-haves, deal-breakers, deadline. Ask
the user for the ones you can't infer. A survey without constraints has no
elimination step, which means it degenerates into vibes - the exact failure
this protocol exists to prevent.

### 1. Breadth pass - map the space, name nothing

Queries at this stage are GENERIC - category, market, year. No candidate names
in the query string: `"<candidate> alternatives"` and `"<candidate> review"`
are depth queries and are banned until the longlist exists.

Vary the query FAMILY, not just the wording - a second engine saying the same
thing is not breadth:

- category surveys: "best <category> <year>", "<category> comparison"
- community: "<category> reddit recommendations", "<category> forum"
- marketplaces/retailers: browse the category page (Shopee/Lazada/Amazon SG
  for purchases), not a product page
- for non-purchase surveys (visa routes, vendors): the official/primary
  source's own enumeration of the options
- curator hunt: for location/category surveys, search for ONE creator who
  systematically reviews every candidate with a consistent rubric -
  `site:lemon8-app.com <category> review`, a YouTube channel, a blogger
  with a per-location series. One curator with a fixed rubric beats 20
  scattered reviews because the rubric makes candidates directly
  comparable (a single Lemon8 creator's per-outlet gym reviews once
  out-valued all scattered sources combined).

Use the `research` stack (SearXNG multi-engine, crawler for JS-heavy pages)
or `web_research`; SearXNG's engine diversity is itself breadth.

Output: a **longlist of 8-12 candidates**, one line each with source. Fewer
than ~5 means you haven't mapped the space - keep going with a different query
family.

### 2. Elimination pass

Score the longlist against the constraint sheet. Cut to a shortlist of 3-5,
and record WHY each cut was made ("fails budget", "no SG shipping", "misses
must-have X"). The cut-list is part of the deliverable - it's the proof the
survey was wide, and it's what lets the user rescue a wrongly-cut option.

### 3. Adversarial pass per finalist

For EACH shortlist entry, actively hunt disconfirming evidence:

- "<name> problems", "<name> issues reddit", "<name> vs <rival> complaints"
- "<name> failure / broke / warranty / return"
- staleness: is this the current model/version/offer, or last year's?

If the adversarial pass for one candidate turns up glowing results only,
distrust the search, not the product - try a different community or engine.

### 4. Matrix with per-cell provenance

Rows = finalists, columns = the constraints + price + key caveats. Every load-
bearing cell carries its source URL and an as-of date. No cell from memory -
recalled specifics route through the `epistemics` rules (and the
`epistemic-guard` now flags bare prices, so unverified amounts literally block
writes).

### 5. Present options, not a verdict

Show the matrix, state which constraint each survivor wins on, and let the
user pick. If you do recommend: steelman the runner-up in two lines and name
the concrete condition that would flip the pick ("if you need X, take Y
instead"). A recommendation with no named flip-condition is a verdict in
disguise.

## Research subagents

Parallel dispatch by source family works well (e.g. one subagent on
Reddit/community sources, one on blogs/retailers) - it keeps raw search
noise out of your context. Two rules learned the hard way:

- Every research-subagent prompt MUST end with: "Do NOT dispatch further
  subagents - execute the searches yourself. Your final message must
  contain the findings, not a plan." Without it a subagent has returned
  "I'll dispatch 5 parallel research subagents" as its final message and
  exited - pure plan, zero work.
- When the corpus is large, ask each subagent to leave a raw-dump
  artifact (sources + snippets written to a file); it doubles as
  provenance for the matrix.

## Pushback = widen, never defend

"Are there no other options?" / "we're tunnel visioning" / "what about <brand
you never mentioned>" means the BREADTH pass failed, not that the candidate is
wrong. The response is to widen:

1. Re-run breadth with a NEW query family (different engine set, a different
   community, marketplace category browse instead of search).
2. Report the DELTA: "the re-sweep added A, B, C; here's how they fare
   against the constraints."
3. If the delta is empty, say that plainly and show the queries you ran - that
   is the honest proof of exhaustiveness.

What you never do: re-justify the existing shortlist more loudly.

## Purchases: perishables and availability

Everything above, plus the claims that rot fastest:

| Claim | Route |
| --- | --- |
| Price, stock, "ships to X" | Fetch the retailer/listing page THIS session (`webfetch` / research crawler `:8889/extract` with `force_js:true` for SPAs). Cite URL + as-of date. Prices perish weekly. |
| Exact model number / SKU / spec figure | Manufacturer's page, not a review snippet. |
| "Discontinued / no longer sold" | Evidence this session: retailer 404, a discontinued notice, or `archive_lookup` on the old listing. Never memory. |
| Local availability (SG) | Check the actual local storefronts (Shopee SG / Lazada SG / Amazon SG / local retailers). "Ships to SG" is verified on the listing, not assumed. |

## Rationalizations

| Excuse | Reality |
| --- | --- |
| "This one is obviously the best, no point listing others." | That's the failure describing itself. The user asked for a survey; the longlist IS the deliverable. |
| "The first result is from a reputable source." | One source is one sample. Reputable sources disagree; that disagreement is the information. |
| "More searching wastes time." | The user has re-asked 'any other options?' in enough past sessions to price the shortcut. |
| "The user seems to like the current pick." | Liking is not a constraint. The matrix lets them choose with eyes open. |
| "I'll just re-run the same search to double-check." | Same queries, same results. Widen the FAMILY: other engines, other communities, category browse. |
| "The negative reviews are probably outliers." | Your job in the adversarial pass is to find them, not to judge them away. |

## Red flags - stop and re-broaden

- Three or more queries in a row naming the same candidate.
- A "recommendation" forming before a longlist exists.
- The words "the best option is" with no comparison table behind them.
- Defending a candidate in your head while reading the user's objection.
- A price, spec, or availability claim you can't point to a fetch for.

## Related

- `research` - the tooling layer: SearXNG `:8888`, crawler `:8889`, OSINT
  `:8890`, and the pi `web_research` / `webfetch` / `archive_lookup` tools.
- `epistemics` - the recalled-vs-verified rule for every specific (and the
  `epistemic-guard` extension that enforces it on writes).
- `validating-empirically` - when a load-bearing claim about a system is
  cheaply testable, test it instead of citing docs.
