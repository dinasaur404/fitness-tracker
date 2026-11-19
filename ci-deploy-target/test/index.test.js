import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("says hello and reports the build sha", async () => {
	const response = await worker.fetch(new Request("https://example.com/"), { BUILD_SHA: "abc123" });
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { hello: "world", worker: "ci-try-deploy-target", sha: "abc123" });
});
