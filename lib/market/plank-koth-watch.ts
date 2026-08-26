/**
 * Season 2 $PLANK King of the Hill — live buy watcher.
 *
 * Real rewrite, 2026-08-26 (external Grok research review,
 * docs/marketplank/GROK-ONESHOT-plank-koth-total-coverage-2026-08-26.md):
 * candidate discovery now reads $PLANK's own Transfer logs directly from
 * this chain's RPC (plank-koth-rpc-scan.ts, built on rpc-provider-pool.ts's
 * throw-on-failure contract) instead of Blockscout's per-pool REST
 * pagination. Real, live-confirmed problem this closes: Blockscout REST is
 * one third-party dependency with no redundancy, we directly reproduced
 * real HTTP 500s from it, and its own fetch wrappers swallowed failures
 * into empty results -- making "genuinely no new buys" and "our one data
 * source failed" indistinguishable. A failed RPC scan now THROWS out of
 * this function instead of silently reporting zero candidates as fact.
 *
 * Robinhood Chain has no HyperSync coverage (only a handful of major
 * chains do — see rpc-provider-pool.ts's own header), but this contest's
 * real activity volume (one token, three pools, ~31 days) is small enough
 * that plain chunked eth_getLogs against the chain's own RPC is genuinely
 * sufficient -- see plank-koth-rpc-scan.ts's own header.
 *
 * FINALITY GATE (fraud doc section 5): Robinhood Chain's own documentation
 * describes real soft (<1s) vs hard (~13min, L1-anchored) finality, and
 * explicitly warns not to treat a soft confirmation as settlement. Rather
 * than a stateful "pending" queue, this watcher simply never processes a
 * transfer whose own block is younger than the finality window — it stays
 * unprocessed (cursor does not advance past it) and gets picked up on a
 * later pass once it's actually old enough.
 *
 * Real bug found live 2026-08-26, moments after this rewrite first
 * deployed: an initial hardcoded "2 blocks/second" assumption (meant to be
 * a generous, conservative guess) turned out to be ~5x SLOWER than this
 * chain's real measured rate (~9.9 blocks/sec, computed from two real,
 * confirmed (block, timestamp) pairs from production transfers earlier
 * this same session) -- silently shrinking the intended 16-minute finality
 * margin down to roughly 3 minutes, the exact failure direction ("false-
 * early promotion") this whole gate exists to prevent. Never hardcode a
 * rate again: measure the chain's REAL, currently-observed block rate
 * fresh on every single pass from two real block timestamps, so this
 * self-corrects if the chain's real block time ever changes.
 */
import { scanForCandidates, fetchBlockTimestampRpc } from "@/lib/market/plank-koth-rpc-scan";
import { evaluatePlankKothCandidate } from "@/lib/market/plank-koth-candidate";
import { startJobRun, heartbeatJobRun, finishJobRun, upsertEvalResult } from "@/lib/market/contest-job-observability";

const FINALITY_DELAY_MS = 16 * 60 * 1000;

/**
 * Real, live-measured finality boundary: fetches the real timestamp of two
 * blocks from THIS pass's own scanned range and derives the chain's actual
 * current block rate from them, then converts the real 16-minute delay
 * into a block-count margin from that measured rate -- never a hardcoded
 * guess. Falls back to the most conservative real answer (every candidate
 * in this pass is treated as NOT yet finalized) if the chain's own block
 * timestamps ever come back non-monotonic or otherwise untrustworthy,
 * since understating the margin is the one failure mode that matters.
 */
async function computeFinalityBoundaryBlock(fromBlock: number, headBlock: number): Promise<number> {
  if (headBlock <= fromBlock) return -1; // no real range to measure from; nothing is safe to finalize yet
  const [fromTs, headTs] = await Promise.all([fetchBlockTimestampRpc(fromBlock), fetchBlockTimestampRpc(headBlock)]);
  const blockDelta = headBlock - fromBlock;
  const secondsDelta = headTs - fromTs;
  if (secondsDelta <= 0) return -1; // non-monotonic timestamps -- distrust entirely, fail safe
  const realBlocksPerSecond = blockDelta / secondsDelta;
  const finalityDelayBlocks = Math.ceil((FINALITY_DELAY_MS / 1000) * realBlocksPerSecond);
  return headBlock - finalityDelayBlocks;
}

