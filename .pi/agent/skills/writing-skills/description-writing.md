# Writing a skill description

The description is the only part of a skill every turn pays for, and the part
that decides whether the body is ever read. Read this when calibrating a new
description or trimming an old one.

Contents:
1. Rich Description Field - triggers, not workflow, with worked good/bad examples
2. Keyword Coverage - the words a future agent will search for
3. Rules checklist

## 1. Rich Description Field

**Purpose:** Claude reads description to decide which skills to load for a given task. Make it answer: "Should I read this skill right now?"

**Format:** Start with "Use when..." to focus on triggering conditions

**CRITICAL: Description = When to Use, NOT What the Skill Does**

The description should ONLY describe triggering conditions. Do NOT summarize the skill's process or workflow in the description.

**Why this matters:** Testing revealed that when a description summarizes the skill's workflow, Claude may follow the description instead of reading the full skill content. A description saying "code review between tasks" caused Claude to do ONE review, even though the skill's flowchart clearly showed TWO reviews (spec compliance then code quality).

When the description was changed to just "Use when executing implementation plans with independent tasks" (no workflow summary), Claude correctly read the flowchart and followed the two-stage review process.

**The trap:** Descriptions that summarize workflow create a shortcut Claude will take. The skill body becomes documentation Claude skips.

```yaml
# BAD: Summarizes workflow - Claude may follow this instead of reading skill
description: Use when executing plans - dispatches subagent per task with code review between tasks

# BAD: Too much process detail
description: Use for TDD - write test first, watch it fail, write minimal code, refactor

# GOOD: Just triggering conditions, no workflow summary
description: Use when executing implementation plans with independent tasks in the current session

# GOOD: Triggering conditions plus the sibling boundary
description: Use when tests have race conditions, timing dependencies, or pass/fail inconsistently. NOT for root-causing a deterministic failure (systematic-debugging)
```

**Content:**
- Use concrete triggers, symptoms, and situations that signal this skill applies
- Describe the *problem* (race conditions, inconsistent behavior) not *language-specific symptoms* (setTimeout, sleep)
- Keep triggers technology-agnostic unless the skill itself is technology-specific
- If skill is technology-specific, make that explicit in the trigger
- Write in third person (injected into system prompt)
- **NEVER summarize the skill's process or workflow**

```yaml
# BAD: Too abstract, vague, doesn't include when to use
description: For async testing

# BAD: First person
description: I can help you with async tests when they're flaky

# BAD: Mentions technology but skill isn't specific to it
description: Use when tests use setTimeout/sleep and are flaky

# GOOD: Technology-specific skill with explicit trigger
description: Use when using React Router and handling authentication redirects
```

## 2. Keyword Coverage

Use words Claude would search for:
- Error messages: "Hook timed out", "ENOTEMPTY", "race condition"
- Symptoms: "flaky", "hanging", "zombie", "pollution"
- Synonyms: "timeout/hang/freeze", "cleanup/teardown/afterEach"
- Tools: Actual commands, library names, file types

## 3. Rules checklist

- Starts with "Use when" ("Use ONLY when the user explicitly asks" for heavyweight process skills)
- Third person; lists concrete triggers (symptoms, phrases, file names, error text)
- Ends with "NOT for <sibling skill>" where confusion is possible
- No workflow summary: nothing an agent could follow instead of reading the body
- Under 500 characters (lint warns); 1024 is the hard limit (lint errors)
- Quoted as a YAML string if it contains `: `
