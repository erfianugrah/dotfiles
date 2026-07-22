/**
 * skill-guard - actively nudge the model toward a matching skill BEFORE it
 * proceeds with trained-default behavior.
 *
 * Why this exists:
 *   Pi skills are passive progressive-disclosure. Only the one-line
 *   descriptions sit in context; loading the SKILL.md is a voluntary `read`
 *   the model often skips. Pi's own docs/skills.md says so verbatim: "models
 *   don't always do this; use prompting or /skill:name to force it".
 *
 *   The miss rate is worst for skills that overlap the model's TRAINED
 *   behavior (git, docker, terraform, fly): the built-in default
 *   out-competes the registered skill. Cross-harness evidence:
 *   anthropics/claude-code#30387 ("Custom skills are not reliably
 *   auto-triggered by the model", closed not-planned) reports ~50% miss on
 *   trained-overlap skills while novel-tool skills fire reliably. The
 *   community fix there is a UserPromptSubmit / PreToolUse hook that
 *   pattern-matches and injects a hard "invoke the X skill" nudge - exactly
 *   how tool-guard converts prompt rules into runtime blocks.
 *
 * Two hooks:
 *   before_agent_start (intent) - match the user's prompt; inject a
 *     NON-BLOCKING message pointing at the skill.
 *   tool_call (action) - when about to write/edit a file (or run a command)
 *     whose type maps to a skill, block ONCE with a nudge, then let the retry
 *     through. `block` is the only lever tool_call exposes, so we reuse the
 *     docs_first "block once, mark session, pass on retry" pattern.
 *
 * Design constraints (from operators running the equivalent Claude Code hooks
 * in prod, and from tool-guard's own conventions):
 *   - Pointer, not payload: inject "read <name>", never the skill body
 *     (avoids context bloat across ~39 skills).
 *   - One-shot per skill per session: a nudge you see every turn is a nudge
 *     you learn to ignore (same lesson as over-hedging).
 *   - Cheap matching: static regex maps, no disk walk on the hot path.
 *   - High precision over coverage: a false nudge trains the model to ignore
 *     the channel. Seed rules are deliberately narrow.
 *
 * Disable a rule by ID via DISABLED below, or the whole extension by renaming
 * the file to skill-guard.ts.disabled.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Rule IDs (for DISABLED):
//   intent:  scaffold_new_project, sa_pov, fly_intent, gh_intent
//   path:    compose_infra, dockerfile_docker, terraform_tf, quarto_qmd, caddyfile
//   bash:    flyctl_fly, terraform_cmd, wrangler_cf, supabase_cli
const DISABLED: Set<string> = new Set();

const SKILLS_DIR = "~/.pi/agent/skills";

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

export function intentMessage(hints: SkillHint[]): string {
  const lines = hints.map(
    (h) => `- \`${h.skill}\` (${SKILLS_DIR}/${h.skill}/SKILL.md): ${h.why}`,
  );
  return (
    `skill-guard: your request matches ${hints.length === 1 ? "a skill" : "these skills"} that the model tends to skip. ` +
    `Read the SKILL.md (or /skill:${hints[0].skill}) before proceeding - pointer only, do not freelance the trained default:\n` +
    lines.join("\n")
  );
}

export function actionReason(hint: SkillHint): string {
  return (
    `skill-guard[${hint.id}]: this touches the \`${hint.skill}\` skill's domain - ${hint.why}. ` +
    `Read ${SKILLS_DIR}/${hint.skill}/SKILL.md (or /skill:${hint.skill}) first, then retry. ` +
    `This nudge fires once per session.`
  );
}

// ---- Extension registration ----------------------------------------------

export default function (pi: ExtensionAPI) {
  // Fired skills, keyed by session file so /new starts fresh. Skill name is
  // the dedup unit: once we've nudged for `fly` this session (via intent OR
  // action OR bash), we don't nudge for it again.
  const firedBySession = new Map<string, Set<string>>();

  const sessionKey = (ctx: unknown): string => {
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string } })
        .sessionManager;
      return sm?.getSessionFile?.() ?? "default";
    } catch {
      return "default";
    }
  };
  const firedSet = (key: string): Set<string> => {
    let s = firedBySession.get(key);
    if (!s) {
      s = new Set();
      firedBySession.set(key, s);
    }
    return s;
  };

  pi.on("session_shutdown", async (_event, ctx) => {
    firedBySession.delete(sessionKey(ctx));
  });

  // Intent path: non-blocking message injection.
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = (event as { prompt?: string }).prompt ?? "";
    const hints = matchIntent(prompt);
    if (hints.length === 0) return undefined;

    const fired = firedSet(sessionKey(ctx));
    const fresh = hints.filter((h) => !fired.has(h.skill));
    if (fresh.length === 0) return undefined;
    for (const h of fresh) fired.add(h.skill);

    return {
      message: {
        customType: "skill-guard",
        content: intentMessage(fresh),
        display: true,
      },
    };
  });

  // Action path: block once with a nudge, then pass on retry.
  pi.on("tool_call", async (event, ctx) => {
    const e = event as {
      toolName: string;
      input: {
        path?: string;
        file_path?: string;
        command?: string;
        patchText?: string;
      };
    };
    const fired = firedSet(sessionKey(ctx));

    let hint: SkillHint | null = null;

    if (e.toolName === "write" || e.toolName === "edit") {
      const p = e.input.path ?? e.input.file_path;
      if (typeof p === "string") hint = matchPath(p);
    } else if (e.toolName === "apply_patch") {
      for (const p of extractPatchPaths(e.input.patchText ?? "")) {
        hint = matchPath(p);
        if (hint) break;
      }
    } else if (e.toolName === "bash") {
      if (typeof e.input.command === "string") hint = matchBash(e.input.command);
    }

    if (!hint) return undefined;
    if (fired.has(hint.skill)) return undefined; // already nudged this session

    fired.add(hint.skill);
    return { block: true, reason: actionReason(hint) };
  });
}
