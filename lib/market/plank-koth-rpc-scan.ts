/**
 * Season 2 $PLANK KOTH -- direct on-chain candidate discovery + receipt
 * fetch, replacing Blockscout REST as the PRIMARY data source.
 *
 * Real, live-confirmed problem this closes (external Grok research review,
 * docs/marketplank/GROK-ONESHOT-plank-koth-total-coverage-2026-08-26.md):
 * Blockscout REST is one third-party dependency with no redundancy, we
 * directly reproduced real HTTP 500s from it, and every one of our own
 * fetch wrappers around it swallowed failures into an empty result --
 * making "genuinely no buy happened" and "our one data source failed"
 * indistinguishable everywhere downstream. Confirmed live: a transaction
 * independently proven to contain a real qualifying buy was misread as
 * not_a_buy when evaluated from production, at multiple retry/concurrency
 * settings, while succeeding instantly from an unrelated network origin.
 *
 * rpc-provider-pool.ts's own rpcCall already has the right contract for
 * this: it THROWS when every provider fails, it never silently returns an
 * empty/null result. Building directly on it (rather than another
 * catch-and-swallow wrapper) makes "the data source failed" and "there is
 * genuinely nothing there" impossible to confuse by construction -- a
 * thrown error propagates to the caller, which must explicitly decide what
 * "I don't know yet" means (see runPlankKothWatch: a failed scan pass
 * advances nothing and reports the failure via contest-job-observability,
 * it never reports zero real candidates as if that were a confirmed fact).
 *
 * Robinhood Chain is not covered by the HyperSync-class indexer this app
 * uses for other chains (see rpc-provider-pool.ts's own header) -- but
 * this contest's real activity volume (one token, three pools, ~31 days)
 * is small enough that plain chunked eth_getLogs against the chain's own
 * RPC is genuinely sufficient; there is no need to wait on broader indexer
 * coverage for a workload this size.
 */
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";
import { readCursor, writeCursor } from "@/lib/market/plank-koth-cursor";
import { ERC20_TRANSFER_TOPIC } from "@/lib/market/plank-koth-net-classify";
import { CANONICAL_PLANK_POOLS, isCanonicalPlankPool } from "@/lib/market/plank-pools";
import { CONTRACT_ADDRESS as PLANK_CONTRACT } from "@/lib/constants";

const CHAIN_SLUG = "robinhood";

/** Real per-call range cap -- this L2 is documented sub-second block times
 * (far denser than a typical L1 in wall-clock terms), so a wide range risks
 * a huge/slow response even at modest real activity; shrinking further on
 * an explicit error keeps a single bad range from failing an entire pass. */
const DEFAULT_CHUNK_BLOCKS = 20_000;
const MIN_CHUNK_BLOCKS = 500;

const CURSOR_KEY = "plank-koth-rpc-scan:last-scanned-block";

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string };

/**
 * Real canary, per Grok's own recommendation: an `eth_getLogs` empty
 * result is only trustworthy once the chain itself is independently proven
 * live (a fresh `eth_blockNumber` genuinely advancing) -- a stalled/broken
 * RPC endpoint returning a frozen or garbage head must never be read as
 * "the chain has no activity." Throws (never silently returns a fabricated
 * "healthy") if the two checks are inconsistent enough to distrust.
 */
export async function assertChainLive(previousHeadBlock: number | null): Promise<number> {
  const { result: headHex } = await rpcCall<string>(CHAIN_SLUG, "eth_blockNumber", []);
  const head = Number.parseInt(headHex, 16);
  if (!Number.isFinite(head) || head <= 0) {
    throw new Error(`plank-koth-rpc-scan: canary failed, eth_blockNumber returned a non-real value (${headHex})`);
  }
  if (previousHeadBlock != null && head < previousHeadBlock) {
    // A real, healthy chain's head never regresses between two of our own
    // calls (no reorg is long enough to un-produce blocks below a prior
    // observed head) -- this is a broken/misrouted RPC endpoint, not a
    // real chain state, and must never be treated as "caught up."
    throw new Error(`plank-koth-rpc-scan: canary failed, head block regressed (${previousHeadBlock} -> ${head})`);
  }
  return head;
}

export type RpcCandidate = { txHash: string; blockNumber: number };

export type RpcScanResult = {
  fromBlock: number;
  toBlock: number;
  headBlock: number;
  candidates: RpcCandidate[];
  done: boolean;
};

