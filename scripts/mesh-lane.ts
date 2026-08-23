/**
 * One source × one chain. Exit 0 if jailed (the mesh keeps other lanes).
 *
 *   npx tsx --env-file=.env.local scripts/mesh-lane.ts --source=opensea-stats --chain=opt-mainnet
 */
import { isSourceJailed, jailSource } from "../lib/market/multichain/mesh/jail";
import type { MeshSource } from "../lib/market/multichain/mesh/matrix";

const source = (process.argv.find((a) => a.startsWith("--source="))?.slice("--source=".length) ?? "") as MeshSource;
const chain = process.argv.find((a) => a.startsWith("--chain="))?.slice("--chain=".length) ?? "";
const subject = process.argv.find((a) => a.startsWith("--subject="))?.slice("--subject=".length) ?? "";

async function main(): Promise<void> {
  if (!source || !chain) {
    throw new Error("mesh-lane requires --source= and --chain=");
  }
  if (await isSourceJailed(source, chain)) {
    console.log(`[mesh-lane] skip jailed source=${source} chain=${chain}`);
    return;
  }

  try {
    if (source === "cryptopunks-native") {
      const { syncCryptoPunksNativeBook } = await import("../lib/market/multichain/native-market-adapters/cryptopunks");
      console.log("[mesh-lane] cryptopunks-native", JSON.stringify(await syncCryptoPunksNativeBook()));
      return;
    }
    if (source === "hypersync-discovery") {
      const { runHypersyncDiscoveryScan } = await import("../lib/market/multichain/discovery/hypersync-evm-scan");
      console.log("[mesh-lane] hypersync-discovery", JSON.stringify(await runHypersyncDiscoveryScan({ chainSlug: chain })));
      return;
    }
    if (source === "hypersync-backfill") {
      const { runHypersyncBackfillScan } = await import("../lib/market/multichain/discovery/hypersync-evm-scan");
      console.log("[mesh-lane] hypersync-backfill", JSON.stringify(await runHypersyncBackfillScan({ chainSlug: chain })));
      return;
    }
    if (source === "helius-discovery") {
      const { runHeliusCollectionScan } = await import("../lib/market/multichain/discovery/helius-collection-scan");
      console.log("[mesh-lane] helius-discovery", JSON.stringify(await runHeliusCollectionScan({ maxPages: 1 })));
      return;
    }
    if (source === "helius-membership") {
      const { scaffoldAllTrackedSolanaCollections } = await import("../lib/market/multichain/discovery/helius-rarity-index-runner");
      console.log("[mesh-lane] helius-membership", JSON.stringify(await scaffoldAllTrackedSolanaCollections({ limit: 1, delayMs: 0, force: true })));
      return;
    }
    if (source === "unisat-discovery") {
      const { runUnisatCollectionListScan } = await import("../lib/market/multichain/discovery/unisat-collection-list-scan");
      console.log("[mesh-lane] unisat-discovery", JSON.stringify(await runUnisatCollectionListScan({ maxPages: 1 })));
      return;
    }
    if (source === "ordiscan-discovery") {
      const { runOrdiscanCollectionScan } = await import("../lib/market/multichain/discovery/ordiscan-collection-scan");
      console.log("[mesh-lane] ordiscan-discovery", JSON.stringify(await runOrdiscanCollectionScan({ maxPages: 1 })));
      return;
    }
    if (source === "robinhood-discovery") {
      const { runRobinhoodChainDiscoveryScan } = await import("../lib/market/multichain/discovery/robinhood-chain-scan");
      console.log("[mesh-lane] robinhood-discovery", JSON.stringify(await runRobinhoodChainDiscoveryScan()));
      return;
    }
    if (source === "robinhood-backfill") {
      const { runRobinhoodChainDiscoveryGenesisBackfill } = await import("../lib/market/multichain/discovery/robinhood-chain-scan");
      console.log("[mesh-lane] robinhood-backfill", JSON.stringify(await runRobinhoodChainDiscoveryGenesisBackfill()));
      return;
    }
    if (source === "robinhood-opensea") {
      const { runOpenSeaRobinhoodDiscoveryScan } = await import("../lib/market/multichain/discovery/opensea-robinhood-scan");
      console.log("[mesh-lane] robinhood-opensea", JSON.stringify(await runOpenSeaRobinhoodDiscoveryScan({ maxPages: 1 })));
      return;
    }
    if (source === "robinhood-membership") {
      const { advanceEvmCollectionMembership, advanceNextRobinhoodMembership } = await import("../lib/market/multichain/rarity-index-runner");
      const result = /^0x[0-9a-f]{40}$/i.test(subject)
        ? await advanceEvmCollectionMembership("robinhood", subject, "robinhood")
        : await advanceNextRobinhoodMembership();
      console.log("[mesh-lane] robinhood-membership", JSON.stringify(result));
      return;
    }
    if (source === "robinhood-metadata") {
      const { advanceRobinhoodTokenMetadata } = await import("../lib/market/multichain/rarity-index-runner");
      let attempted = 0, complete = 0, empty = 0, retry = 0, rarityFinalized = 0;
      const deadline = Date.now() + 45_000;
      while (attempted < 250 && Date.now() < deadline) {
        const batch = await advanceRobinhoodTokenMetadata(25);
        attempted += batch.attempted; complete += batch.complete; empty += batch.empty;
        retry += batch.retry; rarityFinalized += batch.rarityFinalized;
        if (batch.attempted === 0) break;
      }
      console.log("[mesh-lane] robinhood-metadata", JSON.stringify({ attempted, complete, empty, retry, rarityFinalized }));
      return;
    }
    if (source === "evm-metadata") {
      const { advanceEvmTokenMetadata } = await import("../lib/market/multichain/rarity-index-runner");
      let attempted = 0, complete = 0, empty = 0, retry = 0, rarityFinalized = 0;
      const deadline = Date.now() + 45_000;
      const ceiling = subject ? 250 : 75;
      while (attempted < ceiling && Date.now() < deadline) {
        const batch = await advanceEvmTokenMetadata(chain, 25, subject || null);
        attempted += batch.attempted; complete += batch.complete; empty += batch.empty;
        retry += batch.retry; rarityFinalized += batch.rarityFinalized;
        if (batch.attempted === 0) break;
      }
      console.log("[mesh-lane] evm-metadata", JSON.stringify({ attempted, complete, empty, retry, rarityFinalized }));
      return;
    }
    if (source === "unisat-rarity") {
      const { scaffoldAllTrackedBitcoinCollections } = await import("../lib/market/multichain/discovery/unisat-rarity-index-runner");
      console.log("[mesh-lane] unisat-rarity", JSON.stringify(await scaffoldAllTrackedBitcoinCollections({ limit: 1, delayMs: 0 })));
      return;
    }
    if (source === "unisat-membership") {
      const { advanceNextTrackedBitcoinMembership } = await import("../lib/market/multichain/discovery/unisat-membership-index-runner");
      console.log("[mesh-lane] unisat-membership", JSON.stringify(await advanceNextTrackedBitcoinMembership()));
      return;
    }
    if (source === "opensea-stats") {
      const { runOpenSeaStatsSync, syncOpenSeaCollectionStats } = await import("../lib/market/multichain/discovery/opensea-stats");
      const output = subject
        ? await syncOpenSeaCollectionStats(chain, subject)
        : await runOpenSeaStatsSync(chain, 20);
      console.log("[mesh-lane] os", JSON.stringify(output));
      return;
    }
    if (source === "opensea-membership") {
      const { advanceEvmCollectionMembership, advanceNextTrackedEvmMembership } = await import("../lib/market/multichain/rarity-index-runner");
      const result = /^0x[0-9a-f]{40}$/i.test(subject)
        ? await advanceEvmCollectionMembership(chain, subject)
        : await advanceNextTrackedEvmMembership(chain);
      console.log("[mesh-lane] opensea-membership", JSON.stringify(result));
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
      if (chain !== "robinhood") {
        const { scanChainForFillsViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-seaport-scan");
        const scan = await scanChainForFillsViaHypersync(chain);
        if (scan.error) throw new Error(scan.error);
        const { updateEvmVolumeFromSeaportFills } = await import("../lib/market/multichain/store");
        const updated = await updateEvmVolumeFromSeaportFills(chain);
        console.log("[mesh-lane] fills-live", JSON.stringify({ scan, updated }));
        return;
      }
      const { updateEvmVolumeFromSeaportFills } = await import("../lib/market/multichain/store");
      console.log("[mesh-lane] fills", JSON.stringify(await updateEvmVolumeFromSeaportFills(chain)));
      return;
    }
    if (source === "seaport-fills-genesis") {
      const { scanChainForFillsGenesisBackfillViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-seaport-scan");
      const scan = await scanChainForFillsGenesisBackfillViaHypersync(chain);
      if (scan.error) throw new Error(scan.error);
      const { updateEvmVolumeFromSeaportFills } = await import("../lib/market/multichain/store");
      const updated = await updateEvmVolumeFromSeaportFills(chain);
      console.log("[mesh-lane] fills-genesis", JSON.stringify({ scan, updated }));
      return;
    }
    if (source === "wyvern-fills") {
      const { scanChainForWyvernFillsViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-wyvern-scan");
      const scan = await scanChainForWyvernFillsViaHypersync(chain);
      if (scan.error) throw new Error(scan.error);
      console.log("[mesh-lane] wyvern-fills-live", JSON.stringify(scan));
      return;
    }
    if (source === "wyvern-fills-genesis") {
      const { scanChainForWyvernFillsGenesisBackfillViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-wyvern-scan");
      const scan = await scanChainForWyvernFillsGenesisBackfillViaHypersync(chain);
      if (scan.error) throw new Error(scan.error);
      console.log("[mesh-lane] wyvern-fills-genesis", JSON.stringify(scan));
      return;
    }
    if (source === "cryptokitties-fills") {
      const { scanChainForCryptoKittiesFillsViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-cryptokitties-scan");
      const scan = await scanChainForCryptoKittiesFillsViaHypersync(chain);
      if (scan.error) throw new Error(scan.error);
      console.log("[mesh-lane] cryptokitties-fills-live", JSON.stringify(scan));
      return;
    }
    if (source === "cryptokitties-fills-genesis") {
      const { scanChainForCryptoKittiesFillsGenesisBackfillViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-cryptokitties-scan");
      const scan = await scanChainForCryptoKittiesFillsGenesisBackfillViaHypersync(chain);
      if (scan.error) throw new Error(scan.error);
      console.log("[mesh-lane] cryptokitties-fills-genesis", JSON.stringify(scan));
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
      const providerSource = source === "ordiscan-discovery"
        ? "ordiscan"
        : source === "opensea-membership" ? "opensea-stats"
        : source.startsWith("unisat") ? "unisat" : source;
      // Quotas attach to the credential/provider account, not one chain.
      await jailSource(providerSource, 20 * 60_000, true);
      if (providerSource !== source) await jailSource(source, 20 * 60_000, true);
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
    process.exitCode = 0;
  })
  .catch((e) => {
    console.error("[mesh-lane] fatal", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
