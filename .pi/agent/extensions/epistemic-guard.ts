/**
 * epistemic-guard - mechanical provenance checking for the specifics the
 * agent emits, so "do not be confidently wrong" stops being prose and starts
 * being enforcement.
 *
 * Why this exists:
 *   APPEND_SYSTEM.md has an "Epistemic calibration" section, and two skills
 *   cover adjacent ground (`verification-before-completion` for your OWN work,
 *   `validating-empirically` for external RUNTIME behaviour). All three are
 *   read-time guidance. None of them fire at claim time, which is the moment
 *   that matters: the model states `Caddy 2.8.4`, `--dns-01`, `/etc/knot/knot.conf`,
 *   `https://caddyserver.com/docs/caddyfile/directives/tls`, "40% faster" - and
 *   nothing in the harness knows whether it read that or remembered it.
 *
 * The asset a harness has that a chatbot does not:
 *   A session is a PROVENANCE CORPUS. Every tool result, every bash output,
 *   every user message is a record of what the agent actually saw. A specific
 *   literal that appears in the agent's output but in NO tool result is, by
 *   construction, recalled from training - unverified by definition.
 *
 *   That check is cheap, deterministic, and self-healing: the moment the agent
 *   verifies a claim with any tool, the literal enters the corpus and never
 *   flags again. The guard literally rewards checking.
 *
 * What counts as a "specific" (never a whole sentence - only literals that are
 * cheap to check and expensive to get wrong):
 *   version  - `2.8.4`, `v1.24`, `pkg@4.1.0`, `image:1.2.3`   (pin/triple/worded)
 *   url      - a deep link; the classic fabricated citation
 *   cve      - `CVE-2021-44228`; never legitimately invented
 *   perf     - `12ms`, `4200 rps`, `3x faster`; the fabricated benchmark
 *   flag     - `--dns-01`; a CLI flag that may not exist
 *   syspath  - `/etc/...`, `~/.config/...`; a system path claimed to exist
 *
 * Assertive vs constructive context. The same literal means different things
 * in a doc and in code, so the claim set is scoped by payload:
 *   - prose (md/txt/docs, commit messages, chat answers) - every class. Here a
 *     literal is an ASSERTION about the world.
 *   - code - version pins + CVEs only. A flag or path in code is an
 *     INSTRUCTION the runtime will adjudicate, not a claim to the reader;
 *     flagging those would be pure noise.
 *
 * Three surfaces:
 *   1. tool_call gate (write / edit / write_stream / apply_patch, and the
 *      MESSAGE half of a git-commit / gh-pr persist) - blocks with the list.
 *      Durable artifacts are where being wrong is expensive.
 *   2. message_end footer - appends a one-line "recalled, not verified"
 *      annotation to a final chat answer. Non-blocking; gives the human
 *      calibration for free and puts the flag in front of the model next turn.
 *   3. /epistemics - on-demand report: corpus size, what has been flagged,
 *      and the unverified specifics in the last answer.
 *
 * Noise control (a guard you learn to ignore is worse than no guard):
 *   - Each distinct specific is flagged AT MOST ONCE per session. A block is
 *     therefore never a wall: verify it, label it, or just retry - the retry
 *     passes. Same "block once, pass on retry" contract as skill-guard.
 *   - Provenance extraction is deliberately LOOSER than claim extraction, so
 *     ambiguity always resolves toward "seen" (false negatives over false
 *     positives).
 *   - A claim sitting NEXT TO an honest label ("2.11.4, unverified") is already
 *     calibrated and is skipped - but the label has to be near the claim.
 *     A payload-wide bypass would just teach the model to sprinkle the word
 *     "unverified" once at the top, which is worse than no guard.
 *   - Scratch paths (/tmp), lockfiles, vendored trees and generated assets are
 *     skipped entirely.
 *
 * Unattended runs (pi -p: the self-correcting-loop harness, task/bg_task
 * subagents) get different treatment, because the failure modes invert:
 *   - NO chat footer when !ctx.hasUI. In print/json mode the assistant text IS
 *     the machine-readable stdout; appending a guard line there corrupts a
 *     subagent's return payload (fatal if the parent asked for JSON) and leaks
 *     into anything parsing `pi -p` output. The footer is a human-calibration
 *     device, so it needs a human.
 *   - BLOCK BUDGET when !ctx.hasUI (PI_EPISTEMIC_MAX_BLOCKS, default 3). Every
 *     loop iteration is a fresh session with a fresh (empty) corpus, so an
 *     unattended run re-pays the same blocks each pass. Interactive sessions
 *     keep the full gate - a human can see and judge each one - while an
 *     unattended run degrades to observe-only after the budget, bounding the
 *     tax at N turns per iteration instead of one per recalled specific.
 *
 * Kill switches: PI_EPISTEMIC_GUARD_OFF=1 (everything),
 *                PI_EPISTEMIC_FOOTER_OFF=1 (chat annotation only),
 *                PI_EPISTEMIC_MAX_BLOCKS=0 (observe-only in unattended runs).
 *
 * Companion skill: ~/.pi/agent/skills/epistemics/SKILL.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

// ── claim model ─────────────────────────────────────────────────────────────

export type ClaimClass = "version" | "url" | "cve" | "perf" | "flag" | "syspath" | "date";

export interface Claim {
  cls: ClaimClass;
  /** normalized comparison key (what we look up in the corpus) */
  key: string;
  /** as it appeared, for the message */
  raw: string;
  /**
   * The number sits in a because-clause: it was REASONED to, not read.
   * A derived number is not safer than a recalled one - it is a recalled
   * RULE applied without checking its preconditions - and it needs a
   * different correction (state the mechanism) than "go verify the literal".
   */
  derived?: boolean;
}

