import { describe, expect, test } from "bun:test";
import {
	DEFAULT_COUNTERS,
	DEFAULT_LEXICON,
	evaluateCounters,
	extractFacts,
	factRetention,
	findFillerOpeners,
	findNominalizations,
	findPassive,
	findPhrases,
	findRotation,
	lengthStats,
	longParagraphs,
	maskCode,
	maskLinkTargets,
	mergeLexicon,
	proseSentences,
	segment,
	splitSentences,
	stripFrontmatter,
	words,
} from "./prose-lint.ts";

/**
 * Geometry invariant: every mask* / strip* helper returns a string of the SAME
 * length as its input, with newlines preserved. That is what lets a character
 * index into the masked text map back to a line:col in the original file for
 * --explain. Assert it everywhere.
 */
function sameGeometry(before: string, after: string): void {
	expect(after.length).toBe(before.length);
	expect(after.split("\n").length).toBe(before.split("\n").length);
}

describe("stripFrontmatter", () => {
	test("removes a leading YAML block, preserving line geometry", () => {
		const src = "---\nname: x\ndesc: y\n---\nreal prose here.\n";
		const out = stripFrontmatter(src);
		sameGeometry(src, out);
		expect(out).not.toContain("name: x");
		expect(out).toContain("real prose here.");
	});

	test("leaves a horizontal rule mid-document alone", () => {
		const src = "intro para.\n\n---\n\nnext para.\n";
		expect(stripFrontmatter(src)).toBe(src);
	});

	test("leaves a document with no frontmatter alone", () => {
		const src = "# Title\n\nbody.\n";
		expect(stripFrontmatter(src)).toBe(src);
	});

	test("an unterminated opening fence is not treated as frontmatter", () => {
		const src = "---\nname: x\nnever closed\n";
		expect(stripFrontmatter(src)).toBe(src);
	});
});

describe("maskCode", () => {
	test("masks fenced blocks but keeps line count", () => {
		const src = "before.\n\n```ts\nconst x = 1; // semicolon here\n```\n\nafter.\n";
		const out = maskCode(src);
		sameGeometry(src, out);
		expect(out).not.toContain("const x");
		expect(out).not.toContain(";");
		expect(out).toContain("before.");
		expect(out).toContain("after.");
	});

	test("masks tilde fences", () => {
		const src = "a.\n\n~~~\nraw; text\n~~~\n\nb.\n";
		const out = maskCode(src);
		sameGeometry(src, out);
		expect(out).not.toContain("raw; text");
	});

	test("masks inline code spans", () => {
		const src = "Run `npm run build; echo done` to build.\n";
		const out = maskCode(src);
		sameGeometry(src, out);
		expect(out).not.toContain("npm run build");
		expect(out).toContain("to build.");
	});

	test("masks double-backtick spans containing a backtick", () => {
		const src = "Use ``a ` b`` here.\n";
		const out = maskCode(src);
		sameGeometry(src, out);
		expect(out).not.toContain("a ` b");
	});

	test("an unterminated fence masks to end of document", () => {
		const src = "intro.\n\n```\nnever closed; still code\n";
		const out = maskCode(src);
		sameGeometry(src, out);
		expect(out).toContain("intro.");
		expect(out).not.toContain("still code");
	});

	test("does NOT treat 4-space-indented list continuation as code", () => {
		const src = "- item one\n\n    continuation prose that is not code.\n";
		const out = maskCode(src);
		expect(out).toContain("continuation prose that is not code.");
	});
});

describe("maskLinkTargets", () => {
	test("keeps link text, masks the URL", () => {
		const src = "See [the spec](https://asd-ste100.org/about.html) for detail.\n";
		const out = maskLinkTargets(src);
		sameGeometry(src, out);
		expect(out).toContain("the spec");
		expect(out).not.toContain("asd-ste100.org");
	});

	test("masks bare URLs and autolinks", () => {
		const src = "Docs at https://example.com/a.b.c and <https://x.dev/y>.\n";
		const out = maskLinkTargets(src);
		sameGeometry(src, out);
		expect(out).not.toContain("example.com");
		expect(out).not.toContain("x.dev");
	});

	test("keeps image alt text, masks the src", () => {
		const src = "![a red square](./img/red.png) follows.\n";
		const out = maskLinkTargets(src);
		sameGeometry(src, out);
		expect(out).toContain("a red square");
		expect(out).not.toContain("red.png");
	});

	test("masks HTML comments", () => {
		const src = "visible.\n<!-- hidden note; with semicolon -->\nalso visible.\n";
		const out = maskLinkTargets(src);
		sameGeometry(src, out);
		expect(out).not.toContain("hidden note");
		expect(out).toContain("also visible.");
	});
});