/**
 * Scans PLANK's own Transfer logs (not the pools' full transfer history --
 * this app IS the token, so filtering on the token's own address is
 * strictly more precise and is the same real primitive Grok's own review
 * recommended as the safety-net filter) for transfers FROM a canonical
 * pool, i.e. a real buy leaving the pool to a wallet. Only ever advances
 * the durable cursor after a real, successful eth_getLogs call for that
 * exact range -- a thrown rpcCall failure propagates straight out, cursor
 * untouched, so a caller can never mistake "this pass failed" for "there
 * was nothing here."
 */
export async function scanForCandidates(): Promise<RpcScanResult> {
  const previousCursor = await readCursor(CURSOR_KEY);
  const headBlock = await assertChainLive(null);
  const fromBlock = previousCursor == null ? headBlock - DEFAULT_CHUNK_BLOCKS : previousCursor + 1;
  if (fromBlock > headBlock) {
    return { fromBlock, toBlock: headBlock, headBlock, candidates: [], done: true };
  }

  let chunk = DEFAULT_CHUNK_BLOCKS;
  let toBlock = Math.min(headBlock, fromBlock + chunk - 1);
  let logs: RawLog[] | null = null;
  let lastError: unknown = null;
  // Real range-shrink-on-failure, same discipline as this app's other real
  // RPC log scanners (evm-log-scan.ts) -- an oversized range failing is a
  // transient shape problem, not proof the range has no real data.
  while (chunk >= MIN_CHUNK_BLOCKS) {
    toBlock = Math.min(headBlock, fromBlock + chunk - 1);
    try {
      const { result } = await rpcCall<RawLog[]>(CHAIN_SLUG, "eth_getLogs", [
        {
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + toBlock.toString(16),
          address: PLANK_CONTRACT,
          topics: [ERC20_TRANSFER_TOPIC],
        },
      ]);
      logs = result;
      break;
    } catch (error) {
      lastError = error;
      chunk = Math.floor(chunk / 2);
    }
  }
  if (logs === null) {
    throw lastError instanceof Error ? lastError : new Error(`plank-koth-rpc-scan: eth_getLogs failed: ${String(lastError)}`);
  }

  const candidates: RpcCandidate[] = [];
  for (const log of logs) {
    if (log.topics.length !== 3 || !log.topics[1]) continue;
    const from = "0x" + log.topics[1].slice(-40).toLowerCase();
    if (!isCanonicalPlankPool(from)) continue;
    candidates.push({ txHash: log.transactionHash, blockNumber: Number.parseInt(log.blockNumber, 16) });
  }

  await writeCursor(CURSOR_KEY, toBlock);
  return { fromBlock, toBlock, headBlock, candidates, done: toBlock >= headBlock };
}

export type RawReceipt = { status: string; blockNumber: string; logs: RawLog[] };

/** Real, direct receipt fetch -- throws on failure (rpcCall's own
 * contract), never returns a fabricated empty receipt. */
export async function fetchReceiptRpc(txHash: string): Promise<RawReceipt> {
  const { result } = await rpcCall<RawReceipt>(CHAIN_SLUG, "eth_getTransactionReceipt", [txHash]);
  return result;
}

export type RawTx = { from: string; to: string | null; value: string };

/**
 * Real gap found live 2026-08-26 (confirmed against real production tx
 * 0x0716472e...4e74ab via a direct eth_getTransactionByHash call): a real
 * "swap ETH for tokens" buy pays via the transaction's own native `value`
 * field, wrapped into WETH by the router internally -- the buyer's own
 * wallet NEVER appears as the `from` on any ERC-20 WETH Transfer log at
 * all. Net-balance classification over Transfer logs alone would silently
 * miss this real payment leg entirely (the exact same "no value paid"
 * failure shape this whole rewrite exists to close, just via a different
 * mechanism than the router-forwarding case). Fetch the transaction
 * itself so its native `value` can be folded in as a synthetic quote-asset
 * transfer alongside the real ERC-20 legs (see evaluatePlankKothCandidate).
 */
export async function fetchTransactionRpc(txHash: string): Promise<RawTx> {
  const { result } = await rpcCall<RawTx>(CHAIN_SLUG, "eth_getTransactionByHash", [txHash]);
  return result;
}

/** Every canonical pool address, lowercased, for excluding pool-owned net
 * deltas from buyer classification (see plank-koth-net-classify.ts). */
export function canonicalPoolAddressesLower(): string[] {
  return CANONICAL_PLANK_POOLS.map((p) => p.address.toLowerCase());
}
