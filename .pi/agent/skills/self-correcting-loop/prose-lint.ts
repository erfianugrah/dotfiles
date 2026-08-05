#!/usr/bin/env bun
/**
 * prose-lint.ts - a COMPUTATIONAL prose sensor for the loop.
 *
 *   bun prose-lint.ts <files...> [flags]
 *
 * The inferential judge (judge.ts) can tell you a doc reads like an LLM wrote
 * it, but it costs a frontier model per iteration and its verdict is not
 * reproducible. This is the deterministic other half: score prose against
 * structural and lexical measures, gate on a threshold, and - critically -
 * refuse to be gamed.
 *
 * WHY THE COUNTER-METRICS EXIST
 * -----------------------------
 * Every published "AI slop linter" scores things a rewrite can satisfy without
 * improving: cap sentences at 20 words and a model passes by inserting periods,
 * producing choppy stubs that read worse. So the metrics come in three classes:
 *
 *   A. lexical    - marketing adjectives, hedges, nominalizations. Cheap, real,
 *                   and trivially gamed in isolation. Contributes to the score.
 *   B. structural - sentence-length DISTRIBUTION, referent rotation, passive
 *                   with a named agent. Hard to satisfy without rewriting.
 *                   Contributes to the score.
 *   C. counters   - minimum mean sentence length, sentence-length variance
 *                   floor, fact retention vs the previous revision. These are
 *                   HARD GATES, not score contributors: a counter must not be
 *                   tradeable against a lexical win, or it is not a counter.
 *
 * MARKERS ARE NOT SCORED
 * ----------------------
 * Em-dash and semicolon counts are reported and never scored. This is a design
 * decision, stated so nobody mistakes it for a finding: a linter that excludes
 * em-dashes from its total cannot then be used as evidence that "banning
 * em-dashes does not reduce slop" - the result would be true by construction.
 * They are reported because they are useful signals for a human, not a gate.
 *
 * KNOWN LIMITS (no POS tagger; zero runtime deps by design)
 * ---------------------------------------------------------
 * - Passive and nominalization detection are regex heuristics with false
 *   positives ("is based on", "is required"). Passive is therefore two-tier:
 *   only passive WITH a named agent ("... by the parser") is a hard violation.
 * - Referent rotation is configured synonym sets plus abbreviation/expansion
 *   pairs. It is not coreference resolution and never will be.
 * - Markdown input only: YAML frontmatter, fenced and inline code, link
 *   targets and HTML comments are masked. Four-space-indented blocks are NOT
 *   treated as code, because indented list continuations are far more common
 *   in real docs and masking them would silently drop prose.
 * - The abbreviation list suppresses a sentence break after "e.g.", "Fig."
 *   and friends. An unlisted abbreviation over-splits; a listed word used as
 *   a real sentence end under-splits. Both are bounded and visible in --json.
 *
 * Exit 0 = within tolerance, non-zero = over threshold / gamed / usage error.
 */

import { basename, normalize } from "node:path";

/** A unit of document content, after masking. */
export interface Segment {
	/**
	 * "para" and "list" carry prose and feed the sentence metrics.
	 * "heading" and "table" feed the lexical metrics only - a heading is not a
	 * sentence, and counting it as one drags the length distribution down and
	 * masks genuinely long prose sentences.
	 */
	kind: "para" | "list" | "heading" | "table";
	text: string;
	/** 1-indexed line in the ORIGINAL source. */
	line: number;
}

/** Replace every non-newline character in a string with a space. */
const blankStr = (s: string): string => s.replace(/[^\n]/g, " ");

/** Blank src[start,end) in place, preserving length and newlines. */
function blank(src: string, start: number, end: number): string {
	return src.slice(0, start) + blankStr(src.slice(start, end)) + src.slice(end);
}

/**
 * Remove a leading YAML frontmatter block. Length- and line-preserving, so
 * downstream character offsets still map to the original file.
 */
export function stripFrontmatter(src: string): string {
	if (!src.startsWith("---")) return src;
	const firstNl = src.indexOf("\n");
	if (firstNl === -1) return src;
	if (src.slice(0, firstNl).trim() !== "---") return src;
	const close = /^(?:---|\.\.\.)[ \t]*$/gm;
	close.lastIndex = firstNl + 1;
	const m = close.exec(src);
	if (!m) return src;
	return blank(src, 0, m.index + m[0].length);
}

/** Mask fenced code blocks (``` and ~~~), including the fence lines. */
function maskFences(src: string): string {
	const lines = src.split("\n");
	// Character offset of the start of each line.
	const offsets: number[] = [];
	let acc = 0;
	for (const line of lines) {
		offsets.push(acc);
		acc += line.length + 1;
	}
	let out = src;
	let i = 0;
	while (i < lines.length) {
		const open = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
		if (!open) {
			i++;
			continue;
		}
		const marker = open[1][0];
		const len = open[1].length;
		let j = i + 1;
		for (; j < lines.length; j++) {
			const close = new RegExp(`^\\s{0,3}\\${marker}{${len},}\\s*$`).exec(lines[j]);
			if (close) break;
		}
		// Unterminated fence masks to end of document.
		const endLine = Math.min(j, lines.length - 1);
		const start = offsets[i];
		const end = offsets[endLine] + lines[endLine].length;
		out = blank(out, start, end);
		i = endLine + 1;
	}
	return out;
}

/**
 * Mask inline code spans. A span opens with a run of N backticks and closes
 * with the next run of exactly N (CommonMark), so ``a ` b`` is one span.
 */