/**
 * How far from a claim an honest label still counts as labelling THAT claim.
 * Small on purpose: the exemption has to cost the model roughly as much as
 * verifying would, or "unverified" becomes a magic word sprinkled once per
 * document to switch the guard off.
 */
const HEDGE_WINDOW = 160;

const HEDGE_RE =
  /\b(unverified|not verified|un-verified|unconfirmed|recalled|from memory|cannot confirm|can't confirm|have not verified|haven't verified|not checked|doc-cited-not-tested|approximate|roughly|citation needed)\b/i;

/** Is this claim already labelled as uncertain, close enough to be believed? */
export function hedgedNear(text: string, at: number): boolean {
  return HEDGE_RE.test(
    text.slice(Math.max(0, at - HEDGE_WINDOW), Math.min(text.length, at + HEDGE_WINDOW)),
  );
}

/**
 * Causal / capacity-mechanism vocabulary. A number wrapped in this is being
 * DERIVED from a rule ("shares one link, so it caps at ..."), which is the
 * failure the corpus check cannot see: the literal is absent from the corpus
 * because nothing measured it, and "go verify" is the wrong instruction when
 * what actually broke is an unchecked precondition.
 */
const MECHANISM_RE =
  /\b(because|since|so it|so you|therefore|which means|that means|caps? (?:at|out)|capped|ceiling|bottleneck|limited by|shares?|shared|split between|halv(?:e|es|ed|ing)|hairpins?|saturat\w*|contend\w*|divided|per-flow|aggregate|effectively|works out to|leaving|at best|no more than)\b/i;

/** Narrower than HEDGE_WINDOW: the because-clause is adjacent, not paragraphs away. */
const MECHANISM_WINDOW = 120;

/** Is this number embedded in reasoning rather than reported from a measurement? */
export function derivedNear(text: string, at: number): boolean {
  return MECHANISM_RE.test(
    text.slice(Math.max(0, at - MECHANISM_WINDOW), Math.min(text.length, at + MECHANISM_WINDOW)),
  );
}

export interface Corpus {
  version: Set<string>;
  url: Set<string>;
  cve: Set<string>;
  perf: Set<string>;
  flag: Set<string>;
  syspath: Set<string>;
  date: Set<string>;
}

export function newCorpus(): Corpus {
  return {
    version: new Set(),
    url: new Set(),
    cve: new Set(),
    perf: new Set(),
    flag: new Set(),
    syspath: new Set(),
    date: new Set(),
  };
}

/** Per-class routing hint shown in the block message. */
const VERIFY_HINT: Record<ClaimClass, string> = {
  version:
    "oci_tags (images) / `<tool> --version` / package registry / docs_search - never recall a version",
  url: "webfetch or web_research the exact URL; a 404 citation is worse than none",
  cve: "osint_cve / osv_scan - the id and its CVSS are both checkable",
  perf: "quote the tool output you measured (bench, gocurl, pgbench) or drop the number",
  flag: "`<tool> --help` / docs_grep the source - flags are the top hallucination class",
  syspath: "`ls`/`stat` it, or read it - a path you never opened is a guess",
  date:
    "memledger_search / search_ledger / session_search - a date about the user's own history " +
    "lives in the session stores, not in your head",
};

// ── regex sources (built fresh per use; /g + lastIndex is a footgun) ────────

// Semver-ish triple, not part of a longer dotted token. The lookaround pair
// also rejects IPv4 wholesale: in 10.0.69.4 every candidate start is either
// followed by another `.digit` or preceded by a `.`. The trailing guard has to
// admit a sentence-ending period ("we run knot 3.5.") while still rejecting a
// further version segment - hence `\.\d` rather than a bare `.`.
const VER_TAIL = String.raw`(?![\w\-]|\.\d)`;
const RE_VER_TRIPLE = String.raw`(?<![\w.\-/])(\d+\.\d+\.\d+)` + VER_TAIL;
// Pin syntax: pkg@1.2.3, image:1.2.3, ^1.2, >=4.1, v1.24.
// Only the bare `v` prefix needs a left boundary (else `srv1.2` matches); the
// punctuation prefixes legitimately follow a word char, which is the whole
// point of `pkg@1.2.3`.
const RE_VER_PINNED =
  String.raw`(?:(?<![\w])v|[@:^~]|>=|<=|==|>|<)\s?(\d+\.\d+(?:\.\d+)*)` + VER_TAIL;
// "Postgres 17.2", "Caddy 2.8" - a name followed by a version.
const RE_VER_WORDED =
  String.raw`\b([A-Za-z][\w.+-]{2,24})\s+v?(\d+\.\d+(?:\.\d+)*)` + VER_TAIL;
// Loose: anything dotted-numeric (corpus side only).
const RE_VER_LOOSE = String.raw`(?<![\w.\-/])(\d+\.\d+(?:\.\d+)*)` + VER_TAIL;