describe("segment", () => {
	test("classifies headings, paragraphs, list items and table rows", () => {
		const src = [
			"# Title Here",
			"",
			"A normal paragraph of prose.",
			"",
			"- first item",
			"- second item",
			"",
			"| col a | col b |",
			"|---|---|",
			"| v1 | v2 |",
			"",
			"> quoted prose.",
			"",
		].join("\n");
		const segs = segment(src);
		const kinds = segs.map((s) => s.kind);
		expect(kinds).toContain("heading");
		expect(kinds).toContain("para");
		expect(kinds).toContain("list");
		expect(kinds).toContain("table");

		const heading = segs.find((s) => s.kind === "heading");
		expect(heading?.text).toBe("Title Here");
		expect(heading?.line).toBe(1);
	});

	test("a blockquote is prose, not its own kind", () => {
		const segs = segment("> quoted prose here.\n");
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("para");
		expect(segs[0].text).toBe("quoted prose here.");
	});

	test("the table delimiter row is not emitted as content", () => {
		const segs = segment("| a | b |\n|---|---|\n| 1 | 2 |\n");
		const texts = segs.map((s) => s.text);
		expect(texts.some((t) => t.includes("---"))).toBe(false);
	});

	test("list markers are stripped, ordered and unordered", () => {
		const segs = segment("- dash item\n* star item\n1. one item\n2) two item\n");
		expect(segs.map((s) => s.text)).toEqual([
			"dash item",
			"star item",
			"one item",
			"two item",
		]);
		expect(segs.every((s) => s.kind === "list")).toBe(true);
	});

	test("consecutive lines join into one paragraph segment", () => {
		const segs = segment("line one of a wrapped\nparagraph that continues.\n\nsecond para.\n");
		expect(segs).toHaveLength(2);
		expect(segs[0].text).toBe("line one of a wrapped paragraph that continues.");
		expect(segs[1].line).toBe(4);
	});

	test("line numbers are 1-indexed and survive frontmatter + code", () => {
		const src = "---\nk: v\n---\n\n```\ncode\n```\n\nprose after code.\n";
		const segs = segment(src);
		expect(segs).toHaveLength(1);
		expect(segs[0].text).toBe("prose after code.");
		expect(segs[0].line).toBe(9);
	});

	test("emits nothing for an empty or code-only document", () => {
		expect(segment("")).toEqual([]);
		expect(segment("```\nonly code\n```\n")).toEqual([]);
	});
});

describe("splitSentences", () => {
	test("splits on terminal punctuation followed by a capital", () => {
		expect(splitSentences("First one. Second one! Third one?")).toEqual([
			"First one.",
			"Second one!",
			"Third one?",
		]);
	});

	test("does NOT split on a colon (the video's linter bug)", () => {
		expect(splitSentences("Note: the parser reads the file.")).toEqual([
			"Note: the parser reads the file.",
		]);
	});

	test("does not split inside common abbreviations", () => {
		expect(splitSentences("Use a cache, e.g. Valkey, for this.")).toHaveLength(1);
		expect(splitSentences("Retries, i.e. backoff, are on.")).toHaveLength(1);
		expect(splitSentences("See Fig. 2 for the layout.")).toHaveLength(1);
		expect(splitSentences("Chervak et al. found the same.")).toHaveLength(1);
	});

	test("does not split inside version or decimal numbers", () => {
		expect(splitSentences("Upgrade to the 1.2.3 build today.")).toHaveLength(1);
		expect(splitSentences("The ratio is 3.14 exactly.")).toHaveLength(1);
	});

	test("handles a period before a closing quote or bracket", () => {
		expect(
			splitSentences('He said "it works." Then he left.'),
		).toEqual(['He said "it works."', "Then he left."]);
		expect(splitSentences("(See the note.) Next sentence.")).toHaveLength(2);
	});

	test("treats an ellipsis as continuation, not a break", () => {
		expect(splitSentences("It trails off ... And then resumes.")).toHaveLength(1);
	});

	test("splits when the next sentence opens with a digit or quote", () => {
		expect(splitSentences("Count them. 42 remain.")).toHaveLength(2);
		expect(splitSentences('Consider this. "Quoted start" follows.')).toHaveLength(2);
	});

	test("a trailing fragment with no terminator is still a sentence", () => {
		expect(splitSentences("Complete one. Dangling fragment")).toEqual([
			"Complete one.",
			"Dangling fragment",
		]);
	});

	test("empty and whitespace input yield no sentences", () => {
		expect(splitSentences("")).toEqual([]);
		expect(splitSentences("   \n  ")).toEqual([]);
	});
});