function maskInlineCode(src: string): string {
	const runs: { start: number; len: number }[] = [];
	const re = /`+/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
	while ((m = re.exec(src)) !== null) runs.push({ start: m.index, len: m[0].length });
	let out = src;
	const used = new Set<number>();
	for (let i = 0; i < runs.length; i++) {
		if (used.has(i)) continue;
		for (let j = i + 1; j < runs.length; j++) {
			if (used.has(j) || runs[j].len !== runs[i].len) continue;
			out = blank(out, runs[i].start, runs[j].start + runs[j].len);
			for (let k = i; k <= j; k++) used.add(k);
			i = j;
			break;
		}
	}
	return out;
}

/** Mask fenced blocks then inline spans. Length- and line-preserving. */
export function maskCode(src: string): string {
	return maskInlineCode(maskFences(src));
}

/**
 * Mask link/image targets, autolinks, bare URLs and HTML comments, keeping
 * link text and image alt text (both are real prose). URLs are masked because
 * their dots produce phantom sentence breaks and their slugs inflate word
 * counts. Length- and line-preserving.
 */
export function maskLinkTargets(src: string): string {
	let out = src.replace(/<!--[\s\S]*?-->/g, blankStr);
	out = out.replace(/(!?)\[([^\]]*)\]\(([^)]*)\)/g, (full, bang: string, text: string) => {
		const head = " ".repeat(bang.length + 1);
		return head + text + " ".repeat(full.length - head.length - text.length);
	});
	out = out.replace(/<https?:\/\/[^>\s]*>/g, blankStr);
	out = out.replace(/\bhttps?:\/\/\S+/g, blankStr);
	return out;
}

const RE_HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const RE_LIST = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;
const RE_TABLE_DELIM = /^[\s|:-]+$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
/** Thematic break: ---, ***, ___ (three or more, optionally spaced). */
const RE_HRULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

/**
 * Split a markdown document into classified segments. Masking runs first, so
 * code, frontmatter and URLs never reach the metrics.
 */
export function segment(src: string): Segment[] {
	const masked = maskLinkTargets(maskCode(stripFrontmatter(src)));
	const lines = masked.split("\n");
	const segs: Segment[] = [];

	let buf: string[] = [];
	let bufLine = 0;
	const flush = (): void => {
		const text = buf.join(" ").replace(/\s+/g, " ").trim();
		if (text) segs.push({ kind: "para", text, line: bufLine });
		buf = [];
		bufLine = 0;
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const lineNo = i + 1;

		if (!raw.trim()) {
			flush();
			continue;
		}

		// A thematic break is punctuation, not content. Left in, it became a
		// zero-word "sentence" that dragged the mean-length metric down.
		if (RE_HRULE.test(raw)) {
			flush();
			continue;
		}

		const heading = RE_HEADING.exec(raw);
		if (heading) {
			flush();
			if (heading[1].trim()) segs.push({ kind: "heading", text: heading[1].trim(), line: lineNo });
			continue;
		}

		if (RE_TABLE_ROW.test(raw)) {
			flush();
			const inner = raw.trim().replace(/^\||\|$/g, "");
			if (RE_TABLE_DELIM.test(inner)) continue;
			const text = inner
				.split("|")
				.map((c) => c.trim())
				.filter(Boolean)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			if (text) segs.push({ kind: "table", text, line: lineNo });
			continue;
		}

		const list = RE_LIST.exec(raw);
		if (list) {
			flush();
			const text = list[1].replace(/\s+/g, " ").trim();
			if (text) segs.push({ kind: "list", text, line: lineNo });
			continue;
		}

		const quote = RE_QUOTE.exec(raw);
		const content = quote ? quote[1] : raw;
		if (!content.trim()) {
			flush();
			continue;
		}
		if (buf.length === 0) bufLine = lineNo;
		buf.push(content.trim());
	}
	flush();
	return segs;
}

/**
 * Abbreviations that must not end a sentence. Deliberately conservative:
 * "min", "max", "sec", "no", "ms", "st" and "co" are EXCLUDED despite being
 * real abbreviations, because in technical prose they appear far more often as
 * ordinary sentence-final words than as abbreviations, and a wrong suppression
 * silently merges two sentences (inflating the length metric).
 */
const RE_ABBREV =
	/(?:^|[\s("'\u2018\u201c])(?:e\.g|i\.e|etc|vs|cf|fig|dr|mr|mrs|approx|et al|a\.m|p\.m|resp|viz|incl|dept|univ|vol|pp|jr|sr|inc|ltd)\.$/i;

const RE_SENTENCE_OPENER = /["'\u2018\u201cA-Z0-9([]/;
const RE_CLOSER = /["'\u2019\u201d)\]]/;

/**
 * Split prose into sentences. Breaks on . ! ? followed by optional closing
 * quotes/brackets, whitespace, and an opener (capital, digit or quote).
 *
 * Deliberately does NOT break on a colon. The best-known open-source slop
 * linter does, which turns "Note: the parser reads the file." into two
 * sentences and understates every length metric downstream.
 */
export function splitSentences(text: string): string[] {
	const t = text.trim();
	if (!t) return [];
	const out: string[] = [];
	let start = 0;

	for (let i = 0; i < t.length; i++) {
		const c = t[i];
		if (c !== "." && c !== "!" && c !== "?") continue;

		if (c === ".") {
			if (t[i - 1] === "." || t[i + 1] === ".") continue; // ellipsis
			if (/\d/.test(t[i - 1] ?? "") && /\d/.test(t[i + 1] ?? "")) continue; // 3.14, 1.2.3
			if (RE_ABBREV.test(t.slice(0, i + 1))) continue;
		}

		let j = i + 1;
		while (j < t.length && RE_CLOSER.test(t[j])) j++;
		let k = j;
		while (k < t.length && /\s/.test(t[k])) k++;
		if (k === j) continue; // no whitespace after: not a boundary
		if (k >= t.length) break; // trailing punctuation
		if (!RE_SENTENCE_OPENER.test(t[k])) continue;

		const s = t.slice(start, j).trim();
		if (s) out.push(s);
		start = k;
		i = k - 1;
	}

	const tail = t.slice(start).trim();
	if (tail) out.push(tail);
	return out;
}

/**
 * Tokenize into words. A token starts and ends alphanumeric and may contain
 * apostrophes (both ASCII and typographic), hyphens, slashes and dots, so
 * "well-known", "It's" and "1.2" each count once.
 */
export function words(text: string): string[] {
	return text.match(/[A-Za-z0-9](?:[A-Za-z0-9'\u2019\-/.]*[A-Za-z0-9])?/g) ?? [];
}

// ---------------------------------------------------------------------------
// Class B: structural metrics. Hard to satisfy without actually rewriting.
// ---------------------------------------------------------------------------

/** Longest label admitted by isLabel, in words. */
const MAX_LABEL_WORDS = 6;

/**
 * True for a short colon-terminated fragment such as "Tunnel Config:" or
 * "Output:" - a caption introducing a code block, not a sentence.
 *
 * Without this, a command-heavy guide reads as chopped prose: one real doc in
 * the corpus scored a mean of 4.8 words per sentence purely because 20 of its
 * 63 "sentences" were block labels, and it failed the chopping gate despite
 * its actual prose being ordinary. Labels still feed the lexical detectors;
 * they are excluded only from the length distribution.
 */
export function isLabel(text: string): boolean {
	const t = text.trim();
	if (!t.endsWith(":")) return false;
	if (/[.!?]/.test(t.slice(0, -1))) return false;
	return words(t).length <= MAX_LABEL_WORDS;
}

/**
 * Every sentence in the prose-bearing segments (para + list).
 *
 * Block labels and word-free fragments are dropped: both are punctuation or
 * scaffolding rather than prose, and both distort the length distribution that
 * the structural gates read.
 */
export function proseSentences(segs: Segment[]): string[] {
	return segs
		.filter((s) => s.kind === "para" || s.kind === "list")
		.flatMap((s) => splitSentences(s.text))
		.filter((s) => words(s).length > 0 && !isLabel(s));
}

export interface LengthStats {
	count: number;
	mean: number;
	p50: number;
	p95: number;
	max: number;
	/** Population standard deviation. Collapses toward 0 as prose is chopped
	 * into uniform stubs, which is what makes it usable as a counter-metric. */
	stddev: number;
}

/**
 * Sentence-length distribution in words.
 *
 * The distribution is the point. Counting sentences over a fixed cap (the
 * usual approach) throws away the shape, so it cannot tell dense technical
 * prose apart from a run-on, and it rewards chopping. p95 plus stddev can.
 */
export function lengthStats(sentences: string[]): LengthStats {
	const lens = sentences.map((s) => words(s).length).sort((a, b) => a - b);
	const n = lens.length;
	if (n === 0) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0, stddev: 0 };
	const mean = lens.reduce((a, b) => a + b, 0) / n;
	const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
	/** Nearest-rank on the sorted lengths. */
	const q = (p: number): number => lens[Math.floor(p * (n - 1))];
	return {
		count: n,
		mean,
		p50: q(0.5),
		p95: q(0.95),
		max: lens[n - 1],
		stddev: Math.sqrt(variance),
	};
}

/**
 * Paragraphs over the sentence cap. List items are exempt however long they
 * run: a list is already a structural break, and penalising it would push a
 * model to flatten lists back into prose, which is the opposite of the goal.
 */
export function longParagraphs(segs: Segment[], maxSentences: number): Segment[] {
	return segs.filter((s) => s.kind === "para" && splitSentences(s.text).length > maxSentences);
}

/** Irregular past participles that do not end in -ed. */
const PP_IRREGULAR =
	"done|made|sent|read|built|kept|held|set|put|run|written|shown|given|taken|found|got|gotten|seen|known|thrown|drawn|brought|bought|caught|taught|left|lost|meant|met|paid|said|sold|told|understood|won|written|chosen|driven|eaten|fallen|forgotten|hidden|broken|spoken|stolen|frozen";

/**
 * Participles that are conventionally adjectival in technical prose. Without
 * this filter "is based on", "is required" and "is limited to" dominate the
 * passive count and the sensor becomes noise the reader learns to ignore.
 */
const PP_ADJECTIVAL = new Set([
	"based",
	"required",
	"related",
	"involved",
	"located",
	"limited",
	"intended",
	"detailed",
	"advanced",
	"complicated",
	"sophisticated",
	"interested",
	"concerned",
	"dedicated",
	"supposed",
	"unlimited",
	"restricted",
	// Stative in configuration prose: "sandbox is disabled" describes a state,
	// not an action someone performed.
	"enabled",
	"disabled",
	"trusted",
	"untrusted",
	"deprecated",
	"documented",
	"undocumented",
]);

export interface PassiveHit {
	/** The matched auxiliary + participle span. */
	text: string;
	/** True when an agent is named ("... by the parser"). */
	agent: boolean;
	/** Character offset of the match within the input. */
	index: number;
}

const RE_PASSIVE = new RegExp(
	`\\b(am|is|are|was|were|be|been|being)\\s+(?:(\\w+ly)\\s+)?(\\w+ed|${PP_IRREGULAR})\\b`,
	"gi",
);

/**
 * Find passive constructions.
 *
 * Both tiers are SCORED. An earlier design scored only agent-passive on the
 * theory that it is the higher-confidence signal, which is true but useless
 * here: generated prose is overwhelmingly AGENTLESS ("requests are throttled"),
 * so gating on the agent form would miss essentially all of it. The agent flag
 * survives as a subcount because that tier has a deterministic rewrite, which
 * makes it the right thing to put in a remediation hint.
 */
export function findPassive(text: string): PassiveHit[] {
	const out: PassiveHit[] = [];
	RE_PASSIVE.lastIndex = 0;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
	while ((m = RE_PASSIVE.exec(text)) !== null) {
		const participle = m[3].toLowerCase();
		if (PP_ADJECTIVAL.has(participle)) continue;
		const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
		out.push({
			text: m[0],
			agent: /^\s+by\s+\w/i.test(after),
			index: m.index,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Class A: lexical detectors.
//
// These are the tier that leaks. In a closed loop the model sees the failure
// output, learns the word list, and routes around it - which is exactly what a
// lint is for, but it also means Class A must never dominate the score, or the
// sensor degrades into a banned-words list with extra steps. The structural
// measures carry the signal; these are corroboration.
// ---------------------------------------------------------------------------

export interface LexiconConfig {
	marketing: string[];
	hedges: string[];
	phrasalVerbs: string[];
	fillerOpeners: string[];
	/** Groups of interchangeable terms; using 2+ of a group is rotation. */
	synonymSets: string[][];
}

export const DEFAULT_LEXICON: LexiconConfig = {
	marketing: [
		"seamless", "seamlessly", "robust", "powerful", "cutting-edge", "effortless",
		"effortlessly", "world-class", "next-generation", "revolutionary", "blazing",
		"lightning-fast", "delightful", "turnkey", "best-in-class", "state-of-the-art",
		"game-changing", "first-class", "battle-tested", "enterprise-grade",
		"supercharge", "unleash", "empower", "empowers", "sensible defaults",
		"minimal friction", "vendor lock-in", "rock-solid", "bulletproof",
	],
	hedges: [
		"it is important to note", "it should be noted", "it is worth noting",
		"please note that", "as mentioned above", "as noted above", "it may potentially",
		"may help to", "can potentially", "it is generally", "in some cases it may",
		"arguably", "somewhat", "fairly straightforward", "relatively simple",
	],
	phrasalVerbs: [
		"spin up", "spin down", "reach out", "dive into", "dives into", "diving into",
		"kick off", "kicks off", "circle back", "drill down", "spun up", "reaching out",
		"tear down", "ramp up",
	],
	fillerOpeners: [
		"additionally", "furthermore", "moreover", "in conclusion", "overall",
		"ultimately", "that said", "in summary", "to summarize", "in essence",
		"at the end of the day", "simply put",
	],
	/**
	 * Deliberately SHORT. Sets like ["error","failure","fault"] and
	 * ["fetch","retrieve","get"] were removed after they fired on this repo's
	 * own docs, where those words name genuinely distinct concepts (a sensor
	 * failure, an error message, a planted fault). In technical prose most
	 * apparent synonyms are terms of art, so the shipped default covers only
	 * pairs that are interchangeable in essentially every context, plus
	 * clipped-form pairs. Project glossaries belong in .prose-lint.json.
	 */
	synonymSets: [
		["user", "customer", "client", "end-user"],
		["folder", "directory"],
		["parameter", "argument"],
		["config", "configuration"],
		["repo", "repository"],
		["auth", "authentication"],
		["spec", "specification"],
		["env", "environment"],
		["dir", "directory"],
		["db", "database"],
	],
};

export interface Hit {
	term: string;
	index: number;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find configured phrases, word-boundary safe and case-insensitive. Boundaries
 * are asserted manually rather than with \b, because \b misbehaves against
 * terms that start or end with a non-word character ("cutting-edge", "c++").
 */
export function findPhrases(text: string, phrases: string[]): Hit[] {
	if (!text || phrases.length === 0) return [];
	const out: Hit[] = [];
	const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);
	for (const phrase of phrases) {
		const re = new RegExp(escapeRe(phrase), "gi");
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
		while ((m = re.exec(text)) !== null) {
			const before = text[m.index - 1];
			const after = text[m.index + m[0].length];
			const headIsWord = isWord(phrase[0]);
			const tailIsWord = isWord(phrase[phrase.length - 1]);
			if (headIsWord && isWord(before)) continue;
			if (tailIsWord && isWord(after)) continue;
			out.push({ term: phrase, index: m.index });
		}
	}
	return out.sort((a, b) => a.index - b.index);
}

/**
 * Light-verb nominalizations: "perform an analysis of" for "analyze".
 *
 * Only the light-verb construction is detected. The bare "the <X>tion of"
 * pattern is deliberately NOT flagged: "the implementation of the parser" is
 * ordinary technical prose, and flagging it produces more false positives than
 * real findings, which trains the reader to ignore the sensor.
 */
const RE_NOMINALIZATION =
	/\b(perform|performs|performed|conduct|conducts|conducted|carry out|carries out|undertake|undertakes|make use of|makes use of)\s+(?:a|an|the)?\s*\w+(?:tion|ment|ance|ence|sis|ing)\b/gi;

export function findNominalizations(text: string): Hit[] {
	if (!text) return [];
	const out: Hit[] = [];
	RE_NOMINALIZATION.lastIndex = 0;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
	while ((m = RE_NOMINALIZATION.exec(text)) !== null) out.push({ term: m[0], index: m.index });
	return out;
}

/** Filler transitions, counted only where they open a sentence. */
export function findFillerOpeners(sentences: string[], openers: string[]): Hit[] {
	const out: Hit[] = [];
	for (const [i, s] of sentences.entries()) {
		const head = s.trimStart().toLowerCase();
		for (const o of openers) {
			if (!head.startsWith(o.toLowerCase())) continue;
			const next = head[o.length];
			if (next === undefined || /[\s,;:]/.test(next)) {
				out.push({ term: o, index: i });
				break;
			}
		}
	}
	return out;
}

type ListOverride = string[] | { add?: string[]; remove?: string[] };
export type LexiconOverride = Partial<Record<keyof LexiconConfig, ListOverride>>;

/**
 * Merge a user override into the defaults. A plain array REPLACES the list; an
 * `{ add, remove }` object extends it. Both forms are supported because
 * replacing is what you want for a project glossary and extending is what you
 * want for a one-off exception.
 */
export function mergeLexicon(base: LexiconConfig, override: LexiconOverride): LexiconConfig {
	const out: LexiconConfig = {
		marketing: [...base.marketing],
		hedges: [...base.hedges],
		phrasalVerbs: [...base.phrasalVerbs],
		fillerOpeners: [...base.fillerOpeners],
		synonymSets: base.synonymSets.map((s) => [...s]),
	};
	for (const [key, value] of Object.entries(override) as [keyof LexiconConfig, ListOverride][]) {
		if (!(key in out)) throw new Error(`unknown lexicon key: ${key}`);
		if (Array.isArray(value)) {
			// biome-ignore lint/suspicious/noExplicitAny: heterogeneous list shapes
			(out as any)[key] = value;
			continue;
		}
		if (typeof value !== "object" || value === null) {
			throw new Error(`${key}: expected an array or an {add,remove} object`);
		}
		if (key === "synonymSets") throw new Error("synonymSets: expected an array of arrays");
		const remove = new Set((value.remove ?? []).map((s) => s.toLowerCase()));
		const kept = (out[key] as string[]).filter((s) => !remove.has(s.toLowerCase()));
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous list shapes
		(out as any)[key] = [...kept, ...(value.add ?? [])];
	}
	return out;
}

// ---------------------------------------------------------------------------
// Referent rotation: the signal no banned-words list can capture.
//
// Calling one thing by two names is the single rule most associated with
// controlled technical English, and it is invisible to every word-list linter,
// because each individual word is fine. Two mechanisms, neither pretending to
// be coreference resolution: configured synonym sets, and abbreviation pairs
// derived from the text itself.
// ---------------------------------------------------------------------------

export interface RotationHit {
	variants: string[];
	counts: Record<string, number>;
}

function tally(tokens: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const t of tokens) {
		const k = t.toLowerCase();
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	return counts;
}

/**
 * Configured synonym sets with 2+ members used repeatedly in one document.
 *
 * `minCount` (default 2) is load-bearing, not a tuning knob: a single passing
 * mention of an alternative term is almost always a definition or a quote, not
 * rotation, and counting it makes the detector fire on well-written docs.
 */
export function findRotation(tokens: string[], sets: string[][], minCount = 2): RotationHit[] {
	if (tokens.length === 0 || sets.length === 0) return [];
	const counts = tally(tokens);
	const out: RotationHit[] = [];
	for (const set of sets) {
		const present: Record<string, number> = {};
		for (const term of set) {
			const n = counts.get(term.toLowerCase());
			if (n !== undefined && n >= minCount) present[term.toLowerCase()] = n;
		}
		const variants = Object.keys(present);
		if (variants.length >= 2) out.push({ variants, counts: present });
	}
	return out;
}

/*
 * There is no derive-abbreviations-from-the-text detector here, and that is a
 * deliberate removal rather than an omission.
 *
 * The first cut generated abbreviation/expansion pairs by prefix-matching the
 * document's own vocabulary (short token, longer token starting with it, minus
 * known inflections). Measured against this repo's SKILL.md it produced 286
 * hits, of which approximately none were real: loop/loop-built, run/runtime,
 * harness/harnessable, deterministic/deterministically, and not/nothing. A
 * shared prefix is simply not evidence of abbreviation, and no suffix list
 * rescues not/nothing. Curated pairs in `synonymSets` cover the real cases
 * (config/configuration, repo/repository) at zero false-positive cost.
 */

// ---------------------------------------------------------------------------
// Class C: structural floors. HARD GATES, never score contributors.
//
// A counter that merely added points could be paid for by deleting three more
// adjectives, which is exactly the trade it exists to forbid. So these are
// booleans, evaluated separately from the score.
// ---------------------------------------------------------------------------

export interface CounterConfig {
	minMeanSentence: number;
	/**
	 * Wordiness ceiling. This lives here as a GATE rather than as a score term
	 * because mean sentence length is a distribution statistic, and folding a
	 * statistic into a per-100-words count produces a number that means nothing.
	 * Counts go in the score; shape goes in the gates.
	 */
	maxMeanSentence: number;
	minStddev: number;
	/**
	 * Fraction of the previous revision's facts that must survive. Secondary to
	 * maxFactsLost and lax by default, because a ratio is the wrong shape for
	 * this job on its own: it scales tolerance with document size, so a large
	 * measured reference would be permitted to lose more numbers than a short
	 * one.
	 */
	minFactRetention: number;
	/**
	 * Absolute number of facts a revision may drop. This is the binding limit.
	 * Found on a real 294-fact reference doc: deleting a measured latency left
	 * retention at 0.997 and sailed through a 0.9 ratio gate, which is exactly
	 * the edit the gate exists to catch.
	 */
	maxFactsLost: number;
	/** Below this many sentences the variance floor is not evaluated. */
	minSentencesForVariance: number;
}

/**
 * Thresholds derived from measurement, not intuition. Corpus: 49 real
 * documents (this repo's skills, READMEs and AGENTS.md) against two
 * adversarial samples (prose chopped into stubs; a generated marketing-voice
 * README).
 *
 *   metric        our corpus          adversarial              chosen
 *   mean floor    min 6.6             chopped 2.9              5
 *   mean ceiling  max 17.3            generated 32.7           25
 *   stddev floor  min 3.6 (n>=8)      chopped 0.6, gen 3.3     2
 *
 * The stddev floor is a CHOPPING detector only. An earlier draft claimed it
 * caught run-on generated prose too, and the corpus refutes that: our terse
 * CLI-reference docs bottom out at 3.6, which is barely above the generated
 * sample's 3.3, so no threshold separates those two without failing real
 * docs. Run-ons are the mean ceiling's job. One job per gate.
 *
 * The fact-retention pair is calibrated differently: maxFactsLost is the
 * binding limit and defaults to zero tolerance, because a revision that drops
 * a measured number is the case the gate exists for. Raise it deliberately.
 */
export const DEFAULT_COUNTERS: CounterConfig = {
	minMeanSentence: 5,
	maxMeanSentence: 25,
	minStddev: 2,
	minFactRetention: 0.9,
	maxFactsLost: 0,
	minSentencesForVariance: 8,
};

/**
 * Default slop-score gate, violations per 100 words.
 *
 * Measured: our 49-document corpus tops out at 0.72 (p95 0.36); the generated
 * sample scores 3.06. 1.0 clears every real document with headroom and still
 * sits 3x under the slop sample.
 */
export const DEFAULT_MAX_SLOP = 1.0;

export interface CounterResult {
	name: string;
	passed: boolean;
	detail: string;
}

export interface FactRetention {
	ratio: number;
	lost: string[];
	total: number;
}

const RE_BACKTICKED = /`([^`\n]+)`/g;
/**
 * A number, with any unit fused to it kept as part of the fact.
 *
 * The trailing `\b` this replaced made the whole gate blind to the numbers it
 * most needed to protect: `\b172\b` does not match inside "172ms", because the
 * boundary fails between a digit and a letter. On a corpus of measurements -
 * where latencies, sizes and durations nearly always carry a fused unit -
 * deleting "~172ms" from a sentence passed the gate silently.
 */
const RE_NUMBER = /(?<![A-Za-z0-9])\d+(?:[.,]\d+)*(?:[A-Za-z%]{1,4})?/g;
const RE_URL = /\bhttps?:\/\/\S+/g;

/**
 * Extract the load-bearing specifics of a document: backticked identifiers,
 * numbers and URLs.
 *
 * Runs on RAW text, before masking, because masking is exactly what removes
 * these. General content-word retention was considered first and rejected:
 * honest tightening drops plenty of ordinary words, so the measure would be
 * noise. Losing `Retry-After` or "100 requests per minute" is substance loss;
 * losing "comprehensive" is the entire point of the rewrite.
 */
export function extractFacts(text: string): string[] {
	if (!text) return [];
	const out = new Set<string>();
	for (const re of [RE_BACKTICKED, RE_NUMBER, RE_URL]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
		while ((m = re.exec(text)) !== null) {
			const v = (m[1] ?? m[0]).trim();
			if (v) out.add(v);
		}
	}
	return [...out];
}

/** What fraction of the before-text's facts survived into the after-text. */
export function factRetention(before: string, after: string): FactRetention {
	const want = extractFacts(before);
	if (want.length === 0) return { ratio: 1, lost: [], total: 0 };
	const have = new Set(extractFacts(after));
	const lost = want.filter((f) => !have.has(f));
	return { ratio: (want.length - lost.length) / want.length, lost, total: want.length };
}

/**
 * Evaluate the structural floors.
 *
 * The variance floor fires in BOTH directions and says which: uniformly long
 * is a run-on generator, uniformly short is a chopped rewrite. Sentence length
 * alone cannot tell dense technical prose from either, but uniformity can -
 * measured on this repo, real prose runs stddev 10-11 while generated prose
 * runs 3.3 and chopped stubs run 0.6.
 */
export function evaluateCounters(
	stats: LengthStats,
	facts: FactRetention | null,
	cfg: CounterConfig,
): CounterResult[] {
	const out: CounterResult[] = [];

	if (stats.count === 0) {
		out.push({ name: "mean-sentence-floor", passed: true, detail: "skipped: no sentences" });
		out.push({ name: "mean-sentence-ceiling", passed: true, detail: "skipped: no sentences" });
		out.push({ name: "sentence-variance-floor", passed: true, detail: "skipped: no sentences" });
	} else {
		const meanOk = stats.mean >= cfg.minMeanSentence;
		out.push({
			name: "mean-sentence-floor",
			passed: meanOk,
			detail: meanOk
				? `mean ${stats.mean.toFixed(1)} words >= ${cfg.minMeanSentence}`
				: `mean ${stats.mean.toFixed(1)} words < ${cfg.minMeanSentence}: prose chopped into stubs scores well on every other measure while reading worse`,
		});

		const ceilOk = stats.mean <= cfg.maxMeanSentence;
		out.push({
			name: "mean-sentence-ceiling",
			passed: ceilOk,
			detail: ceilOk
				? `mean ${stats.mean.toFixed(1)} words <= ${cfg.maxMeanSentence}`
				: `mean ${stats.mean.toFixed(1)} words > ${cfg.maxMeanSentence}: sustained run-on sentences. Note this is the MEAN, not the longest - one dense sentence among short ones does not trip it.`,
		});

		if (stats.count < cfg.minSentencesForVariance) {
			out.push({
				name: "sentence-variance-floor",
				passed: true,
				detail: `skipped: ${stats.count} sentences is too few for variance to mean anything (need ${cfg.minSentencesForVariance})`,
			});
		} else {
			const varOk = stats.stddev >= cfg.minStddev;
			const direction =
				stats.mean >= cfg.minMeanSentence
					? "uniformly long: the run-on shape a generator produces"
					: "uniformly short: the shape prose takes when it is chopped to beat a length cap";
			out.push({
				name: "sentence-variance-floor",
				passed: varOk,
				detail: varOk
					? `stddev ${stats.stddev.toFixed(1)} >= ${cfg.minStddev}`
					: `stddev ${stats.stddev.toFixed(1)} < ${cfg.minStddev}, ${direction}. Real prose varies its sentence length.`,
			});
		}
	}

	if (facts === null || facts.total === 0) {
		out.push({ name: "fact-retention", passed: true, detail: "skipped: no before-text to compare" });
	} else {
		const ok = facts.lost.length <= cfg.maxFactsLost && facts.ratio >= cfg.minFactRetention;
		out.push({
			name: "fact-retention",
			passed: ok,
			detail: ok
				? `kept ${facts.total - facts.lost.length} of ${facts.total} facts`
				: `dropped ${facts.lost.length} of ${facts.total} facts from the previous revision: ${facts.lost.slice(0, 8).join(", ")}${facts.lost.length > 8 ? ", ..." : ""}`,
		});
	}

	return out;
}

// ---------------------------------------------------------------------------
// Analysis, scoring, CLI.
// ---------------------------------------------------------------------------

export interface Violation {
	category: string;
	term: string;
	/** 1-indexed line in the original file; 0 for whole-document findings. */
	line: number;
}

/**
 * The categories that DISCRIMINATE, and so the only ones in the gated score.
 *
 * Passive voice and long paragraphs are deliberately excluded. Measured on
 * this repo, passive alone was 76 of 81 violations in SKILL.md - and sampling
 * them showed they were real passives in correct, clear prose ("the run is
 * refused"). A measure that fires equally on good and bad writing is not a
 * discriminator, and letting it dominate buries the signals that are: with
 * passive in, generated slop scored 4.08 against our own docs at 0.83 (5x);
 * with it out, 3.06 against 0.02 (150x).
 */
const SLOP_CATEGORIES = new Set([
	"marketing",
	"hedge",
	"phrasal-verb",
	"nominalization",
	"filler-opener",
	"referent-rotation",
]);

export interface FileReport {
	path: string;
	words: number;
	stats: LengthStats;
	violations: Violation[];
	/** Discriminating violations per 100 words. This is what --max gates. */
	score: number;
	/** Passive and long-paragraph per 100 words. Reported, not gated. */
	styleScore: number;
	rotation: RotationHit[];
	counters: CounterResult[];
	/** Reported, never scored. See the header. */
	markers: { emDash: number; semicolon: number };
}

/** Em-dash and en-dash. Counted for the reader, excluded from the score. */
const RE_DASH_MARKER = /[\u2014\u2013]/g;

/** Paragraph sentence cap. Six is the figure controlled-language guides use. */
const MAX_PARAGRAPH_SENTENCES = 6;

export function analyzeText(
	path: string,
	raw: string,
	lexicon: LexiconConfig,
	counters: CounterConfig,
	before: string | null,
): FileReport {
	const segs = segment(raw);
	const prose = segs.filter((s) => s.kind === "para" || s.kind === "list");
	const sentences = proseSentences(segs);
	const stats = lengthStats(sentences);

	const allText = segs.map((s) => s.text).join("\n");
	const tokens = words(allText);

	const violations: Violation[] = [];
	const push = (category: string, line: number, terms: { term: string }[]): void => {
		for (const t of terms) violations.push({ category, term: t.term, line });
	};

	for (const s of segs) {
		push("marketing", s.line, findPhrases(s.text, lexicon.marketing));
		push("hedge", s.line, findPhrases(s.text, lexicon.hedges));
		push("phrasal-verb", s.line, findPhrases(s.text, lexicon.phrasalVerbs));
		push("nominalization", s.line, findNominalizations(s.text));
	}
	for (const s of prose) {
		for (const p of findPassive(s.text)) {
			violations.push({
				category: p.agent ? "passive-with-agent" : "passive",
				term: p.text,
				line: s.line,
			});
		}
		for (const f of findFillerOpeners(splitSentences(s.text), lexicon.fillerOpeners)) {
			violations.push({ category: "filler-opener", term: f.term, line: s.line });
		}
	}
	for (const p of longParagraphs(segs, MAX_PARAGRAPH_SENTENCES)) {
		violations.push({
			category: "long-paragraph",
			term: `${splitSentences(p.text).length} sentences`,
			line: p.line,
		});
	}

	const rotation = findRotation(tokens, lexicon.synonymSets);
	for (const r of rotation) {
		violations.push({ category: "referent-rotation", term: r.variants.join(" / "), line: 0 });
	}

	// Facts are drawn from PROSE, with fenced code masked out but inline
	// backticks kept. Extracting from the whole file made any edit to a code
	// example fail the gate - bumping a version inside a ```bash block dropped
	// a "fact" and failed a legitimate change. The gate exists to stop prose
	// being hollowed out while it is shortened; a fenced example is a separate
	// reviewable artifact, and the false-positive cost of policing it here is
	// higher than the detection it buys.
	const factSource = (t: string): string => maskFences(stripFrontmatter(t));
	const facts = before === null ? null : factRetention(factSource(before), factSource(raw));
	const masked = maskLinkTargets(maskCode(stripFrontmatter(raw)));

	const per100 = (n: number): number => (tokens.length > 0 ? (n * 100) / tokens.length : 0);
	const slop = violations.filter((v) => SLOP_CATEGORIES.has(v.category)).length;

	return {
		path,
		words: tokens.length,
		stats,
		violations: violations.sort((a, b) => a.line - b.line),
		score: per100(slop),
		styleScore: per100(violations.length - slop),
		rotation,
		counters: evaluateCounters(stats, facts, counters),
		markers: {
			emDash: (masked.match(RE_DASH_MARKER) ?? []).length,
			semicolon: (masked.match(/;/g) ?? []).length,
		},
	};
}

export interface Args {
	files: string[];
	max: number | null;
	before: string;
	baselinePath: string;
	configPath: string;
	json: boolean;
	explain: boolean;
	updateBaseline: boolean;
	noCounters: boolean;
}

export function parseArgs(argv: string[]): Args {
	const a: Args = {
		files: [],
		max: DEFAULT_MAX_SLOP,
		before: "",
		baselinePath: "",
		configPath: "",
		json: false,
		explain: false,
		updateBaseline: false,
		noCounters: false,
	};
	const need = (i: number, flag: string): string => {
		const v = argv[i + 1];
		if (v === undefined || v.startsWith("--")) throw new Error(`${flag} wants a value`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--max": {
				const n = Number.parseFloat(need(i, "--max"));
				if (!Number.isFinite(n)) throw new Error("--max wants a number");
				a.max = n;
				i++;
				break;
			}
			case "--before": a.before = need(i, "--before"); i++; break;
			case "--baseline": a.baselinePath = need(i, "--baseline"); i++; break;
			case "--config": a.configPath = need(i, "--config"); i++; break;
			case "--no-max": a.max = null; break;
			case "--json": a.json = true; break;
			case "--explain": a.explain = true; break;
			case "--update-baseline": a.updateBaseline = true; break;
			case "--no-counters": a.noCounters = true; break;
			default:
				if (arg.startsWith("--")) throw new Error(`unknown arg: ${arg}`);
				// Normalized so "./a.md" and "a.md" are one identity. The ratchet
				// keys its stored scores on this string, and a key miss makes the
				// gate silently stop applying - a guard that quietly becomes a
				// no-op is worse than no guard.
				a.files.push(normalize(arg));
		}
	}
	if (a.files.length === 0) {
		throw new Error(
			"usage: prose-lint.ts <files...> [--max n | --no-max] [--before rev] [--baseline json] [--config json] [--json] [--explain] [--update-baseline] [--no-counters]",
		);
	}
	return a;
}

/** Read a path at a git revision. Returns null when it is not in that rev. */
export async function gitShow(rev: string, path: string): Promise<string | null> {
	const p = Bun.spawn(["git", "show", `${rev}:./${path}`], { stdout: "pipe", stderr: "ignore" });
	const text = await new Response(p.stdout).text();
	return (await p.exited) === 0 ? text : null;
}

async function loadLexicon(configPath: string): Promise<LexiconConfig> {
	if (!configPath) return DEFAULT_LEXICON;
	const raw = await Bun.file(configPath).text();
	return mergeLexicon(DEFAULT_LEXICON, JSON.parse(raw) as LexiconOverride);
}

export function renderReport(r: FileReport, explain: boolean): string {
	const lines: string[] = [];
	lines.push(
		`${r.path}: slop ${r.score.toFixed(2)}/100w  (style ${r.styleScore.toFixed(2)}, ${r.words} words, ` +
			`mean ${r.stats.mean.toFixed(1)} sd ${r.stats.stddev.toFixed(1)})  ` +
			`[markers: em-dash ${r.markers.emDash}, semicolon ${r.markers.semicolon}]`,
	);
	for (const c of r.counters.filter((x) => !x.passed)) lines.push(`  GATE ${c.name}: ${c.detail}`);
	const byCat = new Map<string, number>();
	for (const v of r.violations) byCat.set(v.category, (byCat.get(v.category) ?? 0) + 1);
	const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
	if (cats.length > 0) lines.push(`  ${cats.map(([k, n]) => `${k}=${n}`).join("  ")}`);
	if (explain) {
		for (const v of r.violations) {
			// line 0 means the finding is about the document as a whole (referent
			// rotation), so do not print a line number that does not exist.
			const where = v.line > 0 ? `${r.path}:${v.line}` : `${r.path} (whole file)`;
			lines.push(`  ${where}  ${v.category}: ${v.term}`);
		}
	}
	return lines.join("\n");
}

export async function main(argv: string[]): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (err) {
		console.error(`prose-lint: ${(err as Error).message}`);
		return 2;
	}

	let lexicon: LexiconConfig;
	try {
		lexicon = await loadLexicon(args.configPath);
	} catch (err) {
		console.error(`prose-lint: config: ${(err as Error).message}`);
		return 2;
	}

	const reports: FileReport[] = [];
	for (const f of args.files) {
		let raw: string;
		try {
			raw = await Bun.file(f).text();
		} catch {
			console.error(`prose-lint: cannot read ${f}`);
			return 2;
		}
		const before = args.before ? await gitShow(args.before, f) : null;
		reports.push(analyzeText(f, raw, lexicon, DEFAULT_COUNTERS, before));
	}

	let baseline: Record<string, number> = {};
	if (args.baselinePath) {
		try {
			baseline = JSON.parse(await Bun.file(args.baselinePath).text()) as Record<string, number>;
		} catch {
			baseline = {};
		}
	}

	if (args.updateBaseline) {
		if (!args.baselinePath) {
			console.error("prose-lint: --update-baseline needs --baseline <json>");
			return 2;
		}
		const next: Record<string, number> = { ...baseline };
		for (const r of reports) next[r.path] = Number(r.score.toFixed(4));
		await Bun.write(args.baselinePath, `${JSON.stringify(next, null, 2)}\n`);
		console.log(`prose-lint: baseline updated (${reports.length} files) -> ${args.baselinePath}`);
		return 0;
	}

	const failures: string[] = [];
	for (const r of reports) {
		if (!args.noCounters) {
			for (const c of r.counters) if (!c.passed) failures.push(`${r.path}: gate ${c.name} - ${c.detail}`);
		}
		if (args.max !== null && r.score > args.max) {
			failures.push(`${r.path}: score ${r.score.toFixed(2)} > --max ${args.max}`);
		}
		const prior = baseline[r.path];
		// The 0.01 slack absorbs float noise in the stored score, nothing more.
		if (prior !== undefined && r.score > prior + 0.01) {
			failures.push(`${r.path}: score ${r.score.toFixed(2)} regressed against baseline ${prior.toFixed(2)}`);
		}
	}

	if (args.json) {
		console.log(JSON.stringify({ reports, failures }, null, 2));
	} else {
		for (const r of reports) console.log(renderReport(r, args.explain));
		if (reports.length > 1) {
			const w = reports.reduce((a, r) => a + r.words, 0);
			const slop = reports.reduce((a, r) => a + (r.score * r.words) / 100, 0);
			console.log(`TOTAL: slop ${(w > 0 ? (slop * 100) / w : 0).toFixed(2)}/100w across ${reports.length} files`);
		}
		for (const f of failures) console.error(`FAIL ${f}`);
	}

	return failures.length > 0 ? 1 : 0;
}

if (import.meta.main && basename(Bun.main) === "prose-lint.ts") {
	process.exit(await main(Bun.argv.slice(2)));
}
