import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDataJobKey, enqueueDataJob } from "../../lib/market/multichain/control-plane";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

const subject = "0x1111111111111111111111111111111111111abc";
const common = { kind: "mesh-lane:identity-test", source: "opensea-membership", chainSlug: "identity-test", subject };

test("demand identity is independent of producer, preserving source, chain and non-EVM case", () => {
  const expected = `demand:opensea-membership:identity-test:${subject}`;
  assert.equal(canonicalDataJobKey({ ...common, jobKey: `demand:membership:identity-test:${subject}` }), expected);
  assert.equal(canonicalDataJobKey({ ...common, subject: subject.toUpperCase().replace("0X", "0x"), jobKey: "demand:visibility" }), expected);
  assert.notEqual(canonicalDataJobKey({ ...common, subject: "Mint", jobKey: "demand:click" }), canonicalDataJobKey({ ...common, subject: "mint", jobKey: "demand:click" }));
  assert.equal(canonicalDataJobKey({ ...common, jobKey: "mesh:standing-lane" }), "mesh:standing-lane");
});

test("different demand producers reinforce one durable job", { skip: !hasPostgresConfig() }, async () => {
  const canonical = canonicalDataJobKey({ ...common, jobKey: "demand:click" });
  try {
    const ids = await Promise.all([
      enqueueDataJob({ ...common, jobKey: `demand:membership:identity-test:${subject}`, priority: 90 }),
      enqueueDataJob({ ...common, jobKey: "demand:click", priority: 100 }),
      enqueueDataJob({ ...common, jobKey: "demand:visibility", priority: 80 }),
    ]);
    assert.equal(new Set(ids).size, 1);
    const rows = await postgresQuery<{ priority: number }>("SELECT priority FROM plank_data_jobs WHERE job_key = $1", [canonical]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].priority, 100);
  } finally {
    await postgresQuery("DELETE FROM plank_data_jobs WHERE job_key = $1", [canonical]);
  }
});
