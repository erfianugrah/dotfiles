# The governor: how the loop works

Read this when you want to know what the loop does between iterations -
checkpoint, rollback, scope fence, ref/index guards, budgets, sandbox,
escalation - or why a run behaved the way it did. SKILL.md has the quick start
and the manifest reference; this is the mechanism underneath.

Contents:
- The mechanism (pseudocode)
- The governor around the bare loop (each mechanism, and the failure it exists for)
- Two properties that make it work on weak models (fresh context; the sensor is the judge; standing anti-cheat guardrails and what the A/B measured)

## The mechanism

```
checkpoint = git index (best known good)
repeat until every sensor exits 0, OR maxIterations spent:
    pi -p  <task + previous iteration's failing sensor output + loop notes
            + rolled-back attempt history (negative knowledge)>
    jail the agent (bwrap: ro /, rw repo+tmp, overlayfs on ~/.pi/agent,
        masked ~/.ssh et al) - unless sandbox: "off"
    undo any agent-run git commit/reset (HEAD back + checkpoint restored)
    re-impose the checkpoint index (index-guard)
    revert any edits outside writeScope
    run sensors (build / vet / test / tsc / clippy / astro check ...)
        each under a wall-clock budget + optional cgroup caps
    all pass?       -> STOP, success                 (deterministic gate)
    fewer failures? -> checkpoint (keep), continue
    stalled/worse?  -> ROLL BACK to checkpoint; on repeated stalls, escalate
                       to the next model on the ladder
    append a per-iteration record to .pi/harness-report.json
```

The governor around the bare loop (all deterministic, no extra model calls):

- **git checkpoint + regression rollback** - the git index is the best-known-
  good state. An iteration that increases the failing-sensor count (or makes no
  progress) is reverted, so the loop can never degrade the tree.
- **write-scope enforcement** - `writeScope` globs fence what the agent may
  touch; out-of-scope edits are reverted each iteration. This structurally
  kills the test-weakening cheat (keep tests outside the scope) and replaces
  hand-written "integrity" guard sensors.
- **ref-guard** - if the agent runs `git commit`/`git reset` mid-iteration
  (plan docs often instruct per-task commits), the move is undone before the
  footprint capture: HEAD back to the checkpoint. Without this a commit made
  the fence blind (worktree == index = "nothing changed") and baked
  out-of-scope edits into history - observed live on 2026-07-25 in the eaves
  loop run. The iteration prompt also forbids git ref mutations outright.
- **index-guard** - the checkpoint index is re-imposed from its `write-tree`
  snapshot after EVERY iteration (no-op for honest agents). Neutralizes the
  HEAD-preserving attacks: `git reset --hard` / `git checkout -- .` (destroy
  the staged-but-uncommitted checkpoint), `git update-index --skip-worktree`
  (hides a tracked file from `git diff` = fence evasion), and `git stash`
  (hides work from sensors; detected via refs/stash and surfaced as a loop
  note). Tests A/B in loop-index-guard.integration.test.ts are proven to
  fail with the guard disabled.
