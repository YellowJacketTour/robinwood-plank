/**
 * Vault-aware wallet PnL model.
 *
 * v-tokens are FUNGIBLE within a generation (vault address) — a wallet's
 * position in a vault is one pooled cost basis, never per-NFT-ID FIFO/LIFO.
 * This module is pure math: it takes a chronological list of FlowEvents for
 * one (wallet, vault) cohort and reduces them into a running weighted-average
 * cost-basis Position. Callers are responsible for building FlowEvents from
 * the existing event sources (lib/market/vault-activity.ts `Bought`/`Sold`/
 * `Deposited`/`Redeemed` logs) and for supplying NAV (see below) — this file
 * has no RPC/KV/network code so the math can be tested in isolation.
 *
 * NAV, not last-trade price
 * --------------------------
 * Valuing a *current* v-token holding must use the vault's own redeemable NAV
 * (pool ETH reserve / v-token total supply, i.e. what `sellShares`/`redeem`
 * would actually pay out right now — see lib/market/vault.ts
 * getVaultOnChainSnapshot: `ethReserve` / `totalSupply`), never the price of
 * the most recent trade. A thin AMM can print a stale or manipulated last
 * trade far off NAV; the vault's constant-product reserves cannot lie about
 * what redeeming right now is worth.
 *
 * Cost basis, by event kind
 * --------------------------
 * - `buy` / `sell` (AMM trade against the vault): the wallet's real cost or
 *   proceeds is the ETH that actually changed hands (`valueWei` = the
 *   Bought/Sold event's ethIn/ethOut) — this is a real, already-known price,
 *   not an estimate.
 * - `deposit` / `redeem` (NFT <-> v-token mint/burn): no ETH changes hands
 *   directly, but the wallet is economically giving up (or receiving) an
 *   asset priced at the vault's NAV per share at that moment — so
 *   `valueWei` must be supplied as `navPerShareWeiAtEvent * sharesWei`
 *   (18-decimals per-share convention, matching SHARE_UNIT in
 *   lib/market/vault-registry.ts). This is the one place this module leans
 *   on an external NAV lookup (historical, block-indexed) rather than a
 *   value baked into the on-chain event itself.
 *
 * Realized vs. unrealized
 * ------------------------
 * A `decrease` (sell/redeem) realizes PnL immediately: proceeds minus the
 * weighted-average cost of the shares removed. `increase` (buy/deposit) only
 * ever adds to cost basis — it can't realize anything. Unrealized PnL is
 * computed separately, on demand, against a *current* NAV quote via
 * `unrealizedPnlWei` — never folded into the running position, so a caller
 * re-marking the same position against a fresher NAV doesn't need to replay
 * the whole event history.
 *
 * Vault fee accrual
 * ------------------
 * Mint/redeem fees (see VAULT_FEE_DEFAULTS in vault-registry.ts) are already
 * embedded in the *shares out* a wallet actually receives on deposit (fewer
 * shares than the flat NAV-parity amount) and in the *ETH out* on redeem —
 * so they fall out of the cost-basis math automatically as a slightly worse
 * entry/exit rather than needing a separate ledger line. `feeDragWei` on
 * `CohortPosition` is exposed for callers that want to *report* the fee
 * component of realized PnL separately from raw price movement — computed
 * as the gap between what a fee-free NAV-parity flow would have realized and
 * what the fee-bearing flow actually realized, accumulated per decrease.
 */

export type FlowKind = "increase" | "decrease";

export type FlowEvent = {
  kind: FlowKind;
  /** v-token amount moved, 18-decimals wei, always positive. */
  sharesWei: bigint;
  /**
   * Economic ETH value of this flow: real ETH paid/received for a trade,
   * or NAV-per-share * sharesWei for a vault deposit/redeem. Always positive.
   */
  valueWei: bigint;
  /**
   * Fee-free reference value for the same flow (NAV-parity — no mint/redeem
   * fee applied), used only to attribute `feeDragWei` on a decrease. Equal to
   * `valueWei` for AMM trades (no separate protocol fee ledger to split out
   * there). Optional — defaults to `valueWei` (zero fee drag) when omitted.
   */
  navParityValueWei?: bigint;
  source: "trade" | "vault";
  blockNumber: number;
  txHash: string;
};

export type CohortPosition = {
  wallet: string;
  vaultAddress: string;
  sharesHeld: bigint;
  /** Total weighted-average cost basis of `sharesHeld`. */
  costBasisWei: bigint;
  /** Sum of (proceeds - cost-of-shares-removed) across every decrease. */
  realizedPnlWei: bigint;
  realizedProceedsWei: bigint;
  realizedCostWei: bigint;
  /** Sum of (nav-parity realized - actual realized) — positive = fees cost the wallet. */
  feeDragWei: bigint;
  eventCount: number;
};

const ZERO = BigInt(0);

export function emptyPosition(wallet: string, vaultAddress: string): CohortPosition {
  return {
    wallet,
    vaultAddress,
    sharesHeld: ZERO,
    costBasisWei: ZERO,
    realizedPnlWei: ZERO,
    realizedProceedsWei: ZERO,
    realizedCostWei: ZERO,
    feeDragWei: ZERO,
    eventCount: 0,
  };
}

/** Weighted-average cost per v-token share (18-decimals wei), 0 when flat. */
export function avgCostPerShareWei(pos: CohortPosition): bigint {
  if (pos.sharesHeld <= ZERO) return ZERO;
  return (pos.costBasisWei * SHARE_UNIT) / pos.sharesHeld;
}

export const SHARE_UNIT = BigInt("1000000000000000000");

/**
 * Apply one FlowEvent to a position, returning a new position (never
 * mutates). Events for a given cohort must be applied in ascending block
 * order — this is a stateful weighted-average reduction, not commutative.
 */
