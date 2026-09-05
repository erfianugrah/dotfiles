---
name: verification-before-completion
description: "Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - 'done', 'tests pass', 'should work now', 'it will work after a restart'. NOT for external-system claims (validating-empirically) or unverified specifics such as versions and flags (epistemics)."
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

This skill owns claims about YOUR OWN work. Claims about an external system's
runtime behaviour belong to `validating-empirically`; recalled specifics (a
version, a flag, a path) belong to `epistemics`, whose label table is the shared
vocabulary for all three.

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Config/hook/extension installed | Fresh process trips it; live path resolves | File is correct in the repo |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## "It will work after a restart" is an untested claim

Deferring verification to a future session is how dead config ships: a guard
that is written, unit-tested, committed and documented but never stow-linked
can never load, and the deferral hides that for a whole session. The rule is
already global (`~/dotfiles/.pi/agent/prompts/tool-routing.md`, "Implementation
discipline"); this is the checklist form.

Config that loads at process start is testable NOW in a fresh process:

- pi extension: `pi -p '<prompt that should trip it>' </dev/null`
- Claude Code hook: `claude -p '<prompt that should trip it>' --allowedTools Write`
- systemd unit / container: `systemctl show <unit>` / `docker inspect <name>`
- install path: verify the LIVE path, not the repo copy - `stat -c '%N'` on the
  symlink; `stow-drift` exits 1 on `UNLINKED`

If a spawned-process check is genuinely impossible, report "unverified:
activates at next start" as a KNOWN GAP in the completion message, never as
shipped.

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- "It will work after a restart" / "activates on next load"
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence != evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter != compiler |
| "Agent said success" | Verify independently |
| "It loads at startup, I can't test it" | A fresh `pi -p` / `claude -p` IS the startup. Run one |
| "I'm tired" | Exhaustion != excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
```
OK  [Run test command] [See: 34/34 pass] "All tests pass"
BAD "Should pass now" / "Looks correct"
```

**Regression tests (red-green):**
```
OK  Write -> Run (pass) -> Revert fix -> Run (MUST FAIL) -> Restore -> Run (pass)
BAD "I've written a regression test" (without red-green verification)
```

A regression test that never went red proves nothing about the bug. This is the
one place the red-green ritual is mandatory; the global TDD rule
(tool-routing.md) is otherwise pragmatic.

**Build:**
```
OK  [Run build] [See: exit 0] "Build passes"
BAD "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
OK  Re-read plan -> Create checklist -> Verify each -> Report gaps or completion
BAD "Tests pass, phase complete"
```

**Agent delegation:**
```
OK  Agent reports success -> Check VCS diff -> Verify changes -> Report actual state
BAD Trust agent report
```

**Startup-loaded config:**
```
OK  Edit hook -> stat the live symlink -> claude -p 'trip it' -> see the block -> "installed and firing"
BAD "Committed; it will pick it up on restart"
```

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## Related

`validating-empirically` (an external system's runtime behaviour), `epistemics`
(recalled specifics; owns the shared label table), `systematic-debugging` (when
the verification fails and the first fix did not hold).

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. THEN claim the result.

This is non-negotiable.
