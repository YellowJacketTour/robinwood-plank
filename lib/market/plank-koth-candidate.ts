/**
 * Season 2 $PLANK King of the Hill — the fraud-gate pipeline that decides
 * what is allowed to become a candidate fed into plank-koth.ts's
 * offerPlankKothCandidate (itself a thin wrapper around the UNMODIFIED
 * lib/market/king-of-the-hill-rules.ts engine).
 *
 * Full design/citations: docs/marketplank/GROK-FINDINGS-plank-koth-fraud-
 * detection-2026-08-25.md. Pipeline shape (that doc's own synthesized
 * recommendation):
 *
 *   raw candidate intake (canonical pool only)
 *     -> group transfers by tx hash, split by true final recipient
 *     -> reject if recipient can't be resolved (fail closed)
 *     -> reject if same-tx round-trip / flash-loan shape detected
 *     -> flag (review queue, never auto-disqualify) on Bad Boards history
 *        or a funding-source link to a recent seller
 *     -> only promote to CONFIRMED once the block is old enough to be
 *        past Robinhood Chain's own documented ~13min soft->hard finality
 *        window (see watcher's own cursor-lag design)
 *     -> CONFIRMED candidates get a permanent plank_koth_leaderboard row
 *        and are offered to offerPlankKothCandidate
 */
import { fetchTxTokenTransfers, fetchAddressTransactions, type BlockscoutTxTokenTransfer } from "@/lib/market/blockscout";
import { isCanonicalPlankPool, CANONICAL_PLANK_POOLS } from "@/lib/market/plank-pools";
import { classifyWallet, getBadSeverity } from "@/lib/boards-store";
import { getWalletSignals } from "@/lib/market/wallet-signals";
import { getEthUsdPrice, weiToUsd } from "@/lib/eth-price";
import { postgresQuery } from "@/lib/postgres";
import { offerPlankKothCandidate, type PlankKothSale } from "@/lib/market/plank-koth";
import { CONTRACT_ADDRESS as PLANK_CONTRACT } from "@/lib/constants";
import { fetchReceiptRpc, fetchTransactionRpc, canonicalPoolAddressesLower } from "@/lib/market/plank-koth-rpc-scan";
import { decodeErc20TransfersForTokens, computeNetBalances, classifyNetBuyCandidates, type NetBuyCandidate } from "@/lib/market/plank-koth-net-classify";

/** USDG is a stablecoin; treated as $1.00 for value purposes. Real oracle
 * integration would be a nice-to-have, not a launch blocker — a peg
 * deviation here would only ever slightly mis-rank a USDG-denominated buy
 * against an ETH-denominated one, never fabricate a buy that didn't happen. */
const USDG_USD = 1;

export type CandidateOutcome =
  | { status: "confirmed"; sale: PlankKothSale }
  | { status: "flagged"; reason: string }
  | { status: "rejected"; reason: string }
  | { status: "not_a_buy" };

export function isPlankTransfer(t: BlockscoutTxTokenTransfer): boolean {
  const addr = t.token?.address_hash ?? t.token?.address;
  return !!addr && addr.toLowerCase() === PLANK_CONTRACT.toLowerCase() && t.type !== "ERC-721" && t.type !== "ERC-1155";
}

/** address(lowercased) -> counterSymbol, derived once from the pool
 * allowlist itself -- never hand-duplicated, so a pool added there is
 * automatically a recognized quote asset here too. */
function quoteTokenSymbolMap(): Map<string, "WETH" | "USDG"> {
  const map = new Map<string, "WETH" | "USDG">();
  for (const pool of CANONICAL_PLANK_POOLS) map.set(pool.counterToken.toLowerCase(), pool.counterSymbol);
  return map;
}

/**
 * Real design change, 2026-08-26 (external Grok research review, see
 * plank-koth-net-classify.ts's own header): reads NET ERC-20 balance
 * deltas across the whole transaction instead of matching individual
 * transfer legs directly to/from the recipient. A router that receives
 * PLANK/WETH and immediately forwards it nets to ~0 for the router --
 * this holds regardless of how many router/aggregator hops the real
 * payment or the token actually took, closing both the "no value paid
 * found" bug (tx 0x42c96c03...02249a3) and the round-trip false positive
 * (tx 0x0716472e...4e74ab) confirmed live against real production buys
 * this session, without needing a soleRecipient special case at all.
 */
function resolveValuePaidFromNet(candidate: NetBuyCandidate, ethUsd: number): { ethPaidWei: bigint; usdValue: number } {
  const symbolByToken = quoteTokenSymbolMap();
  let ethPaidWei = 0n;
  let usdValue = 0;
  for (const [tokenAddress, amount] of candidate.quoteSpent) {
    const symbol = symbolByToken.get(tokenAddress);
    if (symbol === "WETH") {
      ethPaidWei += amount;
      usdValue += weiToUsd(amount, ethUsd);
    } else if (symbol === "USDG") {
      // USDG is 6 decimals (see GROK findings / uniswap-tokenlist.ts).
      usdValue += Number(amount) / 1_000_000 * USDG_USD;
    }
  }
  return { ethPaidWei, usdValue };
}

