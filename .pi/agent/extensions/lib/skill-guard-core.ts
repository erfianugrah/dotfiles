/**
 * skill-guard-core - pure skill-matching logic. ZERO harness imports. Source of
 * truth for both the pi adapter (../skill-guard.ts, before_agent_start +
 * tool_call hooks) and the Claude Code hooks (../../../.claude/hooks/
 * skill-guard.ts).
 *
 * Why this exists (verbatim from the original skill-guard.ts):
 *   Skills are passive progressive-disclosure. Only the one-line descriptions
 *   sit in context; loading the SKILL.md is a voluntary read the model often
 *   skips - worst for skills that overlap the model's TRAINED behavior (git,
 *   docker, terraform, fly). The community fix (anthropics/claude-code#30387)
 *   is a UserPromptSubmit / PreToolUse hook that pattern-matches and injects a
 *   hard "invoke the X skill" nudge.
 *
 * The pure surface here is: the three rule tables, the three matchers
 * (matchIntent / matchPath / matchBash), the apply_patch path extractor, and
 * the two nudge-text builders. Everything harness-specific (session dedup,
 * event plumbing, hookSpecificOutput shape) lives in the adapters.
 */

// Rule IDs (for DISABLED):
//   intent:  scaffold_new_project, sa_pov, fly_intent, gh_intent
//   path:    compose_infra, dockerfile_docker, terraform_tf, quarto_qmd, caddyfile
//   bash:    flyctl_fly, terraform_cmd, wrangler_cf, supabase_cli
export const DISABLED: Set<string> = new Set();

// Skill location on disk. pi uses ~/.pi/agent/skills; CC uses ~/.claude/skills.
// The pointer string is cosmetic (it tells the model where to read); the pi
// adapter and the CC hook can each override it if they want a harness-native
// path, but the default matches the pi extension's original text.
export const SKILLS_DIR = "~/.pi/agent/skills";

export interface SkillHint {
  id: string;
  skill: string;
  why: string;
}

interface Rule {
  id: string;
  skill: string;
  test: RegExp;
  why: string;
}

// ---- Intent rules (matched against the user's prompt) --------------------
// Narrow, high-precision phrases only. These skills lose to trained defaults
// or are heavyweight workflows the model tends to freelance instead of load.
const INTENT_RULES: Rule[] = [
  {
    id: "scaffold_new_project",
    skill: "scaffold-new-project",
    test: /\bscaffold\b|\bbootstrap\b|\b(create|start|set up|spin up|build)\s+(a\s+)?new\s+(project|app|service|tool|site|dashboard|repo)\b/i,
    why: "orchestrates the user's stack defaults (frontend-stack, infra, design, ci) instead of an ad-hoc question loop",
  },
  {
    id: "sa_pov",
    skill: "sa-pov",
    test: /\bpo[vc]\b|\bproof[- ]of[- ](value|concept)\b|\bkickoff doc\b|\bsuccess criteria\b|\bsolution runbook\b/i,
    why: "the PoV/PoC methodology: scope criteria, validate live (not from docs), package for the customer",
  },
  {
    id: "fly_intent",
    skill: "fly",
    test: /\bfly\.io\b|\bflyctl\b|\bfly\s+deploy\b|\bfly\s+(machine|app|secret|volume|cert)s?\b/i,
    why: "flyctl lifecycle, secrets-from-Vaultwarden workflow, machines-vs-apps, the PROXY-on-TCP trap",
  },
  {
    id: "gh_intent",
    skill: "gh",
    test: /\b(pull request|open (a|the) pr|create (a|the) pr|gh pr|gh release|draft a release|cut a release|gh issue)\b/i,
    why: "token-efficient --json/--jq PR/issue/release patterns and the no-AI-attribution commit rule",
  },
];

// ---- Path rules (matched against write/edit/apply_patch target paths) -----
const PATH_RULES: Rule[] = [
  {
    id: "compose_infra",
    skill: "infrastructure-stack",
    test: /(^|\/)(docker-)?compose\.ya?ml$/i,
    why: "the bridge-network + static-IP + host-mode-Caddy conventions across the user's ~12 compose stacks",
  },
  {
    id: "dockerfile_docker",
    skill: "docker",
    test: /(^|\/)Dockerfile(\.[\w-]+)?$/,
    why: "buildx multi-arch + cache-mount + BuildKit-secret patterns and ghcr.io registry workflow",
  },
  {
    id: "terraform_tf",
    skill: "terraform",
    test: /\.tf(vars)?$/i,
    why: "OpenTofu-preferred module layout, SOPS+age secrets, provider pinning, import workflow",
  },
  {
    id: "quarto_qmd",
    skill: "quarto",
    test: /\.qmd$/i,
    why: "_quarto.yml config, multi-format output, freeze/cache, and the revealjs slide-overflow gotchas",
  },
  {
    id: "caddyfile",
    skill: "caddy",
    test: /(^|\/)Caddyfile$/,
    why: "the xcaddy plugin set, snippet idiom, TSIG/rfc2136 chain, and make restart vs restart-caddy SOPS footgun",
  },
];

