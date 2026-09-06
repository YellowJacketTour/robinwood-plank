/**
 * Market-side predictive focus: nudge collections whose real sales/volume
 * are accelerating to DEMAND_PRIORITY.PREDICT_NEXT in the mesh queue.
 *
 *   npx tsx --env-file=.env.local scripts/market-focus.ts [--min-momentum=40] [--limit=40] [--dry]
 *
 * A writer script, never the App Router. Safe to run from the same cron
 * that runs mesh-tick; enqueueDataJob dedups by job key.
 */
import { focusAcceleratingCollections, rankAcceleratingCollections } from "../lib/market/multichain/edge/predictive-focus";
import { listCollectionsWithSnapshots } from "../lib/market/multichain/store";
import { closePostgres } from "../lib/postgres";

function num(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const dry = process.argv.includes("--dry");
const opts = { minMomentum: num("min-momentum", 40), limit: num("limit", 40) };

try {
  if (dry) {
    const rows = await listCollectionsWithSnapshots();
    const candidates = rankAcceleratingCollections(rows, opts);
    console.log(`[market-focus] dry run: ${candidates.length} accelerating of ${rows.length} tracked`);
    for (const c of candidates) console.log(`  ${c.chainSlug} ${c.contractAddress} momentum=${c.momentum.toFixed(1)} sales24h=${c.sales24h}`);
  } else {
    const r = await focusAcceleratingCollections(opts);
    console.log(`[market-focus] ${r.candidates.length} accelerating collections, ${r.enqueued} jobs nudged to PREDICT_NEXT`);
  }
} finally {
  await closePostgres();
}
