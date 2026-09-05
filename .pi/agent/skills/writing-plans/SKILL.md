---
name: writing-plans
description: "Use ONLY when the user explicitly asks for a written implementation plan - 'write a plan', 'plan this out', 'implementation plan', 'docs/plans'. Heavy artifact - do not auto-fire on a multi-step task; the user usually prefers to dive in directly. NOT for the requirements/design doc that precedes a plan (writing-specs) or for executing a plan with per-task subagents (subagent-driven-development)."
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD where the task is logic or a bugfix. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** If working in an isolated worktree, it should have been created via the `git-worktrees` skill at execution time.

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- (User preferences for plan location override this default)

## Scope Check

If the spec covers multiple independent subsystems, it should have been split into sub-project specs when it was written (see writing-specs). If it wasn't, suggest breaking this into separate plans - one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes).** The step shape follows the global TDD
rule (`~/dotfiles/.pi/agent/prompts/tool-routing.md`, "TDD where useful"): TDD
steps for logic and bugfix tasks; scaffolding, glue, CLI plumbing and config
tasks get a verify step instead of a test ritual.

Logic / bugfix task:
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

Scaffolding / config task:
- "Make the change" - step (show the exact content)
- "Verify" - step (exact command + expected output: the file exists, the service
  starts, the config parses, the symlink resolves)
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, in the current session. Steps use checkbox (`- [ ]`) syntax for tracking. Per-task subagents (subagent-driven-development) only if the user asks for them.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Satisfies:** R2, R3 (requirement IDs, when executing a writing-specs spec)

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

For a scaffolding or config task, Steps 1-4 collapse to "make the change" plus
"verify" (`Run:` + `Expected:`), then commit.

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** - never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code - the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember
- Exact file paths always
- Complete code in every step - if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD for logic and bugfixes, frequent commits
- **If the plan will be executed by the self-correcting loop** (`.pi/harness.json`
  in the target repo), OMIT the per-task commit steps. The loop owns git state
  (index checkpoints + ref-guard); a committing agent fights the governor and
  pollutes its own attempt history. Per-task commits are for human/inline
  execution only.

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself - not a subagent dispatch.

**1. Spec coverage:** If executing a writing-specs spec, check every requirement ID (R1, R2, ...) appears in at least one task's **Satisfies:** line - mechanical, not vibes. Otherwise skim each section of the request and point to the task that implements it. List any gaps.

**2. Placeholder scan:** Search your plan for red flags - any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

If you find issues, fix them inline. No need to re-review - just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

After saving the plan, execution is inline by default:

**"Plan complete and saved to `docs/plans/<filename>.md`. Executing inline, task
by task, with a checkpoint after each task. Say so if you want per-task
subagents instead."**

Only if the user asks for subagents: use subagent-driven-development (fresh
subagent per task, two-stage review). It is a heavyweight workflow and is never
the default.
