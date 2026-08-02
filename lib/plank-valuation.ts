/**
 * $PLANK valuation math, and the record of WHICH supply basis it uses.
 *
 * =====================================================================
 * THE DECISION: this file computes FDV. It never computes a market cap.
 * =====================================================================
 *
 * Market cap = price x supply, and "which supply" is the entire question.
 * Here is the on-chain evidence behind the answer, gathered 2026-07-31
 * against the verified $PLANK source on Robinhood Chain (chain 4663, an
 * Arbitrum L2):
 *
 * 1. `totalSupply()` = 888,420,069,420,888 PLANK (18 decimals). Read live —
 *    see lib/plank-supply.ts — never hard-coded into a displayed figure.
 *
 * 2. Supply is fixed. The verified source has exactly one `_mint(...)`, in
 *    the constructor, to a hard-coded `supplyRecipient`. There is no mint
 *    function, no upgrade path ("This token is not upgradeable"), and
 *    `owner()` now returns the zero address — ownership was renounced, so
 *    even the owner-gated levers (`blacklist`, `enableTrading`,
 *    `updateTradeCooldownTime`, `recoverToken`) are permanently dead. The
 *    token is `ERC20Burnable`, so supply can only ever go DOWN.
 *
 * 3. Nothing has been burned or parked in a sink: `balanceOf(0x…dEaD)` = 0
 *    and `balanceOf(0x0)` = 0. Total supply is fully outstanding.
 *
 * 4. But 56.8% of supply sits in ONE address — `PLANK_SUPPLY_RECIPIENT`, the
 *    constructor's mint target, which is also where ownership was sent. It
 *    is not a vesting contract, not a timelock, not an LP lock: Blockscout
 *    resolves it to an EOA with an EIP-7702 delegation to Alchemy's
 *    `SemiModularAccount7702`. Those tokens are freely transferable today.
 *
 * Point 4 is why this file refuses to publish a circulating market cap.
 * The standard convention only excludes supply that is provably locked,
 * burned, or contractually vested, and none of that applies here — an
 * unlocked wallet balance is circulating supply, however concentrated. To
 * show "market cap = 43.2% of FDV" we would have to assert a lock that does
 * not exist. Inventing that number is exactly the error this module exists
 * to prevent, so the UI shows FDV, labels it FDV, and discloses the
 * concentration instead of silently netting it out.
 *
 * The aggregators independently agree there is no circulating figure:
 * GeckoTerminal returns `market_cap_usd: null` for $PLANK (it publishes a
 * market cap only with a verified circulating supply), and DexScreener
 * returns `marketCap` exactly equal to `fdv` on every $PLANK pair — the same
 * price x total-supply number under two labels. Our computed FDV reproduces
 * GeckoTerminal's `fdv_usd` to the cent, which is the cross-check.
 *
 * If a real lock/vesting contract is ever deployed for that balance, THAT is
 * the moment to add a circulating basis here — with the lock address, not
 * before.
 *
 * Pure functions only: no network, no chain, no KV. Everything here is
 * unit-testable (test/market/plank-valuation.test.ts) and safe to import
 * from a client component.
 */

/**
 * The only supply basis this app is willing to publish. Kept as a named type
 * rather than a bare string so that adding "circulating" later is a
 * deliberate, greppable change with a compile error at every call site.
 */
export type SupplyBasis = "fdv";

export const PLANK_SUPPLY_BASIS: SupplyBasis = "fdv";

/** Headline label. Never render the string "Market cap" against this value. */
export const PLANK_VALUATION_LABEL = "FDV (fully diluted)";

export type PlankValuation = {
  basis: SupplyBasis;
  /** USD price used for the multiply, and which pool it came from. */
  priceUsd: number;
  priceSource: string;
  /** Whole tokens, read from `totalSupply()` on-chain. */
  totalSupply: number;
  /** priceUsd x totalSupply. */
  fdvUsd: number;
  /**
   * Deliberately always null. Present in the type so that any consumer
   * reaching for a market cap gets `null` and has to handle it, rather than
   * quietly falling back to the FDV number under a "Market cap" label.
   */
  marketCapUsd: null;
};

