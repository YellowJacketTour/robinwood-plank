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
 *   tsx scripts/refresh-market-data.ts --metadata # build/resume the canonical IPFS metadata store
 *   tsx scripts/refresh-market-data.ts --purge --rarity --traits --collection
 *
 * Targets: --sales --vault --rarity --traits --collection --metadata --social-decay
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
  "--metadata",
  "--rarity",
  "--traits",
  "--collection",
  "--opensea",
  "--official-assets",
  "--token-registry",
  "--owners",
  "--social-decay",
].filter((t) => args.has(t));

/** Full runs include the expensive collection-wide rebuilds; incremental ones don't.
 * "social-decay" runs in BOTH — it's cheap (a bounded query plus per-wallet
 * writes only for wallets that already have a Bad Boards mark) and, like
 * lp_hold accrual, wants to tick as often as the incremental cadence allows
 * so a real day of good behavior is never delayed behind the daily --full
 * run. */
const targets = new Set(
  explicit.length > 0
    ? explicit.map((t) => t.slice(2))
    : full
      ? ["sales", "vault", "opensea", "official-assets", "token-registry", "owners", "metadata", "rarity", "traits", "collection", "social-decay"]
      : ["sales", "vault", "opensea", "official-assets", "token-registry", "owners", "social-decay"]
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

  // Bad Boards reputation-decay tick (lib/boards.ts's nextGoodStreakDays /
  // decayedBadSeverity, lib/boards-store.ts's recordGoodBehavior). This is
  // the exact gap the PR #21 pen-test flagged: recordGoodBehavior's own doc
  // comment always said it should run "once per wallet per day it shows
  // good behavior", but nothing ever called it — there was no cron. Wiring
  // it naively off widgetSessions (a quote OR swap ping, see
  // recordWidgetActivity) would have made the FIRST wrong choice the
  // pen-test also called out: a free quote (no real trade, no cost, no
  // revenge risk for spamming it) is not "good behavior" and must not fade
  // a real Bad Boards mark. A wallet could quote plank.love once a day
  // forever and launder a sniper/off-widget flag for free.
  //
  // Instead this gates strictly on plank_checks_events rows with
  // category='swap' — a REAL, chain-verified swap that already passed
  // lib/plank-checks.ts's swapPoints() fee-paid accounting, not a
  // self-reported or quote-only signal. Scoped to a lookback window
  // (slightly wider than the incremental cron cadence, so a slow cron pass
  // or a brief outage cannot skip a wallet's day) and further restricted to
  // wallets that already carry a Bad Boards mark — recordGoodBehavior is a
  // no-op for a clean wallet anyway, but filtering here keeps this query
  // (and the run) cheap regardless of total swap volume.
  await step("social-decay", async () => {
    const { postgresQuery } = await import("../lib/postgres");
    const { recordGoodBehavior, listAllBadBoards } = await import("../lib/boards-store");

    const badWallets = new Set(
      (await listAllBadBoards()).map((entry) => entry.address.toLowerCase())
    );
    if (badWallets.size === 0) return "no Bad Boards wallets to decay";

    // Lookback window, not "since last run" — recordGoodBehavior itself is
    // idempotent per UTC calendar day (nextGoodStreakDays no-ops a second
    // tick on the same day), so re-processing the same wallet across
    // overlapping windows is always safe.
    const LOOKBACK_HOURS = 26;
    const result = await postgresQuery<{ wallet_address: string }>(
      `SELECT DISTINCT wallet_address
         FROM plank_checks_events
        WHERE category = 'swap'
          AND earned_at >= NOW() - INTERVAL '${LOOKBACK_HOURS} hours'`
    );

    const swappedToday = result.rows
      .map((row) => row.wallet_address.toLowerCase())
      .filter((wallet) => badWallets.has(wallet));

    let ticked = 0;
    for (const wallet of swappedToday) {
      const updated = await recordGoodBehavior(wallet);
      if (updated) ticked += 1;
    }
    return `${ticked}/${swappedToday.length} Bad Boards wallet(s) ticked (real swap in last ${LOOKBACK_HOURS}h, out of ${badWallets.size} flagged)`;
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
