/**
 * Season 2 $PLANK KOTH -- net-balance-delta buy classification.
 *
 * Real design change, 2026-08-26, per external Grok research review
 * (docs/marketplank/GROK-ONESHOT-plank-koth-total-coverage-2026-08-26.md):
 * the original classifier (plank-koth-candidate.ts's resolveFinalRecipients/
 * hasRoundTripShape/resolveValuePaid) assumed a buyer's own wallet directly
 * moves the counter-asset into the pool and directly receives PLANK from
 * it -- real router-mediated swaps (Universal Router / SwapRouter02, the
 * overwhelmingly common real-world shape) break that assumption, which is
 * exactly the bug confirmed live this session (every real buy misread as a
 * round-trip or "no value paid").
 *
 * The fix Grok proposed and this module implements: compute each address's
 * NET ERC-20 balance delta across every relevant token transfer in a
 * transaction, not the raw transfer graph. A router that receives PLANK
 * and immediately forwards it nets to ~0 for the router -- no explicit
 * "forwarder" detection needed. The real buyer is whoever nets positive in
 * PLANK and negative in a quote asset; this holds regardless of how many
 * router/aggregator hops the payment or the token actually took.
 */

export type Erc20Transfer = {
  tokenAddress: string;
  from: string;
  to: string;
  value: bigint;
};

export type NetBalances = Map<string, Map<string, bigint>>; // address -> tokenAddress -> net delta

/** Real ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
 * topic0 -- distinct from the ERC-721 Transfer shape (which is also 3
 * topics for the signature itself but carries a 4th indexed topic for
 * tokenId); ERC-20's own value is unindexed, always in `data`. */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type RawReceiptLog = {
  address?: string | null;
  topics: Array<string | null | undefined>;
  data?: string | null;
};

/** Decodes every real ERC-20 Transfer log in a transaction receipt for a
 * caller-supplied set of token addresses (PLANK + whatever quote assets
 * this contest cares about) -- ignores every other log (NFT transfers,
 * approvals, pool-internal Sync/Swap accounting logs) since only real
 * token movement matters for net-balance classification. */
export function decodeErc20TransfersForTokens(logs: RawReceiptLog[], tokenAddresses: Set<string>): Erc20Transfer[] {
  const out: Erc20Transfer[] = [];
  for (const log of logs) {
    const address = log.address?.toLowerCase();
    if (!address || !tokenAddresses.has(address)) continue;
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 !== ERC20_TRANSFER_TOPIC) continue;
    // ERC-20 Transfer: exactly 3 topics (topic0 + 2 indexed addresses), value in data.
    if (log.topics.length !== 3 || !log.topics[1] || !log.topics[2] || !log.data) continue;
    const from = "0x" + log.topics[1].slice(-40).toLowerCase();
    const to = "0x" + log.topics[2].slice(-40).toLowerCase();
    let value: bigint;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }
    out.push({ tokenAddress: address, from, to, value });
  }
  return out;
}

/** Real net balance delta per address per token across every transfer in
 * one transaction -- a pure pass-through (received X, sent X onward, same
 * token) nets to 0 with no special-casing required. */
export function computeNetBalances(transfers: Erc20Transfer[]): NetBalances {
  const net: NetBalances = new Map();
  const add = (address: string, tokenAddress: string, delta: bigint) => {
    const perToken = net.get(address) ?? new Map<string, bigint>();
    perToken.set(tokenAddress, (perToken.get(tokenAddress) ?? 0n) + delta);
    net.set(address, perToken);
  };
  for (const t of transfers) {
    add(t.from, t.tokenAddress, -t.value);
    add(t.to, t.tokenAddress, t.value);
  }
  return net;
}

export type NetBuyCandidate = {
  wallet: string;
  plankAmount: bigint;
  /** Per quote-token-address net spend (positive = amount actually paid). */
  quoteSpent: Map<string, bigint>;
  /** Real round-trip signal: this same wallet ALSO nets positive in some
   * quote asset in this same transaction -- i.e. they received value back,
   * not just paid it -- the same-tx manipulate-then-reverse/flash-loan
   * shape the original hasRoundTripShape existed to catch, now derived
   * from net deltas instead of the old (buggy) transfer-graph heuristic. */
  hasRoundTripShape: boolean;
};

/**
 * Real buy classification from net balances: a genuine buyer nets positive
 * in PLANK and negative in at least one quote asset. Excludes the
 * plankAddress/quoteAddresses/canonicalPools themselves (a pool's own net
 * PLANK/quote delta reflects its reserve accounting, never "a buyer").
 */
export function classifyNetBuyCandidates(
  net: NetBalances,
  plankAddress: string,
  quoteAddresses: string[],
  excludeAddresses: Set<string>
): NetBuyCandidate[] {
  const plank = plankAddress.toLowerCase();
  const quotes = quoteAddresses.map((a) => a.toLowerCase());
  const exclude = new Set([...excludeAddresses].map((a) => a.toLowerCase()));
  const out: NetBuyCandidate[] = [];
  for (const [address, perToken] of net) {
    if (exclude.has(address)) continue;
    const plankDelta = perToken.get(plank) ?? 0n;
    if (plankDelta <= 0n) continue;
    const quoteSpent = new Map<string, bigint>();
    let anyQuoteNegative = false;
    let anyQuotePositive = false;
    for (const q of quotes) {
      const delta = perToken.get(q) ?? 0n;
      if (delta < 0n) {
        quoteSpent.set(q, -delta);
        anyQuoteNegative = true;
      } else if (delta > 0n) {
        anyQuotePositive = true;
      }
    }
    if (!anyQuoteNegative) continue; // no real quote-asset payment leg found for this wallet
    out.push({ wallet: address, plankAmount: plankDelta, quoteSpent, hasRoundTripShape: anyQuotePositive });
  }
  return out;
}
