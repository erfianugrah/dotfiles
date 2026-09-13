---
name: stocktake
description: "Use when about to continue implementation after shipping a milestone, or on 'update everything first', 'update the docs/skills before proceeding', 'no debt', 'docs are stale' - the pre-task reconciliation of records (plan doc, AGENTS.md, linked skills, sibling model docs, memory) with code reality. NOT for claims about your own code (verification-before-completion), writing the plan itself (writing-plans), or provenance of a literal (epistemics)."
metadata:
  verified: 2026-09-13
---

# Stocktake

## Overview

Docs are a ledger; code is the inventory. A stocktake is the
reconciliation pass that forces the ledger to match the inventory - run
BEFORE the next implementation task, not at session end (session end is
when stocktakes quietly don't happen). The user has to ask for this less
and less: if a repo has records, the records get reconciled at every
milestone boundary automatically.

**Core principle:** a stale record is not a backlog item - it is active
debt that every future session re-pays (re-reads the stale plan,
re-derives the drift, or trusts a flag that no longer exists).

Baseline (observational, 2026-09-13): netlens shipped T1-T9 across 9
commits with the plan checkboxes stale, three shipped deviations
unrecorded, the AGENTS package map missing, and a bonus network finding
only in a commit message - the user had to prompt "update everything
first" (a demand they report making repeatedly across sessions; cf. the
2026-09-10 llmc stale-AGENTS.md fix that landed days after the drift
shipped).

## The algorithm

1. **Define the record set** for this system: plan doc(s), AGENTS.md /
   README, linked pi skills, sibling model/topology docs in adjacent
   repos, memory entries. `rg` for cross-references between them so the
   set is complete, not the files you remember.
2. **Inventory the facts**: what the code actually is NOW - commands and
   flags (`rg` the source or `--help`), test status (run the suite once -
   so any "green" claim in the docs is true at commit time), commits
   shipped since the last stocktake, live behavior that changed.
3. **Diff, record every item**: stale task status, missing package or
   command, deviation shipped without a note, wrong path/flag/number,
   finding that lives only in chat or a commit message, superseded
   memory entry. An empty diff is a legitimate result - say so and move
   on.
4. **Fix the records** (not the code). If a record points at a REAL
   code defect (a doc promises a flag that was never built), that defect
   becomes a todo - the stocktake itself does not grow code.
5. **Separate `docs:` commit BEFORE the next feature commit**, plus
   update superseded memory entries in the same pass (update, don't
   duplicate - `list` first).

## Rules

- **Fix drift now, never "note it for later".** The later note is the
  debt. Every deferred reconciliation item observed in this tree became
  the next session's re-derivation cost.
- **Deviations get recorded at the point of deviation** (or the very next
  stocktake): attached to the plan task that owns them, with the commit
  reference, stating what shipped vs what the plan assumed. "Obvious from
  the commit message" is not recording - commit messages are archaeology,
  the plan is the working doc the next agent reads first.
- **Specifics in docs are verified in the same pass.** A flag name,
  path, version, port, or count in a doc gets an `rg`/test/`--help`
  check during the stocktake; if it cannot be verified, delete it or
  mark it. (Complements the epistemics rules for YOUR output - this is
  for EXISTING records.)
- **Skills track the system.** Any skill in the record set whose system
  changed gets its update in this pass, and `skills-lint` runs on it.
  A skill that merely consumes the system (netlens consuming eaves)
  needs no update when the consumer changes.
- **Scope fence: stocktake aligns records with reality. It does not
  write features, tests, or refactors.** A test failure or missing test
  discovered by the pass goes on the todo list as its own item - it is
  never silently folded into the docs commit.
- **One commit per repo, `docs:` prefix, before the next feature
  commit.** Uncommitted doc fixes die with the worktree and read as
  "never happened".

## When NOT to use

- Repo with no plan/AGENTS/skills/memory surface (a scratch dir).
- Pure research or read-only investigation sessions.
- Mid-task: a stocktake is a milestone-boundary action, not something
  interleaved with in-flight implementation.

## Red flags (you are about to skip the stocktake)

- "I'll update the docs at the end of the session." (The end is when it
  doesn't happen. Before the next task, now.)
- "The deviation is obvious from the code." (Next agent reads the plan
  first and trusts it.)
- "The stocktake takes 10 minutes, the task takes an hour." (Debt
  compounds per session - the skip is negative value, not free time.)
- "Docs-only, I'll fold it into the feature commit." (Mixed commits make
  the record change invisible in history and un-revertible.)
- "Tests are cached green." (Fine if nothing changed since; if in doubt,
  run once.)

## Verifying the pass is done

- [ ] Plan checkboxes / status banner match shipped commits
- [ ] AGENTS/README command + package index matches `rg` of the source
- [ ] Every deviation since the last stocktake has a task-attached note
- [ ] No unverified specific (flag/path/version/count) left in the records
- [ ] Touched skills lint clean; memory updated where superseded
- [ ] Test suite run this pass; any "green" claim in docs is current
- [ ] Separate `docs:` commit(s) pushed
