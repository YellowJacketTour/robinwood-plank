import assert from "node:assert/strict";
import test from "node:test";
import { closePostgres, hasPostgresConfig, postgresPool, postgresQuery } from "../../lib/postgres";

test("mesh query survives the old client cutoff and retains server cancellation", { skip: !hasPostgresConfig(), timeout: 40_000 }, async () => {
  const previous = process.env.MESH_IN_PROCESS;
  await closePostgres();
  process.env.MESH_IN_PROCESS = "1";
  try {
    const pool = postgresPool();
    const deadline = await postgresQuery<{ statement_timeout: string }>("SHOW statement_timeout");
    assert.equal(deadline.rows[0].statement_timeout, "80s");
    assert.ok(Number(pool.options.query_timeout) > 80_000);
    assert.ok(Number(pool.options.query_timeout) < 89_000, "client deadline must precede the scheduler child kill");
    const completed = await postgresQuery<{ answer: number }>("SELECT 42 AS answer FROM pg_sleep(21)");
    assert.equal(completed.rows[0].answer, 42, "useful scans must survive the former 20-second client cutoff");
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = 100");
      await assert.rejects(client.query("SELECT pg_sleep(1)"), (error: unknown) => (error as { code?: string }).code === "57014");
      assert.equal((await client.query("SELECT 1 AS healthy")).rows[0].healthy, 1);
    } finally {
      await client.query("RESET statement_timeout");
      client.release();
    }
  } finally {
    await closePostgres();
    if (previous === undefined) delete process.env.MESH_IN_PROCESS;
    else process.env.MESH_IN_PROCESS = previous;
  }
  try {
    const web = await postgresQuery<{ statement_timeout: string }>("SHOW statement_timeout");
    assert.equal(web.rows[0].statement_timeout, "15s");
    assert.equal(postgresPool().options.query_timeout, 20_000);
  } finally {
    await closePostgres();
  }
});
