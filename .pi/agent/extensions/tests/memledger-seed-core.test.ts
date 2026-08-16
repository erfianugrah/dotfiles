import { describe, expect, test } from "bun:test";
import { SeedThrottle } from "../lib/memledger-seed-core.ts";

describe("SeedThrottle", () => {
	test("first fire allowed, immediate refire blocked", () => {
		const t = new SeedThrottle(10_000);
		expect(t.tryFire(1000)).toBe(true);
		expect(t.tryFire(1001)).toBe(false); // in-flight
	});

	test("in-flight blocks until done(), then interval applies", () => {
		const t = new SeedThrottle(10_000);
		expect(t.tryFire(1000)).toBe(true);
		t.done();
		expect(t.tryFire(5000)).toBe(false); // within 10s of last fire
		expect(t.tryFire(11_000)).toBe(true);
	});

	test("concurrent fire while in-flight is dropped, not queued", () => {
		const t = new SeedThrottle(0);
		expect(t.tryFire(1000)).toBe(true);
		expect(t.tryFire(2000)).toBe(false);
		t.done();
		expect(t.tryFire(2001)).toBe(true);
	});

	test("fireFinal always fires; marks in-flight only when free", () => {
		const t = new SeedThrottle(10_000);
		expect(t.tryFire(1000)).toBe(true); // in-flight now
		expect(t.fireFinal(2000)).toBe(false); // fires, but must not steal state
		t.done();
		// lastFired moved to 2000 by fireFinal, so interval is measured
		// from the shutdown fire, not the earlier turn fire.
		expect(t.tryFire(5000)).toBe(false);
		expect(t.tryFire(12_001)).toBe(true);
	});
});
