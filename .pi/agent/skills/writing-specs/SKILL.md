---
name: writing-specs
description: Use ONLY when the user explicitly asks for a written spec, requirements doc, or design doc before implementation - "spec this out", "write a spec", "spec-driven", "SDD", "requirements doc", "acceptance criteria". Produces docs/specs/YYYY-MM-DD-<feature>.md with EARS acceptance criteria and a design section. Heavy artifact - do not auto-fire on a feature request; small changes and greenfield scaffolding skip it.
---

# Writing Specs

## Overview

Write a reviewable specification - what the system must do and how it will do it - before any implementation plan exists. The spec is the artifact the user approves; the plan (writing-plans) is what an executor consumes. Keep them separate: a spec answers "what and why", a plan answers "how, file by file".

**Announce at start:** "I'm using the writing-specs skill to write the spec."

**Save specs to:** `docs/specs/YYYY-MM-DD-<feature-name>.md` in the target repo.

## Where this sits (spec sized to the executor)

| Work | Spec artifact |
|---|---|
| Small change, human pairing | In-chat plan. No doc. This is the default. |
| Feature the user asks to spec | This skill, then writing-plans if asked |
| Autonomous loop work | `.pi/harness.json` IS the spec - acceptance criteria become sensors (self-correcting-loop) |
| Greenfield project | scaffold-new-project - conventions come from the stack skills, no spec doc |
| Bug fix | Bugfix spec (below) if the user asks for one; otherwise systematic-debugging alone |

Never produce a spec doc uninvited. If the work clearly needs one and the user didn't ask, say so in one line and proceed without it.

## This skill is not a gate

A spec is a document, not a process prison. It never blocks or replaces the concrete-tech skills: the moment the design section needs stack decisions, read the relevant skills (software-architecture, frontend-stack, infrastructure-stack, supabase, ...) and let them answer. Do not re-derive stack conventions inside the spec. (Historical note: this clause exists because the old brainstorming skill hard-gated every creative task behind its own question loop and forbade handoff to the stack skills. That failure mode is why this skill is explicit-ask-only.)

## Two spec types

**Feature spec** - new capability. Requirements + design.

**Bugfix spec** - freeze the behavior contract before touching code:
- Current behavior (observed, with repro)
- Expected behavior
- Unchanged behavior (what must NOT move - the regression fence)
- Root-cause hypothesis (from systematic-debugging, if that ran)

## Two workflows

**Requirements-first (default).** Capture behavior as requirements, derive the design from them. For product-driven work.

**Design-first.** Start from architecture or pseudocode, derive the requirements it satisfies. For technically-constrained work: strict latency/throughput targets, porting an existing design, feasibility exploration. Say which workflow you are using at the top of the spec.

## Spec file format

```markdown
# <Feature> Spec

**Goal:** one sentence
**Workflow:** requirements-first | design-first
**Non-goals:** what this explicitly does not cover

## Requirements

### R1: <short name>
**Story:** As a <who>, I want <what>, so that <why>.
**Acceptance criteria:**
- WHEN the user submits an empty form, THE SYSTEM SHALL show field-level errors without a network call
- WHILE the request is in flight, THE SYSTEM SHALL disable the submit button

### R2: ...

## Design

Architecture, components, data flow, error handling, testing strategy.
Sequence diagrams in mermaid when interactions matter. Stack decisions
defer to the concrete-tech skills - cite the skill, don't restate it.

## Open questions

Anything unresolved, with a default assumption the implementer can proceed on.
```

Requirement IDs (R1, R2, ...) are stable handles. Never renumber a shipped spec - append new requirements.

## EARS notation

Acceptance criteria use EARS (Easy Approach to Requirements Syntax) so every criterion is testable:

| Pattern | Form |
|---|---|
| Ubiquitous | THE SYSTEM SHALL \<response\> |
| Event-driven | WHEN \<trigger\>, THE SYSTEM SHALL \<response\> |
| State-driven | WHILE \<state\>, THE SYSTEM SHALL \<response\> |
| Unwanted behavior | IF \<undesired condition\>, THEN THE SYSTEM SHALL \<response\> |
| Optional feature | WHERE \<feature is present\>, THE SYSTEM SHALL \<response\> |

One condition per criterion. If a criterion needs "and" between two triggers, split it. Vague words ("fast", "reasonable", "appropriate") are spec defects - replace with a number or an observable.

## Requirements self-analysis

Before writing the design section, re-read the requirements with fresh eyes:

1. **Ambiguity** - could two competent engineers build different things from the same criterion? Fix.
2. **Conflicts** - do any two requirements contradict under some input? Fix.
3. **Gaps** - walk the error paths: empty input, permission denied, timeout, partial failure. Each needs a criterion or an explicit non-goal.
4. **Testability** - every criterion must map to at least one conceivable test. If you cannot imagine the test, rewrite the criterion.

Fix issues inline; do not re-review.

## Traceability and handoff

The spec's IDs flow downstream:

- **writing-plans** - each plan task names the requirement IDs it satisfies (`**Satisfies:** R2, R3`). The plan's self-review then checks coverage mechanically: every R-ID appears in at least one task.
- **self-correcting-loop** - acceptance criteria become `harness.json` sensors; keep the R-ID in the sensor name (`r2-empty-form-no-network`).
- **Bugfix specs** - the "unchanged behavior" list becomes the regression test checklist.

Offer the handoff when the spec is done: "Spec saved to `docs/specs/<file>.md`. Write the implementation plan (writing-plans), or stop here?"

## Living artifact

A spec that has shipped is still the behavior contract. When behavior changes later, update the spec in the same commit as the code change - a stale spec is worse than none. If the change is big enough, new dated spec file instead and mark the old one superseded at the top.
