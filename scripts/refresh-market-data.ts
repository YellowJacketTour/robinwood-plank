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
 *
 * Targets: --sales --vault --rarity --traits --collection
 * Exits non-zero only if every requested target failed, so a single flaky
 * upstream doesn't turn a cron run into a red alert.
 */

const args = new Set(process.argv.slice(2));
const full = args.has("--full");
const explicit = [
  "--sales",
  "--vault",
  "--rarity",
  "--traits",
  "--collection",
  "--opensea",
].filter((t) => args.has(t));

/** Full runs include the expensive collection-wide rebuilds; incremental ones don't. */
const targets = new Set(
  explicit.length > 0
    ? explicit.map((t) => t.slice(2))
    : full
      ? ["sales", "vault", "opensea", "rarity", "traits", "collection"]
      : ["sales", "vault", "opensea"]
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
    const { refreshOpenSeaStats, probeOpenSeaListingShape, OPENSEA_COLLECTION_SLUG } =
      await import("../lib/market/opensea");
    const stats = await refreshOpenSeaStats();
    for (const line of await probeOpenSeaListingShape(OPENSEA_COLLECTION_SLUG)) {
      console.log(`[refresh]   ${line}`);
    }
    if (!stats) return "no stats (no key yet, or OpenSea unreachable)";
    return `volume=${stats.volume ?? "?"} sales=${stats.sales ?? "?"} floor=${stats.floorPrice ?? "?"}`;
  });

  await step("rarity", async () => {
    const { getRaritySnapshot } = await import("../lib/market/rarity-snapshot");
    const snapshot = await getRaritySnapshot();
    // Cold builds are capped (MAX_BACKFILL), so a first run can leave tokens
    // unscored. Say so rather than reporting a clean success.
    const gap = snapshot.sampleSize - snapshot.scoredCount;
    return gap > 0
      ? `${snapshot.scoredCount}/${snapshot.sampleSize} scored — ${gap} still unscored, re-run to fill`
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
