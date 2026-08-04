/**
 * Maps real VaultTradeEvents (lib/market/vault-activity.ts) into the pure
 * FlowEvent input type consumed by lib/market/portfolio-pnl.ts.
 *
 * This file is intentionally the ONLY place that bridges the real event
 * source into the pure math module — portfolio-pnl.ts stays free of
 * RPC/KV/network code so its reduction logic can be unit tested in
 * isolation (see its module doc comment). Everything here that needs a
 * historical NAV lookup takes it as an injected resolver function so this
 * mapper is itself unit-testable without a live RPC or Postgres.
 *
 * Event-kind classification
 * --------------------------
 * - `buy` -> increase, `sell` -> decrease: real AMM trades. valueWei is the
 *   event's own ethIn/ethOut (already a real, known price) — no NAV lookup
 *   needed.
 * - `deposit` -> increase, `redeem` -> decrease: NFT <-> v-token mint/burn.
 *   valueWei must be `navPerShareWeiAtEvent * sharesWei` per portfolio-pnl's
 *   doc comment — see "Historical NAV" and "Deposit/redeem share amount"
 *   below for the two approximations this requires.
 * - `add_lp` / `remove_lp` -> EXCLUDED (mapped to `null`, not increase or
 *   decrease). Reasoned choice, since the source doc comments do not settle
 *   this explicitly:
 *     - `isTradingVolumeEvent` in portfolio-pnl.ts already classifies LP
 *       events as non-trading, same bucket as deposit/redeem — but
 *       deposit/redeem SW into a cost-basis position instead) are the only
 *       ones portfolio-pnl.ts's own doc comment says get a valueWei from
 *       NAV; it says nothing about LP.
 *     - A wallet's v-token cost basis and its LP contribution are different
 *       economic exposures. Buying/depositing to HOLD shares is spending
 *       against the position modeled here. Contributing shares as
 *       AMM-liquidity is closer to *staking already-owned* shares — the
 *       wallet does not receive a new asset, and remove_lp does not sell
 *       one; both largely round-trip the same shares plus fee-market
 *       exposure. Folding that flow through the same weighted-average
 *       cost-basis reducer as a buy/sell would corrupt costBasisWei with a
 *       non-purchase, non-sale event.
 *   Known limitation: a wallet whose ONLY vault activity is add_lp/remove_lp
 *   (no buy/sell/deposit/redeem) gets an empty cohort position here even
 *   though it may hold vault shares. LP-specific PnL (fees earned vs.
 *   impermanent loss) is a distinct model this module does not attempt —
 *   flagged as a deferral, not silently guessed at.
 *
 * Historical NAV at deposit/redeem (tradeoff, read before changing)
 * --------------------------------------------------------------------
 * `navPerShareWeiAtEvent` should be the vault's `ethReserve / totalSupply`
 * at the event's exact block. Getting that exactly requires an
 * archive-node-capable `eth_call` with a historical blockTag, which the
 * public RPC endpoints this app is allowed to hit are NOT guaranteed to
 * serve for blocks outside a shallow (often ~128-block) recent window —
 * see lib/market/fetch-rpc.ts's comments on provider limits. There is no
 * budget in this change to stand up an archive node.
 *
 * The resolver injected as `resolveNavAtBlock` is therefore expected to
 * implement a documented fallback chain (see
 * lib/market/portfolio-nav-history.ts, the real implementation used by the
 * refresh script and API route):
 *   1. Exact historical `eth_call` at the event's block, when the RPC
 *      answers it (works for recent events on a full/less-aggressively-
 *      pruned node).
 *   2. The nearest STORED nav snapshot at or before the event's block, from
 *      a `vault_nav_snapshots` table populated once per refresh-market-data
 *      cron run going forward. This is an approximation: NAV between
 *      snapshots (cron runs roughly every 15 minutes) is assumed flat, and
 *      there is no snapshot history at all for deposit/redeem events that
 *      happened before this feature shipped.
 *   3. The vault's CURRENT NAV, as an honest last resort, clearly worse the
 *      further back the event is — used only when neither of the above is
 *      available (e.g. a deposit from before any snapshot exists).
 * Callers that care which tier was used can inspect the resolver's own
 * logging; this module does not thread a confidence tag through FlowEvent
 * because portfolio-pnl.ts's FlowEvent type intentionally has no field for
 * it (see that file — extending it was out of scope for this change).
 *
 * Deposit/redeem share amount (tradeoff, read before changing)
 * -------------------------------------------------------------
 * `Deposited`/`Redeemed` events (vault-abi.json) carry `tokenId` but NOT the
 * v-token amount minted/burned — that amount is emitted separately as an
 * ERC-20 `Transfer` in the same transaction, which vault-activity.ts's
 * decoder does not currently capture (VaultTradeEvent.sharesWei is `null`
 * for these two kinds). Decoding that Transfer log was out of scope for
 * this change (it would mean widening VaultTradeEvent and the vault-activity
 * scan, a bigger change to a file with its own careful multi-source
 * merge/dedupe logic). This mapper instead approximates
 * sharesWei = SHARE_UNIT (1.0 v-token) per deposit/redeem — the vault's
 * nominal 1:1 parity rate — which is exact for a fee-free vault and slightly
 * overstates cost basis / proceeds for a vault with a nonzero mint/redeem
 * fee (see contracts' mintFeeBps/redeemFeeBps). This is a real, documented
 * gap, not a silent guess: a follow-up should decode the paired Transfer log
 * and pass the real minted/burned amount through instead.
 */

