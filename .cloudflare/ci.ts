// This repository's CI pipeline. A fixed Cloudflare CI pipeline loads this file
// from the pushed commit and runs it with step.dynamic(). Edit it like any code.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

type Output = Awaited<ReturnType<WorkflowStep["runner"]>>["outputs"][string];
type RepoEvent = { sha: string; mr: number | null; checkout: Output };

const NO_RETRIES = { retries: { limit: 0, delay: "1 second" }, timeout: "15 minutes" } as const;
const ENV = { NPM_CONFIG_UPDATE_NOTIFIER: "false", CI: "true" };
const SIZE = "standard-2";

// Runner logs are one merged { data } stream in practice; the docs say { stdout, stderr }.
const tail = (logs: any, lines = 25) =>
	(typeof logs?.data === "string" ? logs.data : `${logs?.stdout?.data ?? ""}\n${logs?.stderr?.data ?? ""}`)
		.trimEnd()
		.split("\n")
		.slice(-lines)
		.join("\n");

export class CI extends WorkflowEntrypoint<unknown, RepoEvent> {
	async run(event: WorkflowEvent<RepoEvent>, step: WorkflowStep) {
		const { checkout } = event.payload;

		const install = await step.runner("install", NO_RETRIES, {
			command: "cd repo && timeout 540 npm ci --no-audit --no-fund",
			inputs: [checkout],
			env: ENV,
			instanceSize: SIZE,
			outputs: { modules: "repo/node_modules" },
			allowFailure: true,
		});
		if (install.exitCode !== 0) {
			return { passed: false, checks: [{ name: "install", exitCode: install.exitCode, log: tail(install.logs) }] };
		}
		const project = [checkout, install.outputs.modules];

		const checks = await Promise.all(
			["typecheck", "build"].map(async (name) => {
				const result = await step.runner(name, NO_RETRIES, {
					command: `cd repo && timeout 540 npm run ${name}`,
					inputs: project,
					env: ENV,
					instanceSize: SIZE,
					allowFailure: true,
				});
				return { name, exitCode: result.exitCode, log: tail(result.logs) };
			}),
		);

		return { passed: checks.every((check) => check.exitCode === 0), checks };
	}
}
