---
name: lab-writeup
description: Use when turning a supabase-lab run into prose - a RUNLOG section, an AGENTS.md key-facts block, a README entry, or a lexicanum reference or guide - and before committing or publishing any of them. Fires when a run has finished and numbers are about to be written down, when a reviewer's findings on a lab write-up arrive, and when a page is about to be pushed to erfi.dev. Not for designing or running the experiment (validating-empirically) or for voice and register (erfi-voice).
---

# Lab write-up

## Overview

A lab run produces a JSON artifact with every number in it. The write-up is
where those numbers get wrong: three independent review passes on the
2026-09-02 pages (Edge Function limits, Auth end to end) found about a hundred
defects, and nearly all fell into a dozen classes that recur. This skill is
those classes as a checklist, the order to work in so they do not arise, and
the reviewer brief to run before publishing.

The disposition: a number travels from the artifact to the page by paste, a
measured row names what it measured, and anything the run did not do is
written as not done.

## Order of work

1. **Render, do not recall.** `pvlab --facts evidence/<ts>/run-<stamp>.json
   --only EF08,EF09` prints each result's measurements as a table. Quote from
   it. If a figure is not in the artifact, it is not a measurement.
2. **Publish the evidence** with `make publish-evidence RUN=...` in the
   experiment (writes a redacted copy and its facts to `out/<date>/`). RUNLOG
   and docs cite `out/`, pinned to the lab commit, never `evidence/` (gitignored)
   and never `/tree/main/`.
3. **Write the RUNLOG first**, then AGENTS.md, README, then the docs page. Each
   downstream file quotes the one above it; nothing is retyped from memory.
   `bun harness/scripts/check-doc-numbers.ts <doc> out/<date>/*.json` lists
   the numbers on measured lines that no artifact contains; a documented figure
   or a derived percentage is fine there, a retyped measurement is the bug.
4. **Run the sweeps** (below), then **the reviewer brief** as a subagent with
   the diff of the files you touched, then fix everything it finds before the
   commit. Expect 10 to 30 findings on a new page; zero is a sign the brief was
   too narrow.
5. **After deploy, check live**: status, footnote count, no literal `[^`, no
   KaTeX spans, the new sentences present, and the leak sweep against the live
   HTML.

## The ambiguity classes (the checklist)

Read every measured sentence against these. Each one cost a review round.

- **Which side.** Managed vs self-hosted GoTrue; PostgREST vs GoTrue as the
  verifier; API deploy vs CLI deploy; plain mode vs JWKS mode. "GoTrue accepts
  it" in a doc with two GoTrues names neither.
- **Which key.** ES256 signing key, legacy HS256 signing key, legacy anon or
  service_role API key (HS256 JWTs), `sb_publishable_` / `sb_secret_`, an
  Edge Function secret. "Revoking the legacy key" collides two of these.
- **Which project, which run.** Several throwaway projects in a day: number
  them and tie each figure to one. "the two earlier projects" with two numbers
  and no mapping is a guess for the reader.
- **Denominator and unit.** "10" is nothing; "10 of 24 functions" is a fact.
  "27 of 119,000 calls" mixed 13 outer refusals into a nested-only count.
  "1,800 chains per second" was nested calls per second.
- **Pass band vs measurement.** A test tolerance ("within 15 s") is not a
  result; the result was a 5 s tick. Quote the observation and, separately,
  the band the module passes on.
- **Docs figure vs measured figure.** "CPU >2 s answers 546" states a docs
  threshold as if probed; the probe was 500 ms pass, 3 s fail. Say which.
- **Inference vs measurement.** "the gateway matches the apikey by value" from
  one probe 10 s after a revoke, against a known 45 s propagation elsewhere,
  is one of two readings. Write both, and that the separating probe was not
  run.
- **"Earlier"/"later" without a date or run id.** A correction dated earlier
  than the paragraph it corrects reads inverted. Use dates and module ids.
