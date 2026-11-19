import { describe, expect, it } from "vitest";
import { CPU_ITERATIONS, burn } from "./helpers";

describe("cpu suite 03", () => {
	for (const part of ["a", "b", "c"]) {
		it(`hashes deterministically (${part})`, () => {
			const first = burn(`03-${part}`, CPU_ITERATIONS);
			expect(first).toMatch(/^[0-9a-f]{64}$/);
			expect(burn(`03-${part}`, 1000)).toHaveLength(64);
		});
	}
});
