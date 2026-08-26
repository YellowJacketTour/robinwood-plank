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
    if (source === "erc4906-rescan") {
      const { runMetadataUpdateRescanBatch } = await import("../lib/market/multichain/discovery/erc4906-rescan");
      console.log("[mesh-lane] erc4906-rescan", JSON.stringify(await runMetadataUpdateRescanBatch(chain, 5)));
      return;
    }
    if (source === "fills-reconcile") {
      const { reconcileFillsBatch } = await import("../lib/market/multichain/discovery/fills-reconcile");
      // Small batch: real, live-observed contention from a concurrent
      // anti-wraparound autovacuum on plank_seaport_fills made even a
      // 10-collection batch take 100s+ (each of 8 real fill-table lookups
      // per collection can individually hit that table's own statement
      // timeout under vacuum pressure) -- 3 keeps one invocation's worst
      // case bounded regardless of what else is contending for the same
      // table right now.
      console.log("[mesh-lane] fills-reconcile", JSON.stringify(await reconcileFillsBatch(3)));
      return;
    }
    if (source === "ipfs-corroboration") {
      const { sampleIpfsCorroboration } = await import("../lib/market/multichain/discovery/ipfs-corroboration");
      const result = await sampleIpfsCorroboration(chain, 25);
      if (result.drifted.length > 0) console.log("[mesh-lane] ipfs-corroboration DRIFT DETECTED", JSON.stringify(result.drifted));
      console.log("[mesh-lane] ipfs-corroboration", JSON.stringify(result));
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
      // Real fix, 2026-08-26: a specific `subject` here means a real,
      // demand-priority job for a collection an actual visitor is looking
      // at right now (vs. the bare background-sweep branch, which just
      // cycles through whatever's next) -- "live" priority now gets real
      // precedence over background-sweep competition for the shared
      // OpenSea pace slot (see opensea-key-pool.ts's BACKGROUND_SKIP_RATE).
      const isDemandDriven = /^0x[0-9a-f]{40}$/i.test(subject);
      const result = isDemandDriven
        ? await advanceEvmCollectionMembership(chain, subject, undefined, "live")
        : await advanceNextTrackedEvmMembership(chain);
      console.log("[mesh-lane] opensea-membership", JSON.stringify(result));
      // Real gap found live 2026-08-26 ("isnt hydrating by thousands in
      // live priority" while actively viewing a 69%-complete collection):
      // one call only ever advances ONE 50-item OpenSea page
      // (rarity-index-runner.ts's own PAGE_SIZE), and unlike anchored-
      // membership just above, this demand-driven job was always marked
      // 'succeeded' after that single page -- it only ran again on the
      // NEXT client visibility/detail ping, not back-to-back within the
      // same viewing session. Same exit-code-2 signal anchored-membership
      // already uses: mesh-tick.ts re-enqueues immediately when more real
      // work remains, so a genuinely incomplete, actively-viewed collection
      // now gets consecutive pages every mesh-tick pass instead of one page
      // per demand ping. Scoped to the demand-driven branch only -- the
      // background-sweep branch already gets its own turn every pass via
      // mesh-tick.ts's own standing MESH_LANES entry, so signaling here too
      // would be redundant, not incorrect.
      if (isDemandDriven && result && "complete" in result && !result.complete) process.exitCode = 2;
      return;
    }
    if (source === "anchored-membership") {
      // Real fix, 2026-08-25 ("if we have ability to track any collections
      // mint then we should auto detect that and anchor it as that
      // collections provenance trail seed... no need to work through
      // blocks it cant physically exist in"): for a collection whose own
      // OpenSea enumeration has provably plateaued (its /nfts pagination
      // looping over already-seen tokens -- Lil Pudgys confirmed live),
      // this walks HyperSync starting at the contract's REAL deployment
      // block (binary-searched via eth_getCode, cached forever) instead of
      // the blind shared 12M-15.5M "boom era" window that includes every
      // block the contract provably could not exist in yet. subject must
      // be a real 0x contract -- this is never a background-sweep source.
      if (!/^0x[0-9a-f]{40}$/i.test(subject)) throw new Error("anchored-membership requires a real contract subject");
      const { runAnchoredMembershipBackfill } = await import("../lib/market/multichain/discovery/anchored-membership-backfill");
      const result = await runAnchoredMembershipBackfill(chain, subject);
      console.log("[mesh-lane] anchored-membership", JSON.stringify(result));
      // Real bug found live 2026-08-25 ("stuck on 60.04 since coming
      // back"): one call only advances a bounded slice of the real
      // 300,000-block anchor window (Lil Pudgys' first real run moved
      // exactly 387 blocks) -- `done` only goes true once the WHOLE
      // window is walked. This is a one-off demand enqueue, not a
      // standing MESH_LANES entry mesh-tick.ts re-queues every pass on
      // its own, so a job that finishes one slice and returns was marked
      // 'succeeded' and permanently dropped from the queue -- real,
      // confirmed progress, then silence forever after.
      //
      // Exit code 2 (not a DB write here) signals "succeeded, but more
      // real work remains" to mesh-tick.ts's worker loop, which re-enqueues
      // the same job key AFTER finishDataJob's own unconditional status
      // update -- doing the re-enqueue from inside THIS process instead
      // would race finishDataJob's later UPDATE (matched by id/lease_owner,
      // unconditional) and get silently overwritten back to 'succeeded'
      // with no future pickup.
      if (!result.done) process.exitCode = 2;
      return;
    }
    if (source === "token-index-probe") {
      // Real fix, 2026-08-25 ("it has to be stuck... was syncing fast and
      // then froze"): anchored-membership was confirmed NOT deadlocked,
      // just genuinely slow closing the final gap because it must replay
      // every real historical Transfer log, most of which are resales of
      // already-known tokens -- see token-index-probe.ts's own header.
      // ERC721Enumerable's tokenByIndex(i) reads the real token ID at
      // each index directly from current contract state, exact and
      // dramatically cheaper, once known_supply is chain-confirmed. Runs
      // alongside anchored-membership rather than replacing it (some real
      // contracts don't implement Enumerable -- this self-detects and
      // no-ops for those, done=true on the very first call).
      if (!/^0x[0-9a-f]{40}$/i.test(subject)) throw new Error("token-index-probe requires a real contract subject");
      const { runTokenIndexProbe } = await import("../lib/market/multichain/discovery/token-index-probe");
      const result = await runTokenIndexProbe(chain, subject);
      console.log("[mesh-lane] token-index-probe", JSON.stringify(result));
      if (!result.done) process.exitCode = 2;
      return;
    }
    if (source === "plank-koth-watch") {
      const { runPlankKothWatch } = await import("../lib/market/plank-koth-watch");
      const result = await runPlankKothWatch();
      console.log("[mesh-lane] plank-koth-watch", JSON.stringify(result));
      // Same exit-code-2 self-requeue pattern as anchored-membership above:
      // `done: false` means a real, unfinalized (or unscanned-this-pass)
      // buy is still waiting, so mesh-tick should reclaim this lane again
      // promptly rather than waiting for its own next scheduled cadence.
      if (!result.done) process.exitCode = 2;
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
    if (source === "archival-frontier") {
      const { runArchivalFrontierLane } = await import("../lib/market/multichain/archival-ledger");
      console.log("[mesh-lane] archival-frontier", JSON.stringify(await runArchivalFrontierLane()));
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