/** Bounded so a first-run (or catch-up-after-downtime) historical backlog
 * can't make a single watch pass run unboundedly long -- each candidate
 * costs several real Blockscout API calls inside evaluatePlankKothCandidate's
 * own fraud-gate pipeline (funding-source/reputation checks only -- primary
 * detection is RPC-native now). `done: false` below when this cap is hit
 * means mesh-lane's exit-code-2 self-requeue picks the remainder back up
 * on the very next pass rather than waiting for the lane's normal cadence. */
const MAX_CANDIDATES_PER_PASS = 5;

export type PlankKothWatchResult = { scanned: number; evaluated: number; done: boolean };

export async function runPlankKothWatch(): Promise<PlankKothWatchResult> {
  const runId = await startJobRun("plank_koth_watch");
  try {
    const scan = await scanForCandidates();
    await heartbeatJobRun(runId, { cursorBlock: scan.toBlock, headBlock: scan.headBlock });

    // Real, block-native finality gate -- a candidate whose own block isn't
    // yet old enough simply isn't processed this pass; it naturally gets
    // picked up on a later pass once the scan's own toBlock has moved past
    // the finality margin (the RPC scan's cursor already only advances
    // through blocks it successfully scanned, so this is purely about
    // WHICH already-discovered candidates are safe to evaluate now).
    const finalityBoundary = await computeFinalityBoundaryBlock(scan.fromBlock, scan.headBlock);
    const finalized = scan.candidates.filter((c) => c.blockNumber <= finalityBoundary);
    const sawUnfinalized = finalized.length < scan.candidates.length;

    const ordered = [...finalized].sort((a, b) => a.blockNumber - b.blockNumber);
    const toProcess = ordered.slice(0, MAX_CANDIDATES_PER_PASS);
    const capped = ordered.length > toProcess.length;

    let evaluated = 0;
    for (const candidate of toProcess) {
      await upsertEvalResult({ txHash: candidate.txHash, status: "pending_source", source: "plank-koth-rpc-scan" });
      let bucket: "ok" | "hold" | "reject" | "error";
      try {
        const outcome = await evaluatePlankKothCandidate(candidate.txHash);
        evaluated += 1;
        if (outcome.status === "confirmed") {
          bucket = "ok";
          await upsertEvalResult({ txHash: candidate.txHash, status: "confirmed", source: "plank-koth-rpc-scan" });
        } else if (outcome.status === "flagged") {
          bucket = "hold";
          await upsertEvalResult({ txHash: candidate.txHash, status: "hold", source: "plank-koth-rpc-scan", reason: outcome.reason });
        } else if (outcome.status === "rejected") {
          bucket = "reject";
          await upsertEvalResult({ txHash: candidate.txHash, status: "reject", source: "plank-koth-rpc-scan", reason: outcome.reason });
        } else {
          bucket = "reject";
          await upsertEvalResult({ txHash: candidate.txHash, status: "reject", source: "plank-koth-rpc-scan", reason: "not_a_buy" });
        }
      } catch (error) {
        // Real, deliberate distinction (see this file's own header): a
        // failed evaluation is a SOURCE ERROR, never silently folded into
        // "rejected"/"not a buy" -- this candidate stays eligible for
        // re-evaluation on a later pass (it is not marked resolved here).
        bucket = "error";
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[plank-koth-watch] evaluate ${candidate.txHash} failed`, message);
        await upsertEvalResult({ txHash: candidate.txHash, status: "source_error", source: "plank-koth-rpc-scan", reason: message });
      }
      await heartbeatJobRun(runId, {
        currentItem: candidate.txHash,
        doneItemsDelta: 1,
        tally: { [bucket]: 1 },
      });
    }

    await finishJobRun(runId, "ok");
    return { scanned: scan.candidates.length, evaluated, done: !sawUnfinalized && !capped && scan.done };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJobRun(runId, "failed", message).catch(() => {});
    throw error;
  }
}