describe("words", () => {
	test("counts hyphenated and apostrophised forms as single words", () => {
		expect(words("It's a well-known bug.")).toEqual(["It's", "a", "well-known", "bug"]);
	});

	test("counts a typographic apostrophe as part of the word", () => {
		expect(words("It\u2019s fine.")).toEqual(["It\u2019s", "fine"]);
	});

	test("keeps alphanumeric tokens, drops bare punctuation", () => {
		expect(words("1.2 -- ok, 42 %")).toEqual(["1.2", "ok", "42"]);
	});

	test("empty input yields no words", () => {
		expect(words("")).toEqual([]);
		expect(words("--- ;; ...")).toEqual([]);
	});
});

describe("proseSentences", () => {
	test("draws only from para and list segments, not headings or tables", () => {
		const src = [
			"# A Heading That Is Not A Sentence",
			"",
			"A paragraph sentence.",
			"",
			"- A list sentence.",
			"",
			"| cell a | cell b |",
			"",
		].join("\n");
		expect(proseSentences(segment(src))).toEqual(["A paragraph sentence.", "A list sentence."]);
	});

	test("splits multi-sentence segments", () => {
		const segs = segment("One here. Two here. Three here.\n");
		expect(proseSentences(segs)).toHaveLength(3);
	});
});

describe("lengthStats", () => {
	test("reports count, mean, percentiles and max in words", () => {
		// Word counts: 1, 2, 3, 4.
		const s = lengthStats(["a", "a b", "a b c", "a b c d"]);
		expect(s.count).toBe(4);
		expect(s.mean).toBeCloseTo(2.5, 5);
		expect(s.max).toBe(4);
	});

	test("percentiles use nearest-rank on the sorted lengths", () => {
		const ten = Array.from({ length: 10 }, (_, i) => "w ".repeat(i + 1).trim());
		const s = lengthStats(ten);
		// sorted lengths 1..10; nearest-rank index = floor(q * (n-1))
		expect(s.p50).toBe(5);
		expect(s.p95).toBe(9);
		expect(s.max).toBe(10);
	});

	test("stddev is population stddev and collapses to 0 for uniform input", () => {
		expect(lengthStats(["a b c", "a b c", "a b c"]).stddev).toBeCloseTo(0, 5);
		expect(lengthStats(["a", "a b c d e"]).stddev).toBeCloseTo(2, 5);
	});

	test("empty input is all zeros, never NaN", () => {
		const s = lengthStats([]);
		expect(s).toEqual({ count: 0, mean: 0, p50: 0, p95: 0, max: 0, stddev: 0 });
	});
});

describe("longParagraphs", () => {
	test("flags only para segments over the sentence cap", () => {
		const src = [
			"One. Two. Three. Four.",
			"",
			"Short one. Short two.",
			"",
		].join("\n");
		const over = longParagraphs(segment(src), 3);
		expect(over).toHaveLength(1);
		expect(over[0].line).toBe(1);
	});

	test("a list item is never a long paragraph, however many sentences it has", () => {
		const segs = segment("- One. Two. Three. Four. Five.\n");
		expect(longParagraphs(segs, 3)).toEqual([]);
	});

	test("exactly at the cap is not a violation", () => {
		expect(longParagraphs(segment("One. Two. Three.\n"), 3)).toEqual([]);
	});
});

