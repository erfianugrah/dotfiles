# Sensor tools: browser-assert, judge, pixel-diff, prose-lint

Read this when wiring a web target (DOM asserts, screenshots), an LLM-as-judge
gate (code or visual), a pixel-regression baseline, or a prose gate into a
manifest. Each tool prints its usage when run with no or bad arguments; there
is no `--help` flag. The judge examples use `anthropic/claude-opus-5`
throughout - any model stronger than the writer rung works, the point is that
it is not the same model.

Contents:
- Behaviour harness for web targets (`browser-assert`: flows, layout asserts, style-ethos gates, screenshots)
- Inferential gate (`judge` CODE mode: placement, dirt in the diff, measured reviewer variance, adversarial N, rubric rules, what it does not review)
- VISUAL mode (`judge --url`)
- Computational visual regression (`pixel-diff`)
- Prose: the writing gate (`prose-lint`)

## Behaviour harness for web targets

Build/typecheck/unit sensors do not prove a page actually renders and works.
The browser layer closes that gap, and comes in two flavours:

- **Computational (the gate): `browser-assert.ts`.** Launches system Chromium
  headless over CDP and runs ORDERED steps: `--wait <sel>`, `--click <sel>`,
  `--type <sel> <text>`, `--press <key>` (trusted CDP Input events),
  `--assert <jsExpr>`, `--screenshot <path>` (+ `--viewport WxH`, `--full-page`).
  So it scripts a real flow (sign-in, form, wizard), not just a static-render
  check. Exits 0/1. Deterministic and self-bounding (per-command CDP timeout +
  reject-on-socket-close, so a wedged browser fails instead of hanging the
  loop). Also doubles as a **UI live-smoke** tool: point `<url>` at a deployed
  environment. Wrap dev-server start/stop in the sensor cmd:

  ```json
  { "name": "e2e",
    "cmd": "bunx --bun astro build && (bunx serve dist -l 4321 & SP=$!; sleep 1; bun ~/.pi/agent/skills/self-correcting-loop/browser-assert.ts http://localhost:4321 --wait '#app' --assert 'document.title.length>0' --assert '!document.querySelector(\".error\")'; RC=$?; kill $SP; exit $RC)" }
  ```

  Put e2e AFTER the fast sensors (build/typecheck/unit) - it is the expensive,
  slower-and-flakier tier, so it only runs once the cheap gates are green.
  Capture is **hardened by default** (device-scale=1, reduced-motion,
  animations/transitions/caret zeroed, waits on `document.fonts.ready`), so
  screenshots and visual diffs are deterministic; `--no-stabilize` opts out.

- **Deterministic layout assertions (computational - prefer these over the
  vision judge where they apply).** A lot of "gross breakage" is exactly
  checkable with `--assert`, which turns a probabilistic visual guess into a
  hard gate with no baseline and no model:
  - horizontal overflow: `--assert 'document.documentElement.scrollWidth <= window.innerWidth'`
  - element actually rendered a box: `--assert 'document.querySelector("nav").getBoundingClientRect().height > 0'`
  - no unstyled-content flash / stylesheet actually applied:
    `--assert 'getComputedStyle(document.querySelector("h1")).fontSize !== "16px"'` (or pin the exact expected value)
  - two elements do not overlap (stacking correct): compare their
    `getBoundingClientRect()` boxes in one expression
  - no raw error banner / framework error overlay:
    `--assert '!document.querySelector(".error, #vite-error-overlay, astro-dev-overlay")'`
  Reach for the vision judge (below) only for what genuinely needs eyes
  (spacing/contrast/"looks off"); everything mechanical should be an `--assert`.

