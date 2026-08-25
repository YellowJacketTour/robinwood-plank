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
  : ["opt-mainnet", "bnb-mainnet", "avax-mainnet", "arb-mainnet", "base-mainnet", "eth-mainnet", "polygon-mainnet"];
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

  if ((want("bitcoin-unisat") || want("all-art")) && remaining()) {
    const { hydrateAllCollectionArt } = await import("../lib/market/multichain/discovery/hydrate-all-collection-art");
    console.log(`[spokes] all-art: ${JSON.stringify(await hydrateAllCollectionArt())}`);
    const { hydrateBitcoinArt } = await import("../lib/market/multichain/discovery/bitcoin-art-rotator");
    const art = await hydrateBitcoinArt(50);
    console.log(`[spokes] bitcoin-art-rotator: ${JSON.stringify(art)}`);
    try {
      const { backfillUnisatCollectionArt } = await import("../lib/market/multichain/adapters/unisat-collections");
      const r = await backfillUnisatCollectionArt(8);
      console.log(`[spokes] bitcoin-unisat-art: ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`[spokes] bitcoin-unisat-art skipped`, e instanceof Error ? e.message : e);
    }
  }

  if (want("adapter-sync") && remaining()) {
    const run = await runMultichainSync({ maxCollections: 120 });
    console.log(`[spokes] adapter-sync: ${run.synced} synced, ${run.failed} failed, ${run.skipped} skipped`);
  }

  if (want("evm-opensea-stats") && remaining()) {
    const osChains = FOREIGN_CHAINS.filter((x) => x.openSeaChain);
    const ordered = chainPriority.length
      ? chainPriority
          .map((slug) => osChains.find((c) => c.chainSlug === slug))
          .filter((c): c is (typeof osChains)[number] => Boolean(c))
      : osChains;
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

  const cgBySpoke: Record<string, string> = {
    "coingecko-bnb": "bnb-mainnet",
    "coingecko-avax": "avax-mainnet",
    "solana-coingecko": "solana-mainnet",
    "bitcoin-coingecko": "bitcoin-mainnet",
    "coingecko-eth": "eth-mainnet",
    "coingecko-polygon": "polygon-mainnet",
    "coingecko-base": "base-mainnet",
    "coingecko-arb": "arb-mainnet",
    "coingecko-opt": "opt-mainnet",
  };
  for (const [spokeId, slug] of Object.entries(cgBySpoke)) {
    if (!want(spokeId) || !remaining()) continue;
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    do {
      const r = await runCoinGeckoNftStats(slug, 20);
      console.log(`[spokes] ${spokeId}: ${JSON.stringify(r)}`);
      if (r.updated === 0 || !only) break;
    } while (remaining());
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
