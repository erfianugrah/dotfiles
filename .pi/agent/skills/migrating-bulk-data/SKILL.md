---
name: migrating-bulk-data
description: Use when moving large data sets (100GB+) between machines or disks where the source gets wiped or reused afterward and correctness must be proven first - NAS rebuilds, disk replacements, server consolidation, array-to-ZFS moves, staging through an intermediate drive. Fires on "migrate the array", "copy everything before wiping", "verify the copy is correct", "are we certain it is all there", "stage then wipe", "move X TB to the new box". Primary tool is migctl (~/infra/migctl); scripts/ are the independent fallback/checker. NOT for same-machine directory/repo moves (relocating-repos) or ongoing backup setup (compose-backups).
---

# Migrating Bulk Data with Proof

## Overview

Moving terabytes is easy. PROVING every byte arrived before destroying the
source is the job. Core principle: **verification is a separate, proven
activity - not a side effect of the transfer tool, and not trusted until it
has caught corruption you planted yourself.**

## The pipeline

```
inventory -> manifest (keep/skip) -> stage -> fixture-test the verifier
-> verify (two passes) -> gate: human confirms -> only then: reuse/wipe source
```

1. **Inventory the source.** Per-share sizes and file counts. Know the total
   before choosing capacity.
2. **Batch by priority when dest capacity < source total.** Irreplaceable
   first (personal data, configs, DBs), re-downloadable last. Write a
   keep/skip manifest the human marks up - never decide what to drop yourself.
3. **Stage.** Pull from the surviving machine (jobs die with the box being
   retired). Parallel rsync per share. Log per share.
4. **Fixture-test the verifier BEFORE trusting it.** Plant the three failure
   modes, confirm your verify pass catches each. See scripts/probe-verifier.sh.
5. **Verify, two passes.** P1: size+mtime (fast, catches truncated/missing).
   P2: full content (slow, catches silent corruption). Both must pass.
6. **Gates are human.** Every irreversible action (wipe, pool create over old
   data, source shutdown) waits for explicit confirmation. Never chain an
   irreversible step to an automated check.

## Failure modes vs passes (validated empirically 2026-08-22)

| Failure mode | Transfer itself | P1 size+mtime | P2 content |
|---|---|---|---|
| In-flight corruption | CAUGHT (rsync whole-file checksum, always on) | - | - |
| Truncated / missing file | fixed on re-run | CAUGHT | caught |
| Same size+mtime, different bytes | skipped silently | **MISSED** | CAUGHT |
| Pre-existing corruption on SOURCE | **copied faithfully, undetectable anywhere** | - | - |

The last row has no fix from the receiving side. If source integrity matters,
scrub/SMART-check the source array BEFORE migrating, and prefer reading from
redundant views (parity-emulated disks self-validate on every read).