/**
 * Real 2-hop funding-source check (fraud doc section 3, Chainalysis's
 * documented heuristic): did the recipient's own funding wallet (or that
 * wallet's own funder) recently sell $PLANK into a canonical pool? A hit is
 * a FLAG, not an auto-reject (this is a probabilistic signal, not proof —
 * see the doc's own "what you don't get" on this section).
 */
/** Bounded tightly on purpose: this runs once per new leaderboard-relevant
 * candidate (fraud doc's own "Rate strategy" discipline for this exact
 * check), but each unbounded step here is a real Blockscout API call, and
 * the very first watch pass against a token with real trading history can
 * see many qualifying candidates in one page -- an unbounded 5-funders x
 * 20-txs-each fan-out (up to 100 calls per candidate) was measured live to
 * make a single watch pass take minutes and risk hammering Blockscout's
 * public API. Two hops, ONE funder (the most recent, most likely to be a
 * fresh/coordinated wallet), FIVE of their recent txs -- still the real,
 * documented Chainalysis 2-hop shape, just scoped to what's actually cheap
 * enough to run inline on every candidate. */
const FUNDING_CHECK_RECENT_TXS = 5;

async function checkFundingSourceLink(recipient: string): Promise<string | null> {
  try {
    const txs = await fetchAddressTransactions(recipient, { maxPages: 1 });
    const firstFunder = txs.find((t) => t.to?.hash?.toLowerCase() === recipient)?.from?.hash?.toLowerCase();
    if (!firstFunder) return null;

    const funderTxs = await fetchAddressTransactions(firstFunder, { maxPages: 1 });
    for (const tx of funderTxs.slice(0, FUNDING_CHECK_RECENT_TXS)) {
      if (!tx.hash) continue;
      const legs = await fetchTxTokenTransfers(tx.hash);
      const soldPlank = legs.some(
        (l) => isPlankTransfer(l) && l.from?.hash?.toLowerCase() === firstFunder && l.to?.hash && isCanonicalPlankPool(l.to.hash)
      );
      if (soldPlank) return `funding wallet ${firstFunder} sold $PLANK into a canonical pool in tx ${tx.hash}`;
    }
    return null;
  } catch {
    // Best-effort signal only -- a failed lookup must never block a real,
    // otherwise-clean candidate. Absence of a flag here is not proof of
    // innocence, just "this check couldn't run."
    return null;
  }
}

async function writeReviewQueue(input: {
  txHash: string;
  wallet: string | null;
  ethPaidWei: string | null;
  plankAmount: string | null;
  blockNumber: number | null;
  reason: string;
  evidence: Record<string, unknown>;
}): Promise<void> {
  // Real bug found live 2026-08-26: ON CONFLICT DO NOTHING meant a tx
  // re-evaluated under later-fixed classification logic never updated its
  // stored reason -- confirmed live, a transaction correctly resolving a
  // recipient/value-paid under the RPC-rewrite still showed its old,
  // pre-fix "no value paid"/"round-trip" reason from months earlier,
  // making the queue's own "reason" column lie about current reality.
  // Refresh on conflict, but ONLY while still 'pending' -- never overwrite
  // a row a human has already resolved (approved/rejected).
  await postgresQuery(
    `INSERT INTO plank_koth_review_queue (tx_hash, wallet, eth_paid_wei, plank_amount, block_number, reason, evidence)
     VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7::jsonb)
     ON CONFLICT (tx_hash) DO UPDATE SET
       wallet = COALESCE(EXCLUDED.wallet, plank_koth_review_queue.wallet),
       eth_paid_wei = COALESCE(EXCLUDED.eth_paid_wei, plank_koth_review_queue.eth_paid_wei),
       plank_amount = COALESCE(EXCLUDED.plank_amount, plank_koth_review_queue.plank_amount),
       block_number = COALESCE(EXCLUDED.block_number, plank_koth_review_queue.block_number),
       reason = EXCLUDED.reason,
       evidence = EXCLUDED.evidence
     WHERE plank_koth_review_queue.status = 'pending'`,
    [input.txHash, input.wallet, input.ethPaidWei, input.plankAmount, input.blockNumber, input.reason, JSON.stringify(input.evidence)]
  );
  // Unified intelligence layer v1 (docs/marketplank/GROK-FINDINGS-unified-
  // intelligence-layer-2026-08-25.md) -- same real observation, mirrored
  // into the shared wallet_signals ledger so a wallet flagged here is
  // visible to Bad Boards and any future feature, not just this queue.
  if (input.wallet) {
    const { recordWalletSignal } = await import("@/lib/market/wallet-signals");
    await recordWalletSignal({
      wallet: input.wallet,
      chainSlug: "robinhood",
      source: "plank_koth_review",
      severity: 0.5,
      reason: input.reason,
      evidence: input.evidence,
      txHash: input.txHash,
    });
  }
}

