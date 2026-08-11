/**
 * oci-tags-core - pure OCI registry tag logic, ZERO harness imports.
 *
 * Source of truth for both the pi adapter (../oci-tags.ts, defineTool) and the
 * Claude Code MCP adapter (../../../.claude/mcp/toolkit.ts). Uses only global
 * `fetch`, so it runs unmodified under pi, an MCP server, or `bun test`.
 *
 * Extracted from oci-tags.ts (2026-08-11) as the first vertical slice of the
 * dual-harness port; see .pi/agent/docs/pi-to-claude-code-port.md.
 */

// -- registry parse ----------------------------------------------------------

// Exported for unit tests.
export function parseImage(image: string): { registry: string; repo: string } {
  // Strip @digest and :tag suffixes
  const clean = image.replace(/@.*$/, "").replace(/:([^/]*)$/, "");
  const first = clean.split("/")[0];
  // No slash -> Docker Hub library/ namespace
  if (!clean.includes("/")) return { registry: "registry-1.docker.io", repo: `library/${clean}` };
  // First segment looks like a hostname (has dot/colon) -> use as registry
  if (first.includes(".") || first.includes(":")) {
    return { registry: first, repo: clean.slice(first.length + 1) };
  }
  // Otherwise treat first segment as Docker Hub org/user
  return { registry: "registry-1.docker.io", repo: clean };
}

// -- bearer token via www-authenticate challenge -----------------------------

async function token(registry: string, repo: string): Promise<string | undefined> {
  const url = `https://${registry}/v2/${repo}/tags/list`;
  const probe = await fetch(url, { method: "GET", redirect: "follow" }).catch(() => null);
  if (!probe || probe.ok) return undefined;

  const challenge = probe.headers.get("www-authenticate") ?? "";
  const realm = challenge.match(/realm="([^"]+)"/)?.[1];
  const service = challenge.match(/service="([^"]+)"/)?.[1];
  if (!realm) return undefined;

  const resp = await fetch(`${realm}?service=${service ?? ""}&scope=repository:${repo}:pull`).catch(() => null);
  if (!resp?.ok) return undefined;
  const json = (await resp.json()) as { token?: string; access_token?: string };
  return json.token ?? json.access_token;
}

// -- paginated tag fetch -----------------------------------------------------

async function tags(registry: string, repo: string, auth: string | undefined): Promise<string[]> {
  const headers: Record<string, string> = auth ? { Authorization: `Bearer ${auth}` } : {};
  const result: string[] = [];
  let url: string | null = `https://${registry}/v2/${repo}/tags/list`;

  while (url) {
    const resp: Response = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${registry}`);
    const json = (await resp.json()) as { tags?: string[] };
    if (json.tags) result.push(...json.tags);

    const link: string | null = resp.headers.get("link");
    const next: string | undefined = link?.match(/<([^>]+)>/)?.[1];
    if (next) {
      url = next.startsWith("http") ? next : `https://${registry}${next}`;
    } else {
      url = null;
    }
  }

  return result;
}

// -- stable-semver filter ----------------------------------------------------

// Pre-release / dev / nightly markers that should be excluded when semver:true.
// Matched as whole tokens (bounded by start, '.', or '-') so legit build
// suffixes like linuxserver's `-ls307` or binhex's `-1-01` are kept.
// Exported for unit tests.
export const PRERELEASE =
  /(?:^|[.\-])(?:develop(?:ment)?|nightly|unstable|preview|canary|testing|edge|snapshot|version|beta|alpha|rc)(?:[.\-]|\d|$)/i;

// Exported for unit tests.
export function isStableSemver(tag: string): boolean {
  if (!/^v?\d+\.\d+/.test(tag)) return false;
  if (PRERELEASE.test(tag)) return false;
  return true;
}

// First numeric component (the "major"), ignoring a leading `v`. NaN if none.
// Exported for unit tests.
export function majorOf(tag: string): number {
  const m = tag.replace(/^v/, "").match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : NaN;
}

// -- version-aware sort ------------------------------------------------------

// Natural-order comparison: split each string into alternating digit / non-digit
// chunks and compare digit-runs numerically. This fixes the lexical-width bug
// where `ls10` sorted before `ls9` (the dominant linuxserver `-lsNNN` scheme).
// Exported for unit tests.
export function versionCompare(a: string, b: string): number {
  const ax = (a.replace(/^v/, "").match(/\d+|\D+/g) ?? []) as string[];
  const bx = (b.replace(/^v/, "").match(/\d+|\D+/g) ?? []) as string[];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const as = ax[i] ?? "";
    const bs = bx[i] ?? "";
    const aNum = /^\d+$/.test(as);
    const bNum = /^\d+$/.test(bs);
    if (aNum && bNum) {
      const d = parseInt(as, 10) - parseInt(bs, 10);
      if (d !== 0) return d;
    } else if (as !== bs) {
      // Shorter string sorts first (e.g. `6.2.1` before `6.2.1.10461-ls305`).
      return as < bs ? -1 : 1;
    }
  }
  return 0;
}

// -- harness-agnostic query --------------------------------------------------

export interface OciTagsOpts {
  semver?: boolean;
  current?: string;
  limit?: number;
}

export interface OciTagsResult {
  /** Human-readable text block (the LLM-facing payload). */
  text: string;
  /** Structured detail for programmatic consumers. */
  details: Record<string, unknown>;
}

/**
 * Fetch + filter + sort + format tags for an image. Returns a harness-agnostic
 * { text, details }; each adapter wraps this in its own tool-result shape.
 */
export async function queryOciTags(image: string, opts: OciTagsOpts = {}): Promise<OciTagsResult> {
  const { registry, repo } = parseImage(image);
  const normalized = registry === "docker.io" ? "registry-1.docker.io" : registry;
  const auth = await token(normalized, repo);
  const all = await tags(normalized, repo, auth);

  let filtered = all;
  if (opts.semver) filtered = filtered.filter(isStableSemver);
  filtered.sort(versionCompare);

  const limit = Math.min(opts.limit ?? 10, 100);

  if (filtered.length === 0) {
    return {
      text: `No tags found for ${image}`,
      details: { count: 0, registry: normalized, image },
    };
  }

  // current-anchored mode: partition into same-major vs different-major
  if (opts.current) {
    const cur = opts.current;
    const curMajor = majorOf(cur);
    const newer = filtered.filter((t) => versionCompare(t, cur) > 0);
    const sameMajor = newer.filter((t) => majorOf(t) === curMajor).slice(-limit);
    const higherMajor = newer.filter((t) => majorOf(t) > curMajor).slice(-limit);

    const lines: string[] = [`current: ${cur}`, ""];
    lines.push(
      sameMajor.length
        ? `same-major updates (${curMajor}.x):\n  ${sameMajor.join("\n  ")}`
        : `same-major updates (${curMajor}.x): none - you are on the latest ${curMajor}.x`,
    );
    if (higherMajor.length) {
      lines.push("");
      lines.push(`different major versions (review before upgrading - likely breaking):\n  ${higherMajor.join("\n  ")}`);
    }

    return {
      text: lines.join("\n"),
      details: {
        registry: normalized,
        image,
        current: cur,
        sameMajor,
        higherMajor,
        sameMajorCount: sameMajor.length,
        higherMajorCount: higherMajor.length,
      },
    };
  }

  const result = filtered.slice(-limit);
  return {
    text: result.join("\n"),
    details: { count: result.length, registry: normalized, image },
  };
}