const RE_URL = String.raw`https?://[^\s<>()\[\]{}"'\`\\^|]+`;
const RE_CVE = String.raw`\bCVE-\d{4}-\d{4,7}\b`;
const RE_PERF_UNIT = String.raw`(?<![\w.])(\d+(?:\.\d+)?)\s?(ms|µs|us|ns|rps|qps|tps|ops/s|req/s|MB/s|GB/s|Mbps|Gbps)(?![\w/])`;
const RE_PERF_FACTOR = String.raw`(?<![\w.])(\d+(?:\.\d+)?)\s?x\s+(faster|slower|speedup|throughput)`;
const RE_FLAG = String.raw`(?<![\w-])--([a-z][a-z0-9-]{2,})(?![\w-])`;
const RE_SYSPATH = String.raw`(?<![\w])(~/[\w.\-/]{3,}|/(?:etc|usr|opt|var|srv|proc|sys|boot|lib|lib64|run)/[\w.\-/]{2,})`;

// ISO date. The trailing `\b` is the whole trick for excluding timestamps:
// in `2026-08-10T04:03:48Z` both the last digit and the following `T` are
// word characters, so there is no boundary there and the pattern simply does
// not match inside a longer datetime - no separate exclusion needed.
const RE_DATE_ISO = String.raw`\b(\d{4}-\d{2}-\d{2})\b`;

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
// Day Month Year: "10 August 2026".
const RE_DATE_DMY = String.raw`\b\d{1,2}\s+(?:${MONTHS})\s+\d{4}\b`;
// Month Day[,] Year: "August 10, 2026".
const RE_DATE_MDY = String.raw`\b(?:${MONTHS})\s+\d{1,2},?\s+\d{4}\b`;
// [qualifier] Month Year: "August 2026", "late July 2026". The optional
// early/mid/late prefix is a vagueness qualifier on the SAME claim, not a
// separate fact - normalizeWordedDateKey drops it.
const RE_DATE_MY = String.raw`\b(?:(?:early|mid|late)\s+)?(?:${MONTHS})\s+\d{4}\b`;

const MONTH_INDEX: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

/**
 * Words that make a following number an ordinal/reference, not a version.
 * "section 3.2" is not a claim about software.
 */
const NOT_A_PRODUCT = new Set([
  "section",
  "chapter",
  "step",
  "figure",
  "fig",
  "table",
  "phase",
  "item",
  "line",
  "lines",
  "page",
  "note",
  "part",
  "appendix",
  "rule",
  "point",
  "task",
  "issue",
  "pr",
  "example",
  "case",
]);

/**
 * Flags so universal that "I have not seen it this session" says nothing.
 * Precision over coverage: these would fire constantly and train the reader
 * to skim the guard.
 */
const UBIQUITOUS_FLAG = new Set([
  "--help",
  "--version",
  "--json",
  "--yaml",
  "--verbose",
  "--quiet",
  "--debug",
  "--force",
  "--dry-run",
  "--all",
  "--yes",
  "--file",
  "--output",
  "--config",
  "--recursive",
  "--no-color",
]);

/** Hosts whose URLs are placeholders or local - never a citation claim. */
const PLACEHOLDER_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|example\.(com|org|net)|.*\.local|.*\.internal|.*\.test|.*\.invalid)$/i;

function all(text: string, src: string, flags = "g"): RegExpExecArray[] {
  const re = new RegExp(src, flags);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** Trailing sentence punctuation is not part of a URL/path literal. */
export function trimTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?'")\]]+$/, "");
}

export function normalizeUrl(u: string): string {
  const t = trimTrailingPunct(u).toLowerCase();
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

/** A URL is a citation claim only when it points AT something (has a path). */
export function isDeepUrl(u: string): boolean {
  try {
    const url = new URL(trimTrailingPunct(u));
    if (PLACEHOLDER_HOST.test(url.hostname)) return false;
    return url.pathname.replace(/\/+$/, "").length > 1 || url.search.length > 1;
  } catch {
    return false;
  }
}

// ── corpus side: LOOSE extraction (ambiguity resolves to "seen") ────────────

const CORPUS_TEXT_CAP = 256 * 1024;
const CORPUS_SET_CAP = 40_000;

function add(set: Set<string>, v: string): void {
  if (v && set.size < CORPUS_SET_CAP) set.add(v);
}

/**
 * Normalize a worded date to a comparison key: lowercased, commas stripped,
 * whitespace collapsed, and any leading vagueness qualifier (early/mid/late)
 * dropped - the month is the claim, the qualifier is not a separate fact.
 * Applied uniformly to every worded form (D-M-Y, M-D-Y, M-Y) rather than
 * threading per-pattern capture groups through.
 */
export function normalizeWordedDateKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(early|mid|late)\s+/, "");
}

interface DateCandidate {
  start: number;
  end: number;
  key: string;
  raw: string;
}

/**
 * All worded-date matches in `text`, longest-and-earliest-wins so a DMY match
 * ("10 August 2026") does not ALSO yield the shorter MY match nested inside it
 * ("August 2026") as a second, spurious claim.
 */
