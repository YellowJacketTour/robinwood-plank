/**
 * Walk every hub chain until the clock runs out: OpenSea named slugs for
 * EVM, CoinGecko exact-contract/id for CG platforms, adapter-sync for
 * ME/UniSat/Helius. Fail closed. Never invent. Hub GET stays read-only.
 *
 *   npx tsx --env-file=.env.local scripts/fill-all-collection-stats.ts --minutes=20
 */
import { FOREIGN_CHAINS } from "../lib/market/multichain/trading/foreign-chain-registry";

const minutesArg = process.argv.find((a) => a.startsWith("--minutes="));
const minutes = minutesArg ? Number(minutesArg.slice("--minutes=".length)) : 18;
const started = Date.now();
const deadline = started + minutes * 60_000;
const remaining = () => Date.now() < deadline;

const CG_CHAINS = [
  "bnb-mainnet",
  "avax-mainnet",
  "solana-mainnet",
  "bitcoin-mainnet",
  "eth-mainnet",
  "polygon-mainnet",
  "base-mainnet",
  "arb-mainnet",
  "opt-mainnet",
] as const;

async function main() {
  const { hasDurableKv } = await import("../lib/market/durable-kv");
  if (!hasDurableKv()) throw new Error("No PG datastore.");
  const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
  const { runOpenSeaStatsSync } = await import("../lib/market/multichain/discovery/opensea-stats");
  const { runMultichainSync } = await import("../lib/market/multichain/sync");
  const { sanitizeUnknownZeros } = await import("../lib/market/multichain/store");

  const healed = await sanitizeUnknownZeros();
  console.log("[fill-all] heal", JSON.stringify(healed));

  let round = 0;
  while (remaining()) {
    round += 1;
    console.log(`\n======== fill-all round ${round} remaining=${Math.round((deadline - Date.now()) / 1000)}s ========`);

    if (remaining()) {
      const osChains = FOREIGN_CHAINS.filter((c) => c.openSeaChain);
      for (const c of osChains) {
        if (!remaining()) break;
        try {
          const r = await runOpenSeaStatsSync(c.chainSlug, 24);
          console.log(`[fill-all] os ${c.chainSlug}`, JSON.stringify(r));
        } catch (e) {
          console.log(`[fill-all] os ${c.chainSlug} ERR`, e instanceof Error ? e.message : e);
        }
      }
    }

    for (const slug of CG_CHAINS) {
      if (!remaining()) break;
      try {
        const r = await runCoinGeckoNftStats(slug, 20);
        console.log(`[fill-all] cg ${slug}`, JSON.stringify(r));
        if (r.updated === 0 && r.matched === 0) continue;
      } catch (e) {
        console.log(`[fill-all] cg ${slug} ERR`, e instanceof Error ? e.message : e);
      }
    }

    if (remaining()) {
      try {
        const { hydrateBitcoinArt } = await import("../lib/market/multichain/discovery/bitcoin-art-rotator");
        console.log("[fill-all] btc-art", JSON.stringify(await hydrateBitcoinArt(40)));
        const { backfillUnisatCollectionArt } = await import("../lib/market/multichain/adapters/unisat-collections");
        const art = await backfillUnisatCollectionArt(8);
        console.log("[fill-all] unisat-art", JSON.stringify(art));
      } catch (e) {
        console.log("[fill-all] unisat-art ERR", e instanceof Error ? e.message : e);
      }
    }

    if (remaining()) {
      for (const chainSlug of ["solana-mainnet", "bitcoin-mainnet", "robinhood"] as const) {
        if (!remaining()) break;
        const sync = await runMultichainSync({ maxCollections: 60, chainSlug });
        console.log(`[fill-all] adapter ${chainSlug}`, JSON.stringify({ synced: sync.synced, failed: sync.failed, skipped: sync.skipped }));
      }
    }
  }
  console.log(`[fill-all] done rounds=${round} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .then(async () => {
    try {
      const { hasPostgresConfig, postgresPool } = await import("../lib/postgres");
      if (hasPostgresConfig()) await postgresPool().end();
    } catch {
      /* */
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error("[fill-all] fatal", e instanceof Error ? e.message : e);
    process.exit(1);
  });
