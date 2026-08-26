/**
 * TEMPORARY, one-shot: directly evaluates ONE specific real transaction
 * hash against production, bypassing the normal discovery-scan + cursor
 * flow entirely. Used live 2026-08-26 to confirm a real, very recent
 * ($2,036, tx 0x2476f15a...21b2f) buy onto the leaderboard immediately
 * rather than waiting for the RPC scanner's own backfill (currently
 * walking forward from a real cursor reset) to reach its block naturally.
 *
 * Usage: PLANK_EVAL_TX_HASH=0x... npx tsx --env-file=... \
 *   scripts/evaluate-plank-koth-tx.ts
 */
import { evaluatePlankKothCandidate } from "../lib/market/plank-koth-candidate";

async function main(): Promise<void> {
  const txHash = process.env.PLANK_EVAL_TX_HASH;
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error("evaluate-plank-koth-tx: set PLANK_EVAL_TX_HASH to a real 32-byte tx hash");
  }
  const outcome = await evaluatePlankKothCandidate(txHash);
  console.log(`[evaluate-tx] ${txHash} ->`, JSON.stringify(outcome));
}

main()
  .then(() => process.exitCode = 0)
  .catch((error) => {
    console.error("[evaluate-plank-koth-tx] fatal", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