`rsync -c` changes only the SKIP heuristic, not transfer integrity (verified:
archwiki Rsync.md - "a checksum is always used for the block-based file
construction"). P2 exists to reconcile files that were already sitting on the
dest in a same-size-wrong-bytes state - which is exactly what interrupted
`--ignore-existing` runs leave behind. NEVER use `--ignore-existing` for the
primary copy of irreplaceable data; it trusts existence over correctness.

## Verification tool selection

| Situation | Tool |
|---|---|
| Tree-to-tree, need permanent proof artifact | per-side sha256 manifest + diff (scripts/manifest.sh) |
| Tree-to-tree, self-healing re-verify | rsync -c (scripts/verify.sh) |
| Tree-to-tree, want parallelism + structured reports | rclone check --one-way --download --checkers=16 |
| ZFS -> ZFS | zfs send/recv (self-checksummed, resumable, incremental; syncoid wraps it) - the separate verify pass disappears |
| Backup repo as dest | restic check --read-data / borg check --verify-data (slow; ~40MB/s seen on 3.4TB) |

After verification passes on a ZFS dest: `zpool scrub <pool>` once so at-rest
state is freshly validated too.

## Operational patterns

- **Everything under tmux/nohup with per-share logs.** Sessions die; work must not.
- **Structured verdicts, not log greps.** Verify script writes PASS/FAIL per
  share with the transferred-file count. Grep for the verdict line only.
- **Progress via /proc/<pid>/io read_bytes** for long local checksums - the
  rsync log can't tell you how far through a dry-run it is.
- **Quiesce the source** before the final verify pass (stop writers), or the
  proof is invalidated by writes that land after their file was verified.
- **Metadata beyond bytes:** symlink lists, hardlink groups, empty dirs, file
  counts - content hashes miss all of these. LC_ALL=C on both sides or sort
  order breaks manifest diffs spuriously.
- **Re-runs are fix-forward and idempotent.** A non-zero transferred count in
  P2 means files were repaired; re-run until clean, then the gate is real.

## Tooling: migctl (primary) + shell scripts (fallback/checker)

**migctl** (`~/infra/migctl`, deployed at `/root/migctl` on the dest box) is the
primary tool. It is this skill's executable form: plan.json declaration +
append-only events.jsonl state + folded status. Verdicts are parsed from rsync
`--stats`, never rc.

```
migctl init/validate/inventory/probe/run/status/coverage/gate/report/note/stop
```

Key behaviors: `probe` fixture-tests the verifier before any p2 run; `run` audit
is dry-run proof, `--repair` is a full reconciliation (never `--ignore-existing`);
`coverage` is the union-of-sources vs dst set diff (missing + extras) that
answers "is everything there"; `gate` prints CLEAR/BLOCKED and never executes.

### The shell scripts as independent fallback/checker

Keep scripts/ as the *independent* check on migctl, not replaced by it. When a
migctl verdict is load-bearing (a wipe gate), re-derive it with the raw tool:

- **migctl `probe`** == probe-verifier.sh. If migctl's probe and the script ever
  disagree, trust neither until reconciled.
- **migctl `run` verdict** == verify.sh's `Number of regular files transferred`
  grep. Spot-check a PASS by hand-grepping migctl's own log in
  state_dir/logs/ for a non-zero transferred count.
- **migctl `coverage` missing/extra** == a manual `find src -type f -printf '%P\n'
  | sort` on both sides + `comm`. coverage is metadata-only; bytes are p2's job.
- **Permanent proof artifact**: scripts/manifest.sh (per-side sha256 + diff).
  migctl has no manifest command yet - use the script when a durable hash record
  is required before a wipe.

The scripts never lie about what rsync did; migctl orchestrates and records.
Cross-check before every irreversible action.

| Script | Purpose | migctl equivalent |
|---|---|---|
| scripts/stage.sh | Parameterized parallel rsync pull, per-share logs | (staging is upstream of migctl; `run` is verify+reconcile, not the first copy) |
| scripts/verify.sh | Two-pass verify, PASS/FAIL verdict lines, fix-forward | `migctl run` (audit) / `run --repair` |
| scripts/probe-verifier.sh | Plants truncated/missing/silent-corruption fixtures | `migctl probe` |
| scripts/manifest.sh | sha256 manifests both sides + diff (permanent proof) | none - use the script |

Run the probe output (migctl or script) as the FIRST evidence in every
migration's docs. A verifier that has never caught anything is an assumption,
not a control.

## Common mistakes

- Trusting P1 alone: it is blind to same-size corruption (proven by fixture).
- `--ignore-existing` to "speed up" re-runs: creates the exact gap P2 must close.
- Chaining wipe commands after `&&`-ed checks: gates are human, always.
- Verifying while the source is still being written to.
- Parallel rsync of many shares against a single failing disk: watch iostat;
  degraded arrays amplify seek thrash.
- Declaring a share DONE from a command's exit code instead of its recorded
  PASS/FAIL verdict line. (Distinct from the WAITER commands: `migctl
  scrub-wait`/`expand-wait`/`scrub-status`/`expand-status` deliberately exit
  non-zero WHILE running so `expand-wait && expand <next-disk>` chains off the
  signal - that is a control signal, not a completion verdict.)
- Attaching the next expansion disk before the reflow finishes, or recording a
  scrub/expansion that never ran: `migctl scrub-record`/`expand-record` PASS
  only on positive evidence (a matched completed line, 0 errors) - `scan: none
  requested` or a canceled scrub is refused, never a silent PASS.

## Done criteria (all required)

1. Fixture test on file: verifier demonstrably catches all three failure modes.
2. P1 clean and P2 clean for every share (transferred=0, or re-run until 0).
3. File counts + metadata manifests match.
4. Dest scrub clean (ZFS) or SMART long test (non-ZFS).
5. Source quiesced since verification started.
6. Human has explicitly confirmed each irreversible action.

Cooling-off: keep the source intact and powered until the data has been USED
from the dest for days. Hash diffs don't surface "where did my sidecar files
go" - only usage does.