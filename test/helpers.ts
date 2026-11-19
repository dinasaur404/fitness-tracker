import { pbkdf2Sync } from "node:crypto";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// CPU-bound work: a fixed number of PBKDF2 iterations, so the cost scales with vCPU.
export function burn(seed: string, iterations: number) {
	return pbkdf2Sync(seed, "ci-try-test-speed", iterations, 32, "sha256").toString("hex");
}

export const CPU_ITERATIONS = Number(process.env.CPU_ITERATIONS ?? 1_500_000);
export const SLEEP_MS = Number(process.env.SLEEP_MS ?? 2000);