// ---- Bash rules (matched against the bash command) ------------------------
const BASH_RULES: Rule[] = [
  {
    id: "flyctl_fly",
    skill: "fly",
    test: /\bflyctl\b|\bfly\s+(deploy|launch|secrets|machines?|apps?|volumes?|certs?|scale)\b/,
    why: "flyctl lifecycle, secrets-from-Vaultwarden workflow, machines-vs-apps, cost/auto-stop patterns",
  },
  {
    id: "terraform_cmd",
    skill: "terraform",
    test: /\b(terraform|tofu)\s+(plan|apply|init|import|destroy|state)\b/,
    why: "OpenTofu module layout, state backends, SOPS+age secrets, cf-terraforming import workflow",
  },
  {
    id: "wrangler_cf",
    skill: "cloudflare",
    test: /\bwrangler\s+[a-z]/,
    why: "wrangler Workers/Pages/R2/D1/KV/Queues patterns, token scoping, Durable Object idioms",
  },
  {
    id: "supabase_cli",
    skill: "supabase",
    test: /\bsupabase\s+(db|migration|functions|start|link|gen)\b/,
    why: "CLI + migrations, RLS/auth patterns, SSR client wiring, edge functions",
  },
  {
    // The 2026-08-30 rustnzb miss: agent said "composerd runs there" and still
    // ran `ssh servarr 'docker compose ... up -d rustnzb'` against a path that
    // exists only on the router. docker is trained-default behavior, so it
    // out-competes the composer skill exactly as this file's header predicts.
    // Read-only verbs (ps/logs/inspect/stats) are deliberately NOT matched -
    // those are fine over raw ssh and nudging them would train the model to
    // ignore the channel.
    id: "composer_stack_compose",
    skill: "composer",
    test: /\bssh\s+\S*(servarr|router)\S*\s+[\s\S]{0,200}?\bdocker\s+compose\s+(?:-[^\s]+\s+\S+\s+)*(up|down|restart|build|pull|rm|stop|start|create)\b/,
    why: "these stacks are composer-managed: the compose checkout lives on the ROUTER (/var/lib/composer/stacks/<name>, container view /opt/stacks/<name>) even for servarr-host stacks, so raw ssh+compose hits a nonexistent path AND bypasses SOPS decryption + the per-stack lock. Lifecycle goes through POST /stacks/{name}/{up,down,restart}?async=true; ad-hoc commands (force-recreate) through POST /stacks/{name}/exec with {\"command\": \"up -d --force-recreate <svc>\"}",
  },
];

// ---- Pure matchers (exported for unit tests) ------------------------------

/** All intent skills whose trigger fires for this prompt (DISABLED filtered). */
export function matchIntent(prompt: string): SkillHint[] {
  if (!prompt) return [];
  const out: SkillHint[] = [];
  for (const r of INTENT_RULES) {
    if (DISABLED.has(r.id)) continue;
    if (r.test.test(prompt)) out.push({ id: r.id, skill: r.skill, why: r.why });
  }
  return out;
}

/** First path rule that fires for this target path, or null. */
export function matchPath(path: string): SkillHint | null {
  if (!path) return null;
  for (const r of PATH_RULES) {
    if (DISABLED.has(r.id)) continue;
    if (r.test.test(path)) return { id: r.id, skill: r.skill, why: r.why };
  }
  return null;
}

/** First bash rule that fires for this command, or null. */
export function matchBash(command: string): SkillHint | null {
  if (!command) return null;
  for (const r of BASH_RULES) {
    if (DISABLED.has(r.id)) continue;
    if (r.test.test(command)) return { id: r.id, skill: r.skill, why: r.why };
  }
  return null;
}

/** apply_patch envelope path extraction (Add/Update/Delete/Move File: lines). */
export function extractPatchPaths(patchText: string): string[] {
  if (!patchText) return [];
  const paths: string[] = [];
  for (const line of patchText.split("\n")) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete|Move) File: (.+?)(?:\s+->\s+(.+))?$/);
    if (m) {
      if (m[1]) paths.push(m[1].trim());
      if (m[2]) paths.push(m[2].trim());
    }
  }
  return paths;
}

// ---- Nudge text builders (exported for unit tests) ------------------------

export function intentMessage(hints: SkillHint[], skillsDir: string = SKILLS_DIR): string {
  const lines = hints.map(
    (h) => `- \`${h.skill}\` (${skillsDir}/${h.skill}/SKILL.md): ${h.why}`,
  );
  return (
    `skill-guard: your request matches ${hints.length === 1 ? "a skill" : "these skills"} that the model tends to skip. ` +
    `Read the SKILL.md (or /skill:${hints[0].skill}) before proceeding - pointer only, do not freelance the trained default:\n` +
    lines.join("\n")
  );
}

export function actionReason(hint: SkillHint, skillsDir: string = SKILLS_DIR): string {
  return (
    `skill-guard[${hint.id}]: this touches the \`${hint.skill}\` skill's domain - ${hint.why}. ` +
    `Read ${skillsDir}/${hint.skill}/SKILL.md (or /skill:${hint.skill}) first, then retry. ` +
    `This nudge fires once per session.`
  );
}

// ---- Harness-agnostic orchestrator ---------------------------------------

export type CcToolName = "Write" | "Edit" | "MultiEdit" | "Bash" | string;

/**
 * Resolve a single skill hint for a Claude Code PreToolUse tool call, given the
 * tool name and its input object. Mirrors the pi tool_call branch logic:
 *   - Write/Edit/MultiEdit -> match the target file_path against PATH_RULES
 *   - Bash                  -> match the command against BASH_RULES
 * Returns null when nothing matches. Session-dedup is the caller's job.
 */
export function matchToolCall(toolName: CcToolName, input: Record<string, unknown>): SkillHint | null {
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const p = input.file_path ?? input.path;
    if (typeof p === "string") return matchPath(p);
    return null;
  }
  if (toolName === "Bash") {
    const cmd = input.command;
    if (typeof cmd === "string") return matchBash(cmd);
    return null;
  }
  return null;
}
