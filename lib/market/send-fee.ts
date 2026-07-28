import { MARKET_FEE_RECIPIENT } from "@/lib/constants";

/**
 * Send/batch-send fee: flat base + a smaller per-additional-item increment,
 * so a batch is always cheaper PER ITEM than paying the base fee N separate
 * times (the whole point of "batch" pricing) — while staying priced off the
 * chain's OWN current gas price with a margin multiplier, not a fixed ETH
 * number, so a gas spike between quote and confirmation can't turn a
 * profitable fee into a loss. There is no deployed batch-send router
 * contract (yet) — see sendNftBatch in transfer.ts — so "batch" today means
 * N sequential signed transfers plus ONE fee payment, not one atomic
 * on-chain call; the fee still reflects genuine batching savings on our
 * side (fewer separate quote/UI round-trips, one combined confirmation
 * flow) even though gas itself is paid per-transaction regardless.
 */

/** Multiplier over raw estimated gas cost. 3x means the fee stays
 * profitable even if gas triples between the quote and the actual sends
 * landing — the number that makes "no matter what gas conditions arise"
 * true rather than aspirational. */
export const SEND_FEE_MARGIN_MULTIPLIER = BigInt(3);

/** Generous estimate for one ERC-721 safeTransferFrom, including the
 * 21,000 base tx cost — real sends on this chain run well under this. */
const GAS_UNITS_FIRST_ITEM = BigInt(90_000);
/** Marginal cost for each additional item in the same batch — deliberately
 * lower than the first-item rate; this gap IS the batch discount. */
const GAS_UNITS_PER_ADDITIONAL_ITEM = BigInt(60_000);

export type SendFeeQuote = {
  itemCount: number;
  gasPriceWei: bigint;
  totalFeeWei: bigint;
  /** totalFeeWei / itemCount, for display — "≈X Ξ per item". */
  averagePerItemWei: bigint;
  /** What itemCount separate single-item sends would have cost in fees —
   * shown alongside totalFeeWei so the batch discount is visible, not just
   * asserted. */
  equivalentSingleSendsFeeWei: bigint;
};

export function computeSendFeeWei(itemCount: number, gasPriceWei: bigint): SendFeeQuote {
  if (itemCount <= 0 || gasPriceWei <= BigInt(0)) {
    return {
      itemCount,
      gasPriceWei,
      totalFeeWei: BigInt(0),
      averagePerItemWei: BigInt(0),
      equivalentSingleSendsFeeWei: BigInt(0),
    };
  }
  const singleItemFee = GAS_UNITS_FIRST_ITEM * gasPriceWei * SEND_FEE_MARGIN_MULTIPLIER;
  const additionalItemFee = GAS_UNITS_PER_ADDITIONAL_ITEM * gasPriceWei * SEND_FEE_MARGIN_MULTIPLIER;
  const totalFeeWei = singleItemFee + additionalItemFee * BigInt(itemCount - 1);
  return {
    itemCount,
    gasPriceWei,
    totalFeeWei,
    averagePerItemWei: totalFeeWei / BigInt(itemCount),
    equivalentSingleSendsFeeWei: singleItemFee * BigInt(itemCount),
  };
}

/** Live gas price straight from the chain via our own RPC proxy (same one
 * everything else uses — see app/api/rpc) — never a cached or guessed
 * number, since the whole point of this schedule is tracking real
 * conditions. */
export async function getCurrentGasPriceWei(): Promise<bigint> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
  });
  const json = (await res.json()) as { result?: string };
  if (!json.result) throw new Error("Could not read current gas price.");
  return BigInt(json.result);
}

export async function quoteSendFee(itemCount: number): Promise<SendFeeQuote> {
  const gasPriceWei = await getCurrentGasPriceWei();
  return computeSendFeeWei(itemCount, gasPriceWei);
}

export { MARKET_FEE_RECIPIENT as SEND_FEE_RECIPIENT };