export function applyFlow(pos: CohortPosition, event: FlowEvent): CohortPosition {
  if (event.sharesWei <= ZERO) return pos; // no-op, guard against zero/garbage events
  const navParity = event.navParityValueWei ?? event.valueWei;

  if (event.kind === "increase") {
    return {
      ...pos,
      sharesHeld: pos.sharesHeld + event.sharesWei,
      costBasisWei: pos.costBasisWei + event.valueWei,
      eventCount: pos.eventCount + 1,
    };
  }

  // decrease — realize PnL on the portion removed, weighted-average.
  // Clamp to what's actually held: a decrease larger than the tracked
  // position (e.g. cohort history starts mid-stream, missing an earlier
  // deposit) still realizes correctly against whatever basis IS known,
  // rather than going net negative on shares held.
  const sharesRemoved = event.sharesWei > pos.sharesHeld ? pos.sharesHeld : event.sharesWei;
  const avgCost = avgCostPerShareWei(pos);
  const costOfRemoved = (avgCost * sharesRemoved) / SHARE_UNIT;

  // Proceeds/nav-parity are for the FULL event size (even the unmatched
  // excess, if any) — that excess just has zero attributable cost basis,
  // which is the honest "we don't know" answer rather than dropping it.
  const proceeds = event.valueWei;
  const navParityProceeds = navParity;
  const realized = proceeds - costOfRemoved;
  const feeDrag = navParityProceeds - proceeds;

  return {
    ...pos,
    sharesHeld: pos.sharesHeld - sharesRemoved,
    costBasisWei: pos.costBasisWei - costOfRemoved,
    realizedPnlWei: pos.realizedPnlWei + realized,
    realizedProceedsWei: pos.realizedProceedsWei + proceeds,
    realizedCostWei: pos.realizedCostWei + costOfRemoved,
    feeDragWei: pos.feeDragWei + feeDrag,
    eventCount: pos.eventCount + 1,
  };
}

/** Reduce a full chronological (ascending block order) event list into a position. */
export function reduceFlows(
  wallet: string,
  vaultAddress: string,
  events: FlowEvent[]
): CohortPosition {
  const sorted = [...events].sort((a, b) => a.blockNumber - b.blockNumber);
  return sorted.reduce((pos, ev) => applyFlow(pos, ev), emptyPosition(wallet, vaultAddress));
}

/**
 * Mark-to-market unrealized PnL of the CURRENT holding against a fresh NAV
 * quote (ETH reserve / total supply — see module doc). Never uses last-trade
 * price. Positive = up, negative = down.
 */
export function unrealizedPnlWei(pos: CohortPosition, currentNavPerShareWei: bigint): bigint {
  if (pos.sharesHeld <= ZERO) return ZERO;
  const marketValue = (pos.sharesHeld * currentNavPerShareWei) / SHARE_UNIT;
  return marketValue - pos.costBasisWei;
}

/** Current market value of the held position at a given NAV-per-share quote. */
export function marketValueWei(pos: CohortPosition, currentNavPerShareWei: bigint): bigint {
  if (pos.sharesHeld <= ZERO) return ZERO;
  return (pos.sharesHeld * currentNavPerShareWei) / SHARE_UNIT;
}

/**
 * Group a flat list of per-cohort events by (wallet, vaultAddress) and reduce
 * each cohort independently. Input events need not be pre-sorted or
 * pre-grouped — this does both.
 */
export function computeCohortPositions(
  rows: Array<{ wallet: string; vaultAddress: string; event: FlowEvent }>
): Map<string, CohortPosition> {
  const byCohort = new Map<string, Array<{ wallet: string; vaultAddress: string; event: FlowEvent }>>();
  for (const row of rows) {
    const key = cohortKey(row.wallet, row.vaultAddress);
    const list = byCohort.get(key);
    if (list) list.push(row);
    else byCohort.set(key, [row]);
  }
  const out = new Map<string, CohortPosition>();
  for (const [key, list] of byCohort) {
    const { wallet, vaultAddress } = list[0];
    out.set(key, reduceFlows(wallet, vaultAddress, list.map((r) => r.event)));
  }
  return out;
}

export function cohortKey(wallet: string, vaultAddress: string): string {
  return `${wallet.toLowerCase()}:${vaultAddress.toLowerCase()}`;
}

/**
 * NAV per share (18-decimals wei) from a vault's own reserves — the
 * redeemable value, matching lib/market/vault.ts getVaultOnChainSnapshot's
 * `ethReserve` and `totalSupply` fields exactly (call with those two).
 * Returns 0 when supply is 0 (never divide by zero; an empty/unseeded vault
 * has no NAV yet).
 */
export function navPerShareWei(ethReserveWei: bigint, totalSupplyWei: bigint): bigint {
  if (totalSupplyWei <= ZERO) return ZERO;
  return (ethReserveWei * SHARE_UNIT) / totalSupplyWei;
}

/**
 * Classify vault-activity events (lib/market/vault-activity.ts VaultTradeKind)
 * into trading-volume vs internal-rebalancing buckets, per the requirement
 * that vault mint/burn never inflates a "trading volume" chart.
 *
 * - buy / sell: real AMM trades against the pool — counts as trading volume.
 * - deposit / redeem: NFT <-> v-token mint/burn — internal rebalancing, must
 *   be EXCLUDED from volume.
 * - add_lp / remove_lp: liquidity provisioning — also not a trade, excluded.
 */
export type VaultTradeKindForVolume = "buy" | "sell" | "deposit" | "redeem" | "add_lp" | "remove_lp";

export function isTradingVolumeEvent(kind: VaultTradeKindForVolume): boolean {
  return kind === "buy" || kind === "sell";
}