describe("findPassive", () => {
	test("detects agentless passive, the dominant form in generated prose", () => {
		const hits = findPassive("The request is throttled at the edge.");
		expect(hits).toHaveLength(1);
		expect(hits[0].agent).toBe(false);
		expect(hits[0].text).toContain("is throttled");
	});

	test("marks passive that names its agent", () => {
		const hits = findPassive("The file is read by the parser.");
		expect(hits).toHaveLength(1);
		expect(hits[0].agent).toBe(true);
	});

	test("covers irregular participles", () => {
		expect(findPassive("The value was written to disk.")).toHaveLength(1);
		expect(findPassive("The record has been shown already.")).toHaveLength(1);
	});

	test("suppresses adjectival participles that are not really passive", () => {
		expect(findPassive("The design is based on the spec.")).toEqual([]);
		expect(findPassive("A token is required for this call.")).toEqual([]);
		expect(findPassive("Support is limited to two regions.")).toEqual([]);
	});

	test("tolerates an adverb between the auxiliary and the participle", () => {
		expect(findPassive("The cache is silently dropped on restart.")).toHaveLength(1);
	});

	test("does not fire on active voice or a bare copula", () => {
		expect(findPassive("The parser reads the file.")).toEqual([]);
		expect(findPassive("The result is a single row.")).toEqual([]);
		expect(findPassive("The server is fast.")).toEqual([]);
	});

	test("finds several hits in one passage", () => {
		const hits = findPassive("Requests are queued and responses are cached by the proxy.");
		expect(hits).toHaveLength(2);
		expect(hits.filter((h) => h.agent)).toHaveLength(1);
	});

	test("empty input yields no hits", () => {
		expect(findPassive("")).toEqual([]);
	});
});

describe("findPhrases", () => {
	test("matches case-insensitively and reports the offset", () => {
		const hits = findPhrases("A Seamless and robust design.", ["seamless", "robust"]);
		expect(hits.map((h) => h.term)).toEqual(["seamless", "robust"]);
		expect(hits[0].index).toBe(2);
	});

	test("respects word boundaries and does not match inside a longer word", () => {
		expect(findPhrases("An unlockable feature.", ["unlock"])).toEqual([]);
		expect(findPhrases("We unlock it.", ["unlock"])).toHaveLength(1);
	});

	test("matches multi-word phrases", () => {
		expect(findPhrases("It is important to note that this works.", ["it is important to note"])).toHaveLength(1);
	});

	test("counts every occurrence, in document order", () => {
		const hits = findPhrases("robust, then seamless, then robust again.", ["robust", "seamless"]);
		expect(hits.map((h) => h.term)).toEqual(["robust", "seamless", "robust"]);
	});

	test("tolerates regex metacharacters in a configured term", () => {
		expect(() => findPhrases("a c++ thing", ["c++"])).not.toThrow();
	});

	test("empty inputs yield no hits", () => {
		expect(findPhrases("", ["robust"])).toEqual([]);
		expect(findPhrases("robust", [])).toEqual([]);
	});
});

describe("findNominalizations", () => {
	test("flags a light verb plus a nominalized noun", () => {
		expect(findNominalizations("We perform an analysis of the log.")).toHaveLength(1);
		expect(findNominalizations("It will conduct a migration tonight.")).toHaveLength(1);
	});

	test("does NOT flag ordinary verbs with ordinary objects", () => {
		expect(findNominalizations("The API provides a cache.")).toEqual([]);
		expect(findNominalizations("The parser reads the file.")).toEqual([]);
	});

	test("does not flag a bare nominalization without a light verb", () => {
		// Deliberately out of scope: "the implementation of X" is normal in
		// technical prose and flagging it makes the sensor noise.
		expect(findNominalizations("The implementation of the parser is done.")).toEqual([]);
	});

	test("empty input yields no hits", () => {
		expect(findNominalizations("")).toEqual([]);
	});
});

describe("findFillerOpeners", () => {
	test("flags a filler only when it opens a sentence", () => {
		expect(findFillerOpeners(["Additionally, it caches."], DEFAULT_LEXICON.fillerOpeners)).toHaveLength(1);
		expect(findFillerOpeners(["It caches and additionally logs."], DEFAULT_LEXICON.fillerOpeners)).toEqual([]);
	});

	test("is case-insensitive and tolerates a missing comma", () => {
		expect(findFillerOpeners(["furthermore the cache warms."], ["furthermore"])).toHaveLength(1);
	});

	test("empty input yields no hits", () => {
		expect(findFillerOpeners([], DEFAULT_LEXICON.fillerOpeners)).toEqual([]);
	});
});

