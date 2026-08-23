/**
 * Scheduled refresh for every market data snapshot.
 *
 * Why this exists: nothing on a schedule ever rebuilt NFT/sales/vault data.
 * Snapshots were built lazily on whichever unlucky user request found the key
 * missing, or by a set of hand-run seed scripts that still wrote to the
 * pre-PostgreSQL datastore — so running them changed nothing the app could
 * see. Those scripts are deleted; this replaces all of them. It imports the
 * real library code, so it always writes wherever the app reads.
 *
 * Usage:
 *   tsx scripts/refresh-market-data.ts            # incremental (cron, ~15m)
 *   tsx scripts/refresh-market-data.ts --full     # full rebuild (cron, daily)
 *   tsx scripts/refresh-market-data.ts --sales    # one target only
 *   tsx scripts/refresh-market-data.ts --events   # advance the permanent event ledger only
 *   tsx scripts/refresh-market-data.ts --metadata # build/resume the canonical IPFS metadata store
 *   tsx scripts/refresh-market-data.ts --purge --rarity --traits --collection
 *
 * Targets: --events --sales --vault --portfolio --rarity --traits --collection --metadata
 *
 * --events advances `plank_chain_events` (see migration 008), the permanent
 * append-only on-chain ledger the Activity feed reads from. It is idempotent
 * and resumable via a stored per-contract cursor: re-running it over an
 * already-indexed range inserts nothing, so an interrupted run is always safe
 * to repeat. Backfill is not a separate script — a cold database simply starts
 * its cursor at the collection's deploy block and catches up over successive
 * cron ticks. Runs first: nothing else here depends on it, but everything
 * downstream is more accurate once it has.
 *
 * --portfolio must run after --vault in the same pass (it reads the durable
 * activity lineage that step just refreshed): records a NAV snapshot per
 * vault then recomputes every wallet+vault CohortPosition
 * (lib/market/portfolio-pnl.ts) and upserts it — see migration
 * 008_portfolio_pnl.sql and lib/market/portfolio-flow-mapper.ts's doc
 * comment for the historical-NAV and LP-exclusion tradeoffs this makes.
 *
 * --metadata builds `robinwood_token_metadata` (see
 * lib/market/robinwood-metadata.ts) — the canonical, IPFS-only source for
 * every token's name/description/image/traits. It is idempotent and
 * resumable: already-stored tokens are skipped, so a partial or failed run is
 * always safe to re-run. It has NO per-run cap, unlike the rarity/trait
 * backfills this replaced, which silently capped themselves at a few hundred
 * tokens and could report a false "success" on an incomplete snapshot. Run
 * this to completion (watch for "complete=true" in its own log line) BEFORE
 * --rarity/--traits/--collection — those now read this table instead of
 * Blockscout and will just see gaps as unscored/missing if it hasn't finished.
 *
 * --purge deletes the collection-wide snapshots BEFORE rebuilding them. The
 * rarity snapshot and the collection image map are deliberately stored without
 * a TTL (rebuilding them depends on rate-limited Blockscout/IPFS, and expiring
 * them stampeded every Passenger worker at once). The cost of that choice is
 * that a snapshot built from bad upstream data is permanent — which is exactly
 * what happened when Blockscout served pre-reveal stubs for planks #1-180 and
 * they stuck long after reveal. Nothing short of deleting the key fixes that,
 * so this is the operational half of that fix. Not for routine cron use.
 * Exits non-zero only if every requested target failed, so a single flaky
 * upstream doesn't turn a cron run into a red alert.
 */

const CHAIN_ID = 4663;
const args = new Set(process.argv.slice(2));
const full = args.has("--full");
const explicit = [
  "--sales",
  "--vault",
  "--portfolio",
  "--metadata",
  "--rarity",
  "--traits",
  "--collection",
  "--opensea",
  "--pulp",
  "--official-assets",
  "--token-registry",
  "--owners",
  "--events",
  "--multichain",
  "--discover-evm",
  "--discover-hypersync",
  "--discover-hypersync-backfill",
  "--discover-bitcoin-collections",
  "--discover-ordiscan-collections",
  "--discover-ordinalswallet-collections",
  "--discover-solana-collections",
  "--discover-robinhood",
  "--discover-robinhood-opensea",
  "--discover-opensea-bulk",
  "--hydrate-opensea",
  "--hydrate-bitcoin-membership",
  "--hydrate-solana-membership",
  "--seaport-fills",
  "--seaport-fills-backfill",
  "--cryptopunks-native-book",
  "--robinwood-floor-observation",
  "--own-ranking",
  "--scaffold-rarity",
].filter((t) => args.has(t));

/**
 * Full runs include the expensive collection-wide rebuilds; incremental
 * ones don't. scaffold-rarity is FULL-ONLY on purpose: own-ranking's
 * per-tick promotion is a handful of metadata lookups, but scaffolding a
 * newly-registered collection means paginating its ENTIRE token set
 * (up to 100 pages, see rarity-index-runner.ts) -- real work that doesn't
 * belong on a 2-minute incremental cadence. Its own freshness-skip
 * (scaffold-all-collections.ts's --freshDays default) keeps a full run
 * cheap on every tick after the first anyway -- most collections are
 * already fresh and get skipped in one cheap read.
 */
const targets = new Set(
  explicit.length > 0
    ? explicit.map((t) => t.slice(2))
    : full
      ? ["events", "sales", "vault", "portfolio", "opensea", "pulp", "official-assets", "token-registry", "owners", "metadata", "rarity", "traits", "collection", "multichain", "discover-evm", "discover-hypersync", "discover-hypersync-backfill", "discover-bitcoin-collections", "discover-ordiscan-collections", "discover-ordinalswallet-collections", "discover-solana-collections", "discover-robinhood", "discover-robinhood-opensea", "discover-opensea-bulk", "hydrate-opensea", "hydrate-bitcoin-membership", "hydrate-solana-membership", "seaport-fills", "seaport-fills-backfill", "looksrare-fills", "looksrare-fills-backfill", "blur-fills", "blur-fills-backfill", "x2y2-fills", "x2y2-fills-backfill", "foundation-fills", "foundation-fills-backfill", "cryptopunks-native-book", "robinwood-floor-observation", "own-ranking", "scaffold-rarity", "scaffold-rarity-solana", "scaffold-rarity-bitcoin", "scaffold-rarity-ordinalswallet", "evm-fill-stats", "coingecko-solana-stats", "coingecko-bitcoin-stats", "coingecko-bnb-stats", "coingecko-avax-stats", "coingecko-eth-stats", "coingecko-polygon-stats", "coingecko-base-stats", "coingecko-arb-stats", "coingecko-opt-stats"]
      : ["events", "sales", "vault", "portfolio", "opensea", "pulp", "official-assets", "token-registry", "owners", "multichain", "discover-evm", "discover-hypersync", "discover-hypersync-backfill", "discover-bitcoin-collections", "discover-ordiscan-collections", "discover-ordinalswallet-collections", "discover-solana-collections", "discover-robinhood", "discover-robinhood-opensea", "discover-opensea-bulk", "hydrate-opensea", "hydrate-bitcoin-membership", "hydrate-solana-membership", "seaport-fills", "seaport-fills-backfill", "looksrare-fills", "looksrare-fills-backfill", "blur-fills", "blur-fills-backfill", "x2y2-fills", "x2y2-fills-backfill", "foundation-fills", "foundation-fills-backfill", "cryptopunks-native-book", "robinwood-floor-observation", "own-ranking", "evm-fill-stats", "coingecko-solana-stats", "coingecko-bitcoin-stats", "coingecko-bnb-stats", "coingecko-avax-stats", "coingecko-eth-stats", "coingecko-polygon-stats", "coingecko-base-stats", "coingecko-arb-stats", "coingecko-opt-stats"]
);

