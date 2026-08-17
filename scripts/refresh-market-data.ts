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
].filter((t) => args.has(t));

/** Full runs include the expensive collection-wide rebuilds; incremental ones don't. */
const targets = new Set(
  explicit.length > 0
    ? explicit.map((t) => t.slice(2))
    : full
      ? ["events", "sales", "vault", "portfolio", "opensea", "pulp", "official-assets", "token-registry", "owners", "metadata", "rarity", "traits", "collection", "multichain", "discover-evm"]
      : ["events", "sales", "vault", "portfolio", "opensea", "pulp", "official-assets", "token-registry", "owners", "multichain", "discover-evm"]
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
    const { runChainIndexer } = await import("../lib/market/chain-indexer");
    const run = await runChainIndexer();
    const parts = run.sources.map((s) => {
      const range = s.toBlock >= s.fromBlock ? `${s.fromBlock}-${s.toBlock}` : "nothing due";
      return (
        `${s.source}:${s.contract.slice(0, 10)} ${range} ` +
        `+${s.rowsInserted}/${s.logsScanned}${s.error ? ` ERR(${s.error.slice(0, 60)})` : ""}`
      );
    });
    return (
      `head=${run.head} confirmed=${run.confirmedHead} ` +
      `+${run.rowsInserted} new rows, caughtUp=${run.caughtUp} — ${parts.join("; ")}`
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
