/**
 * One source × one chain. Exit 0 if jailed (the mesh keeps other lanes).
 *
 *   npx tsx --env-file=.env.local scripts/mesh-lane.ts --source=opensea-stats --chain=opt-mainnet
 */
import { isSourceJailed, jailSource } from "../lib/market/multichain/mesh/jail";
import type { MeshSource } from "../lib/market/multichain/mesh/matrix";

const source = (process.argv.find((a) => a.startsWith("--source="))?.slice("--source=".length) ?? "") as MeshSource;
const chain = process.argv.find((a) => a.startsWith("--chain="))?.slice("--chain=".length) ?? "";

async function main(): Promise<void> {
  if (!source || !chain) {
    throw new Error("mesh-lane requires --source= and --chain=");
  }
  if (await isSourceJailed(source, chain)) {
    console.log(`[mesh-lane] skip jailed source=${source} chain=${chain}`);
    return;
  }

  try {
    if (source === "opensea-stats") {
      const { runOpenSeaStatsSync } = await import("../lib/market/multichain/discovery/opensea-stats");
      console.log("[mesh-lane] os", JSON.stringify(await runOpenSeaStatsSync(chain, 20)));
      return;
    }
    if (source === "coingecko-nft") {
      const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
      console.log("[mesh-lane] cg", JSON.stringify(await runCoinGeckoNftStats(chain, 15)));
      return;
    }
    if (source === "ordinals-wallet") {
      const { hydrateBitcoinArt } = await import("../lib/market/multichain/discovery/bitcoin-art-rotator");
      console.log("[mesh-lane] ow", JSON.stringify(await hydrateBitcoinArt(40)));
      return;
    }
    if (source === "magiceden-solana") {
      const { hydrateSolanaFromMagicEden } = await import("../lib/market/multichain/discovery/hydrate-all-collection-art");
      console.log("[mesh-lane] me", JSON.stringify(await hydrateSolanaFromMagicEden()));
      return;
    }
    if (source === "unisat-collections") {
      const { backfillUnisatCollectionArt } = await import("../lib/market/multichain/adapters/unisat-collections");
      console.log("[mesh-lane] unisat", JSON.stringify(await backfillUnisatCollectionArt(6)));
      return;
    }
    if (source === "adapter-sync") {
      const { runMultichainSync } = await import("../lib/market/multichain/sync");
      const r = await runMultichainSync({ maxCollections: 80, chainSlug: chain });
      console.log("[mesh-lane] adapter", JSON.stringify({ synced: r.synced, failed: r.failed, skipped: r.skipped }));
      return;
    }
    if (source === "seaport-fills") {
      const { updateEvmVolumeFromSeaportFills } = await import("../lib/market/multichain/store");
      console.log("[mesh-lane] fills", JSON.stringify(await updateEvmVolumeFromSeaportFills(chain)));
      return;
    }
    if (source === "native-robinwood") {
      const { sanitizeUnknownZeros } = await import("../lib/market/multichain/store");
      console.log("[mesh-lane] heal", JSON.stringify(await sanitizeUnknownZeros()));
      return;
    }
    console.log(`[mesh-lane] no runner for source=${source}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/429|403|rate limit|quota/i.test(msg)) {
      await jailSource(source, 20 * 60_000, true, chain);
      console.log(`[mesh-lane] jailed ${source}: ${msg.slice(0, 180)}`);
      return;
    }
    throw e;
  }
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
    console.error("[mesh-lane] fatal", e instanceof Error ? e.message : e);
    process.exit(1);
  });