- **Style-ethos gates: computed-style asserts are the pressure, the vision judge is the tiebreaker** (learned the hard way on the docs-ssh landing restyle: the vision judge PASSed the original off-ethos page - it only fails *ugly*, not *off-brief*). When the task is "restyle to ethos X" (dense / flat / sharp / single-accent), encode the ethos as computed-style asserts; they are what create real selection pressure:
  - density: `--assert 'parseFloat(getComputedStyle(document.querySelector("main")).paddingTop) <= 32'`
  - sharp corners: `--assert '[...document.querySelectorAll("*")].every(e => parseFloat(getComputedStyle(e).borderTopLeftRadius) <= 6)'`
  - flat: same `.every()` shape for `getComputedStyle(e).boxShadow === "none"` and `!getComputedStyle(e).backgroundImage.includes("gradient")`
  - single accent: count distinct saturated text colors outside `<pre>`/code blocks (parse the rgb() triple, flag max-min > 60, dedupe in a Set), assert `<= 1` - working IIFE in `~/docs-ssh/.pi/harness.json` ("dom" sensor)
  Then keep the vision judge LAST for what computed styles can't express (overlap, clipping, unstyled flash) - as tiebreaker, not primary gate.

- **Inferential (as a debugging aid): a screenshot the model reads.**
  `browser-assert ... --screenshot /tmp/x.png` captures the post-interaction
  page; the agent then `read`s the PNG to reason about layout/visual issues the
  DOM can't express. On its own this is a probabilistic aid, not a gate - but
  when you *do* want rendered-UI to gate the loop, use `judge.ts` VISUAL mode
  (next section), which captures the same way and puts a second model's verdict
  behind it. The bare screenshot-read stays the free-form debugging path.

Visual-regression (diff the `--screenshot` PNG against a baseline) and a11y
(`axe`) are further sensors you can layer on; they need their own baselines/
tooling. `--type`/`--click` use trusted CDP Input events, but for complex flows
(multi-tab, downloads, network mocking) a target's own Playwright suite is still
the right tool - `browser-assert` is the zero-dep gate.

## Inferential gate: correctness the computational sensors miss (`judge.ts`)

Bockeler splits sensors into **computational** (tests/linters/types -
deterministic, cheap, every change) and **inferential** (semantic AI review /
"LLM as judge" - slower, non-deterministic, richer judgment). Everything above
is computational: it proves the code *passes the checks*, never that it did the
*right thing*. A misunderstood-but-green change, over-engineering, or an agent
that weakened its own tests all sail through. `judge.ts` adds the inferential
column as an actual **gate**:

```json
{ "name": "judge",
  "cmd": "bun ~/.pi/agent/skills/self-correcting-loop/judge.ts --spec 'the task, restated as acceptance criteria' --model anthropic/claude-opus-5" }
```

It collects `git diff HEAD` (plus untracked files), feeds it with the spec to a
SECOND `pi -p`, and exits on the model's `VERDICT: PASS/FAIL`. Use it well:

- **Put it LAST** (keep quality left): it is the expensive, probabilistic tier -
  it should only run once the cheap computational gates are green.
- **`--allow-dirty` + judge = pre-existing dirt in the diff.** The judge
  collects `git diff HEAD`, which includes uncommitted work that predates the
  run - and a reviewer will reject a modified tracked binary as "unverifiable
  scope creep" no matter what the code looks like (two consecutive rejections
  on 2026-08-09 while the actual change was spec-complete). Either start the
  run on a clean tree, or put a SCOPE NOTE in the judge spec naming the
  pre-existing paths to ignore.
- **Use a DIFFERENT / stronger model** than the one writing the code (`--model`).
  A judge that is the same model that wrote the diff is a closed loop, same as
  self-graded tests.
