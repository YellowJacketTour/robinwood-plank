/**
 * Season 2 $PLANK King of the Hill — live buy watcher.
 *
 * Robinhood Chain has no HyperSync coverage (only a handful of major chains
 * do — see lib/market/multichain/discovery/rpc-provider-pool.ts), so this
 * uses Blockscout's own REST API (lib/market/blockscout.ts, already used
 * elsewhere in this app) rather than the HyperSync-based scan patterns used
 * for other chains.
 *
 * FINALITY GATE (fraud doc section 5): Robinhood Chain's own documentation
 * describes real soft (<1s) vs hard (~13min, L1-anchored) finality, and
 * explicitly warns not to treat a soft confirmation as settlement. Rather
 * than a stateful "pending" queue, this watcher simply never processes a
 * transfer whose own block timestamp is younger than FINALITY_DELAY_MS —
 * it stays unprocessed (cursor does not advance past it) and gets picked up
 * on a later pass once it's actually old enough. A rare L2 reorg before
 * that point means the transfer simply never gets processed at all, which
 * is the correct, safe failure direction (never promote an unconfirmed
 * buy), not an incorrect one.
 */
import { fetchAddressTokenTransfers } from "@/lib/market/blockscout";
import { CANONICAL_PLANK_POOLS, isCanonicalPlankPool } from "@/lib/market/plank-pools";
import { evaluatePlankKothCandidate } from "@/lib/market/plank-koth-candidate";
import { readCursor, writeCursor } from "@/lib/market/multichain/discovery/evm-log-scan";
import { CONTRACT_ADDRESS as PLANK_CONTRACT } from "@/lib/constants";

/** ~13 real documented minutes plus a safety margin -- see this file's own
 * header. Never hard-code a shorter window; a false-early promotion is the
 * one failure mode real value is riding on here. */
const FINALITY_DELAY_MS = 16 * 60 * 1000;

const CURSOR_KEY = "plank-koth-watch:last-processed-block";

/** Bounded so a first-run (or catch-up-after-downtime) historical backlog
 * can't make a single watch pass run unboundedly long -- each candidate
 * costs several real Blockscout API calls (evaluatePlankKothCandidate's own
 * fraud-gate pipeline, including the funding-source check). `done: false`
 * below when this cap is hit means mesh-lane's exit-code-2 self-requeue
 * (see mesh-lane.ts's own dispatch) picks the remainder back up on the very
 * next pass rather than waiting for the lane's normal cadence. */
// Measured live 2026-08-25 against real Blockscout latency (including its
// own real flakiness -- see bsGetRetried's header): 5 candidates/pass took
// up to 128s, well past mesh-lane.ts's 90s LANE_TIMEOUT_MS, which would get
// this SIGKILLed mid-work in production. 2/pass measured comfortably under
// that ceiling even with a retry or two; the exit-code-2 self-requeue
// means a real backlog still drains steadily across passes, just via more
// of them rather than fewer larger ones.
const MAX_CANDIDATES_PER_PASS = 2;

export type PlankKothWatchResult = { scanned: number; evaluated: number; done: boolean };

export async function runPlankKothWatch(): Promise<PlankKothWatchResult> {
  const lastProcessedBlock = (await readCursor(CURSOR_KEY)) ?? 0;

  // Per-pool, not token-wide: Blockscout's own /api/v2/tokens/{addr}/
  // transfers returns a real, confirmed HTTP 500 for $PLANK specifically
  // (verified live via direct curl) -- see fetchAddressTokenTransfers's own
  // header. Polling each of the three canonical pools' own address-scoped
  // transfers instead works fine and is strictly more precise anyway (only
  // real canonical-pool activity, never a token-wide firehose). Newest-
  // first, per Blockscout's own convention -- one page per pool is enough
  // real headroom for a single-token contest's realistic buy frequency.
  // Real bug found live 2026-08-25: even the address-scoped endpoint 500s
  // for at least one of the three canonical pools (the USDG pair) -- an
  // Unpromise.all would let one bad pool's upstream failure kill the whole
  // pass, silently missing real buys on the other two pools every time it
  // happens. Each pool is independent real signal; a failure on one must
  // never block processing the others.
  const transfers = (
    await Promise.all(
      CANONICAL_PLANK_POOLS.map((pool) =>
        fetchAddressTokenTransfers(pool.address, PLANK_CONTRACT, { maxPages: 2 }).catch((error) => {
          console.error(
            `[plank-koth-watch] pool ${pool.address} (${pool.counterSymbol}) transfer fetch failed`,
            error instanceof Error ? error.message : error
          );
          return [];
        })
      )
    )
  ).flat();

  const now = Date.now();
  const candidates = new Map<string, number>(); // txHash -> blockNumber
  let sawUnfinalized = false;

  for (const t of transfers) {
    const from = t.from?.hash;
    const blockNumber = t.block_number;
    const txHash = t.transaction_hash;
    if (!from || !isCanonicalPlankPool(from) || blockNumber == null || !txHash) continue;
    if (blockNumber <= lastProcessedBlock) continue;

    const tsMs = t.timestamp ? Date.parse(t.timestamp) : NaN;
    if (Number.isNaN(tsMs) || now - tsMs < FINALITY_DELAY_MS) {
      sawUnfinalized = true;
      continue;
    }
    candidates.set(txHash, blockNumber);
  }

  // Oldest-block-first, capped -- see MAX_CANDIDATES_PER_PASS's own header.
  const ordered = [...candidates.entries()].sort((a, b) => a[1] - b[1]);
  const toProcess = ordered.slice(0, MAX_CANDIDATES_PER_PASS);
  const capped = ordered.length > toProcess.length;

  let evaluated = 0;
  let highestProcessedBlock = lastProcessedBlock;
  for (const [txHash, blockNumber] of toProcess) {
    await evaluatePlankKothCandidate(txHash).catch((error) => {
      console.error(`[plank-koth-watch] evaluate ${txHash} failed`, error instanceof Error ? error.message : error);
    });
    evaluated += 1;
    if (blockNumber > highestProcessedBlock) highestProcessedBlock = blockNumber;
  }

  // Block timestamps are monotonic with block number, so every processed
  // block here is safely older than every not-yet-final or not-yet-
  // processed one -- the cursor can always advance up through
  // highestProcessedBlock; anything left uncapped/unfinalized simply stays
  // above the new cursor for a later pass.
  if (highestProcessedBlock > lastProcessedBlock) {
    await writeCursor(CURSOR_KEY, highestProcessedBlock);
  }

  return { scanned: transfers.length, evaluated, done: !sawUnfinalized && !capped };
}