type Outcome = { target: string; ok: boolean; detail: string };
const results: Outcome[] = [];

async function step(target: string, run: () => Promise<string>): Promise<void> {
  if (!targets.has(target)) return;
  const startedAt = Date.now();
  try {
    const detail = await run();
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    results.push({ target, ok: true, detail: `${detail} (${secs}s)` });
    console.log(`[refresh] ${target}: ${detail} (${secs}s)`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ target, ok: false, detail });
    console.error(`[refresh] ${target} FAILED: ${detail}`);
  }
}

async function main(): Promise<void> {
  const { hasDurableKv, durableKvBackend } = await import("../lib/market/durable-kv");
  if (!hasDurableKv()) {
    throw new Error(
      "No datastore configured. Set PGHOST/PGDATABASE/PGUSER/PGPASSWORD so this writes where the app reads."
    );
  }
  console.log(`[refresh] backend=${durableKvBackend()} mode=${full ? "full" : "incremental"}`);

  // Renew the OpenSea credential before it lapses. Free keys expire after 30
  // days; a silent expiry would make volume quietly stop updating, which is the
  // same failure the sales catalog already had. Runs every cron pass, does
  // nothing until the key is within a week of expiry. Never fatal — losing
  // OpenSea data must not stop the rest of the refresh.
  try {
    const { ensureOpenSeaKey } = await import("../lib/market/opensea");
    const key = await ensureOpenSeaKey();
    const loud = key.status === "failed" || key.status === "unavailable";
    (loud ? console.error : console.log)(`[refresh] opensea-key: ${key.status} — ${key.detail}`);
  } catch (error) {
    console.error(
      "[refresh] opensea-key: check failed —",
      error instanceof Error ? error.message : error
    );
  }

  // Permanent on-chain event ledger. Runs FIRST, and on every tick including
  // incremental ones, because it is the only step whose output is append-only
  // and irreplaceable: every other snapshot here can be rebuilt from upstream
  // at any time, whereas a block range that is never scanned leaves a hole
  // nothing can later notice or fill.
  //
  // Backfill and live sync are the same call — see lib/market/chain-indexer.ts.
  // On a cold database the first several runs walk history forward from the
  // collection's deploy block and report caughtUp=false; once the cursor
  // reaches the confirmed head each run costs a single small forward window.
  await step("events", async () => {
    const { runChainIndexer, reindexNftRange } = await import("../lib/market/chain-indexer");
    const { unpricedSaleBlockRanges } = await import("../lib/market/chain-events");
    const run = await runChainIndexer();
    // A transaction/receipt lookup can fail transiently after the Transfer
    // log itself succeeded. Keep the append-only event immediately, then
    // heal a bounded number of exact suspect ranges on every cron tick.
    const repairRanges = (await unpricedSaleBlockRanges()).slice(0, 3);
    let repaired = 0;
    for (const range of repairRanges) {
      const repair = await reindexNftRange(range);
      repaired += repair.rowsRepaired;
    }
    const parts = run.sources.map((s) => {
      const range = s.toBlock >= s.fromBlock ? `${s.fromBlock}-${s.toBlock}` : "nothing due";
      return (
        `${s.source}:${s.contract.slice(0, 10)} ${range} ` +
        `+${s.rowsInserted}/${s.logsScanned}${s.error ? ` ERR(${s.error.slice(0, 60)})` : ""}`
      );
    });
    return (
      `head=${run.head} confirmed=${run.confirmedHead} ` +
      `+${run.rowsInserted} new rows, repaired=${repaired}, ` +
      `repairRanges=${repairRanges.length}, caughtUp=${run.caughtUp} — ${parts.join("; ")}`
    );
  });

  // Sales catalog — the one that actually changes over time, and the one whose
  // absence blanks Highest sale / volume / sale history.
  await step("sales", async () => {
    const {
      buildRoyaltySalesCatalog,
      writeSalesCatalog,
      readStoredSalesCatalog,
      mergeSalesCatalogs,
    } = await import("../lib/market/sales-catalog");

    const stored = await readStoredSalesCatalog();
    const built = await buildRoyaltySalesCatalog(
      full ? { maxTransferPages: 60, maxTxDetail: 400 } : undefined
    );

    // Union, never replace: a bounded (or partially failed) walk can return
    // fewer sales than we already have, and a settled sale never un-happens.
    const merged = mergeSalesCatalogs(stored, built);
    if (merged.sales.length === 0) return "no sales found, nothing stored";

    const added = merged.sales.length - (stored?.sales?.length ?? 0);
    if (added === 0 && stored) return `${merged.sales.length} sales (no change)`;

    await writeSalesCatalog(merged);
    return `${merged.sales.length} sales (+${added} new, built ${built.sales.length})`;
  });

  // Vault activity — a bounded live scan merged into the durable lineage.
  // Not full=true: that short-circuits to the stored lineage when one exists.
  await step("vault", async () => {
    const { getVaultActivity } = await import("../lib/market/vault-activity");
    const events = await getVaultActivity(full ? 400 : 100);
    return `${events.length} events`;
  });

  // Vault-aware wallet portfolio PnL — records a NAV snapshot per vault
  // (grows the historical-NAV fallback table lib/market/portfolio-nav-history.ts
  // uses for deposit/redeem valuation) then recomputes every wallet+vault
  // cohort seen in the vault activity we just scanned above and upserts
  // CohortPositions (migration 008_portfolio_pnl.sql) so /api/portfolio
  // reads a precomputed row instead of re-deriving from scratch per request.
  await step("portfolio", async () => {
    const { MARKET_VAULT_ADDRESS, MARKET_VAULT_ADDRESSES } = await import("../lib/constants");
    const { getVaultActivity } = await import("../lib/market/vault-activity");
    const { vaultEventsToFlowRows } = await import("../lib/market/portfolio-flow-mapper");
    const { computeCohortPositions } = await import("../lib/market/portfolio-pnl");
    const { resolveNavAtBlock, recordCurrentNavSnapshot } = await import(
      "../lib/market/portfolio-nav-history"
    );
    const { upsertCohortPosition } = await import("../lib/market/portfolio-store");

    const vaults =
      MARKET_VAULT_ADDRESSES.length > 0
        ? [...MARKET_VAULT_ADDRESSES]
        : MARKET_VAULT_ADDRESS
          ? [MARKET_VAULT_ADDRESS]
          : [];
    if (vaults.length === 0) return "no vault configured, skipped";

    let snapshotsWritten = 0;
    for (const vault of vaults) {
      try {
        const snapshot = await recordCurrentNavSnapshot(vault);
        if (snapshot) snapshotsWritten += 1;
      } catch {
        /* one vault's NAV read failing must not block the others */
      }
    }

    // Full lineage — cost-basis is a stateful reduction over ALL history for
    // a cohort, not just the incremental window; getVaultActivity(full:true)
    // serves the durable merged history (capped at 500 events) built up by
    // the "vault" step above, no extra scan.
    const events = await getVaultActivity(400, { full: true });
    const rows = await vaultEventsToFlowRows(events, resolveNavAtBlock);
    const positions = computeCohortPositions(rows);

    let written = 0;
    for (const pos of positions.values()) {
      try {
        await upsertCohortPosition(pos);
        written += 1;
      } catch {
        /* one cohort failing to write must not lose the rest */
      }
    }
    return `${snapshotsWritten}/${vaults.length} nav snapshots, ${written}/${positions.size} cohort positions from ${events.length} events`;
  });

  // OpenSea's own collection figures, stored for reconciliation against our
  // catalog. Also logs the shape of a real listing, which is the only way to
  // learn whether their orders on this chain are fulfillable by us — that
  // decides a working Buy button versus an honest deep link.
  await step("opensea", async () => {
    const { refreshOpenSeaStats, refreshOpenSeaListings } = await import(
      "../lib/market/opensea"
    );
    const [stats, listings] = await Promise.all([
      refreshOpenSeaStats(),
      refreshOpenSeaListings(),
    ]);
    const statsPart = stats
      ? `volume=${stats.volume ?? "?"} sales=${stats.sales ?? "?"} floor=${stats.floorPrice ?? "?"}`
      : "no stats";
    return `${statsPart}, ${listings.length} listings`;
  });

  // PulpMarket listings for the same collection. Independent of the opensea
  // step in both directions: either venue can fail without touching the
  // other's rows, and neither writes anything the other reads.
  //
  // ONE REQUEST PER PASS. Their docs ask for "no more than about one request
  // per second" and publish no hard limit, so this deliberately lives on the
  // cron rather than being called per visitor — even though their CORS header
  // would allow a browser to call it directly.
  await step("pulp", async () => {
    const { refreshPulpListings } = await import("../lib/market/pulp");
    const listings = await refreshPulpListings();
    return `${listings.length} listings`;
  });

  // Robinhood's own token registry. Backs the "Official" badge in the swap
  // picker — the only authoritative answer to "which of these 50 tokens called
  // USDC is real", where an authority exists at all.
  await step("official-assets", async () => {
    const { refreshOfficialAssets } = await import("../lib/market/robinhood-assets");
    const assets = await refreshOfficialAssets();
    return `${assets.length} official tokens on chain ${CHAIN_ID}`;
  });

  // Token registry — chain-discovered, ranked by traded volume. Must run after
  // official-assets so equities can be annotated in the same pass.
  await step("token-registry", async () => {
    const { refreshTokenRegistry } = await import("../lib/market/token-registry");
    const tokens = await refreshTokenRegistry();
    const top = tokens.slice(0, 6).map((t) => t.symbol).join(", ");
    return `${tokens.length} tokens — top: ${top}`;
  });

  // Collection-wide owner snapshot. Keeps /api/market/token off a per-token
  // ownerOf — measured at ~26 CU per distinct token view, and since every
  // visitor looks at different tokens no cache could ever absorb it.
  await step("owners", async () => {
    const { rebuildOwnerIndex } = await import("../lib/market/owner-index");
    const { NFT_CONTRACT_ADDRESS } = await import("../lib/mint-contract");
    const snapshot = await rebuildOwnerIndex(NFT_CONTRACT_ADDRESS);
    return `${snapshot.count} owners indexed via ${snapshot.source}`;
  });

  // Must run BEFORE the rebuilds below, and only when asked. There is no
  // kv.del, so this writes a deliberately unusable value with a 1s expiry:
  // both readers already reject an undersized blob and fall through to a
  // rebuild, so an empty object is indistinguishable from "never built".
  // Deliberately NOT routed through step(): step() returns silently for any
  // target not in `targets`, so a purge invoked that way would no-op without
  // saying so and the operator would believe the cache had been cleared.
  if (args.has("--purge")) {
    const { durableKv } = await import("../lib/market/durable-kv");
    const { MARKET_COLLECTIONS } = await import("../lib/market/collections");
    const keys = [
      // v5: sourced from the canonical robinwood_token_metadata table, not
      // Blockscout. The old v4 key is left alone — nothing reads it anymore.
      "plank:market:rarity-snapshot-v5",
      // Has a TTL, so it heals on its own eventually — but the collection
      // index reads its per-token attributes from here, so leaving it means a
      // rebuilt index still serves stale traits against a correct name,
      // image and rank. Purge it in the same pass.
      ...MARKET_COLLECTIONS.map((c) => `plank:market:trait-index-v1:${c.slug}`),
    ];
    for (const key of keys) await durableKv.set(key, {}, { ex: 1 });
    console.log(`[refresh] purge: invalidated ${keys.join(", ")}`);
    console.log(
      "[refresh] purge: NOTE — robinwood_token_metadata (the canonical IPFS store) is " +
        "NOT purged by this flag. It is immutable, verified-CID data; delete rows there " +
        "explicitly (or pass --metadata --force via a one-off script) if it is ever wrong."
    );
  }

  // Canonical IPFS-sourced metadata store. Must run before rarity/traits/
  // collection — they now read this table instead of walking Blockscout/IPFS
  // themselves. No cap: walks whatever is still missing, however long that
  // takes, and says plainly whether the run finished.
  await step("metadata", async () => {
    const { buildRobinwoodMetadataStore } = await import("../lib/market/robinwood-metadata");
    const report = await buildRobinwoodMetadataStore();
    const stored = report.alreadyStored + report.newlyStored;
    return report.complete
      ? `complete=true ${stored}/${report.totalSupply} stored`
      : `complete=false ${stored}/${report.totalSupply} stored, ${report.failed.length} failed ` +
          `(ids: ${report.failed.slice(0, 20).join(",")}${report.failed.length > 20 ? ",…" : ""}) — re-run to resume`;
  });

  await step("rarity", async () => {
    const { getRaritySnapshot } = await import("../lib/market/rarity-snapshot");
    const snapshot = await getRaritySnapshot();
    const gap = snapshot.sampleSize - snapshot.scoredCount;
    return gap > 0
      ? `${snapshot.scoredCount}/${snapshot.sampleSize} scored — ${gap} still unscored, ` +
          `run --metadata to fill the canonical store then re-run this`
      : `${snapshot.scoredCount}/${snapshot.sampleSize} scored`;
  });

  await step("traits", async () => {
    const { MARKET_COLLECTIONS } = await import("../lib/market/collections");
    const { getTraitIndex } = await import("../lib/market/trait-index");
    const parts: string[] = [];
    for (const collection of MARKET_COLLECTIONS) {
      const { index, complete } = await getTraitIndex(collection);
      const traits = index ? Object.keys(index.traits).length : 0;
      parts.push(`${collection.slug}=${traits} traits${complete ? "" : " (incomplete)"}`);
    }
    return parts.join(", ");
  });

  await step("collection", async () => {
    const { getCollectionIndex } = await import("../lib/market/collection-index");
    const index = await getCollectionIndex();
    return `${index.count}/${index.totalSupply} tokens`;
  });

  // Multi-chain collection index — completely independent of every step
  // above (different tables, different upstream APIs, no Robinhood-chain
  // dependency), so a failure here never blocks or is blocked by the rest
  // of this run. See lib/market/multichain/ for the adapter architecture.
  await step("multichain", async () => {
    const { runMultichainSync } = await import("../lib/market/multichain/sync");
    const run = await runMultichainSync();
    return (
      `${run.synced} synced, ${run.failed} failed, ${run.skipped} skipped` +
      (run.errors.length > 0
        ? ` — ${run.errors.slice(0, 5).map((e) => `${e.chainSlug}:${e.contractAddress.slice(0, 10)} (${e.error.slice(0, 60)})`).join("; ")}`
        : "")
    );
  });

  // Free, always-scanning EVM collection discovery -- watches raw chain
  // activity instead of asking a ranking API (none exists for free as of
  // 2026-08-17; see lib/market/multichain/discovery/evm-log-scan.ts's
  // header). Runs AFTER multichain on purpose: any collection this
  // discovers gets its first snapshot written immediately, so the very
  // next --multichain tick has nothing new to catch up on.
  await step("discover-evm", async () => {
    const { runAllEvmDiscoveryScans } = await import("../lib/market/multichain/discovery/evm-log-scan");
    const runs = await runAllEvmDiscoveryScans();
    const parts = runs.map((r) =>
      r.error
        ? `${r.chainSlug}: ERR(${r.error.slice(0, 60)})`
        : `${r.chainSlug}: blocks ${r.fromBlock}-${r.toBlock}, +${r.registered} new (${r.candidates} candidates, ${r.skippedNoMetadata} no-metadata)`
    );
    return parts.join("; ");
  });

  // The fast path -- see lib/market/multichain/discovery/hypersync-evm-scan.ts's
  // own header. Same candidate logic and cursor table as discover-evm above,
  // just up to ~2000x faster per real Envio benchmarks, so real forward
  // progress toward full chain history is actually achievable instead of
  // permanently bottlenecked at 10 blocks/tick. No-ops with a clear error
  // (not a crash) when ENVIO_API_TOKEN isn't set -- this is additive, not a
  // replacement for discover-evm, which keeps running either way.
  await step("discover-hypersync", async () => {
    const { runAllHypersyncDiscoveryScans } = await import("../lib/market/multichain/discovery/hypersync-evm-scan");
    const runs = await runAllHypersyncDiscoveryScans();
    const parts = runs.map((r) =>
      r.error
        ? `${r.chainSlug}: ERR(${r.error.slice(0, 60)})`
        : `${r.chainSlug}: blocks ${r.fromBlock}-${r.toBlock}, +${r.registered} new (${r.candidates} candidates, ${r.skippedNoMetadata} no-metadata, ${r.logsScanned} logs)`
    );
    return parts.join("; ");
  });

  // Historical backfill -- see runHypersyncBackfillScan's own header for
  // why this is a genuinely separate function from discover-hypersync
  // above, not just "run it with different bounds": forward discovery can
  // never reach anything before the moment it first started, so this
  // covers [0, that starting point) instead, genesis-forward, gap-free by
  // construction. Runs on every incremental tick (cheap once a chain
  // reports done: true -- one no-op read per tick after that), not just
  // --full, so real backfill progress accumulates continuously.
  await step("discover-hypersync-backfill", async () => {
    const { runHypersyncBackfillScan } = await import("../lib/market/multichain/discovery/hypersync-evm-scan");
    const { EVM_CHAIN_ID } = await import("../lib/market/multichain/discovery/evm-log-scan");
    const parts: string[] = [];
    for (const chainSlug of Object.keys(EVM_CHAIN_ID)) {
      try {
        const r = await runHypersyncBackfillScan({ chainSlug });
        parts.push(
          r.error
            ? `${chainSlug}: ERR(${r.error.slice(0, 60)})`
            : r.done
              ? `${chainSlug}: DONE (full history covered)`
              : `${chainSlug}: blocks ${r.fromBlock}-${r.toBlock}, +${r.registered} new (${r.candidates} candidates, ${r.skippedNoMetadata} no-metadata, ${r.logsScanned} logs)`
        );
      } catch (error) {
        parts.push(`${chainSlug}: ERR(${(error instanceof Error ? error.message : String(error)).slice(0, 60)})`);
      }
    }
    return parts.join("; ");
  });

  // Exhaustive Bitcoin Ordinals collection discovery -- see
  // unisat-collection-list-scan.ts's own header for why this is the real
  // answer (UniSat's own complete collection registry, ~2,625 real
  // collections total, not the 500M+-event parent-child provenance walk
  // that would otherwise be needed on a chain with no ERC-721-style
  // contract concept). Bounded per tick (maxPages) same as every other
  // discovery step; resumable via its own cursor, reports done: true once
  // the real, reported total has been fully walked.
  await step("discover-bitcoin-collections", async () => {
    const { runUnisatCollectionListScan } = await import("../lib/market/multichain/discovery/unisat-collection-list-scan");
    const r = await runUnisatCollectionListScan({ maxPages: full ? 30 : 10 });
    return r.error
      ? `ERR(${r.error.slice(0, 60)})`
      : `start ${r.start}/${r.total}, ${r.pagesWalked} pages, +${r.registered} new (${r.skippedHiddenOrEmpty} hidden/empty)${r.done ? " — DONE, full catalog walked" : ""}`;
  });

  // Second real Bitcoin Ordinals collection-discovery source, alongside
  // discover-bitcoin-collections above -- see ordiscan-collection-scan.ts's
  // own header for why it's registered under its own "ordiscan-ordinals"
  // adapter rather than merged into UniSat's rows (Ordiscan's slug and
  // UniSat's collectionId are two different indexers' own identity
  // strings for what may or may not be the same real-world collection).
  await step("discover-ordiscan-collections", async () => {
    const { runOrdiscanCollectionScan } = await import("../lib/market/multichain/discovery/ordiscan-collection-scan");
    const r = await runOrdiscanCollectionScan({ maxPages: full ? 30 : 10 });
    return `page ${r.page}, ${r.pagesWalked} pages, +${r.registered} new (${r.skippedEmpty} empty)${r.done ? " — DONE, full catalog walked" : ""}`;
  });

  // Third real Bitcoin Ordinals collection-discovery source, keyless
  // (turbo.ordinalswallet.com needs no API key at all) -- see
  // ordinalswallet-collection-scan.ts's own header for why it registers
  // under its own "ordinalswallet-ordinals" adapter rather than merging
  // into UniSat's or Ordiscan's rows. Its real catalog is far larger
  // (~424k rows, confirmed live) than either of the other two Bitcoin
  // scans because it includes rune-ticker/junk entries; the scan itself
  // filters those out via a real total_supply > 0 check.
  await step("discover-ordinalswallet-collections", async () => {
    const { runOrdinalsWalletCollectionScan } = await import("../lib/market/multichain/discovery/ordinalswallet-collection-scan");
    const r = await runOrdinalsWalletCollectionScan({ maxPages: full ? 30 : 10 });
    return `offset ${r.offset}/${r.total}, ${r.pagesWalked} pages, +${r.registered} new (${r.skippedEmpty} empty)${r.done ? " — DONE, full catalog walked" : ""}`;
  });

  // Exhaustive Solana collection discovery via Helius DAS -- see
  // helius-collection-scan.ts's own header for the real, live-verified
  // scope: covers Metaplex's newer Core standard exhaustively, NOT legacy
  // (V1_NFT) collections, which stay on magiceden-solana.ts's ranked list
  // (no clean collection-identity signal exists for those in a broad
  // search, same class of problem already declined for Bitcoin's raw
  // inscription walk rather than force a fragile heuristic).
  await step("discover-solana-collections", async () => {
    const { runHeliusCollectionScan } = await import("../lib/market/multichain/discovery/helius-collection-scan");
    const r = await runHeliusCollectionScan({ maxPages: full ? 20 : 5 });
    return r.error
      ? `ERR(${r.error.slice(0, 60)})`
      : `${r.pagesWalked} pages, +${r.registered} new${r.done ? " — DONE, full MplCore catalog walked" : ""}`;
  });

  // "Stage B" for the HOME chain itself -- see robinhood-chain-scan.ts's
  // own header for why this can't reuse discover-evm's Alchemy-metadata
  // validation (Robinhood Chain is a private Orbit L3 Alchemy doesn't
  // list). Runs the same conservative CHUNK_BLOCKS window every tick,
  // same cadence as every other discovery step.
  await step("discover-robinhood", async () => {
    const { runRobinhoodChainDiscoveryScan } = await import("../lib/market/multichain/discovery/robinhood-chain-scan");
    const r = await runRobinhoodChainDiscoveryScan();
    return `blocks ${r.fromBlock}-${r.toBlock}, +${r.registered} new (${r.candidatesSeen} candidates, ${r.skippedNotArt} not-art)`;
  });

  // Bulk Robinhood-Chain discovery via OpenSea's own chain-wide
  // /collections?chain=robinhood list -- verified live 2026-08-18 to return
  // real Robinhood-Chain collections OpenSea already indexes, far faster
  // than discover-robinhood's raw eth_getLogs scan (see
  // opensea-robinhood-scan.ts's own header). Runs after the raw scan so
  // both paths' "already tracked" checks see each other's just-registered
  // rows within the same tick.
  await step("discover-robinhood-opensea", async () => {
    const { runOpenSeaRobinhoodDiscoveryScan } = await import(
      "../lib/market/multichain/discovery/opensea-robinhood-scan"
    );
    const r = await runOpenSeaRobinhoodDiscoveryScan();
    if (r.error) return `ERR(${r.error.slice(0, 80)})`;
    return `${r.pagesScanned} pages, ${r.entriesSeen} seen, +${r.registered} new (${r.skippedNotArt} not-art, ${r.skippedNotErc721} not-erc721, ${r.skippedAlreadyTracked} already-tracked)`;
  });

  // Same technique, generalized to the 7 real foreign EVM chains --
  // OpenSea's bulk /collections?chain={slug} list enumerates real contract
  // addresses far faster than discover-evm's 10-block-per-tick scanner
  // (which registered ~300 collections total across 8 chains after 85+
  // ticks this session). See opensea-bulk-scan.ts's own header for why
  // this is safe to use for discovery (not ranking) despite OpenSea's list
  // having no floor/volume fields -- every candidate still gets verified
  // through the SAME alchemyNftAdapter.fetchSnapshot + isNotRealCollectibleArt
  // gate discover-evm already trusts.
  await step("discover-opensea-bulk", async () => {
    const { runAllOpenSeaBulkScans } = await import("../lib/market/multichain/discovery/opensea-bulk-scan");
    const runs = await runAllOpenSeaBulkScans();
    return runs
      .map((r) =>
        r.error
          ? `${r.chainSlug}: ERR(${r.error.slice(0, 60)})`
          : `${r.chainSlug}: ${r.pagesScanned}p, +${r.registered} new (${r.entriesSeen} seen, ${r.skippedNotArt} not-art, ${r.skippedNoMetadata} no-meta, ${r.skippedAlreadyTracked} tracked)`
      )
      .join("; ");
  });

  // Spend authenticated capacity on canonical collection membership before
  // the lower-value activity-derived rarity sample below. Two 100-piece
  // pages per incremental tick yields up to 144,000 newly projected pieces
  // per UTC day at a two-minute cadence while the shared durable 1,800-call
  // gate retains 200 calls of provider headroom. Cursors are per collection;
  // failures never erase earlier pages and the oldest incomplete collection
  // is resumed automatically.
  await step("hydrate-bitcoin-membership", async () => {
    const { advanceNextTrackedBitcoinMembership } = await import("../lib/market/multichain/discovery/unisat-membership-index-runner");
    const attempts = full ? 20 : 2;
    let pages = 0;
    let pieces = 0;
    let completed = 0;
    for (let i = 0; i < attempts; i++) {
      const result = await advanceNextTrackedBitcoinMembership();
      if (!result) break;
      pages += 1;
      pieces += result.itemsObserved;
      if (result.complete) completed += 1;
    }
    return `${pages} membership pages, +${pieces} pieces, ${completed} collection(s) completed`;
  });

  // Helius DAS uses a different identity/membership model from EVM and
  // Bitcoin. Advance bounded 1,000-asset pages on every cron pass using the
  // durable fair selector; this is the live parity lane for Solana traits and
  // rarity, not an EVM adapter disguised behind a shared interface.
  await step("hydrate-solana-membership", async () => {
    const { advanceNextTrackedSolanaMembership } = await import("../lib/market/multichain/discovery/helius-rarity-index-runner");
    const attempts = full ? 10 : 1;
    let pages = 0;
    let pieces = 0;
    let completed = 0;
    for (let i = 0; i < attempts; i++) {
      const result = await advanceNextTrackedSolanaMembership();
      if (!result) break;
      pages += 1;
      pieces += result.tokensIndexed;
      if (result.complete) completed += 1;
    }
    return `${pages} DAS membership pages, +${pieces} pieces, ${completed} collection(s) completed`;
  });

  // Discovery only creates identities. Keep a separate, tightly bounded
  // hydration lane on every incremental tick so newly found EVM contracts
  // acquire names, art, floors and market snapshots instead of remaining
  // invisible hex shells forever. Each chain has its own durable cursor and
  // failures remain isolated by runOpenSeaStatsSync's source breaker.
  await step("hydrate-opensea", async () => {
    const { runOpenSeaStatsSync } = await import("../lib/market/multichain/discovery/opensea-stats");
    const { FOREIGN_CHAINS } = await import("../lib/market/multichain/trading/foreign-chain-registry");
    const runs = [];
    for (const chain of FOREIGN_CHAINS) runs.push(await runOpenSeaStatsSync(chain.chainSlug, 3));
    return runs.map((r) => `${r.chainSlug}: ${r.displayUpdated} display/${r.updated} stats`).join("; ");
  });

  // Self-hosted, on-chain Seaport OrderFulfilled fill index -- see
  // migration 023_seaport_fill_index.sql and lib/market/multichain/
  // seaport-fill-indexer.ts's own headers. Same backfill-and-live-sync-
  // are-the-same-call property as the "events" step above (cursor per
  // chain, forward-only from first run rather than a historical backfill
  // -- documented scope decision, not a gap).
  await step("seaport-fills", async () => {
    const { scanAllChainsForFills } = await import("../lib/market/multichain/seaport-fill-indexer");
    const runs = await scanAllChainsForFills();
    return runs
      .map((r) =>
        r.error
          ? `${r.chainSlug}: ERR(${r.error.slice(0, 60)})`
          : `${r.chainSlug}: ${r.fromBlock}-${r.toBlock} +${r.fillsWritten}/${r.logsScanned}`
      )
      .join("; ");
  });

  // Separate genesis cursor for the same canonical fill ledger. The live
  // cursor above protects freshness; this lane closes the older-history gap
  // continuously without ever moving that live cursor backwards. HyperSync
  // seeks across empty pre-deployment ranges and is capped by matched logs,
  // so chains progress by useful evidence rather than 50k empty blocks/tick.
  await step("seaport-fills-backfill", async () => {
    const { scanChainForFillsGenesisBackfillViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-seaport-scan");
    const { EVM_CHAIN_ID } = await import("../lib/market/multichain/discovery/evm-log-scan");
    const parts: string[] = [];
    for (const chainSlug of Object.keys(EVM_CHAIN_ID)) {
      const result = await scanChainForFillsGenesisBackfillViaHypersync(chainSlug);
      parts.push(result.error
        ? `${chainSlug}: ERR(${result.error.slice(0, 60)})`
        : `${chainSlug}: ${result.fromBlock}-${result.toBlock} +${result.fillsWritten}/${result.logsScanned}`);
    }
    return parts.join("; ");
  });

  // Second real historic marketplace this app indexes directly on-chain --
  // LooksRare v1 TakerAsk/TakerBid, same dual-cursor live/genesis pattern as
  // the Seaport steps above. See hypersync-looksrare-scan.ts's own header
  // for the cited address/event sources and honest v1/eth-mainnet-only scope.
  await step("looksrare-fills", async () => {
    const { scanLooksRareFillsViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-looksrare-scan");
    const { LOOKSRARE_V1_CHAIN_SLUG } = await import("../lib/market/multichain/looksrare-fill-indexer");
    const result = await scanLooksRareFillsViaHypersync(LOOKSRARE_V1_CHAIN_SLUG);
    return result.error
      ? `${result.chainSlug}: ERR(${result.error.slice(0, 60)})`
      : `${result.chainSlug}: ${result.fromBlock}-${result.toBlock} +${result.fillsWritten}/${result.logsScanned}`;
  });

  await step("looksrare-fills-backfill", async () => {
    const { scanLooksRareFillsGenesisBackfillViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-looksrare-scan");
    const { LOOKSRARE_V1_CHAIN_SLUG } = await import("../lib/market/multichain/looksrare-fill-indexer");
    const result = await scanLooksRareFillsGenesisBackfillViaHypersync(LOOKSRARE_V1_CHAIN_SLUG);
    return result.error
      ? `${result.chainSlug}: ERR(${result.error.slice(0, 60)})`
      : `${result.chainSlug}: ${result.fromBlock}-${result.toBlock} +${result.fillsWritten}/${result.logsScanned}`;
  });

  // Third real historic marketplace this app indexes directly on-chain --
  // BlurExchange OrdersMatched (Blend pooled-bid financing deliberately out
  // of scope, see blur-fill-indexer.ts's own header), same dual-cursor
  // live/genesis pattern as the Seaport/LooksRare/Wyvern steps above.
  await step("blur-fills", async () => {
    const { scanBlurFillsViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-blur-scan");
    const { BLUR_CHAIN_SLUG } = await import("../lib/market/multichain/blur-fill-indexer");
    const result = await scanBlurFillsViaHypersync(BLUR_CHAIN_SLUG);
    return result.error
      ? `${result.chainSlug}: ERR(${result.error.slice(0, 60)})`
      : `${result.chainSlug}: ${result.fromBlock}-${result.toBlock} +${result.fillsWritten}/${result.logsScanned}`;
  });

  await step("blur-fills-backfill", async () => {
    const { scanBlurFillsGenesisBackfillViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-blur-scan");
    const { BLUR_CHAIN_SLUG } = await import("../lib/market/multichain/blur-fill-indexer");
    const result = await scanBlurFillsGenesisBackfillViaHypersync(BLUR_CHAIN_SLUG);
    return result.error
      ? `${result.chainSlug}: ERR(${result.error.slice(0, 60)})`
      : `${result.chainSlug}: ${result.fromBlock}-${result.toBlock} +${result.fillsWritten}/${result.logsScanned}`;
  });

  // Fourth real historic marketplace this app indexes directly on-chain --
  // X2Y2 (X2Y2_r1) EvInventory, same dual-cursor live/genesis pattern.
  await step("x2y2-fills", async () => {
    const { scanX2Y2FillsViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-x2y2-scan");
    const { X2Y2_CHAIN_SLUG } = await import("../lib/market/multichain/x2y2-fill-indexer");
    const result = await scanX2Y2FillsViaHypersync(X2Y2_CHAIN_SLUG);
    return result.error
      ? `${result.chainSlug}: ERR(${result.error.slice(0, 60)})`
      : `${result.chainSlug}: ${result.fromBlock}-${result.toBlock} +${result.fillsWritten}/${result.logsScanned}`;
  });

  await step("x2y2-fills-backfill", async () => {
    const { scanX2Y2FillsGenesisBackfillViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-x2y2-scan");
    const { X2Y2_CHAIN_SLUG } = await import("../lib/market/multichain/x2y2-fill-indexer");
    const result = await scanX2Y2FillsGenesisBackfillViaHypersync(X2Y2_CHAIN_SLUG);
    return result.error
      ? `${result.chainSlug}: ERR(${result.error.slice(0, 60)})`
      : `${result.chainSlug}: ${result.fromBlock}-${result.toBlock} +${result.fillsWritten}/${result.logsScanned}`;
  });

  // Fifth real historic marketplace this app indexes directly on-chain --
  // Foundation Market's BuyPriceAccepted/OfferAccepted/ReserveAuctionFinalized,
  // same dual-cursor live/genesis pattern as the steps above. See
  // hypersync-foundation-scan.ts's own header for the cited address/event
  // sources and honest eth-mainnet-only scope.
  await step("foundation-fills", async () => {
    const { scanFoundationFillsViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-foundation-scan");
    const { FOUNDATION_CHAIN_SLUG } = await import("../lib/market/multichain/foundation-fill-indexer");
    const result = await scanFoundationFillsViaHypersync(FOUNDATION_CHAIN_SLUG);
    return result.error
      ? `${result.chainSlug}: ERR(${result.error.slice(0, 60)})`
      : `${result.chainSlug}: ${result.fromBlock}-${result.toBlock} +${result.fillsWritten}/${result.logsScanned}`;
  });

  await step("foundation-fills-backfill", async () => {
    const { scanFoundationFillsGenesisBackfillViaHypersync } = await import("../lib/market/multichain/discovery/hypersync-foundation-scan");
    const { FOUNDATION_CHAIN_SLUG } = await import("../lib/market/multichain/foundation-fill-indexer");
    const result = await scanFoundationFillsGenesisBackfillViaHypersync(FOUNDATION_CHAIN_SLUG);
    return result.error
      ? `${result.chainSlug}: ERR(${result.error.slice(0, 60)})`
      : `${result.chainSlug}: ${result.fromBlock}-${result.toBlock} +${result.fillsWritten}/${result.logsScanned}`;
  });

  // The reverse-engineered ranking source: Magic Eden's Reservoir-powered
  // v4 EVM API (the one real candidate for a free cross-EVM ranking
  // endpoint) has been confirmed live 2026-08-17, multiple retests, as
  // "503 no healthy upstream" -- a genuine outage, not a missing feature.
  // Rather than block on it, this reads back what discover-evm's per-tick
  // scans have been accumulating into plank_multichain_activity_stats
  // (migration 015) all along: our OWN observed top-by-transfer-volume
  // ranking, built for free from data already collected. Runs last so it
  // benefits from this tick's own discover-evm activity write.
  await step("own-ranking", async () => {
    const { runAllOwnRankingPromotions } = await import("../lib/market/multichain/discovery/evm-log-scan");
    const runs = await runAllOwnRankingPromotions();
    const parts = runs.map((r) =>
      r.error
        ? `${r.chainSlug}: ERR(${r.error.slice(0, 60)})`
        : `${r.chainSlug}: ${r.ranked} ranked, +${r.registered} new (${r.skippedNoMetadata} no-metadata)`
    );
    return parts.join("; ");
  });

  // Brings any collection own-ranking just registered (or any collection
  // that's aged past its freshness window) up to full rarity/trait parity
  // -- the "Marketplank feel" (tier badges, floors-by-rarity, trait
  // filters, criteria bids) is otherwise stuck at zero for a collection
  // until someone manually runs scripts/index-foreign-rarity.ts for it.
  // Runs last so it benefits from this tick's own own-ranking promotions.
  await step("scaffold-rarity", async () => {
    const { scaffoldAllTrackedCollections } = await import("../lib/market/multichain/rarity-index-runner");
    const result = await scaffoldAllTrackedCollections({
      onProgress: (line) => console.log(`[refresh:scaffold-rarity] ${line}`),
    });
    return `${result.evmInScope} EVM tracked -> ${result.indexed} indexed, ${result.skippedFresh} fresh, ${result.failed} failed; ${result.solanaSkipped} Solana routed to scaffold-rarity-solana below`;
  });

  // Solana's own real trait/rarity scaffold -- see
  // helius-rarity-index-runner.ts's own header for why this is a
  // DIFFERENT, real capability from the "Solana has no clean grouping
  // signal" limitation documented for broad DISCOVERY (helius-collection-
  // scan.ts): once a collection's address is already known (every row
  // scaffold-rarity's own solanaSkipped count above represents), Helius's
  // real grouping filter cleanly enumerates its real member NFTs with
  // real trait attributes, regardless of legacy/pNFT vs. MplCore standard.
  await step("scaffold-rarity-solana", async () => {
    const { scaffoldAllTrackedSolanaCollections } = await import("../lib/market/multichain/discovery/helius-rarity-index-runner");
    const result = await scaffoldAllTrackedSolanaCollections({
      onProgress: (line) => console.log(`[refresh:scaffold-rarity-solana] ${line}`),
    });
    return `${result.totalTracked} Solana tracked -> ${result.indexed} indexed, ${result.skippedFresh} fresh, ${result.failed} failed`;
  });

  // Bitcoin's own real trait/rarity scaffold -- see unisat-rarity-index-
  // runner.ts's own header for the real source (UniSat's marketplace
  // activity log, not a collection enumeration) and why it's ALWAYS
  // partial coverage by construction, never a bug to chase to 100%.
  await step("scaffold-rarity-bitcoin", async () => {
    const { scaffoldAllTrackedBitcoinCollections } = await import("../lib/market/multichain/discovery/unisat-rarity-index-runner");
    const result = await scaffoldAllTrackedBitcoinCollections({
      onProgress: (line) => console.log(`[refresh:scaffold-rarity-bitcoin] ${line}`),
    });
    return `${result.totalTracked} Bitcoin tracked -> ${result.indexed} indexed (partial coverage), ${result.skippedFresh} fresh, ${result.failed} failed`;
  });

  // Ordinals Wallet's own real trait/rarity scaffold -- see
  // ordinalswallet-rarity-index-runner.ts's own header: UNLIKE
  // scaffold-rarity-bitcoin above (a marketplace activity log, always
  // partial by construction), this source is a real collection
  // enumeration -- a single call returns every real inscription in the
  // collection with real traits, so `partial` here reflects an honest
  // count comparison against the collection's own stated total_supply,
  // not an always-true flag.
  await step("scaffold-rarity-ordinalswallet", async () => {
    const { scaffoldAllTrackedOrdinalsWalletCollections } = await import("../lib/market/multichain/discovery/ordinalswallet-rarity-index-runner");
    const result = await scaffoldAllTrackedOrdinalsWalletCollections({
      onProgress: (line) => console.log(`[refresh:scaffold-rarity-ordinalswallet] ${line}`),
    });
    return `${result.totalTracked} OrdinalsWallet tracked -> ${result.indexed} indexed, ${result.skippedFresh} fresh, ${result.failed} failed`;
  });

  // Real 24h volume/sales for every EVM chain, from this app's own
  // first-party plank_seaport_fills index -- see
  // updateEvmVolumeFromSeaportFills's own header (store.ts) for why this
  // was a real, present, unused data asset before 2026-08-20. Covers
  // Robinhood Chain's own community collections too, which have zero
  // OpenSea presence and so had zero other possible source of this data.
  await step("evm-fill-stats", async () => {
    const { updateEvmVolumeFromSeaportFills } = await import("../lib/market/multichain/store");
    const { FOREIGN_CHAINS } = await import("../lib/market/multichain/trading/foreign-chain-registry");
    const { ROBINHOOD_CHAIN_SLUG } = await import("../lib/market/multichain/trading/non-evm-chains");
    const chains = [ROBINHOOD_CHAIN_SLUG, ...FOREIGN_CHAINS.map((c) => c.chainSlug)];
    let totalUpdated = 0;
    for (const chainSlug of chains) {
      const r = await updateEvmVolumeFromSeaportFills(chainSlug);
      totalUpdated += r.updated;
    }
    return `${totalUpdated} collection(s) updated across ${chains.length} EVM chains from real observed fills`;
  });

  await step("cryptopunks-native-book", async () => {
    const { syncCryptoPunksNativeBook } = await import("../lib/market/multichain/native-market-adapters/cryptopunks");
    const result = await syncCryptoPunksNativeBook();
    return `${result.listed} contract listings (${result.publicListed} public); floor ${result.floorWei ?? "none"}`;
  });

  // RobinWood's native Marketplank floor is built from executable orders,
  // not inferred from purchases. Record it every refresh so the API can
  // produce a real 24h comparison once both endpoints exist.
  await step("robinwood-floor-observation", async () => {
    const { NFT_CONTRACT_ADDRESS } = await import("../lib/mint-contract");
    const { getListings } = await import("../lib/market/orders-store");
    const { recordFloorObservation, upsertTrackedCollection } = await import("../lib/market/multichain/store");
    const bySlug = await getListings("robinwood").catch(() => []);
    const byContract = await getListings(NFT_CONTRACT_ADDRESS.toLowerCase()).catch(() => []);
    const listings = bySlug.length >= byContract.length ? bySlug : byContract;
    let floor = listings.reduce<bigint | null>((minimum, listing) => {
      try {
        const price = BigInt(listing.priceWei);
        return minimum == null || price < minimum ? price : minimum;
      } catch {
        return minimum;
      }
    }, null);
    let listedCount = listings.length;
    let source = "native-executable-order-book";
    // A local/dev worker can legitimately have an empty local order store
    // while the canonical deployment owns the live signed book. Observe the
    // same canonical book the public projection uses, otherwise local refresh
    // runs register the collection but still never create a price endpoint.
    if (floor == null) {
      const { fetchCanonicalRobinwoodStats } = await import("../lib/market/canonical-robinwood");
      const canonical = await fetchCanonicalRobinwoodStats({ hostHeader: null });
      if (canonical?.floorPriceWei) {
        floor = BigInt(canonical.floorPriceWei);
        listedCount = canonical.listedCount;
        source = "canonical-native-executable-order-book";
      }
    }
    // RobinWood is projected into the public index as its native home row,
    // rather than discovered by a third-party adapter. Floor observations
    // resolve their FK by (chain, contract), so the native collection must
    // still be registered in the same durable collection table first. Before
    // this invariant was enforced the INSERT ... SELECT matched zero rows and
    // every scheduled observation was silently discarded.
    await upsertTrackedCollection({
      chainSlug: "robinhood",
      chainId: 4663,
      contractAddress: NFT_CONTRACT_ADDRESS,
      adapter: "robinhood-native",
      isVaultBacked: true,
    });
    await recordFloorObservation("robinhood", NFT_CONTRACT_ADDRESS, {
      priceAtomic: floor?.toString() ?? null,
      currency: "ETH",
      marketplace: "marketplank",
      listedCount,
      source,
    });
    return floor == null ? "no executable native floor" : `${listedCount} listings; floor ${floor}`;
  });

  // Real 24h volume/sales/floor-change for Solana and Bitcoin Ordinals,
  // via CoinGecko's free public NFT API -- see coingecko-nft-stats.ts's
  // own header for the live-verified source and the exact-slug-only
  // matching discipline. Two separate steps (not one) so a failure on one
  // chain never blocks the other, same isolation every other per-chain
  // step in this file already has.
  await step("coingecko-solana-stats", async () => {
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    const r = await runCoinGeckoNftStats("solana-mainnet", full ? 100 : 20);
    return `${r.candidates} tracked -> ${r.matched} real CoinGecko matches -> ${r.updated} updated, ${r.errors} errors`;
  });
  await step("coingecko-bitcoin-stats", async () => {
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    const r = await runCoinGeckoNftStats("bitcoin-mainnet", full ? 100 : 20);
    return `${r.candidates} tracked -> ${r.matched} real CoinGecko matches -> ${r.updated} updated, ${r.errors} errors`;
  });
  // BNB OpenSea list slugs 404 /stats (pancake-squad zeros). Exact-contract CG is the liquid book.
  await step("coingecko-bnb-stats", async () => {
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    const r = await runCoinGeckoNftStats("bnb-mainnet", full ? 80 : 15);
    return `${r.candidates} tracked -> ${r.matched} real CoinGecko matches -> ${r.updated} updated, ${r.errors} errors`;
  });
  await step("coingecko-avax-stats", async () => {
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    const r = await runCoinGeckoNftStats("avax-mainnet", full ? 80 : 15);
    return `${r.candidates} tracked -> ${r.matched} real CoinGecko matches -> ${r.updated} updated, ${r.errors} errors`;
  });
  await step("coingecko-eth-stats", async () => {
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    const r = await runCoinGeckoNftStats("eth-mainnet", full ? 40 : 10);
    return `${r.candidates} tracked -> ${r.matched} real CoinGecko matches -> ${r.updated} updated, ${r.errors} errors`;
  });
  await step("coingecko-polygon-stats", async () => {
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    const r = await runCoinGeckoNftStats("polygon-mainnet", full ? 40 : 10);
    return `${r.candidates} tracked -> ${r.matched} real CoinGecko matches -> ${r.updated} updated, ${r.errors} errors`;
  });
  await step("coingecko-base-stats", async () => {
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    const r = await runCoinGeckoNftStats("base-mainnet", full ? 30 : 8);
    return `${r.candidates} tracked -> ${r.matched} real CoinGecko matches -> ${r.updated} updated, ${r.errors} errors`;
  });
  await step("coingecko-arb-stats", async () => {
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    const r = await runCoinGeckoNftStats("arb-mainnet", full ? 30 : 8);
    return `${r.candidates} tracked -> ${r.matched} real CoinGecko matches -> ${r.updated} updated, ${r.errors} errors`;
  });
  await step("coingecko-opt-stats", async () => {
    const { runCoinGeckoNftStats } = await import("../lib/market/multichain/discovery/coingecko-nft-stats");
    const r = await runCoinGeckoNftStats("opt-mainnet", full ? 30 : 8);
    return `${r.candidates} tracked -> ${r.matched} real CoinGecko matches -> ${r.updated} updated, ${r.errors} errors`;
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0 && failed.length === results.length) {
    throw new Error(`all ${results.length} target(s) failed`);
  }
  if (failed.length > 0) {
    console.warn(`[refresh] ${failed.length}/${results.length} target(s) failed`);
  }
}

main()
  .then(async () => {
    // Release the pg pool so cron doesn't hang on an open connection.
    try {
      const { hasPostgresConfig, postgresPool } = await import("../lib/postgres");
      if (hasPostgresConfig()) await postgresPool().end();
    } catch {
      /* pool was never opened */
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("[refresh] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