- **wall-clock budgets** - every sensor gets `timeoutMs` (default 600s,
  per-sensor override) and every agent iteration gets `agentTimeoutMs`
  (default 1800s). A process that exceeds its budget is KILLED and reported as
  a failure, never as a hang. Both spawn sites were previously unbounded, so a
  wedged suite or a stuck `pi -p` stalled the run with no rollback, no
  escalation and no report entry. The kill goes through GNU `timeout`, which
  signals the process GROUP - Bun's native spawn timeout reaps only the direct
  child, leaving grandchildren alive holding the inherited stdout pipe (so
  nothing reading the loop's output ever sees EOF), plus ports and disk.
  Verified in `loop-timeout.integration.test.ts`; the orphan count on a wedged
  agent went 1 -> 0 with the group kill.
- **PID-namespace containment for the sandboxed agent** - the jail adds
  `--unshare-pid`, so bwrap is PID 1 of a namespace the kernel tears down
  whole when it exits. This is NOT redundant with the group kill: bwrap's
  `--new-session` calls `setsid(2)`, which moves the sandbox out of the
  process group GNU `timeout` signals, so the deadline reaps bwrap and
  leaves its descendants running. Found 2026-08-04 when a killed agent kept
  editing a repo for 11 more minutes - the worst failure this loop can have,
  because the governor's checkpoint/rollback accounting no longer covers it
  and the survivor works from stale sensor feedback. `--proc` was already
  present and is only correct inside a new PID namespace anyway.
- **resource limits** *(Bun)* - optional `limits` (`memoryMax` / `cpuQuota` /
  `tasksMax`) wraps each sensor in a transient `systemd-run --user --scope`
  cgroup. Sensors run OUTSIDE the bwrap jail, so nothing else bounds them; the
  Bun run crashed its machine repeatedly on tests that exhausted memory,
  sockets and disk before they reached for cgroups. The scope also makes the
  timeout kill tree-wide by construction.
- **model escalation ladder** - start on the cheapest model; climb a rung after
  `stallPatience` consecutive no-progress iterations. Strength on demand.
- **agent sandbox (bwrap)** - the writeScope fence is repo-scoped; the jail
  covers the rest of the filesystem. `/` is read-only, only the repo cwd and
  /tmp are writable, and `~/.pi/agent` sits under an overlayfs copy-on-write
  mount: pi can write its locks/session files (discarded at exit - loop agent
  sessions never pollute the FTS index), but extensions/skills/auth/settings
  are untouchable, including the stow symlink chain (plain rw-bind + per-file
  ro-binds can't do this - bwrap can't mount over absolute symlink chains, and
  per-file binds don't stop symlink REPLACEMENT). Secret dirs (~/.ssh,
  ~/.gnupg, ~/.aws, ~/.kube, ~/.config/gh) are masked with tmpfs (resolved
  through symlinks). Network stays up - pi needs the model gateway. Sensors
  and the judge run OUTSIDE the jail (operator-configured, trusted).
- **negative-knowledge history** - each iteration's touched files are recorded
  BEFORE any revert, and rolled-back attempts are injected into later prompts
  ("Previous approaches that were rolled back - do not repeat them"). A fresh
  `pi -p` otherwise can't tell a dead end from an untried path, so it can
  re-attempt the exact approach iteration N-3 already proved wrong.
  `formatAttemptHistory` caps the block at the 5 most recent rolled-back
  attempts and truncates long file lists, so the prompt stays sharp.
- **standing rules, hot-reloaded** *(Bun)* - `rules` is appended verbatim to
  every prompt and RE-READ from the manifest between iterations, so a human
  watching a run can correct the loop without killing it. This is the article's
  central operating discipline made mechanical: when the output is wrong, fix
  the process that generates the code, not the code. ("Claude interpreted 'get
  all the crates to compile' as 'stub out the functions'... one prompt edit and
  a few hours later, these things stopped happening.") Only `rules` and `guide`
  are hot - changing sensors or scope mid-run would invalidate the checkpoint
  and progress accounting.
- **binding conventions** *(Bun)* - `guide` lists paths the agent must read
  first (a porting guide, a lifetimes table, an interface spec). Because each
  iteration is a fresh `pi -p`, an on-disk guide is the ONLY channel that
  carries conventions across iterations. The Bun run spent ~3h producing
  `PORTING.md` and a per-struct-field `LIFETIMES.tsv`, adversarially reviewed
  *the documents* before writing any code, and checked every implementer
  against them. Paths are injected, not contents, so a large guide does not
  bloat every prompt.
- **run report** - `.pi/harness-report.json` records model, failing-count
  trend, kept/rolled-back, escalations, scope violations, changed files,
  per-sensor durations, and timeout flags (`timedOut`, `agentTimedOut`) per
  iteration.

Two properties make this work on weak models:

1. **Fresh context per iteration.** Each `pi -p` is a new session. State lives
   in the *filesystem* (the model's prior edits) plus the *injected sensor
   feedback* - never in a bloating conversation that drifts. A weak model with
   a small, sharp prompt beats a strong model with a polluted 200-turn context.
2. **The sensor is the judge.** `go test` exit code is not negotiable. The
   model cannot hallucinate green. `buildPrompt` also injects anti-cheat
   guardrails because gaming the sensor is the #1 weak-model failure mode.
   The list is empirical, not imagined - test-weakening and git-ref mutation
   came from this loop's own runs, and two more come from the Bun rewrite:
   - *no stubbing*: "let's get all the crates to compile" was read as "stub out
     the functions with compilation errors". A build sensor is trivially
     satisfied by `unimplemented!()` / `throw new Error("not implemented")`, so
     the prompt states that a check satisfied by a stub is a FAILED iteration.
   - *no justifying essays*: "If you need a paragraph-long comment to justify
     why the workaround is OK, the code is wrong - fix the code." Used verbatim
     as a reviewer rejection rule; long explanatory comments turned out to be a
     reliable tell for a bad workaround.

   **These guardrails are STANDING - they render on every iteration including
   the first.** They used to live only inside the failure-feedback block, so a
   task the model one-shot received *no guardrails at all*: the iteration-1
   prompt was literally the task string. Found 2026-08-04 by an A/B that
   returned a null because every run converged in one iteration and the rule
   under test was never in the prompt. "Don't weaken tests" is a property of
   how the loop works, not advice about a particular failure. Only the two
   genuinely failure-scoped lines ("don't touch code unrelated to these
   failures", "make the smallest change") stay in the feedback block.

   **Measured effect of the anti-stub rule: none, at this difficulty.** A/B on
   a build-only gate (8 specified functions, `go build` fully satisfiable by
   stubs, hidden acceptance suite scoring the result), 3 runs per arm on
   claude-haiku-4-5: *identical* 8/8 hidden pass, 0 stub markers, 1 iteration,
   in both arms. Controls were sound - a correct implementation scores 8/8,
   pure stubs score 0/8 and still pass the gate. So the rule is unfalsified
   but unproven as a behaviour-changer: the model simply did not want to stub
   8 well-specified textbook functions. The Bun case that motivated it was a
   16,000-error Rust port where implementing correctly was genuinely hard, and
   that difficulty is the variable this experiment could not reproduce.

   Practical consequence: **treat the prompt rule as free but unproven, and
   rely on the `no-stubs` counter sensor for the actual guarantee.** A prompt
   rule is unenforceable by construction; a counter is a gate. If you only
   have budget for one, take the sensor. Harness for re-running the A/B at
   higher difficulty: `~/.local/share/loop-validation/build-gate/`.

