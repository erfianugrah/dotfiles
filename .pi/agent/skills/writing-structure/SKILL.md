---
name: writing-structure
description: Use when drafting or restructuring long-form written content - design docs, plan docs, READMEs, reports, runbooks, essays - and the question is how to organise it (heading hierarchy, paragraph order, where the thesis goes) or how to cite sources in it (Source lines, APA 7, RFC-style [TAG] references). Fires on "structure this doc", "essay structure", "PEEL/TEEL", "heading levels", "document hierarchy", "how do I cite/reference this", "Simplified Technical English / STE / ASD-STE100". Not for voice/register (that is erfi-voice) or paste mechanics (paste-formatting).
---

# Writing structure

## Overview

One rule, applied at three scales: **state the point first, support it, close the loop.**

```
Document    heading outline = the skeleton (state the doc's shape first)
  Section   essay logic: thesis -> support -> close (intro/body/conclusion)
    Paragraph   PEEL: Point, Evidence, Explanation, Link (one point per unit)
```

The same test applies at every level: strip everything below a level and what remains must still read coherently. Headings alone = the table of contents. Headings + first sentences = the whole argument. If either fails, restructure before polishing prose.

This is a reference/technique skill. Read it, apply the pattern that fits the surface. No ritual.

## Document hierarchy

- **One H1** - the document title. H2s for major sections, H3/H4 for subsections.
- **Never skip levels going down** (no H2 -> H4). Skipping *up* when closing a subsection is fine.
- **Three levels is the working ceiling.** Deeper = the doc wants splitting, not more levels.
- **Headings are the outline.** Screen readers, search engines, skimmers, and the `docs_summary` tool all navigate on headings alone - the heading list must be a coherent TOC. Never pick a level for visual size; that is CSS's job.
- **Heading style**: sentence case, short, front-loaded keywords, parallel grammar at the same level. Statement or topic headings by default; question headings only when the audience arrives with known questions (a FAQ, a troubleshooting page).

Sources: W3C WAI, WebAIM, MDN, Australian Style Manual, Digital.gov - all convergent.

## Essay / long-form skeleton

- **Intro ~10%** (broad to narrow: context -> the issue -> thesis -> outline), **body ~80%**, **conclusion ~10%** (narrow to broad: restate thesis, sum points, wider implication).
- **No new information in the conclusion.** If a fact first appears there, it belongs in the body.
- **The thesis is the spine.** Intro, every topic sentence, and conclusion all reference it. Re-read intro and conclusion together; if the argument differs between them, the thesis needs revising.
- **Court report, not murder mystery** (Newcastle): state the conclusion first, then show how you got there. A reader should get the gist by reading only the first line of each section/paragraph.
- Expect plan -> draft -> edit -> redraft; structure problems are found in the edit pass, not prevented in the draft.

Sources: ANU, RMIT, Victoria U, Oxford Brookes, Newcastle writing centres.

## Paragraphs: PEEL

- **Point** - topic sentence first, echoes the thesis. One point per paragraph; if you cannot name the point, it is two paragraphs.
- **Evidence** - the quote, number, code, or citation. Never dropped in without framing.
- **Explanation** - the "so what": how the evidence supports the point and the point supports the thesis. This is where the value is; summary without explanation earns nothing.
- **Link** - close back to the thesis and/or forward to the next paragraph.
- Aliases TEEL / PEAL / PEELC (adds a Critical note on the evidence) - same four functions, order flexes by subject, presence does not.
- Length: 200-300 words is the working guideline. 1-3 sentences = underdeveloped; near a page = split it.

For agent-drafted docs the mapping is direct: every H2 section's first sentence is the section's Point; evidence is the command output / measurement / code; explanation is the mechanism; the last line links to the next section.

## Sentence discipline (imported from ASD-STE100)

STE's sentence-level principles generalise; its full apparatus does not. The apparatus - a ~900-word approved dictionary, one-word-one-meaning, the -ing-form restrictions - is for safety-critical maintenance docs read by non-native speakers (STE is mandated by ATA iSpec 2200 and S1000D; Issue 9, Jan 2025, made it an international standard). What transfers to technical prose:

- **One idea per sentence.** Short beats elegant.
- **Active voice; imperative for procedures.** "Install the component", not "the component must be installed" - write as if standing next to the person doing the work.
- **Condition before result** when the reader must know the condition first: "If hot oil touches your skin, it can cause burns." Safer and easier to parse.
- **One term per concept, used consistently.** STE's one-word-one-meaning, relaxed to project vocabulary: pick one name for a thing and never synonym-swap for variety.
- **One word over its synonyms**: "start", not "begin/commence/initiate". (Overlaps erfi-voice's plain-words rule - same instinct, different origin.)

## Citations: pick the format by surface

Every non-obvious claim gets a source (the epistemics/erfi-voice rule); the FORMAT depends on the surface:

| Surface | Format | Example |
|---|---|---|
| Chat reply / TUI / paste targets | Full absolute plain-text URL, one per line under "Sources:". Never markdown label-links (the TUI renders the label and discards the target) | `https://www.rfc-editor.org/info/rfc7322` |
| docs.erfi.io content | `Source: /docs/<source>/<file>.md` line after the claim | `Source: /docs/supabase/guides/auth.md` |
| Formal doc (design doc, report) | APA 7: `Author, A. A. (Year). Title. Site Name. https://...` | See rules below |
| Spec-like / standards doc | IETF (RFC 7322): bracketed `[TAG]` citations matching a References list | `[RFC2119] Bradner, S., "Key words for use in RFCs...", BCP 14, RFC 2119, March 1997, <https://www.rfc-editor.org/info/rfc2119>` |

**APA 7 rules that matter** (apastyle.apa.org):

- DOI preferred over URL; never both. DOI as a live `https://doi.org/xxxxx` link.
- No period after a DOI/URL; no "Retrieved from"; copy-paste the URL verbatim.
- One-to-one match: every in-text citation has a reference entry and vice versa.
- Retrieval date only for content designed to change (a live dashboard, a profile page).

**IETF rules that matter** (RFC 7322, authors.ietf.org):

- Citations in square brackets, no spaces: `[RFC2119]`, not `[RFC 2119]`. In prose, name with a space: "see RFC 2119 [BCP14]".
- Reference for every citation and vice versa; list split into **Normative** (required to understand/implement) vs **Informative** (background) when both exist.
- Cross-reference by section number, never page number.
- Useful borrow even outside RFCs: the normative/informative split maps to "must read to act on this doc" vs "further reading".

## Common mistakes

| Mistake | Fix |
|---|---|
| Murder-mystery structure (conclusion revealed at the end) | Court report: conclusion first, then the support |
| Heading list that is not a coherent outline | Strip to headings; if it does not read as the doc, restructure |
| Multiple points in one paragraph | Split; one Point per PEEL unit |
| Evidence with no Explanation | Add the "so what" - mechanism, implication, number |
| Markdown-link citations in chat/paste targets | Full plain URL, one per line |
| Skipping heading levels for visual effect | Restyle with CSS, keep the level semantics |
| Importing STE's full apparatus (dictionary, -ing ban) | Import the sentence principles only |

## References

- https://libguides.staffs.ac.uk/academic_writing/PEEL
- https://anglia.libguides.com/academic-writing/paragraphs
- https://www.ncl.ac.uk/academic-skills-kit/writing/academic-writing/paragraphing/
- https://learninglab.rmit.edu.au/assessments/essays/write/
- https://www.w3.org/WAI/tutorials/page-structure/headings/
- https://www.stylemanual.gov.au/about-style-manual/government-writing-handbook/editors-tips/headings
- https://www.asd-ste100.org/ (Issue 9, 2025-01-15; free official copy on request)
- https://apastyle.apa.org/style-grammar-guidelines/references/dois-urls
- https://www.rfc-editor.org/info/rfc7322
- https://authors.ietf.org/en/reference-style-guidance