- **One term for two things.** "key", "token", "cap", "limit", "secret",
  "legacy". Pick the full noun phrase where two meanings are in play.
- **Polarity.** "zero rows, no error" read as "tampering is harmless"; state
  what did not happen ("nothing noticed the substitution").
- **Cells that need another row.** "the same, with..." and "the second bleeds
  onto anon" cannot be read alone. Every cell stands on its own.
- **A single clean trial against a reported failure path** is "one trial,
  unproven", never reassurance.
- **The subject of "accepted".** "the public half was accepted by PostgREST"
  when the token signed with it was.
- **Scope claims.** "rules out slug collision" holds for these runs; say so.
- **Not run vs not re-run.** "not re-run here" implies an earlier run; if
  there was none, write "not run".
- **A docs figure's unit of account.** The wall clock is per worker in the
  docs; a single-request run does not test a shared warm worker. Say what the
  run's shape covers and what it does not.

## Sweeps before commit

Run all of these; keep the pattern list in a file so the shell guards do not
scan it.

- **ASCII**: `rg -n '[^\x00-\x7F]' <files>` must be empty (no em dashes, curly
  quotes, ellipsis characters).
- **Tells**: the lexicanum build gates the regex-able subset; for lab prose run
  the erfi-voice sweep list from a pattern file with `rg -f`.
- **Leaks**: nothing internal in a public repo. Ticket-style ids, chat or
  wiki links, org slugs, project refs (any 20-lowercase-letter token; the lab's
  `identifiers.test.ts` scans tracked markdown and `out/`), named individuals,
  customer or partner names, "internal", "playbook", private file names. The
  reviewer's own sources are not the page's sources: cite public docs, public
  issues, public commits, or say "reasoned, not measured".
- **Spelling**: British -ise in prose; product nouns keep the vendor's spelling
  (Supabase's "organization"), and one spelling per doc.
- **Contrast cadence**: "X, not Y" once is a distinction; several in a page is
  rhythm. Keep the ones that carry a real difference (throttle vs quota).

## The reviewer brief

Dispatch as a fresh subagent, read-only, with the file list or the `git show
HEAD` diff. Ask for exactly three sections and nothing else:

```
A. AMBIGUITY - for each: file:line, the exact quote, the two or more readings,
   a rewrite that keeps every number and identifier verbatim (ASCII, British
   -ise). Classes: pronoun with two antecedents; unclear side/verifier/key/
   project; number without unit or denominator; earlier/later without a date;
   one term for two things; polarity that can be misread; a cell that needs
   another row; a sentence that says the opposite of the evidence beside it.
B. LANGUAGE - only: non-ASCII punctuation, American -ize outside product nouns,
   sentence-initial However/Additionally/Moreover, the watchlist words, the
   importance-announcing phrases from the erfi-voice skill, "not X, it's Y"
   contrasts, decorative bold in short prose.
C. LEAKS - anything that looks internal: ticket-style ids, chat/wiki links,
   20-lowercase-letter tokens, people other than the author, customer or
   partner names, "internal", "playbook", private file names.
Order by severity: a reader acting on the wrong reading does damage first.
Say explicitly when a category is empty. End with a verdict per file.
```

Ask the reviewer to cross-check numbers against the published `out/` artifact
and the test source, not only against the prose. Apply findings by editing the
sentence, not by adding a caveat next to it.

## What a reviewer will ask you to check

Every external review that day ended with "check me on N". Answer each one
explicitly in the reply: which claims rest on a source the page cannot cite,
which observations were fetch artefacts (JSX stripped, diagram flattened,
smart quotes from the renderer), which points are inferences from docs wording
rather than measurements, and which the run cannot separate (per chain vs per
project; window vs per invocation). Those answers become the page's "Not
settled" text.

## Related

- `validating-empirically` - designing and running the probe.
- `erfi-voice` - the register and the structural tells.
- `epistemics` - provenance for every specific.
- lexicanum `AGENTS.md`, "Docs that publish measured numbers" - the house
  rules this skill's checklist feeds.