describe("mergeLexicon", () => {
	test("a plain array replaces the default list", () => {
		const m = mergeLexicon(DEFAULT_LEXICON, { marketing: ["zesty"] });
		expect(m.marketing).toEqual(["zesty"]);
		expect(m.hedges).toEqual(DEFAULT_LEXICON.hedges);
	});

	test("an add/remove object extends the default list", () => {
		const m = mergeLexicon(DEFAULT_LEXICON, { marketing: { add: ["zesty"], remove: ["robust"] } });
		expect(m.marketing).toContain("zesty");
		expect(m.marketing).not.toContain("robust");
		expect(m.marketing).toContain("seamless");
	});

	test("remove is case-insensitive and a no-op for absent terms", () => {
		const m = mergeLexicon(DEFAULT_LEXICON, { marketing: { remove: ["ROBUST", "nosuchword"] } });
		expect(m.marketing).not.toContain("robust");
	});

	test("an empty override returns the defaults unchanged", () => {
		expect(mergeLexicon(DEFAULT_LEXICON, {})).toEqual(DEFAULT_LEXICON);
	});

	test("rejects a non-array, non-add/remove value", () => {
		expect(() => mergeLexicon(DEFAULT_LEXICON, { marketing: "robust" as unknown as string[] })).toThrow(
			"marketing",
		);
	});
});

describe("findRotation", () => {
	test("flags two members of a configured synonym set in one document", () => {
		const hits = findRotation(
			words("The user signs in. The user waits. The customer pays. The customer leaves."),
			[["user", "customer", "client"]],
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].variants.sort()).toEqual(["customer", "user"]);
	});

	test("one member used consistently is not a violation", () => {
		expect(findRotation(words("The user signs in. The user waits."), [["user", "customer"]])).toEqual([]);
	});

	test("reports per-variant counts so the fix is obvious", () => {
		const hits = findRotation(words("user user user customer customer"), [["user", "customer"]]);
		expect(hits[0].counts).toEqual({ user: 3, customer: 2 });
	});

	test("is case-insensitive", () => {
		expect(findRotation(words("User user then CUSTOMER customer."), [["user", "customer"]])).toHaveLength(1);
	});

	test("a single passing mention of an alternative is not rotation", () => {
		// The minCount guard. Without it this detector fires on well-written
		// docs that mention an alternative term once, in passing or as a quote.
		expect(findRotation(words("user user user customer"), [["user", "customer"]])).toEqual([]);
	});

	test("minCount is tunable", () => {
		expect(findRotation(words("user customer"), [["user", "customer"]], 1)).toHaveLength(1);
	});

	test("covers clipped-form pairs from the shipped defaults", () => {
		const hits = findRotation(
			words("the config and the config, then the configuration and the configuration"),
			DEFAULT_LEXICON.synonymSets,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].variants.sort()).toEqual(["config", "configuration"]);
	});

	test("shipped defaults do not fire on distinct technical terms", () => {
		// error/failure/fault were REMOVED from the defaults: in this repo's own
		// docs they name three different things, and flagging them was noise.
		const text = "an error and an error, a failure and a failure, a fault and a fault";
		expect(findRotation(words(text), DEFAULT_LEXICON.synonymSets)).toEqual([]);
	});

	test("empty inputs yield no hits", () => {
		expect(findRotation([], [["user", "customer"]])).toEqual([]);
		expect(findRotation(words("user customer"), [])).toEqual([]);
	});
});

describe("extractFacts", () => {
	test("pulls backticked identifiers, numbers and URLs from RAW text", () => {
		const facts = extractFacts("Set `Retry-After` to 100 per minute. See https://x.dev/a for detail.");
		expect(facts).toContain("Retry-After");
		expect(facts).toContain("100");
		expect(facts).toContain("https://x.dev/a");
	});

	test("ignores ordinary prose words", () => {
		expect(extractFacts("The comprehensive and robust solution.")).toEqual([]);
	});

	test("deduplicates repeated facts", () => {
		expect(extractFacts("`a` and `a` and 5 and 5").sort()).toEqual(["5", "a"]);
	});

	test("keeps decimals and versions intact", () => {
		expect(extractFacts("upgrade to 1.2.3 now")).toContain("1.2.3");
	});

	test("empty input yields no facts", () => {
		expect(extractFacts("")).toEqual([]);
	});
});

