/**
 * Canonical $PLANK liquidity pools on Robinhood Chain — the real, verified
 * set a Season 2 King of the Hill buy must route through to count. See
 * docs/marketplank/GROK-FINDINGS-plank-koth-fraud-detection-2026-08-25.md
 * section 4 ("decoy/non-canonical pool attacks"): an attacker deploying
 * their own thin fake pool to record an artificial "buy" outside the real
 * market is a documented real attack pattern; a hard allowlist of the real
 * pool addresses closes it completely for a single-token contest.
 *
 * VERIFIED 2026-08-25, two independent ways:
 *  1. A live indicative quote from this app's own Trading API integration
 *     (curl POST /api/uniswap/quote, direction=buy) returned exactly these
 *     three pools as its real, currently-liquid split-route for WETH -> PLANK.
 *  2. Direct on-chain `token0()`/`token1()` (`fee()` for the V3 pools) reads
 *     against each address, confirming each really does pair PLANK with
 *     either WETH (MARKET_OFFER_CURRENCY, lib/constants.ts) or USDG.
 *
 * A single real "buy" can legitimately split across more than one of these
 * pools in one transaction (Uniswap's own routing does this for better
 * pricing — confirmed live in the same quote) — the candidate pipeline
 * groups by tx hash and sums legs, it does not treat each pool leg as a
 * separate buy. Never add a pool here from a scan/discovery heuristic;
 * only ever from a fresh manual verification against this file's own
 * process, since this list IS the fraud boundary.
 */

export type PlankPool = {
  address: string;
  kind: "v3" | "v2";
  /** The non-PLANK side of the pair. */
  counterToken: string;
  counterSymbol: "WETH" | "USDG";
  /** V3 fee tier in hundredths of a bip (10000 = 1%); absent for v2. */
  feeTier?: number;
};

export const CANONICAL_PLANK_POOLS: readonly PlankPool[] = [
  {
    address: "0x3CE05Efe2e7C9c136f12a1Be695f75F807B6c69E",
    kind: "v3",
    counterToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH (MARKET_OFFER_CURRENCY)
    counterSymbol: "WETH",
    feeTier: 10000,
  },
  {
    address: "0x01b1BEf6fBA02c846eA5c4Ff59193988B5f86F73",
    kind: "v2",
    counterToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    counterSymbol: "WETH",
  },
  {
    address: "0x7D5ed97f76e19EF3dFD345F56a09faD6B2e49E61",
    kind: "v3",
    counterToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // USDG
    counterSymbol: "USDG",
    feeTier: 10000,
  },
] as const;

const POOL_ADDRESS_SET = new Set(CANONICAL_PLANK_POOLS.map((p) => p.address.toLowerCase()));

export function isCanonicalPlankPool(address: string): boolean {
  return POOL_ADDRESS_SET.has(address.toLowerCase());
}

export function plankPoolByAddress(address: string): PlankPool | null {
  const lower = address.toLowerCase();
  return CANONICAL_PLANK_POOLS.find((p) => p.address.toLowerCase() === lower) ?? null;
}
