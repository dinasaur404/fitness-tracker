import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";

// A runner output. Pass it back as an input, and do not change it.
type Output = Record<string, unknown>;

type RunnerResult = {
	exitCode: number;
	logs: { data: string; truncated: boolean };
	outputs: Record<string, Output | null>;
};

// The step that the deployed pipeline gives this file.
type CIStep = WorkflowStep & {
	runner(name: string, config: object, options: object): Promise<RunnerResult>;
	readFile(path: string): Promise<string | null>;
};

type RepoEvent = {
	ref: string;
	before: string;
	after: string;
	defaultBranch: string;
	checkout: Output;
};

const NO_RETRIES = { retries: { limit: 0, delay: "1 second" } } as const;
const NPM = { NPM_CONFIG_UPDATE_NOTIFIER: "false" };

export class CI extends WorkflowEntrypoint<unknown, RepoEvent> {
	async run(event: WorkflowEvent<RepoEvent>, step: CIStep) {
		const { checkout } = event.payload;
		const pkg = JSON.parse((await step.readFile("package.json")) ?? "{}");

		// Round 3 verification: each of these should be refused by the pipeline's CIStep.
		const refused: Record<string, string> = {};
		const attempt = async (label: string, run: () => Promise<unknown>) => {
			try {
				await run();
				refused[label] = "allowed";
			} catch (err) {
				refused[label] = String((err as Error)?.message ?? err);
			}
		};
		await attempt("standard-4", () =>
			step.runner("too big", NO_RETRIES, { command: "nproc", instanceSize: "standard-4" }),
		);
		await attempt("own image", () =>
			step.runner("own image", NO_RETRIES, {
				command: "true",
				image: { repository: "my-toolchain", digest: `sha256:${"0".repeat(64)}` },
			}),
		);
		await attempt("forged input", () =>
			step.runner("forged input", NO_RETRIES, {
				command: "true",
				inputs: [{ ...checkout, data: { ref: "forged", file: null } }],
			}),
		);
		await attempt("dynamic", () => (step as any).dynamic("nested", {}, { event: {} }));

		const install = await step.runner("install dependencies", NO_RETRIES, {
			command: "cd repo && npm ci",
			inputs: [checkout],
			env: NPM,
			outputs: { modules: "repo/node_modules" },
		});
		const project = [checkout, install.outputs.modules];

		const checks = await Promise.all(
			["typecheck", "build", "deps"].map(async (name) => {
				const result = await step.runner(name, NO_RETRIES, {
					command:
						name === "deps"
							? "git --version && cd repo && npm ls --omit=dev --depth=0"
							: `cd repo && npm run ${name}`,
					image: name === "deps" ? "workflows/node" : undefined,
					inputs: project,
					env: NPM,
					allowFailure: true,
				});
				return {
					name,
					exitCode: result.exitCode,
					log: result.logs.data.trimEnd().split("\n").slice(-25).join("\n"),
				};
			}),
		);

		return { passed: checks.every((check) => check.exitCode === 0), package: pkg.name, refused, checks };
	}
}