describe("factRetention", () => {
	test("a rewrite that keeps every fact scores 1", () => {
		const r = factRetention("limit is 100 via `Retry-After`", "The limit is 100. Read `Retry-After`.");
		expect(r.ratio).toBe(1);
		expect(r.lost).toEqual([]);
	});

	test("names the facts a rewrite dropped", () => {
		const r = factRetention("limit is 100 via `Retry-After`", "There is a limit. Wait and retry.");
		expect(r.lost.sort()).toEqual(["100", "Retry-After"]);
		expect(r.ratio).toBe(0);
	});

	test("partial loss is a partial ratio", () => {
		const r = factRetention("`a` and `b`", "only `a` survives");
		expect(r.ratio).toBeCloseTo(0.5, 5);
		expect(r.lost).toEqual(["b"]);
	});

	test("a before-text with no facts is vacuously fine", () => {
		expect(factRetention("just prose here", "different prose").ratio).toBe(1);
	});

	test("adding facts does not penalise", () => {
		expect(factRetention("`a`", "`a` and `b` and 9").ratio).toBe(1);
	});
});

describe("evaluateCounters", () => {
	const stats = (mean: number, stddev: number, count = 20) => ({
		count,
		mean,
		p50: mean,
		p95: mean,
		max: mean,
		stddev,
	});

	test("passes healthy prose on every counter", () => {
		const r = evaluateCounters(stats(15, 10), null, DEFAULT_COUNTERS);
		expect(r.every((c) => c.passed)).toBe(true);
	});

	test("the mean floor catches prose chopped into stubs", () => {
		const r = evaluateCounters(stats(2.9, 0.6), null, DEFAULT_COUNTERS);
		expect(r.find((c) => c.name === "mean-sentence-floor")?.passed).toBe(false);
	});

	test("the mean ceiling ignores one long sentence among short ones", () => {
		// Guards the CP2 finding: our SKILL.md has p95=39 and max=70, higher than
		// the generated sample's longest, but a mean of 15.7. Gating on the tail
		// would rank our own docs below the slop they are meant to catch.
		const r = evaluateCounters(stats(15.7, 11.1, 578), null, DEFAULT_COUNTERS);
		expect(r.every((c) => c.passed)).toBe(true);
	});

	test("generated run-on prose is caught by the CEILING, not the variance floor", () => {
		// The generated sample: mean 32.7, stddev 3.3. An earlier design expected
		// the variance floor to catch this too. The corpus refuted it - our own
		// terse CLI docs bottom out at stddev 3.6, so any threshold that fails
		// 3.3 also fails real documents. The two gates have separate jobs.
		const r = evaluateCounters(stats(32.7, 3.3), null, DEFAULT_COUNTERS);
		expect(r.find((c) => c.name === "mean-sentence-ceiling")?.passed).toBe(false);
		expect(r.find((c) => c.name === "sentence-variance-floor")?.passed).toBe(true);
	});

	test("the calibrated variance floor clears our tersest real document", () => {
		// gocurl/SKILL.md: mean 6.6, stddev 3.6, 41 sentences. The tightest real
		// case in the corpus; it must stay green or the gate is unusable.
		const r = evaluateCounters(stats(6.6, 3.6, 41), null, DEFAULT_COUNTERS);
		expect(r.every((c) => c.passed)).toBe(true);
	});

	test("the variance floor explains the chopped direction differently", () => {
		const r = evaluateCounters(stats(3, 0.6), null, DEFAULT_COUNTERS);
		const v = r.find((c) => c.name === "sentence-variance-floor");
		expect(v?.detail).toContain("chopped");
	});

	test("the variance floor is skipped on too few sentences to be meaningful", () => {
		const r = evaluateCounters(stats(18, 0.1, 3), null, DEFAULT_COUNTERS);
		const v = r.find((c) => c.name === "sentence-variance-floor");
		expect(v?.passed).toBe(true);
		expect(v?.detail).toContain("skipped");
	});

	test("fact retention is skipped when there is no before-text", () => {
		const r = evaluateCounters(stats(15, 10), null, DEFAULT_COUNTERS);
		const f = r.find((c) => c.name === "fact-retention");
		expect(f?.passed).toBe(true);
		expect(f?.detail).toContain("skipped");
	});

	test("fact retention fails and names what was dropped", () => {
		const r = evaluateCounters(
			stats(15, 10),
			{ ratio: 0.5, lost: ["100", "Retry-After"], total: 4 },
			DEFAULT_COUNTERS,
		);
		const f = r.find((c) => c.name === "fact-retention");
		expect(f?.passed).toBe(false);
		expect(f?.detail).toContain("Retry-After");
	});

	test("an empty document trips nothing (no sentences, no claims)", () => {
		const r = evaluateCounters(stats(0, 0, 0), null, DEFAULT_COUNTERS);
		expect(r.every((c) => c.passed)).toBe(true);
	});
});
