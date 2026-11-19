export default {
	async fetch(request, env) {
		const body = { hello: "world", worker: "ci-try-deploy-target", sha: env.BUILD_SHA ?? "dev" };
		return Response.json(body);
	},
};
