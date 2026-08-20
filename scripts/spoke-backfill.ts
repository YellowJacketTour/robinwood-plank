/**
 * Detached per-spoke backfill. Run in its own process / window:
 *   npx tsx scripts/spoke-backfill.ts --minutes=8
 *   npm run market:spokes
 *
 * Never imported by Next. Writes Postgres snapshots only. Fail closed:
 * unmatched / 429 / no slug => skip, leave existing cells.
 */
import { SPOKES } from "../lib/market/multichain/spokes";

const argv = process.argv.slice(2);
const minutesArg = argv.find((a) => a.startsWith("--minutes="));
const minutes = minutesArg ? Number(minutesArg.slice("--minutes=".length)) : 8;
const only = argv.find((a) => a.startsWith("--spoke="))?.slice("--spoke=".length);
const chainsArg = argv.find((a) => a.startsWith("--chains="))?.slice("--chains=".length);
const chainPriority = chainsArg
  ? chainsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : ["bnb-mainnet", "avax-mainnet", "arb-mainnet", "base-mainnet", "eth-mainnet", "polygon-mainnet", "opt-mainnet"];
const started = Date.now();
const deadline = started + minutes * 60_000;

function remaining(): boolean {
  return Date.now() < deadline;
}

async function main(): Promise<void> {
  const { hasDurableKv, durableKvBackend } = await import("../lib/market/durable-kv");
  if (!hasDurableKv()) {
    throw new Error("No PG datastore. Set PGHOST/PGDATABASE/PGUSER/PGPASSWORD.");
  }
  console.log(`[spokes] backend=${durableKvBackend()} minutes=${minutes}`);
  console.log(`[spokes] catalog:\n${SPOKES.map((s) => `  - ${s.id} [${s.chainSlug}] ${s.cells.join(",")} via ${s.source}`).join("\n")}`);

  const { runMultichainSync } = await import("../lib/market/multichain/sync");
  const { runOpenSeaStatsSync } = await import("../lib/market/multichain/discovery/opensea-stats");
  const { FOREIGN_CHAINS } = await import("../lib/market/multichain/trading/foreign-chain-registry");
  const { updateEvmVolumeFromSeaportFills } = await import("../lib/market/multichain/store");
  const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
  const { ROBINHOOD_CHAIN_SLUG } = await import("../lib/market/multichain/trading/non-evm-chains");

  const want = (id: string) => !only || only === id;

  if (want("adapter-sync") && remaining()) {
    const run = await runMultichainSync({ maxCollections: 120 });
    console.log(`[spokes] adapter-sync: ${run.synced} synced, ${run.failed} failed, ${run.skipped} skipped`);
  }

  if (want("evm-opensea-stats") && remaining()) {
    const osChains = FOREIGN_CHAINS.filter((x) => x.openSeaChain);
    const ordered = [
      ...chainPriority.map((slug) => osChains.find((c) => c.chainSlug === slug)).filter((c): c is (typeof osChains)[number] => Boolean(c)),
      ...osChains.filter((c) => !chainPriority.includes(c.chainSlug)),
    ];
    for (const c of ordered) {
      if (!remaining()) break;
      try {
        const r = await runOpenSeaStatsSync(c.chainSlug, 16);
        console.log(`[spokes] evm-opensea-stats ${c.chainSlug}: ${JSON.stringify(r)}`);
      } catch (err) {
        console.log(`[spokes] evm-opensea-stats ${c.chainSlug}: ERR ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (want("evm-seaport-fills") && remaining()) {
    const chains = [ROBINHOOD_CHAIN_SLUG, ...FOREIGN_CHAINS.map((c) => c.chainSlug)];
    for (const chainSlug of chains) {
      const r = await updateEvmVolumeFromSeaportFills(chainSlug);
      console.log(`[spokes] evm-seaport-fills ${chainSlug}: ${r.updated} updated`);
    }
  }

  if (want("solana-coingecko") && remaining()) {
    const r = await runCoinGeckoNftStats("solana-mainnet", 20);
    console.log(`[spokes] solana-coingecko: ${JSON.stringify(r)}`);
  }

  if (want("bitcoin-coingecko") && remaining()) {
    const r = await runCoinGeckoNftStats("bitcoin-mainnet", 20);
    console.log(`[spokes] bitcoin-coingecko: ${JSON.stringify(r)}`);
  }

  console.log(`[spokes] pass done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .then(async () => {
    try {
      const { hasPostgresConfig, postgresPool } = await import("../lib/postgres");
      if (hasPostgresConfig()) await postgresPool().end();
    } catch {
      /* never opened */
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("[spokes] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
