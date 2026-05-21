---
description: Guided AGENTS.md setup tailored to this repo
argument-hint: "[focus or constraint]"
---

Create or update `AGENTS.md` for this repository.

The goal is a compact instruction file that helps future Pi sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.

User-provided focus or constraints (honor these):
$ARGUMENTS

## How to investigate

Read the highest-value sources first:
- `README*`, root manifests, workspace config, lockfiles (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`)
- build, test, lint, formatter, typecheck, codegen, and migration configs
- CI workflows (`.github/workflows/`, `.gitlab-ci.yml`) and pre-commit / task runner config
- existing instruction files: `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`
- repo-local Pi config: `.pi/agent/AGENTS.md`, `.pi/extensions/`, `opencode.json` (if present)

Cross-reference with the docs server when stack is identified — `docs.erfi.io` has 158 sources covering most things (postgres, nextjs, rust, supabase, kubernetes, etc.). Cite them like `[docs: postgres → ddl-rowsecurity]` if a non-obvious behaviour is worth pointing to.

If architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow. Prefer reading files that explain how the system is wired together over random leaf files.

Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust the executable and only keep what you can verify.

## What to extract

Highest-signal facts for an agent working in this repo:

- exact developer commands, especially non-obvious ones (`pnpm test:e2e` needs Docker, etc.)
- how to run a single test, a single package, or a focused verification step
- required command order when it matters: `lint → typecheck → test`, `migrations → seed → start`
- monorepo or multi-package boundaries, ownership of major directories, real app/library entrypoints
- framework or toolchain quirks: generated code, migrations, codegen, build artifacts, special env loading, dev servers, infra deploy flow
- testing quirks: fixtures, integration prerequisites, snapshot workflows, required services, flaky or expensive suites
- repo-specific conventions that **differ from defaults** — defaults aren't worth documenting
- gotchas you wish you'd known: ESM-only imports, auto-generated files that shouldn't be edited, files where Edit corrupts past 100KB (opencode#19604)

## What to leave out

- generic best practices ("write tests", "use TypeScript")
- things obvious from the file structure ("controllers/ holds controllers")
- corporate boilerplate (license, contributing) — link don't restate
- anything that would be re-discovered in <30s by reading one file

## Format

Terse. Use tables where dense lookup helps. Inline `code spans` for commands/paths. Match the user's existing AGENTS.md style if one already exists.

## After writing

- Run the actual commands you put in the file. If `pnpm test` doesn't exist, don't claim it does.
- If the repo already has an AGENTS.md, treat your work as a diff — preserve correct existing content, fix only what's wrong or missing.
- If you find conflicting info (CI says X, README says Y), pick the executable truth and explicitly note the discrepancy in the AGENTS.md so future agents don't re-step on it.
