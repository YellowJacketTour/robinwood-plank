/**
 * Real, computable wash-trade SUSPICION scoring over a window of settled
 * sales -- chain-agnostic (EVM/Solana/Bitcoin/Robinhood-native all produce
 * the same shape: a buyer address, a seller address, a price, a timestamp).
 *
 * This is deliberately a DOWNWEIGHT signal, never a hide/delete: real data
 * is never destroyed, and a false positive here (flagging a real collector
 * relisting to themselves once, or a market maker's legitimate repeat
 * trading) is worse than a missed true positive. See module callers
 * (lib/market/trending.ts, lib/market/multichain/demand-score.ts) for how
 * the ratio this produces is actually applied.
 *
 * TWO REAL, PUBLISHED HEURISTICS -- not invented from scratch:
 *
 * 1) Exact self-transfer: buyer address === seller address on the same
 *    sale. This is the simplest wash-trade signature there is (no address
 *    obfuscation at all) and is exactly what Chainalysis's 2022 NFT wash
 *    trading report (https://www.chainalysis.com/blog/2022-crypto-crime-report-preview-nft-wash-trading-money-laundering/)
 *    and NFTGo's wash-trading methodology (https://nftgo.io/research/nft-wash-trading-report)
 *    both flag as the unambiguous case: same wallet on both sides of a
 *    transfer that market data treats as a "sale."
 *
 * 2) Reciprocal address-pair trading: the same two wallets trading an NFT
 *    back and forth (A sells to B, then B sells back to A, or a fixed pair
 *    repeats sale after sale) within the scored window. This is the
 *    "closed loop" / "round-trip" pattern documented in the same
 *    Chainalysis report and in Dune Analytics community wash-trading
 *    dashboards for NFT marketplaces (e.g. the widely cited LooksRare
 *    reward-farming analyses from Jan 2022, where the same two or three
 *    wallets round-tripped a JPEG dozens of times purely to farm token
 *    rewards). We flag a sale as reciprocal-pair suspicious only when the
 *    same unordered {buyer, seller} pair appears at least twice in the
 *    window AND at least one sale runs in each direction -- a single
 *    one-way resale between two wallets (a completely normal secondary-
 *    market pattern) never triggers this, only an actual back-and-forth.
 *
 * Both heuristics use only data this app already stores per sale (from/to
 * addresses, price, timestamp, tx hash) -- no external API, no wallet-
 * clustering heuristics that could misfire on shared custodial wallets.
 */

export type WashCandidateSale = {
  txHash: string;
  from: string | null;
  to: string | null;
  priceWei: string;
  timestamp: string | null;
};

export type WashSuspicionResult = {
  totalTradeCount: number;
  totalVolumeWei: bigint;
  /** Count of sales flagged by either heuristic. */
  suspiciousTradeCount: number;
  suspiciousVolumeWei: bigint;
  /** suspiciousVolumeWei / totalVolumeWei, in [0,1]. 0 when there is no volume to judge. */
  suspicionRatio: number;
  selfTransferCount: number;
  reciprocalPairCount: number;
  /** tx hashes of every sale flagged by either heuristic -- lets a caller exclude exactly these rows from downstream aggregates instead of only reading the aggregate ratio. */
  suspiciousTxHashes: Set<string>;
};

function safeBigInt(wei: string): bigint | null {
  try {
    const v = BigInt(wei);
    return v > BigInt(0) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Score a window of sales for a single collection. Order-independent;
 * callers should pre-filter to the window they want scored (e.g. last 24h,
 * last 7d) since suspicion is inherently relative to a time window -- a
 * pair that round-tripped once six months apart from once today is not the
 * same signal as two round-trips an hour apart.
 */
export function computeWashSuspicion(sales: readonly WashCandidateSale[]): WashSuspicionResult {
  let totalVolumeWei = BigInt(0);
  let totalTradeCount = 0;
  const pairCounts = new Map<string, { count: number; directions: Set<string> }>();

  for (const s of sales) {
    const price = safeBigInt(s.priceWei);
    if (price == null) continue;
    totalTradeCount += 1;
    totalVolumeWei += price;
    const from = s.from?.toLowerCase() || null;
    const to = s.to?.toLowerCase() || null;
    if (!from || !to) continue;
    const pairKey = [from, to].sort().join("|");
    const entry = pairCounts.get(pairKey) ?? { count: 0, directions: new Set<string>() };
    entry.count += 1;
    entry.directions.add(`${from}>${to}`);
    pairCounts.set(pairKey, entry);
  }

  let selfTransferCount = 0;
  let reciprocalPairCount = 0;
  let suspiciousTradeCount = 0;
  let suspiciousVolumeWei = BigInt(0);
  const suspiciousTxHashes = new Set<string>();

  for (const s of sales) {
    const price = safeBigInt(s.priceWei);
    if (price == null) continue;
    const from = s.from?.toLowerCase() || null;
    const to = s.to?.toLowerCase() || null;
    if (!from || !to) continue;

    const isSelfTransfer = from === to;
    let isReciprocalPair = false;
    if (!isSelfTransfer) {
      const pairKey = [from, to].sort().join("|");
      const entry = pairCounts.get(pairKey);
      // Reciprocal only when the same pair appears 2+ times AND trades ran
      // in both directions -- a plain one-way resale never qualifies.
      isReciprocalPair = !!entry && entry.count >= 2 && entry.directions.size >= 2;
    }

    if (isSelfTransfer) selfTransferCount += 1;
    if (isReciprocalPair) reciprocalPairCount += 1;
    if (isSelfTransfer || isReciprocalPair) {
      suspiciousTradeCount += 1;
      suspiciousVolumeWei += price;
      suspiciousTxHashes.add(s.txHash);
    }
  }

  const suspicionRatio =
    totalVolumeWei > BigInt(0) ? Number(suspiciousVolumeWei) / Number(totalVolumeWei) : 0;

  return {
    totalTradeCount,
    totalVolumeWei,
    suspiciousTradeCount,
    suspiciousVolumeWei,
    suspicionRatio: Math.max(0, Math.min(1, suspicionRatio)),
    selfTransferCount,
    reciprocalPairCount,
    suspiciousTxHashes,
  };
}
