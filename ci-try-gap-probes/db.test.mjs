// Throwaway probe for Cloudflare CI (ci-try/gap-probes): integration test against a Postgres started in the runner.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

test("insert and read a workout row", async () => {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	try {
		await client.query("CREATE TABLE IF NOT EXISTS workouts (id serial PRIMARY KEY, name text NOT NULL, reps int NOT NULL)");
		await client.query("INSERT INTO workouts (name, reps) VALUES ($1, $2)", ["squat", 5]);
		const { rows } = await client.query("SELECT name, reps FROM workouts WHERE name = $1", ["squat"]);
		assert.deepEqual(rows[0], { name: "squat", reps: 5 });
		const { rows: version } = await client.query("SELECT version()");
		console.log(version[0].version);
	} finally {
		await client.end();
	}
});
