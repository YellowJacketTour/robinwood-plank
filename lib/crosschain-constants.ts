import { CHAIN, CONTRACT_ADDRESS } from "@/lib/constants";

/**
 * Phase C — cross-chain buys INTO $PLANK on Robinhood Chain (4663).
 *
 * HARD OFF by default. This is a distinct, slower, riskier flow than the
 * same-chain SwapWidget: settlement takes minutes (not seconds), spans two
 * chains, and Uniswap's own docs for CHAINED routing state plainly that a
 * failed destination-side step can leave a user holding an intermediate
 * token instead of $PLANK, with no automatic refund. Do not flip this on
 * until that has been exercised against a live quote/plan on Robinhood
 * Chain, and the resulting UX has been reviewed end to end.
 *
 * Set NEXT_PUBLIC_CROSSCHAIN_ENABLED=true to enable the "Buy from another
 * chain" panel. Also read client-side (this is not a secret) so the panel
 * can no-op cleanly with zero bundle-visible behavior change when off.
 */
export const CROSSCHAIN_ENABLED =
  process.env.NEXT_PUBLIC_CROSSCHAIN_ENABLED?.trim().toLowerCase() === "true";

/**
 * Destination is always official $PLANK on Robinhood Chain — never
 * configurable, never client-supplied. Mirrors the "PLANK on exactly one
 * side" guard in lib/uniswap-server.ts's assertAllowedPair, but for the
 * cross-chain entry point the PLANK side is always the OUTPUT.
 */
export const CROSSCHAIN_DEST_CHAIN_ID = CHAIN.id;
export const CROSSCHAIN_DEST_TOKEN = CONTRACT_ADDRESS;

export type CrossChainSourceChain = {
  chainId: number;
  name: string;
  /** Native currency symbol — v1 only supports paying with the source
   * chain's native token (no per-chain ERC-20 allowlist yet; see
   * lib/crosschain-server.ts assertSourceChainAllowed). */
  nativeSymbol: string;
};

/**
 * Source chains this feature will quote from. Every entry here must be a
 * chain the Uniswap Trading API lists as supported AND that Across
 * (the bridge Uniswap's CHAINED/BRIDGE routing uses under the hood) can
 * reach Robinhood Chain (4663) from. Verified against docs as of
 * 2026-07-30 — reverify before enabling in production, chain support can
 * change without notice on either side.
 *
 * @see https://developers.uniswap.org/docs/trading/swapping-api/supported-chains
 * @see https://developers.uniswap.org/docs/trading/swapping-api/chained-actions-integration
 */
export const CROSSCHAIN_SOURCE_CHAINS: ReadonlyArray<CrossChainSourceChain> = Object.freeze([
  Object.freeze({ chainId: 1, name: "Ethereum", nativeSymbol: "ETH" }),
  Object.freeze({ chainId: 42161, name: "Arbitrum", nativeSymbol: "ETH" }),
  Object.freeze({ chainId: 8453, name: "Base", nativeSymbol: "ETH" }),
  Object.freeze({ chainId: 10, name: "Optimism", nativeSymbol: "ETH" }),
  Object.freeze({ chainId: 137, name: "Polygon", nativeSymbol: "POL" }),
]);

export function findSourceChain(chainId: number): CrossChainSourceChain | null {
  return CROSSCHAIN_SOURCE_CHAINS.find((c) => c.chainId === chainId) ?? null;
}

/** Native-token sentinel address used by the Uniswap Trading API on every chain. */
export const CROSSCHAIN_NATIVE_TOKEN_ADDRESS =
  "0x0000000000000000000000000000000000000000";

/**
 * Step shapes we recognize from Uniswap's /plan response. Anything outside
 * this set is rejected rather than blindly relayed to the client — the same
 * fail-closed posture as lib/uniswap-server.ts's routing/pair guards.
 */
export const CROSSCHAIN_KNOWN_STEP_TYPES = new Set([
  "APPROVAL_TXN",
  "SWAP_TXN",
  "BRIDGE_TXN",
  "TXN",
]);

export const CROSSCHAIN_KNOWN_METHODS = new Set(["SEND_TX", "SIGN_TX"]);

export const CROSSCHAIN_KNOWN_STATUSES = new Set([
  "AWAITING_ACTION",
  "IN_PROGRESS",
  "COMPLETE",
  "STEP_ERROR",
  "NOT_READY",
]);
