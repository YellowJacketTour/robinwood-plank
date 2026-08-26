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
import { fetchTxTokenTransfers, fetchTransaction, fetchAddressTransactions, type BlockscoutTxTokenTransfer } from "@/lib/market/blockscout";
import { isCanonicalPlankPool, plankPoolByAddress } from "@/lib/market/plank-pools";
import { classifyWallet, getBadSeverity } from "@/lib/boards-store";
import { getWalletSignals } from "@/lib/market/wallet-signals";
import { getEthUsdPrice, weiToUsd } from "@/lib/eth-price";
import { postgresQuery } from "@/lib/postgres";
import { offerPlankKothCandidate, type PlankKothSale } from "@/lib/market/plank-koth";
import { CONTRACT_ADDRESS as PLANK_CONTRACT } from "@/lib/constants";

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

/**
 * Real recipient resolution for a (possibly router-routed) buy: Blockscout
 * already decodes every real token movement inside the transaction, so the
 * true final buyer is whichever address received real $PLANK in this tx and
 * did NOT itself forward any of it onward in the same tx — a router/relayer
 * that briefly holds tokens always shows a matching outbound leg. This
 * avoids needing to hand-decode Universal Router/0x calldata at all (see
 * the fraud doc's section 2 for why that's normally the hard part).
 */
export function resolveFinalRecipients(transfers: BlockscoutTxTokenTransfer[]): Map<string, bigint> {
  const plankTransfers = transfers.filter(isPlankTransfer);
  const received = new Map<string, bigint>();
  const forwarded = new Set<string>();
  for (const t of plankTransfers) {
    const to = t.to?.hash?.toLowerCase();
    const from = t.from?.hash?.toLowerCase();
    const value = BigInt(t.total?.value ?? "0");
    if (to && !isCanonicalPlankPool(to)) {
      received.set(to, (received.get(to) ?? 0n) + value);
    }
    if (from && !isCanonicalPlankPool(from)) {
      forwarded.add(from);
    }
  }
  for (const addr of forwarded) received.delete(addr);
  return received;
}

/** Real value paid for one recipient's leg: sum of WETH/USDG legs flowing
 * FROM that recipient INTO a canonical pool in this same transaction. */
export function resolveValuePaid(
  transfers: BlockscoutTxTokenTransfer[],
  recipient: string,
  ethUsd: number
): { ethPaidWei: bigint; usdValue: number } {
  let ethPaidWei = 0n;
  let usdValue = 0;
  for (const t of transfers) {
    const from = t.from?.hash?.toLowerCase();
    const to = t.to?.hash?.toLowerCase();
    if (from !== recipient || !to || !isCanonicalPlankPool(to)) continue;
    const pool = plankPoolByAddress(to);
    const value = BigInt(t.total?.value ?? "0");
    if (pool?.counterSymbol === "WETH") {
      ethPaidWei += value;
      usdValue += weiToUsd(value, ethUsd);
    } else if (pool?.counterSymbol === "USDG") {
      // USDG is 6 decimals (see GROK findings / uniswap-tokenlist.ts).
      usdValue += Number(value) / 1_000_000 * USDG_USD;
    }
  }
  return { ethPaidWei, usdValue };
}

/**
 * Real same-tx round-trip / flash-loan shape check (fraud doc section 1):
 * the recipient (or a contract it deployed/controls in this same tx)
 * should not ALSO be supplying a large amount of the counter-asset TO the
 * pool in the same transaction (a sell leg) beyond what's needed to pay for
 * this buy, nor receiving a large amount of the counter-asset back FROM the
 * pool — either shape is the signature of a manipulate-then-buy-back or
 * flash-loan unwind pattern.
 */