- **Measured reviewer variance: zero, and `--adversarial` bought nothing.**
  A/B on a fixed diff with one planted, unambiguous spec violation (`Median`
  sorting the caller's slice, which the spec explicitly forbids), scored
  against a clean control. 8 single-reviewer trials per arm per model:

  | judge | caught the flaw | false-rejected clean |
  |---|---|---|
  | claude-sonnet-5 | 8/8 | 0/8 |
  | claude-haiku-4-5 | 8/8 | 0/8 |

  With p = 1.0 and q = 0.0, `1-(1-p)^k` is flat: a second and third reviewer
  add cost and change no outcome. Be honest about the sample: n=8 with no
  errors gives an exact 95% one-sided bound of p >= 0.688 and q <= 0.312,
  so this rules out a *badly* noisy reviewer, not a mildly noisy one. The
  flaw was also localised and spec-explicit - variance should be expected
  to appear on ambiguous or diffuse defects. But the load-bearing
  claim ("one sampled judgment is noisy") did NOT reproduce at this
  difficulty, on either a strong or a weak judge.

  **The one apparent miss was a bug in this harness, not model variance.**
  A haiku run came back `unknown` -> fail-closed. The transcript showed it had
  diagnosed the flaw correctly and written `**VERDICT: FAIL**`; `parseVerdict`
  required a bare line and discarded it. Fail-closed hid the damage that time,
  but the symmetric case is worse - a bolded `**VERDICT: PASS**` becomes a
  FAIL and blocks good work. Fixed to tolerate markdown decoration (bold,
  headings, list markers, blockquotes, backticks) while still refusing prose
  mentions. Before assuming a judge is flaky, check that its verdict parses.

  Practical consequence: **leave `--adversarial` at 1 unless you have measured
  variance on your own diffs.** Harness to measure it:
  `~/.local/share/loop-validation/judge-variance/`.
- **Run 2+ reviewers with `--adversarial N`** *(Bun)*. The Bun rewrite's unit
  of work was `1 implementer -> 2 adversarial reviewers -> 1 fixer`, with the
  roles kept strictly apart: "The Claude that wrote the code wants the code to
  get accepted. The Claude that reviews wants to find issues... The implementer
  doesn't review. The reviewer doesn't implement." `--adversarial N` runs N
  independent reviewer contexts concurrently and fails if **any** rejects -
  deliberately not a majority vote, because one reviewer finding a real bug
  outranks N-1 that missed it. It also blunts the biggest weakness of an
  inferential gate: one sampled judgment is noisy, unanimity is not. Costs N
  model calls per iteration, so reserve it for runs that matter.
- **Reviewer rejection rules worth stealing.** Give `--rubric` the ones that
  run had to add after watching the failure modes: reject a change whose
  workaround needs a paragraph-long comment to justify it; reject stubbed or
  no-op'd functions presented as an implementation; reject behaviour that
  differs from the stated reference even when the code compiles and passes.
- **Role separation is only half-implemented here.** `judge.ts` gives you the
  reviewer half (separate context, separate model, read-only tools). There is
  no distinct *fixer* role yet - a judge FAIL restarts the implementer with the
  findings as feedback rather than handing them to an agent that only fixes.
  Worth knowing when comparing this loop against the article.
- **Fail-closed by default**: an unparseable / errored verdict counts as FAIL,
  so the loop keeps trying rather than declaring victory on an unclear answer.
  `--lenient` flips to fail-open for noisy judges.
- **Read-only tools** (`--tools read` default) - the judge inspects, never edits.
- `--rubric "..."` appends task-specific acceptance criteria; `--base <ref>`
  changes what the diff is taken against (default `HEAD`, the loop's baseline).

Honest caveat: it is inferential, so it is non-deterministic and costs a model
call per iteration. It raises confidence, it does not replace a specification -
a vague `--spec` judges vaguely. It is the answer to "green but wrong", not a
license to skip writing down what "right" means.

**Two things the judge does not review.** Both were found the hard way, on the
same run.

- **The loop's own artifacts.** `collectDiff` includes untracked files so a
  brand-new file is visible - which meant `.pi/harness-run.log` was handed to
  the reviewers as part of the change. Both of them wrote it up as a defect
  ("committing a harness run log as the sole deliverable is unrequested
  scope"), correctly by their lights. Unstaging it at checkpoint time was not
  enough: that only moved it from `git diff <base>` into `git ls-files
  --others`, which this collector also reads. Filtered in both places now.
- **An empty diff.** At baseline the tree matches the base ref, so an
  adversarial CODE judge spends minutes of a frontier model reaching a
  guaranteed FAIL - and its verbose "the work was not started" reasoning then
  lands in iteration 1's prompt under the heading *"Automated checks failed on
  the previous attempt"*, describing an attempt that never happened. Measured
  at 147s of opus per baseline, doubled by `--adversarial 2`. The judge now
  short-circuits: no diff, no model call, one-line fail-closed verdict.

### VISUAL mode: UI/UX awareness for a live dev server

DOM asserts (`browser-assert`) prove elements *exist*; they cannot see that the
page *looks* right. `judge.ts --url` closes that: it screenshots a live dev
server (reusing `browser-assert` under the hood) and asks a vision-capable
`pi -p` to judge the render - layout, overflow/clipping, contrast, unstyled
flash, overlap, raw-markup/error banners - against the spec, gating on the same
`VERDICT: PASS/FAIL`.

```json
{ "name": "ux",
  "cmd": "bun ~/.pi/agent/skills/self-correcting-loop/judge.ts --url http://localhost:4333/guides/x --wait 'main' --full-page --viewport 1280x800 --model anthropic/claude-opus-5 --spec 'the guide page renders: readable prose, code blocks styled (not raw), no horizontal overflow, no error banners'" }
```

- `--url` captures to a temp PNG (or `--screenshot <path>` to keep it); pass
  `--screenshot <path>` WITHOUT `--url` to judge a pre-captured PNG instead.
- `--wait <sel>` / `--viewport WxH` / `--full-page` are forwarded to the
  capture, so you gate the *hydrated* page at a real size, full-height.
- The judge opens the PNG with its `read` tool (pi renders images to the model),
  so `read` is forced into `--tools` automatically.
- Same discipline as code mode: run it LAST (it is the slowest/most expensive
  tier), use a strong `--model`, fail-closed by default. A capture failure
  (server down, wedged browser) is a FAIL unless `--lenient`.
- Wrap the dev-server lifecycle in the sensor `cmd` if it is not already up,
  e.g. `(bun dev & SP=$!; sleep 2; bun judge.ts --url ...; RC=$?; kill $SP; exit $RC)`.

Caveat: a vision judgment is coarser than a human's eye and non-deterministic -
it reliably catches gross breakage (overflow, unstyled content, blank/error
pages) and is far weaker on pixel-level polish. For exact regressions, use the
computational baseline diff below.

### Computational visual regression: baseline PNG diff (`pixel-diff.ts`)

The deterministic half of the visual gate: capture the current render and diff
it against a committed, human-**approved** baseline PNG, failing when too many
pixels changed. Zero-dep (PNG decode/encode via `node:zlib`), with a YIQ
perceptual per-pixel threshold so anti-aliasing / sub-pixel noise does not
false-positive.

```json
{ "name": "visual-regression",
  "cmd": "bun ~/.pi/agent/skills/self-correcting-loop/pixel-diff.ts --url http://localhost:4333/guides/x --baseline .pi/baselines/guide-x.png --wait 'main' --full-page --viewport 1280x800 --max-diff-ratio 0.001 --diff-out /tmp/guide-x.diff.png" }
```

- **Approved-baseline lifecycle:** generate baselines as a SETUP step and COMMIT
  them (committing = approval). On a missing baseline the sensor writes it and
  FAILs ("review and commit it") - so a stray baseline can never silently gate.
  Refresh an intentionally-changed reference with `--update-baseline`.
- **`--baseline <png>`** is the reference; the current render comes from `--url`
  (captured via browser-assert, forwarding `--wait`/`--viewport`/`--full-page`)
  or `--current <png>` (pre-captured).
- **`--threshold 0..1`** = per-pixel YIQ sensitivity (default 0.1); **`--max-diff-ratio 0..1`** = allowed fraction of changed pixels (default 0). Capture
  hardening (on by default in browser-assert) makes same-host re-captures
  bit-identical, so 0 is realistic; bump the ratio for cross-host noise.
- **`--ignore-region x,y,w,h`** (repeatable) zeroes dynamic areas (timestamps,
  avatars) before diffing. **`--diff-out <png>`** writes a red-highlight image
  the agent can `read` to see exactly what moved.
- Run it LAST with the fast sensors green, same as the other visual gates.

When to use which visual gate: **`pixel-diff`** for "nothing should change"
(regression-locking a stable page - exact, deterministic); **`judge` VISUAL**
for "does this new/changed page look right" (no baseline exists yet, or the
change is intended and you want a judgment not a byte-compare).

### Prose: the writing gate (`prose-lint.ts`)

The deterministic counterpart to `judge` for documentation, the way
`pixel-diff` is for UI. `judge` can tell you a doc reads like a model wrote it,
but it costs a frontier model per iteration and its verdict is not
reproducible. This is countable, instant and free.

```bash
prose-lint docs/*.md                       # default gate: slop <= 1.0/100w
prose-lint README.md --explain             # file:line for every violation
prose-lint doc.md --before HEAD            # also gate on fact retention
prose-lint docs/*.md --baseline .pi/prose.json   # ratchet, adopt a legacy tree
rg --files -g '*.md' | xargs -r prose-lint       # the sensor form (presets/docs.json)
```

**Two numbers, and only one of them gates.** `slop` counts marketing
adjectives, hedges, filler openers, nominalizations, phrasal verbs and referent
rotation. `style` counts passive voice and long paragraphs, and is reported
only. That split came out of measurement: passive was 76 of 81 violations in
this skill's own SKILL.md, and sampling showed they were real passives in
correct prose ("the run is refused"). A measure that fires equally on good and
bad writing is not a discriminator. Measured both ways, with passive in the
score the generated sample scored 4.08 against our SKILL.md at 0.83; with it
out, 3.06 against 0.02.

**Counts go in the score; distribution shape goes in the gates.** The gates are
hard booleans, never score contributors, because a counter you can pay for by
deleting three more adjectives is not a counter:

| gate | catches | threshold | derived from |
|---|---|---|---|
| `mean-sentence-floor` | prose chopped into stubs to beat a length rule | 5 | corpus min 6.6, chopped sample 2.9 |
| `mean-sentence-ceiling` | sustained run-ons | 25 | corpus max 17.3, generated sample 32.7 |
| `sentence-variance-floor` | uniform sentence length | 2 | corpus min 3.6, chopped sample 0.6 |
| `fact-retention` | specifics deleted to shorten the text | 0 facts lost | see below |

Fact retention gates on an ABSOLUTE count, not a ratio. It began as a ratio and
a real 294-fact reference doc showed why that is the wrong shape: deleting a
measured latency left retention at 0.997 and sailed through a 0.9 gate. A ratio
scales tolerance with document size, so the longest and most measurement-dense
documents - the ones most worth protecting - get the most licence to lose a
number. `maxFactsLost` defaults to 0; `minFactRetention` survives as a
secondary, lax bound for anyone who deliberately raises the count.

Thresholds come from a 49-document corpus (this repo's skills, READMEs,
AGENTS.md) tested against two adversarial samples. Re-derive them for a corpus
with a different register rather than trusting these. Note what the corpus
refuted: the variance floor is a CHOPPING detector only. Our tersest CLI
reference doc sits at stddev 3.6 and the generated sample at 3.3, so no
threshold separates those two without failing real documents. Run-ons are the
ceiling's job. One job per gate.

**Em-dashes and semicolons are reported and never scored.** Stated here so it
reads as a design decision rather than a result: a linter that excludes
em-dashes from its total cannot then be cited as evidence that banning
em-dashes fails to reduce slop, because that would be true by construction.

**Block labels and thematic breaks are not sentences.** A command-heavy guide
is full of `Output:` / `Tunnel Config:` lines introducing fences, and a bare
`---` rule. Counted as sentences they collapse the mean: one real guide scored
4.8 words per sentence and failed the chopping gate on prose that was not
chopped, because 23 of its 63 "sentences" were labels and rules. Both are
excluded from the length distribution and still scanned for vocabulary.

**What it deliberately does not do.** There is no POS tagger (zero-dep), so
passive and nominalization are regex heuristics - survivable precisely because
neither one gates. Referent rotation is curated synonym sets, not coreference;
a derive-abbreviations-from-the-text detector was built, measured at 286 hits
and approximately zero true positives on our own SKILL.md (`loop`/`loop-built`,
`not`/`nothing`), and deleted. Markdown only.

**The circularity to avoid.** As a lint, teaching to the test is the point. As
evidence it is worthless: if you use this to show that some writing skill
reduces slop, and that skill's rule list is where these word lists came from,
you have measured instruction-following. Score that claim with a rubric the
skill has never seen.

