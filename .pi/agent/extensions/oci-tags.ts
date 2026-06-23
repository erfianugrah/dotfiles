/**
 * oci-tags — query OCI container registries directly for image tags.
 *
 * Ports the opencode fork's built-in oci_tags tool (commit 8cf0f6b87) to a Pi
 * extension. Use this instead of web search when you need container image
 * versions — registry API is authoritative, no stale results, minimal tokens.
 *
 * Works with Docker Hub, ghcr.io, quay.io, and any OCI-compliant registry.
 *
 * Known limits (tag-scheme realities the registry tags/list API can't resolve
 * without per-manifest timestamps — documented so they aren't re-discovered):
 *
 *   1. Date-versioned images (e.g. thrnz/docker-wireguard-pia
 *      `20260622_master_835e5bc`) are dropped entirely by `semver:true` —
 *      they don't match `\d+\.\d+`. Query these WITHOUT `semver`.
 *   2. Commit-hash-suffixed tags (e.g. slskd `0.25.1.65534-fc722e4a`) share
 *      a version prefix and differ only by hash; the sort orders the hash
 *      lexically, so "latest" is meaningless. Ignore the ordering for these.
 *   3. Separator-less prereleases (`1.0.0rc1`) slip past the stable filter.
 *      Rare; tightening the boundary risks false-positives on legit tags, so
 *      left as-is.
 *   4. `0.x -> 0.x` minor bumps are grouped as "same-major" (compatible) even
 *      though semver treats 0.x minors as breaking. Matches operator intent
 *      (numeric-major grouping); not treated as a major jump.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── registry parse ────────────────────────────────────────────────────────

// Exported for unit tests.
export function parseImage(image: string): { registry: string; repo: string } {
  // Strip @digest and :tag suffixes
  const clean = image.replace(/@.*$/, "").replace(/:([^/]*)$/, "");
  const first = clean.split("/")[0];
  // No slash → Docker Hub library/ namespace
  if (!clean.includes("/")) return { registry: "registry-1.docker.io", repo: `library/${clean}` };
  // First segment looks like a hostname (has dot/colon) → use as registry
  if (first.includes(".") || first.includes(":")) {
    return { registry: first, repo: clean.slice(first.length + 1) };
  }
  // Otherwise treat first segment as Docker Hub org/user
  return { registry: "registry-1.docker.io", repo: clean };
}

// ── bearer token via www-authenticate challenge ───────────────────────────

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

// ── paginated tag fetch ───────────────────────────────────────────────────

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

// ── stable-semver filter ──────────────────────────────────────────────────

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

// ── version-aware sort ────────────────────────────────────────────────────

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

// ── tool definition ───────────────────────────────────────────────────────

const ociTagsTool = defineTool({
  name: "oci_tags",
  promptSnippet: "oci_tags — OCI registry tag query. Use for container versions.",
  promptGuidelines: [
    "Pass semver:true for release tags only (excludes nightly/develop/rc/beta/preview/-version- dev tags).",
    "Pass current:<tag> to anchor on the running version — output splits into same-major updates vs different-major (breaking) jumps so a major bump is never silently recommended as routine.",
  ],
  label: "OCI Tags",
  description:
    "Query OCI registries (Docker Hub, ghcr.io, quay.io, any OCI) for image tags. Sorted by version (latest last).",

  parameters: Type.Object({
    image: Type.String({
      description: 'Container image reference (e.g. "vaultwarden/server", "ghcr.io/astral-sh/uv", "nginx")',
    }),
    semver: Type.Optional(
      Type.Boolean({
        description: "Filter to stable release tags only — excludes nightly/develop/rc/beta/preview/-version- dev tags (default: false)",
      }),
    ),
    current: Type.Optional(
      Type.String({
        description:
          "Currently-deployed tag (e.g. '4.0.17'). When set, output is partitioned into same-major updates vs different-major (breaking) jumps, so a major version change is never recommended as a routine bump.",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max tags to return (default: 10, max: 100)",
      }),
    ),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const { registry, repo } = parseImage(params.image);
    const normalized = registry === "docker.io" ? "registry-1.docker.io" : registry;
    const auth = await token(normalized, repo);
    const all = await tags(normalized, repo, auth);

    let filtered = all;
    if (params.semver) filtered = filtered.filter(isStableSemver);
    filtered.sort(versionCompare);

    const limit = Math.min(params.limit ?? 10, 100);

    if (filtered.length === 0) {
      return {
        content: [{ type: "text", text: `No tags found for ${params.image}` }],
        details: { count: 0, registry: normalized, image: params.image },
      };
    }

    // ── current-anchored mode: partition into same-major vs different-major ──
    if (params.current) {
      const cur = params.current;
      const curMajor = majorOf(cur);
      const newer = filtered.filter((t) => versionCompare(t, cur) > 0);
      const sameMajor = newer.filter((t) => majorOf(t) === curMajor).slice(-limit);
      const higherMajor = newer.filter((t) => majorOf(t) > curMajor).slice(-limit);

      const lines: string[] = [`current: ${cur}`];
      lines.push("");
      lines.push(
        sameMajor.length
          ? `same-major updates (${curMajor}.x):\n  ${sameMajor.join("\n  ")}`
          : `same-major updates (${curMajor}.x): none — you are on the latest ${curMajor}.x`,
      );
      if (higherMajor.length) {
        lines.push("");
        lines.push(`⚠ different major versions (review before upgrading — likely breaking):\n  ${higherMajor.join("\n  ")}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          registry: normalized,
          image: params.image,
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
      content: [{ type: "text", text: result.join("\n") }],
      details: { count: result.length, registry: normalized, image: params.image },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(ociTagsTool);
}