export function wordedDateCandidates(text: string): DateCandidate[] {
  const raw: DateCandidate[] = [];
  for (const re of [RE_DATE_DMY, RE_DATE_MDY, RE_DATE_MY]) {
    for (const m of all(text, re, "gi")) {
      raw.push({
        start: m.index,
        end: m.index + m[0].length,
        key: normalizeWordedDateKey(m[0]),
        raw: m[0],
      });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: DateCandidate[] = [];
  let lastEnd = -1;
  for (const c of raw) {
    if (c.start < lastEnd) continue;
    out.push(c);
    lastEnd = c.end;
  }
  return out;
}

/**
 * "yyyy-mm" for either an ISO date/timestamp key or a normalized worded date
 * key, or null when the key has no recognisable month. This is what lets an
 * ISO claim and a worded claim about the SAME month cross-match in
 * `hasProvenance` without ever rewriting one form's key into the other -
 * cross-matching is a provenance-time concern, extraction keeps what the
 * model actually wrote.
 */
export function dateMonthKey(key: string): string | null {
  const iso = key.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const worded = key.match(/\b([a-z]+)\b.*?\b(\d{4})\b/);
  if (worded && MONTH_INDEX[worded[1]]) return `${worded[2]}-${MONTH_INDEX[worded[1]]}`;
  return null;
}

/** Fold every literal in `text` into the corpus as provenance. */
export function absorb(corpus: Corpus, text: string): void {
  if (!text) return;
  const t = text.length > CORPUS_TEXT_CAP ? text.slice(0, CORPUS_TEXT_CAP) : text;

  for (const m of all(t, RE_VER_LOOSE)) add(corpus.version, m[1]);
  for (const m of all(t, RE_VER_PINNED)) add(corpus.version, m[1]);
  for (const m of all(t, RE_URL)) add(corpus.url, normalizeUrl(m[0]));
  for (const m of all(t, RE_CVE, "gi")) add(corpus.cve, m[0].toUpperCase());
  for (const m of all(t, RE_PERF_UNIT)) add(corpus.perf, `${m[1]}${m[2].toLowerCase()}`);
  for (const m of all(t, RE_PERF_FACTOR)) add(corpus.perf, `${m[1]}x`);
  for (const m of all(t, RE_FLAG)) add(corpus.flag, `--${m[1]}`);
  for (const m of all(t, RE_SYSPATH)) add(corpus.syspath, trimTrailingPunct(m[1]).replace(/\/+$/, ""));
  for (const m of all(t, RE_DATE_ISO)) add(corpus.date, m[1]);
  for (const c of wordedDateCandidates(t)) add(corpus.date, c.key);
}

export function corpusSize(c: Corpus): number {
  return (
    c.version.size + c.url.size + c.cve.size + c.perf.size + c.flag.size + c.syspath.size + c.date.size
  );
}

// ── claim side: STRICT extraction, scoped by payload kind ───────────────────

export type PayloadMode = "prose" | "code" | "skip";

const PROSE_EXT = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc", ".org"]);

const SKIP_PATH =
  /(^|\/)(node_modules|\.git|dist|build|out|vendor|target|\.next|\.astro|coverage)\//;
const SKIP_FILE =
  /(\.(lock|lockb|min\.[a-z]+|map|svg|png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|wasm)$|(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|flake\.lock)$)/i;

/**
 * Which claim classes apply to this write target.
 *   prose -> assertions about the world (all classes)
 *   code  -> constructive literals (pins + CVEs only)
 *   skip  -> scratch / generated / vendored; no claims at all
 */
export function payloadMode(target: string): PayloadMode {
  if (!target) return "skip";
  const p = target.replace(/\\/g, "/");
  if (p.startsWith("/tmp/") || p.startsWith("/var/tmp/") || p.includes("/.pi/agent/sessions/")) {
    return "skip";
  }
  if (SKIP_PATH.test(p) || SKIP_FILE.test(p)) return "skip";
  const ext = path.extname(p).toLowerCase();
  if (PROSE_EXT.has(ext) || /(^|\/)docs?\//i.test(p)) return "prose";
  return "code";
}

/**
 * Lines that are version BOOKKEEPING rather than a claim about the world:
 * a changelog heading or the package's own version field. The agent inventing
 * the NEXT version there is correct behaviour, not a hallucination.
 */
function isVersionBookkeeping(line: string): boolean {
  return (
    /^\s{0,3}#{1,4}\s*\[?v?\d+\.\d+/.test(line) ||
    /"version"\s*:/.test(line) ||
    /^\s*version\s*[:=]/i.test(line) ||
    /^\s*##\s*\[?unreleased/i.test(line)
  );
}

/** 10.0.69.2 is an address, not a release. */
function isIpv4(key: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(key);
}

/**
 * Lines that are date BOOKKEEPING rather than a claim about the user's
 * history: a changelog/markdown heading, or a `field: value` line (a
 * frontmatter-style `date:`/`Date:`/`Last updated:` field). The agent
 * stamping a heading with the date it's writing is correct behaviour, not a
 * fabrication - there is nothing to verify because nothing is being asserted.
 */
function isDateBookkeeping(line: string): boolean {
  return (
    /^\s{0,3}#{1,6}\s/.test(line) ||
    /^\s*[A-Za-z][\w -]*:\s*\d{4}-\d{2}-\d{2}\s*$/.test(line)
  );
}

function pushUnique(out: Claim[], seen: Set<string>, c: Claim, text: string, at: number): void {
  const id = `${c.cls}:${c.key}`;
  if (seen.has(id)) return;
  if (hedgedNear(text, at)) return;
  seen.add(id);
  // Only perf numbers get the derived treatment. A version or a path in a
  // because-clause is still just a recalled literal; a THROUGHPUT in one is a
  // conclusion, and conclusions fail differently.
  out.push(c.cls === "perf" && derivedNear(text, at) ? { ...c, derived: true } : c);
}

export interface Segment {
  text: string;
  fenced: boolean;
}

/**
 * Split prose into unfenced and fenced-code segments.
 *
 * The assertive/constructive split is not a property of the FILE, it is a
 * property of the region: a fenced block inside a markdown doc is a command
 * you are told to run (the shell adjudicates it), while the paragraph around
 * it is a claim about the world. So fenced regions get the `code` claim set
 * (pins + CVEs), unfenced gets everything. This is what keeps `--help` in a
 * usage example from being treated as an assertion.
 */
export function splitFences(text: string): Segment[] {
  const out: Segment[] = [];
  // NOTE: `\z` does not exist in JS regex (it is a literal "z"), so the
  // end-of-input alternative has to be a negative lookahead. An UNTERMINATED
  // fence swallows the rest of the payload as code, which is the safe side:
  // a truncated code block should not start producing prose claims.
  const re = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), fenced: false });
    out.push({ text: m[2] ?? "", fenced: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), fenced: false });
  return out;
}

