/**
 * One-off enqueue: find every real collection whose OpenSea enumeration
 * has provably plateaued (real, live signal -- tokens_ever_hydrated stuck
 * well under known_supply across many consecutive unchanged checks, see
 * collection-archival-stats), and enqueue a real anchored-membership job
 * for each (scripts/mesh-lane.ts's "anchored-membership" source), so
 * mesh-tick.ts's normal paced/watchdog-protected worker loop picks them up
 * exactly like every other real job -- no separate ad-hoc scan competing
 * outside the existing budget/pacing discipline.
 */
import { enqueueDataJob } from "../lib/market/multichain/control-plane";
import { postgresQuery } from "../lib/postgres";

async function main() {
  const stuck = await postgresQuery<{ chain_slug: string; collection_key: string; known_supply: string; tokens_ever_hydrated: string; consecutive_unchanged: number }>(
    `SELECT chain_slug, collection_key, known_supply, tokens_ever_hydrated, consecutive_unchanged
     FROM collection_archival_stats
     WHERE known_supply IS NOT NULL AND known_supply > 0
       AND tokens_ever_hydrated < known_supply * 0.5
       AND consecutive_unchanged >= 20
       AND chain_slug != 'robinhood'`
  );
  console.log(`found ${stuck.rows.length} stuck collections`);
  for (const row of stuck.rows) {
    if (!/^0x[0-9a-f]{40}$/i.test(row.collection_key)) {
      console.log(`skip ${row.chain_slug}:${row.collection_key} -- not an EVM contract, anchored backfill is EVM-only`);
      continue;
    }
    await enqueueDataJob({
      jobKey: `demand:anchored-membership:${row.chain_slug}:${row.collection_key}`,
      kind: `mesh-lane:${row.chain_slug}`,
      source: "anchored-membership",
      chainSlug: row.chain_slug,
      subject: row.collection_key,
      priority: 90,
    });
    console.log(`enqueued ${row.chain_slug}:${row.collection_key} (${row.tokens_ever_hydrated}/${row.known_supply}, unchanged=${row.consecutive_unchanged})`);
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
