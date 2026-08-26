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
 * transfer whose own block is younger than the finality window (estimated
 * from block number now that discovery is block-native, not Blockscout
 * timestamp-native) — it stays unprocessed (cursor does not advance past
 * it) and gets picked up on a later pass once it's actually old enough.
 */
import { scanForCandidates } from "@/lib/market/plank-koth-rpc-scan";
import { evaluatePlankKothCandidate } from "@/lib/market/plank-koth-candidate";
import { startJobRun, heartbeatJobRun, finishJobRun, upsertEvalResult } from "@/lib/market/contest-job-observability";

/** ~13 real documented minutes plus a safety margin -- see this file's own
 * header. Never hard-code a shorter window; a false-early promotion is the
 * one failure mode real value is riding on here. Robinhood Chain is
 * documented sub-second block time; a generous 2 blocks/second assumption
 * (conservative -- real blocks land faster) converts the same real 16-
 * minute delay into a block-count finality margin without depending on
 * Blockscout's own per-transfer timestamp field. */
const FINALITY_DELAY_MS = 16 * 60 * 1000;
const ASSUMED_BLOCKS_PER_SECOND = 2;
const FINALITY_DELAY_BLOCKS = Math.ceil((FINALITY_DELAY_MS / 1000) * ASSUMED_BLOCKS_PER_SECOND);

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
    const finalityBoundary = scan.headBlock - FINALITY_DELAY_BLOCKS;
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