async function writeLeaderboardRow(sale: PlankKothSale): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_koth_leaderboard (tx_hash, wallet, eth_paid_wei, plank_amount, usd_value_at_buy, block_number)
     VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6)
     ON CONFLICT (tx_hash) DO NOTHING`,
    [sale.txHash, sale.wallet, sale.ethPaidWei, sale.plankAmount, sale.usdValueAtBuy, sale.blockNumber]
  );
}

/**
 * Evaluate one real, already-finality-safe transaction hash (the watcher —
 * plank-koth-watch.ts — is responsible for only calling this once the block
 * is old enough per Robinhood Chain's documented finality window; this
 * function does not itself re-check finality).
 *
 * Real rewrite, 2026-08-26 (external Grok research review): candidate
 * intake and net-balance classification now read the transaction's real
 * RPC receipt directly (fetchReceiptRpc, rpcCall's own THROW-on-failure
 * contract underneath -- see plank-koth-rpc-scan.ts's own header) instead
 * of Blockscout's tx-token-transfers walk. A failed receipt fetch now
 * THROWS out of this function -- it is the caller's job (the watcher) to
 * treat that as "unknown, try again," never silently as "not a buy." Only
 * the reputation/funding checks below (classifyWallet, checkFundingSourceLink)
 * still read Blockscout -- lower-severity, best-effort signals already
 * designed to fail open (an unavailable check just means "no signal," never
 * blocks an otherwise-clean candidate), unlike the primary detection path
 * this rewrite closes.
 */
export async function evaluatePlankKothCandidate(txHash: string): Promise<CandidateOutcome> {
  const receipt = await fetchReceiptRpc(txHash);
  if (!receipt || receipt.status !== "0x1") return { status: "not_a_buy" };
  const blockNumber = Number.parseInt(receipt.blockNumber, 16);

  const quoteTokenAddresses = [...new Set(CANONICAL_PLANK_POOLS.map((p) => p.counterToken.toLowerCase()))];
  const relevantTokens = new Set([PLANK_CONTRACT.toLowerCase(), ...quoteTokenAddresses]);
  const decoded = decodeErc20TransfersForTokens(receipt.logs, relevantTokens);
  if (!decoded.some((t) => t.tokenAddress === PLANK_CONTRACT.toLowerCase() && isCanonicalPlankPool(t.from))) {
    return { status: "not_a_buy" };
  }

  // Real gap found live 2026-08-26 (confirmed against real production tx
  // 0x0716472e...4e74ab): a "swap ETH for tokens" buy pays via the
  // transaction's own native `value` field, wrapped into WETH by the
  // router internally -- the buyer's own wallet never appears as `from`
  // on any ERC-20 WETH Transfer log at all. Fold the tx's real native
  // value in as a synthetic WETH-equivalent transfer (buyer -> tx.to)
  // BEFORE net-balance computation, so the same uniform netting logic
  // handles a native-ETH-funded buy exactly like an already-wrapped-WETH
  // one -- see plank-koth-rpc-scan.ts's fetchTransactionRpc for the full
  // real evidence this closes.
  const wethPool = CANONICAL_PLANK_POOLS.find((p) => p.counterSymbol === "WETH");
  if (wethPool) {
    const tx = await fetchTransactionRpc(txHash);
    const nativeValue = BigInt(tx.value ?? "0x0");
    if (nativeValue > 0n && tx.from && tx.to) {
      decoded.push({ tokenAddress: wethPool.counterToken.toLowerCase(), from: tx.from.toLowerCase(), to: tx.to.toLowerCase(), value: nativeValue });
    }
  }

  const net = computeNetBalances(decoded);
  const excluded = new Set([...canonicalPoolAddressesLower(), PLANK_CONTRACT.toLowerCase(), ...quoteTokenAddresses]);
  const candidates = classifyNetBuyCandidates(net, PLANK_CONTRACT, quoteTokenAddresses, excluded);
  if (candidates.length === 0) {
    await writeReviewQueue({
      txHash,
      wallet: null,
      ethPaidWei: null,
      plankAmount: null,
      blockNumber,
      reason: "no wallet nets positive PLANK and negative quote-asset in this tx (router/relayer held tokens with no clear net buyer)",
      evidence: { logs: receipt.logs },
    });
    return { status: "rejected", reason: "unresolvable recipient" };
  }

  const { usd: ethUsd } = await getEthUsdPrice();
  // Multiple distinct net buyers = a real batched multi-user router tx
  // (fraud doc section 2) -- evaluate and, if warranted, offer EACH as its
  // own independent candidate, never summed into one giant "buy".
  let anyConfirmed: PlankKothSale | null = null;
  for (const candidate of candidates) {
    const recipient = candidate.wallet;
    const plankAmount = candidate.plankAmount;
    if (candidate.hasRoundTripShape) {
      await writeReviewQueue({
        txHash,
        wallet: recipient,
        ethPaidWei: null,
        plankAmount: plankAmount.toString(),
        blockNumber,
        reason: "same-tx round-trip shape: this wallet also nets positive in a quote asset in this same tx",
        evidence: { logs: receipt.logs },
      });
      continue;
    }

    const { ethPaidWei, usdValue } = resolveValuePaidFromNet(candidate, ethUsd);
    if (usdValue <= 0) {
      await writeReviewQueue({
        txHash,
        wallet: recipient,
        ethPaidWei: ethPaidWei.toString(),
        plankAmount: plankAmount.toString(),
        blockNumber,
        reason: "no real value-paid leg resolved for this recipient (possible airdrop/transfer misidentified as a buy)",
        evidence: { logs: receipt.logs },
      });
      continue;
    }

    const [board, severity, fundingFlag, priorSignals] = await Promise.all([
      classifyWallet(recipient),
      getBadSeverity(recipient),
      checkFundingSourceLink(recipient),
      getWalletSignals(recipient, "robinhood", 10).catch(() => []),
    ]);
    // Unified intelligence layer v1 -- consume, not just produce: a wallet
    // some OTHER feature entirely flagged (Bad Boards, a future feature) is
    // real prior signal this check would otherwise never see, since
    // classifyWallet/getBadSeverity only know about Bad Boards' own
    // launch-window marks.
    //
    // Real bug found live 2026-08-26: this used to include signals with
    // source "plank_koth_review" -- i.e. THIS SAME PIPELINE'S OWN past
    // writeReviewQueue calls. Confirmed live: a wallet flagged once under
    // an OLD, since-fixed classification bug (e.g. the router-mediated-
    // payment bug fixed earlier tonight) got permanently re-flagged on
    // every future evaluation forever, with the reason text nesting
    // recursively ("prior signal from plank_koth_review: prior signal
    // from plank_koth_review: ...: no value paid resolved") -- the
    // pipeline was treating its own past, now-known-wrong conclusion as
    // independent corroborating evidence for the same decision. A
    // self-sourced signal is not independent evidence; only a signal from
    // a genuinely different feature counts here.
    const priorHighSeverity = priorSignals.find((s) => s.severity >= 0.5 && s.source !== "plank_koth_review");

    const sale: PlankKothSale = {
      txHash,
      tokenId: null,
      wallet: recipient,
      // Ranking key -- see plank-koth.ts's header on why this is USD
      // micros, not raw ETH-wei. Math.round is safe here: usdValue is a
      // real dollar amount well within Number precision for any buy size
      // this contest will plausibly see.
      priceWei: Math.round(usdValue * 1_000_000).toString(),
      ethPaidWei: ethPaidWei.toString(),
      plankAmount: plankAmount.toString(),
      usdValueAtBuy: usdValue,
      blockNumber,
    };

    if ((board.side === "bad_boards" || board.side === "fallen") && severity > 0.3) {
      await writeReviewQueue({
        txHash,
        wallet: recipient,
        ethPaidWei: ethPaidWei.toString(),
        plankAmount: plankAmount.toString(),
        blockNumber,
        reason: `wallet has real Bad Boards history (side=${board.side}, severity=${severity.toFixed(2)}) -- ${board.badEntry?.reason ?? "reason not recorded"}`,
        evidence: { badEntry: board.badEntry },
      });
      continue;
    }
    if (priorHighSeverity) {
      await writeReviewQueue({
        txHash,
        wallet: recipient,
        ethPaidWei: ethPaidWei.toString(),
        plankAmount: plankAmount.toString(),
        blockNumber,
        reason: `wallet has a real prior high-severity signal from ${priorHighSeverity.source} (${priorHighSeverity.createdAt}): ${priorHighSeverity.reason}`,
        evidence: { priorSignal: priorHighSeverity },
      });
      continue;
    }
    if (fundingFlag) {
      await writeReviewQueue({
        txHash,
        wallet: recipient,
        ethPaidWei: ethPaidWei.toString(),
        plankAmount: plankAmount.toString(),
        blockNumber,
        reason: fundingFlag,
        evidence: { logs: receipt.logs },
      });
      continue;
    }

    await writeLeaderboardRow(sale);
    await offerPlankKothCandidate(sale);
    anyConfirmed = sale;
  }

  return anyConfirmed ? { status: "confirmed", sale: anyConfirmed } : { status: "flagged", reason: "all recipients flagged for review" };
}
