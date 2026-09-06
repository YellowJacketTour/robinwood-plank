/**
 * Edge load proof: vendor calls per unique cell per minute under N
 * simulated users must be O(1), not O(N).
 *
 *   npx tsx --env-file=.env.local scripts/edge-load-proof.ts --users=200 --cells=25 --rounds=4
 *
 * Simulates N users each reading every one of C cells through the unified
 * read gateway (lib/market/multichain/edge/read-gateway.ts) in `rounds`
 * bursts. The "vendor" is a fake fetcher with a real 80-150ms latency so
 * the coalescing lease and stale-while-revalidate paths are exercised the
 * way a real vendor round-trip would exercise them. Requires the local
 * Postgres (the lease and cache live there). Prints a before/after table:
 * the naive fan-out (users x cells x rounds) versus the real number of
 * fetcher invocations.
 */
import { edgeRead, readEdgeStats, resetEdgeStats } from "../lib/market/multichain/edge/read-gateway";
import { flushProviderLedger, readProviderLedger } from "../lib/market/multichain/edge/provider-ledger";
import { closePostgres, hasPostgresConfig, postgresQuery } from "../lib/postgres";

function arg(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const users = arg("users", 200);
const cells = arg("cells", 25);
const rounds = arg("rounds", 4);
const roundGapMs = arg("gap-ms", 500);

async function main() {
  if (!hasPostgresConfig()) {
    console.error("Postgres is required (the coalescing lease and cache live there). Source .env.local first.");
    process.exit(1);
  }
  const runId = `proof-${Date.now()}`;
  const cellList = Array.from({ length: cells }, (_, i) => ({
    kind: "listings" as const,
    chainSlug: "zzproof-chain",
    subject: `${runId}-collection-${i}`,
    variant: { limit: 24 },
  }));
  let vendorCalls = 0;
  const vendor = async () => {
    vendorCalls += 1;
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 70));
    return { listings: Array.from({ length: 24 }, (_, i) => ({ tokenId: String(i), priceWei: "1000000000000000" })) };
  };
  resetEdgeStats();
  const t0 = Date.now();
  let reads = 0;
  for (let round = 0; round < rounds; round++) {
    await Promise.all(
      Array.from({ length: users }, async () => {
        for (const cell of cellList) {
          await edgeRead(cell, vendor);
          reads += 1;
        }
      })
    );
    if (round < rounds - 1) await new Promise((r) => setTimeout(r, roundGapMs));
  }
  const elapsedMs = Date.now() - t0;
  await flushProviderLedger();
  const ledger = (await readProviderLedger(5)).filter((r) => r.chainSlug === "zzproof-chain");
  const stats = readEdgeStats();
  const naive = users * cells * rounds;
  const minutes = Math.max(elapsedMs / 60_000, 1 / 60);
  const rows = [
    ["users", users],
    ["unique cells", cells],
    ["rounds", rounds],
    ["elapsed ms", elapsedMs],
    ["browser reads served", reads],
    ["naive vendor calls (users x cells x rounds)", naive],
    ["real vendor calls", vendorCalls],
    ["vendor calls per unique cell", (vendorCalls / cells).toFixed(3)],
    ["vendor calls per unique cell per minute", (vendorCalls / cells / minutes).toFixed(3)],
    ["reads per vendor call", (reads / Math.max(1, vendorCalls)).toFixed(1)],
    ["reduction vs naive", `${(100 * (1 - vendorCalls / naive)).toFixed(2)}%`],
    ["ledger rows (edge:listings, zzproof-chain)", ledger.map((r) => `${r.calls} calls, ${r.ok} ok`).join("; ") || "-"],
  ];
  console.log(`\nEDGE LOAD PROOF ${new Date().toISOString()}`);
  for (const [k, v] of rows) console.log(`${String(k).padEnd(48)} ${v}`);
  console.log("\nper-kind edge stats:", JSON.stringify(stats.byKind, null, 2));
  // Cleanup: the proof's cells and ledger rows.
  await postgresQuery(`DELETE FROM plank_kv_values WHERE key_name LIKE $1`, [`plank:singleflight:edge:listings:zzproof-chain:${runId}%`]);
  await postgresQuery(`DELETE FROM plank_provider_ledger WHERE chain_slug = 'zzproof-chain'`);
  await closePostgres();
  if (vendorCalls > cells * 2) {
    console.error(`FAIL: ${vendorCalls} vendor calls for ${cells} cells -- not O(1) per cell.`);
    process.exit(2);
  }
  console.log("\nPASS: vendor cost is O(1) per unique cell across", users, "users.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