/** Strict, context-aware claim extraction. */
export function extractClaims(text: string, mode: Exclude<PayloadMode, "skip">): Claim[] {
  if (!text) return [];
  if (mode === "prose") {
    const out: Claim[] = [];
    const seen = new Set<string>();
    for (const seg of splitFences(text)) {
      extractInto(out, seen, seg.text, seg.fenced ? "code" : "prose");
    }
    return out;
  }
  const out: Claim[] = [];
  extractInto(out, new Set<string>(), text, "code");
  return out;
}

function extractInto(
  out: Claim[],
  seen: Set<string>,
  text: string,
  mode: Exclude<PayloadMode, "skip">,
): void {
  if (!text) return;

  for (const m of all(text, RE_CVE, "gi")) {
    pushUnique(out, seen, { cls: "cve", key: m[0].toUpperCase(), raw: m[0] }, text, m.index);
  }

  // versions: pins everywhere; triples + worded only in prose (a bare triple in
  // code is as likely a coordinate/id as a dependency).
  const lineOf = (idx: number): string => {
    const s = text.lastIndexOf("\n", idx) + 1;
    const e = text.indexOf("\n", idx);
    return text.slice(s, e === -1 ? text.length : e);
  };
  const addVersion = (key: string, raw: string, at: number) => {
    if (isIpv4(key)) return;
    if (isVersionBookkeeping(lineOf(at))) return;
    pushUnique(out, seen, { cls: "version", key, raw }, text, at);
  };
  // Most readable form first - dedup is by key, so whichever pass runs first
  // supplies the `raw` the human sees ("Caddy 2.8.4" beats ":2.8.4").
  if (mode === "prose") {
    for (const m of all(text, RE_VER_WORDED)) {
      if (NOT_A_PRODUCT.has(m[1].toLowerCase())) continue;
      addVersion(m[2], `${m[1]} ${m[2]}`, m.index);
    }
    for (const m of all(text, RE_VER_TRIPLE)) addVersion(m[1], m[1], m.index);
  }
  for (const m of all(text, RE_VER_PINNED)) {
    addVersion(m[1], m[0].trim().replace(/^:/, ""), m.index);
  }

  if (mode !== "prose") return;

  for (const m of all(text, RE_URL)) {
    if (!isDeepUrl(m[0])) continue;
    const c: Claim = { cls: "url", key: normalizeUrl(m[0]), raw: trimTrailingPunct(m[0]) };
    pushUnique(out, seen, c, text, m.index);
  }
  for (const m of all(text, RE_PERF_UNIT)) {
    const c: Claim = {
      cls: "perf",
      key: `${m[1]}${m[2].toLowerCase()}`,
      raw: `${m[1]}${m[2]}`,
    };
    pushUnique(out, seen, c, text, m.index);
  }
  for (const m of all(text, RE_PERF_FACTOR)) {
    pushUnique(out, seen, { cls: "perf", key: `${m[1]}x`, raw: `${m[1]}x ${m[2]}` }, text, m.index);
  }
  const addDate = (key: string, raw: string, at: number) => {
    if (isDateBookkeeping(lineOf(at))) return;
    pushUnique(out, seen, { cls: "date", key, raw }, text, at);
  };
  for (const m of all(text, RE_DATE_ISO)) addDate(m[1], m[1], m.index);
  for (const c of wordedDateCandidates(text)) addDate(c.key, c.raw, c.start);
  for (const m of all(text, RE_FLAG)) {
    const key = `--${m[1]}`;
    if (UBIQUITOUS_FLAG.has(key)) continue;
    pushUnique(out, seen, { cls: "flag", key, raw: key }, text, m.index);
  }
  for (const m of all(text, RE_SYSPATH)) {
    const k = trimTrailingPunct(m[1]).replace(/\/+$/, "");
    pushUnique(out, seen, { cls: "syspath", key: k, raw: k }, text, m.index);
  }
}

