/**
 * Re-read historical blocks and correct what the ledger already stored.
 *
 * WHY THIS EXISTS
 * ---------------
 * The indexer's normal write path is `ON CONFLICT DO NOTHING`, which makes a
 * cron tick safely re-runnable — and makes a mistake permanent. Two real
 * failure modes need a way back:
 *
 *   1. A DECODER GAP that has since been fixed. Collection-bid fills put the
 *      NFT in the order's consideration and the money in its offer; the old
 *      decoder only ever looked at the offer, so those sales stored with a null
 *      price. Re-running the cron could never repair them.
 *   2. A TRANSIENT RPC FAILURE. The receipt fetch that recovers a sale price is
 *      best-effort by design (better unpriced than guessed), so a 429 during
 *      backfill silently froze a row as an unpriced sale forever.
 *
 * Usage:
 *   npm run market:reindex                  # every block range with a suspect row
 *   npm run market:reindex -- --from=A --to=B
 *   npm run market:reindex -- --dry-run     # report the ranges, touch nothing
 *
 * Only DERIVED columns (kind, price_wei, venue) can change — see
 * repairChainEvents in lib/market/chain-events.ts.
 */

import { hasChainEventStore, unpricedSaleBlockRanges } from "../lib/market/chain-events";
import { reindexNftRange } from "../lib/market/chain-indexer";

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function numericFlag(name: string): number | null {
  const raw = flag(name);
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

async function main(): Promise<void> {
  if (!hasChainEventStore()) {
    throw new Error(
      "reindex-chain-events requires PostgreSQL (PGHOST/PGDATABASE/PGUSER/PGPASSWORD)."
    );
  }
  const dryRun = process.argv.includes("--dry-run");
  const from = numericFlag("from");
  const to = numericFlag("to");

  // An explicit range wins; otherwise aim at exactly the windows that hold a
  // row we already know is suspect, rather than re-walking all of history.
  const ranges =
    from != null && to != null
      ? [{ fromBlock: from, toBlock: to }]
      : await unpricedSaleBlockRanges();

  if (ranges.length === 0) {
    console.log("[reindex] nothing to do — no unpriced sales in the ledger");
    return;
  }

  const spanned = ranges.reduce((sum, r) => sum + (r.toBlock - r.fromBlock + 1), 0);
  console.log(`[reindex] ${ranges.length} range(s), ${spanned} blocks`);
  for (const range of ranges) console.log(`  ${range.fromBlock}-${range.toBlock}`);
  if (dryRun) {
    console.log("[reindex] --dry-run, stopping before any write");
    return;
  }

  let inserted = 0;
  let repaired = 0;
  let scanned = 0;
  for (const range of ranges) {
    try {
      const result = await reindexNftRange(range);
      inserted += result.rowsInserted;
      repaired += result.rowsRepaired;
      scanned += result.logsScanned;
      console.log(
        `[reindex] ${range.fromBlock}-${range.toBlock}: ${result.logsScanned} logs, ` +
          `+${result.rowsInserted} new, ~${result.rowsRepaired} repaired ` +
          `(${result.windows} window(s))`
      );
    } catch (error) {
      // Keep going: one failed range must not abandon the rest, and a range
      // that fails is simply left as it was for the next run.
      console.error(
        `[reindex] ${range.fromBlock}-${range.toBlock} FAILED —`,
        error instanceof Error ? error.message : error
      );
    }
  }
  console.log(`[reindex] done: ${scanned} logs, +${inserted} new rows, ~${repaired} repaired`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[reindex] fatal —", error instanceof Error ? error.message : error);
    process.exit(1);
  });
