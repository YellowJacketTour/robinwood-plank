/**
 * TEMPORARY, one-shot: resets the RPC scanner's own durable cursor
 * (plank-koth-rpc-scan.ts's "plank-koth-rpc-scan:last-scanned-block")
 * back to a real block near Season 2's actual launch time.
 *
 * Real gap found live 2026-08-26: the RPC-based rewrite's own scan cursor
 * started fresh on its first-ever run (this deploy, ~19:08 UTC) from
 * `headBlock - DEFAULT_CHUNK_BLOCKS` (20,000 blocks back, ~33 real
 * minutes at this chain's measured ~9.9 blocks/sec) -- never backfilling
 * from the real contest launch (13:08 UTC, ~6 hours earlier). Confirmed
 * live: real buys over $600/$1,000 the owner saw on DexScreener were
 * NEVER discovered by either the old Blockscout-based watcher or this
 * new RPC-based one -- the largest amount anywhere in the entire
 * plank_koth_review_queue backlog was ~$0.50. Resetting the cursor lets
 * the live cron naturally walk forward through the whole missed window
 * on its normal 2-minute cadence (each pass covers up to 20,000 blocks,
 * so the ~6-hour gap needs roughly 15 passes / ~30 minutes to fully
 * catch up) instead of a separate one-off backfill script.
 *
 * Usage: PLANK_RPC_CURSOR_RESET_BLOCK=46600000 npx tsx --env-file=... \
 *   scripts/reset-plank-koth-rpc-cursor.ts
 */
import { readCursor, writeCursor } from "../lib/market/plank-koth-cursor";

const CURSOR_KEY = "plank-koth-rpc-scan:last-scanned-block";

async function main(): Promise<void> {
  const resetBlock = Number(process.env.PLANK_RPC_CURSOR_RESET_BLOCK);
  if (!Number.isFinite(resetBlock) || resetBlock <= 0) {
    throw new Error("reset-plank-koth-rpc-cursor: set PLANK_RPC_CURSOR_RESET_BLOCK to a real, positive block number");
  }
  const before = await readCursor(CURSOR_KEY);
  console.log(`[reset-cursor] current cursor: ${before}`);
  if (before != null && resetBlock >= before) {
    throw new Error(`reset-plank-koth-rpc-cursor: refusing to move the cursor FORWARD (${before} -> ${resetBlock}) -- this script only backfills`);
  }
  await writeCursor(CURSOR_KEY, resetBlock);
  console.log(`[reset-cursor] cursor reset: ${before} -> ${resetBlock}`);
}

main()
  .then(() => process.exitCode = 0)
  .catch((error) => {
    console.error("[reset-plank-koth-rpc-cursor] fatal", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