/**
 * FDV = price x total supply. Returns null rather than 0/NaN when either
 * input is missing, so callers render an em dash instead of a fake "$0".
 */
export function computeFdvUsd(
  priceUsd: number | null | undefined,
  totalSupply: number | null | undefined
): number | null {
  if (priceUsd == null || totalSupply == null) return null;
  if (!Number.isFinite(priceUsd) || !Number.isFinite(totalSupply)) return null;
  if (priceUsd < 0 || totalSupply < 0) return null;
  const fdv = priceUsd * totalSupply;
  return Number.isFinite(fdv) ? fdv : null;
}

/**
 * Percentage gap between our figure and an aggregator's, relative to the
 * aggregator's. Used to surface a warning in the UI if a third party ever
 * disagrees with us materially — a silent divergence would mean one of the
 * two is wrong about supply, which is precisely the failure mode this whole
 * module guards against.
 */
export function valuationDivergencePct(
  ours: number | null,
  reported: number | null
): number | null {
  if (ours == null || reported == null) return null;
  if (!Number.isFinite(ours) || !Number.isFinite(reported) || reported === 0) return null;
  return ((ours - reported) / reported) * 100;
}

/**
 * Above this, our FDV and an aggregator's are telling different stories about
 * supply rather than merely quoting different pools a few seconds apart.
 * Real observed spread across $PLANK's five pools on 2026-07-31 was ~0.6%
 * (Uniswap v4, the dust pool, being the outlier); the deepest pools sat
 * within 0.3% of each other. 5% leaves generous room for price timing while
 * still catching a supply mismatch.
 */
export const VALUATION_DIVERGENCE_WARN_PCT = 5;

/**
 * Share of total supply held by one address, as a percentage. Null-safe so a
 * failed balance read degrades to "not shown" rather than "0% concentration",
 * which would read as reassuring and be a lie.
 */
export function supplySharePct(
  balance: number | null | undefined,
  totalSupply: number | null | undefined
): number | null {
  if (balance == null || totalSupply == null) return null;
  if (!Number.isFinite(balance) || !Number.isFinite(totalSupply) || totalSupply <= 0) return null;
  return (balance / totalSupply) * 100;
}

/** Compact USD for headline figures: $366.1K, $1.2M. */
export function formatCompactUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 1) return `$${value.toFixed(2)}`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Full token counts with thousands separators. $PLANK's supply is 15 digits
 * — compact notation ("888.42T") is fine for a subtitle but the exact number
 * has to be available somewhere, because it is the multiplicand behind the
 * headline figure and the thing a reader would check against the explorer.
 */
export function formatTokenAmount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

/** Compact token counts for tight spaces: 888.42T PLANK. */
export function formatCompactTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Convert a raw base-unit balance to whole tokens without going through an
 * intermediate `Number` that would lose precision.
 *
 * $PLANK's raw total supply is 8.884e32, far past `Number.MAX_SAFE_INTEGER`
 * (9.007e15). Dividing as BigInt first lands on 888,420,069,420,888 — which
 * IS exactly representable — and only the sub-token remainder is converted
 * as a float. `Number(raw) / 1e18` would silently corrupt the multiplicand
 * behind every figure on the page.
 */
export function baseUnitsToTokens(raw: bigint, decimals: number): number {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`baseUnitsToTokens: bad decimals ${decimals}`);
  }
  // BigInt(10), not a `10n` literal: this repo's tsconfig target predates
  // ES2020 BigInt literals (TS2737) — same reason lib/constants.ts writes
  // BUY_GAS_RESERVE_WEI as BigInt("...").
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = raw / scale;
  const remainder = raw % scale;
  return Number(whole) + Number(remainder) / Number(scale);
}
