import { describe, expect, it } from "vitest";
import { SLEEP_MS, sleep } from "./helpers";

describe("sleep suite 01", () => {
	it("waits for a slow dependency (a)", async () => {
		const start = Date.now();
		await sleep(SLEEP_MS);
		expect(Date.now() - start).toBeGreaterThanOrEqual(SLEEP_MS - 5);
	});
	it("waits for a slow dependency (b)", async () => {
		await sleep(SLEEP_MS);
		expect([1, 2, 3].map((n) => n * 1)).toHaveLength(3);
	});
	it("waits for a slow dependency (c)", async () => {
		await sleep(SLEEP_MS);
		expect(JSON.parse(JSON.stringify({ suite: "01" }))).toEqual({ suite: "01" });
	});
	it("is fast", () => {
		expect("01".padStart(4, "0")).toBe("0001");
	});
});