import type { VaultTradeEvent, VaultTradeKind } from "@/lib/market/vault-activity";
import {
  type FlowEvent,
  type FlowKind,
  SHARE_UNIT,
  isTradingVolumeEvent,
} from "@/lib/market/portfolio-pnl";

/** Resolves NAV-per-share (18-decimals wei) for a vault at (at-or-before) a
 * given block number. See the "Historical NAV" doc comment above for the
 * expected fallback chain — this mapper only calls the function, it does
 * not implement the chain itself. */
export type NavAtBlockResolver = (
  vaultAddress: string,
  blockNumber: number
) => Promise<bigint>;

/** One row of the flat input `computeCohortPositions` in portfolio-pnl.ts
 * expects: a resolved wallet + vault + FlowEvent, or null when the source
 * event does not participate in cost-basis tracking (add_lp/remove_lp, or
 * a malformed/unusable event). */
export type CohortFlowRow = { wallet: string; vaultAddress: string; event: FlowEvent };

const ZERO = BigInt(0);
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function flowKindFor(kind: VaultTradeKind): FlowKind | null {
  switch (kind) {
    case "buy":
    case "deposit":
      return "increase";
    case "sell":
    case "redeem":
      return "decrease";
    case "add_lp":
    case "remove_lp":
      // See module doc comment "Event-kind classification" — deliberately
      // excluded from cost-basis tracking, not a missing case.
      return null;
    default: {
      const exhaustive: never = kind;
      throw new Error(`flowKindFor: unhandled VaultTradeKind ${String(exhaustive)}`);
    }
  }
}

/**
 * Map one VaultTradeEvent into a CohortFlowRow, or null when it should not
 * enter the cost-basis reduction (add_lp/remove_lp, missing wallet address,
 * missing vault address, or a trade event with no ETH amount recorded).
 *
 * `resolveNavAtBlock` is only ever called for deposit/redeem — buy/sell use
 * the event's own real ETH amount and never touch NAV.
 */
export async function vaultEventToFlowRow(
  event: VaultTradeEvent,
  resolveNavAtBlock: NavAtBlockResolver
): Promise<CohortFlowRow | null> {
  const flowKind = flowKindFor(event.kind);
  if (!flowKind) return null;
  // isTradingVolumeEvent's exhaustive switch is the canonical source of
  // truth for kind classification elsewhere in the app; asserting agreement
  // here means a future kind added to one but not the other fails a test
  // instead of silently diverging. (add_lp/remove_lp already returned above,
  // so this only ever runs for buy/sell/deposit/redeem.)
  if (isTradingVolumeEvent(event.kind) !== (event.kind === "buy" || event.kind === "sell")) {
    throw new Error(`vaultEventToFlowRow: classification mismatch for kind ${event.kind}`);
  }

  const wallet = event.address;
  const vaultAddress = event.vaultAddress;
  if (!wallet || !HEX_ADDRESS.test(wallet)) return null;
  if (!vaultAddress || !HEX_ADDRESS.test(vaultAddress)) return null;

  let sharesWei: bigint;
  let valueWei: bigint;

  if (event.kind === "buy" || event.kind === "sell") {
    if (!event.ethWei || !event.sharesWei) return null; // malformed decode, skip rather than fabricate
    sharesWei = BigInt(event.sharesWei);
    valueWei = BigInt(event.ethWei);
  } else {
    // deposit / redeem — see "Deposit/redeem share amount" doc comment.
    sharesWei = SHARE_UNIT;
    const navPerShareWei = await resolveNavAtBlock(vaultAddress, event.blockNumber);
    valueWei = (sharesWei * navPerShareWei) / SHARE_UNIT;
  }

  if (sharesWei <= ZERO || valueWei < ZERO) return null;

  const flowEvent: FlowEvent = {
    kind: flowKind,
    sharesWei,
    valueWei,
    source: event.kind === "buy" || event.kind === "sell" ? "trade" : "vault",
    blockNumber: event.blockNumber,
    txHash: event.txHash,
  };

  return { wallet: wallet.toLowerCase(), vaultAddress: vaultAddress.toLowerCase(), event: flowEvent };
}

/**
 * Map a whole VaultTradeEvent history into CohortFlowRows, dropping events
 * that don't participate (see vaultEventToFlowRow). Order is preserved;
 * portfolio-pnl.ts's reduceFlows/computeCohortPositions sort by blockNumber
 * themselves so callers don't need to pre-sort.
 */
export async function vaultEventsToFlowRows(
  events: VaultTradeEvent[],
  resolveNavAtBlock: NavAtBlockResolver
): Promise<CohortFlowRow[]> {
  const rows: CohortFlowRow[] = [];
  for (const event of events) {
    const row = await vaultEventToFlowRow(event, resolveNavAtBlock);
    if (row) rows.push(row);
  }
  return rows;
}