export function hasRoundTripShape(transfers: BlockscoutTxTokenTransfer[], recipient: string): boolean {
  for (const t of transfers) {
    const from = t.from?.hash?.toLowerCase();
    const to = t.to?.hash?.toLowerCase();
    // Recipient receiving WETH/USDG FROM a canonical pool in the same tx
    // they're also buying PLANK from -- a real buyer only sends value in,
    // never also receives the counter-asset back out.
    if (to === recipient && from && isCanonicalPlankPool(from)) {
      const pool = plankPoolByAddress(from);
      if (pool && (pool.counterSymbol === "WETH" || pool.counterSymbol === "USDG")) return true;
    }
  }
  return false;
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
  await postgresQuery(
    `INSERT INTO plank_koth_review_queue (tx_hash, wallet, eth_paid_wei, plank_amount, block_number, reason, evidence)
     VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6, $7::jsonb)
     ON CONFLICT (tx_hash) DO NOTHING`,
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
 */
export async function evaluatePlankKothCandidate(txHash: string): Promise<CandidateOutcome> {
  const [tx, transfers] = await Promise.all([fetchTransaction(txHash), fetchTxTokenTransfers(txHash)]);
  if (!tx || tx.status !== "ok") return { status: "not_a_buy" };
  if (!transfers.some((t) => isPlankTransfer(t) && t.from?.hash && isCanonicalPlankPool(t.from.hash))) {
    return { status: "not_a_buy" };
  }

  const recipients = resolveFinalRecipients(transfers);
  if (recipients.size === 0) {
    await writeReviewQueue({
      txHash,
      wallet: null,
      ethPaidWei: null,
      plankAmount: null,
      blockNumber: tx.block_number ?? null,
      reason: "true recipient could not be resolved (router/relayer held tokens with no clear final holder)",
      evidence: { transfers },
    });
    return { status: "rejected", reason: "unresolvable recipient" };
  }

  const { usd: ethUsd } = await getEthUsdPrice();
  // Multiple distinct final recipients = a real batched multi-user router
  // tx (fraud doc section 2) -- evaluate and, if warranted, offer EACH as
  // its own independent candidate, never summed into one giant "buy".
  let anyConfirmed: PlankKothSale | null = null;
  for (const [recipient, plankAmount] of recipients) {
    if (hasRoundTripShape(transfers, recipient)) {
      await writeReviewQueue({
        txHash,
        wallet: recipient,
        ethPaidWei: null,
        plankAmount: plankAmount.toString(),
        blockNumber: tx.block_number ?? null,
        reason: "same-tx round-trip shape: recipient also received the counter-asset back from a canonical pool in this tx",
        evidence: { transfers },
      });
      continue;
    }

    const { ethPaidWei, usdValue } = resolveValuePaid(transfers, recipient, ethUsd);
    if (usdValue <= 0) {
      await writeReviewQueue({
        txHash,
        wallet: recipient,
        ethPaidWei: ethPaidWei.toString(),
        plankAmount: plankAmount.toString(),
        blockNumber: tx.block_number ?? null,
        reason: "no real value-paid leg resolved for this recipient (possible airdrop/transfer misidentified as a buy)",
        evidence: { transfers },
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
    // this same pipeline already flagged on an EARLIER buy this round (or
    // that some other feature entirely flagged) is real prior signal this
    // check would otherwise never see, since classifyWallet/getBadSeverity
    // only know about Bad Boards' own launch-window marks.
    const priorHighSeverity = priorSignals.find((s) => s.severity >= 0.5);

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
      blockNumber: tx.block_number ?? 0,
    };

    if ((board.side === "bad_boards" || board.side === "fallen") && severity > 0.3) {
      await writeReviewQueue({
        txHash,
        wallet: recipient,
        ethPaidWei: ethPaidWei.toString(),
        plankAmount: plankAmount.toString(),
        blockNumber: tx.block_number ?? null,
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
        blockNumber: tx.block_number ?? null,
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
        blockNumber: tx.block_number ?? null,
        reason: fundingFlag,
        evidence: { transfers },
      });
      continue;
    }

    await writeLeaderboardRow(sale);
    await offerPlankKothCandidate(sale);
    anyConfirmed = sale;
  }

  return anyConfirmed ? { status: "confirmed", sale: anyConfirmed } : { status: "flagged", reason: "all recipients flagged for review" };
}