/** Prefix-tolerant membership: /etc/knot is covered by /etc/knot/knot.conf. */
function hasPrefixMatch(set: Set<string>, key: string): boolean {
  if (set.has(key)) return true;
  for (const v of set) {
    if (v.startsWith(key) || key.startsWith(v)) return true;
  }
  return false;
}

export function hasProvenance(corpus: Corpus, c: Claim): boolean {
  switch (c.cls) {
    case "version":
      return corpus.version.has(c.key);
    case "cve":
      return corpus.cve.has(c.key);
    case "perf":
      return corpus.perf.has(c.key);
    case "flag":
      return corpus.flag.has(c.key);
    case "url":
      return hasPrefixMatch(corpus.url, c.key);
    case "syspath":
      return hasPrefixMatch(corpus.syspath, c.key);
    case "date": {
      if (corpus.date.has(c.key)) return true;
      // ISO <-> worded cross-match: same month, different spelling, is the
      // same fact. This is a provenance-time comparison only - the claim's
      // own key is never rewritten, so the block message still quotes
      // exactly what the model wrote.
      const monthKey = dateMonthKey(c.key);
      if (!monthKey) return false;
      for (const v of corpus.date) {
        if (dateMonthKey(v) === monthKey) return true;
      }
      return false;
    }
  }
}

/**
 * Claims with no provenance, minus anything already flagged this session.
 * Mutates `flagged` - a specific is surfaced at most once per session, so a
 * block is never a wall and a retry always gets through.
 */
export function unprovenanced(corpus: Corpus, claims: Claim[], flagged: Set<string>): Claim[] {
  const out: Claim[] = [];
  for (const c of claims) {
    const id = `${c.cls}:${c.key}`;
    if (flagged.has(id)) continue;
    if (hasProvenance(corpus, c)) continue;
    flagged.add(id);
    out.push(c);
  }
  return out;
}



// ── messages ────────────────────────────────────────────────────────────────

const MAX_REPORTED = 5;

export function blockReason(claims: Claim[], where: string): string {
  const shown = claims.slice(0, MAX_REPORTED);
  const lines = shown.map(
    (c) =>
      `  - \`${c.raw}\` (${c.cls}${c.derived ? ", derived" : ""}) -> ` +
      (c.derived ? DERIVED_HINT : VERIFY_HINT[c.cls]),
  );
  const more = claims.length > shown.length ? `\n  ... and ${claims.length - shown.length} more` : "";
  const one = claims.length === 1;
  return (
    `epistemic-guard: ${claims.length} specific${one ? "" : "s"} in this payload (${where}) ` +
    `ha${one ? "s" : "ve"} no provenance in this session - nothing you read, ran, or were ` +
    `told contains ${one ? "it" : "them"}, so ${one ? "it is" : "they are"} ` +
    `recalled from training, not verified:\n` +
    lines.join("\n") +
    more +
    `\n\nDo ONE of: (a) verify - any tool result puts the literal in the corpus and this never fires for it ` +
    `again; (b) label it in the text as unverified / recalled; (c) drop the specific. Then retry - each ` +
    `specific is flagged once per session, so the retry passes either way. ` +
    `Method: ~/.pi/agent/skills/epistemics/SKILL.md. Kill switch: PI_EPISTEMIC_GUARD_OFF=1.`
  );
}

export function footerLine(claims: Claim[]): string {
  const shown = claims.slice(0, MAX_REPORTED);
  const list = shown.map((c) => `\`${c.raw}\` (${c.cls}${c.derived ? ", derived" : ""})`).join(", ");
  const more = claims.length > shown.length ? `, +${claims.length - shown.length} more` : "";
  const base = `epistemic-guard: recalled, not verified this session - ${list}${more}.`;
  return claims.some((c) => c.derived) ? `${base}\n${DERIVED_NOTE}` : base;
}

const DERIVED_HINT =
  "this number sits in a because-clause, so it was reasoned to, not measured - " +
  "state the mechanism and the precondition you checked, or measure it";

const DERIVED_NOTE =
  "  A derived number (one you reasoned to, not read) is a recalled RULE applied " +
  "without checking its preconditions. Name the mechanism in one clause and one " +
  "condition that would make it false - full-duplex vs shared, per-flow vs aggregate, " +
  "which layer, sequential vs parallel, warm vs cold, per-core vs total.";

// ── provenance harvesting from session entries ──────────────────────────────

type TextBlock = { type?: string; text?: string };

function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as TextBlock[])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * Text from ONE session entry that counts as provenance.
 *
 * Provenance is what the agent SAW: tool results, bash output, user messages,
 * and compaction/branch summaries (which carry facts forward after the raw
 * output leaves the context). Assistant text and tool-call ARGUMENTS are
 * excluded on purpose - counting the agent's own output as evidence would let
 * a hallucination bootstrap itself into "verified".
 */
export function provenanceText(entry: unknown): string {
  const e = entry as { type?: string; message?: Record<string, unknown> };
  if (!e || e.type !== "message" || !e.message) return "";
  const m = e.message;
  switch (m.role) {
    case "user":
      return blocksToText(m.content);
    case "toolResult":
      return blocksToText(m.content);
    case "bashExecution":
      return `${String(m.command ?? "")}\n${String(m.output ?? "")}`;
    case "compactionSummary":
    case "branchSummary":
      return String(m.summary ?? "");
    default:
      return "";
  }
}

/** Assistant text blocks of a message, or "" when it is not a plain answer. */
export function assistantAnswerText(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return "";
  // A message that also calls tools is a working step, not an answer - the
  // tool results it is about to get are precisely the missing provenance.
  if ((m.content as TextBlock[]).some((b) => b?.type === "toolCall")) return "";
  return blocksToText(m.content);
}

// ── extension ───────────────────────────────────────────────────────────────

interface SessionState {
  corpus: Corpus;
  cursor: number;
  flagged: Set<string>;
  seededSystemPrompt: boolean;
  blocks: number;
  footers: number;
  suppressed: number;
}

/**
 * Block budget for an unattended run. Interactive sessions are unbudgeted -
 * per-specific dedup is enough noise control when a human is watching, and
 * every block there is information. `pi -p` is different: a loop harness
 * restarts with an empty corpus each iteration, so the same recalled specifics
 * re-block every pass. Capping keeps that a bounded tax instead of a per-claim
 * one, and 0 turns the gate into pure observation.
 */
function unattendedBudget(): number {
  const raw = process.env.PI_EPISTEMIC_MAX_BLOCKS;
  if (raw === undefined) return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

/** Commit / PR / issue persists whose MESSAGE text is a prose claim surface. */
export function isMessagePersist(cmd: string): boolean {
  return /\bgit\s+(commit|tag)\b|\bgh\s+(pr|issue|release)\s+(create|edit|comment)\b/.test(cmd);
}

/**
 * The prose half of a commit/PR command: -m / --body / --notes text and
 * heredoc bodies. Deliberately NOT the staged diff - that is code, already
 * gated at write time, and scanning it would drag code literals into the
 * prose claim set.
 */
export function commitMessageText(cmd: string): string {
  const parts: string[] = [];
  for (const m of all(cmd, String.raw`(?:-m|--message|--body|--notes|--title)(?:=|\s+)(['"])([\s\S]*?)\1`)) {
    parts.push(m[2]);
  }
  for (const m of all(cmd, String.raw`<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\s*\1`)) {
    parts.push(m[2]);
  }
  return parts.join("\n");
}

/** `+` lines of an apply_patch envelope (the content actually being added). */
export function patchAddedText(patchText: string): string {
  return patchText
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
}

export function patchTargets(patchText: string): string[] {
  const out: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete|Move(?: to)?) File: (.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_EPISTEMIC_GUARD_OFF === "1") return;
  const footerOff = process.env.PI_EPISTEMIC_FOOTER_OFF === "1";

  const states = new Map<string, SessionState>();

  const sessionKey = (ctx: unknown): string => {
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string } }).sessionManager;
      return sm?.getSessionFile?.() ?? "default";
    } catch {
      return "default";
    }
  };

  const stateFor = (ctx: unknown): SessionState => {
    const key = sessionKey(ctx);
    let s = states.get(key);
    if (!s) {
      s = {
        corpus: newCorpus(),
        cursor: 0,
        flagged: new Set(),
        seededSystemPrompt: false,
        blocks: 0,
        footers: 0,
        suppressed: 0,
      };
      states.set(key, s);
    }
    return s;
  };

  /**
   * Bring the corpus up to date with the session. Cursor-based so a long
   * session costs nothing per call, and re-derived from sessionManager rather
   * than accumulated in-process so /resume and forks inherit provenance.
   */
  const sync = (ctx: unknown): SessionState => {
    const s = stateFor(ctx);
    const c = ctx as {
      sessionManager?: { getEntries?: () => unknown[] };
      getSystemPrompt?: () => string;
    };

    if (!s.seededSystemPrompt) {
      s.seededSystemPrompt = true;
      // AGENTS.md + tool snippets + skill descriptions are things the agent was
      // TOLD, so paths and flags quoted there are legitimately provenanced.
      try {
        absorb(s.corpus, c.getSystemPrompt?.() ?? "");
      } catch {
        /* older pi: no getSystemPrompt */
      }
    }

    let entries: unknown[] = [];
    try {
      entries = c.sessionManager?.getEntries?.() ?? [];
    } catch {
      return s;
    }
    for (let i = s.cursor; i < entries.length; i++) {
      const t = provenanceText(entries[i]);
      if (t) absorb(s.corpus, t);
    }
    s.cursor = entries.length;
    return s;
  };

  // 1. write / commit gate ──────────────────────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    const e = event as {
      toolName: string;
      input: {
        path?: string;
        file_path?: string;
        content?: string;
        newText?: string;
        edits?: Array<{ newText?: string }>;
        patchText?: string;
        command?: string;
      };
    };

    let mode: PayloadMode = "skip";
    let text = "";
    let where = "";

    if (e.toolName === "write" || e.toolName === "write_stream" || e.toolName === "edit") {
      const target = e.input.path ?? e.input.file_path;
      if (typeof target !== "string") return undefined;
      mode = payloadMode(target);
      if (mode === "skip") return undefined;
      const edits = Array.isArray(e.input.edits) ? e.input.edits.map((x) => x?.newText ?? "") : [];
      text = [e.input.content ?? "", e.input.newText ?? "", ...edits].join("\n");
      where = `${e.toolName} -> ${target}`;
    } else if (e.toolName === "apply_patch") {
      const patchText = e.input.patchText ?? "";
      const targets = patchTargets(patchText);
      // Prose wins: one doc in a mixed patch means the doc's claims get checked.
      const modes = targets.map(payloadMode);
      mode = modes.includes("prose") ? "prose" : modes.includes("code") ? "code" : "skip";
      if (mode === "skip") return undefined;
      text = patchAddedText(patchText);
      where = "apply_patch";
    } else if (e.toolName === "bash") {
      const cmd = e.input.command;
      if (typeof cmd !== "string" || !isMessagePersist(cmd)) return undefined;
      text = commitMessageText(cmd);
      if (!text.trim()) return undefined;
      mode = "prose";
      where = "commit/PR message";
    } else {
      return undefined;
    }

    if (!text.trim()) return undefined;

    const s = sync(ctx);
    const claims = extractClaims(text, mode);
    if (claims.length === 0) return undefined;

    const hits = unprovenanced(s.corpus, claims, s.flagged);
    if (hits.length === 0) return undefined;

    // Unattended: record, then stop blocking once the budget is spent. The
    // specifics stay in `flagged` so /epistemics still reports them if this
    // session is later resumed interactively.
    const hasUI = (ctx as { hasUI?: boolean }).hasUI !== false;
    if (!hasUI && s.blocks >= unattendedBudget()) {
      s.suppressed += hits.length;
      return undefined;
    }

    s.blocks++;
    return { block: true, reason: blockReason(hits, where) };
  });

  // 2. chat answer annotation ───────────────────────────────────────────────
  pi.on("message_end", async (event, ctx) => {
    if (footerOff) return undefined;
    // Print/JSON mode: the assistant text IS the machine-readable stdout of a
    // `pi -p` run (a task/bg_task subagent's return value, a loop harness's
    // captured output). Appending a guard line there corrupts the payload.
    if ((ctx as { hasUI?: boolean }).hasUI === false) return undefined;

    const e = event as { message?: { role?: string; content?: unknown } };
    const msg = e.message;
    if (!msg || msg.role !== "assistant") return undefined;

    const answer = assistantAnswerText(msg);
    if (!answer.trim()) return undefined;

    const s = sync(ctx);
    const hits = unprovenanced(s.corpus, extractClaims(answer, "prose"), s.flagged);
    if (hits.length === 0) return undefined;

    const content = msg.content as TextBlock[];
    let lastText = -1;
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i]?.type === "text" && typeof content[i]?.text === "string") {
        lastText = i;
        break;
      }
    }
    if (lastText === -1) return undefined;

    s.footers++;
    const patched = content.map((b, i) =>
      i === lastText ? { ...b, text: `${b.text}\n\n${footerLine(hits)}` } : b,
    );
    return { message: { ...msg, content: patched } };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    states.delete(sessionKey(ctx));
  });

  // 3. /epistemics ──────────────────────────────────────────────────────────
  pi.registerCommand("epistemics", {
    description: "Provenance report: what this session verified vs recalled (/epistemics [reset])",
    handler: async (args, ctx) => {
      const s = sync(ctx);

      if (args.trim() === "reset") {
        s.flagged.clear();
        ctx.ui.notify("epistemic-guard: flagged set cleared", "info");
        return;
      }

      const c = s.corpus;
      const lines: string[] = [
        "epistemic-guard - session provenance",
        "",
        `corpus (literals seen in tool output / user messages): ${corpusSize(c)}`,
        `  version ${c.version.size}  url ${c.url.size}  cve ${c.cve.size}` +
          `  perf ${c.perf.size}  flag ${c.flag.size}  syspath ${c.syspath.size}`,
        `entries scanned: ${s.cursor}   writes blocked: ${s.blocks}` +
          `   answers annotated: ${s.footers}` +
          (s.suppressed ? `   suppressed (budget spent): ${s.suppressed}` : ""),
        "",
      ];

      if (s.flagged.size === 0) {
        lines.push("flagged this session: none - every specific emitted so far had provenance.");
      } else {
        lines.push(`flagged this session (recalled, not verified) - ${s.flagged.size}:`);
        for (const id of [...s.flagged].slice(0, 40)) {
          const i = id.indexOf(":");
          lines.push(`  - ${id.slice(i + 1)}  (${id.slice(0, i)})`);
        }
        if (s.flagged.size > 40) lines.push(`  ... and ${s.flagged.size - 40} more`);
      }

      // Unverified specifics still standing in the most recent answer.
      let entries: unknown[] = [];
      try {
        entries = ctx.sessionManager.getEntries();
      } catch {
        entries = [];
      }
      for (let i = entries.length - 1; i >= 0; i--) {
        const en = entries[i] as { type?: string; message?: unknown };
        if (en?.type !== "message") continue;
        const answer = assistantAnswerText(en.message);
        if (!answer) continue;
        const claims = extractClaims(answer, "prose");
        const open = claims.filter((x) => !hasProvenance(s.corpus, x));
        lines.push("", `last answer: ${claims.length} specific(s), ${open.length} without provenance`);
        for (const x of open.slice(0, 10)) lines.push(`  - ${x.raw}  (${x.cls})`);
        break;
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
