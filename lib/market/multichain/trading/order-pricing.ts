/**
 * Pure order pricing for Seaport orders (2026-09-06). No imports beyond
 * types: this file is shared by the server (listings route) and the browser
 * (foreign-fulfill sweep cap), so it must never pull in Postgres or vendor
 * key pools. See AUDIT lens 2 #1.
 */
/** Seaport ItemType values this pricing helper understands. */
const ITEM_NATIVE = 0;
const ITEM_ERC20 = 1;

export type OrderPricing = {
  /** Sum of consideration in the priced currency's atomic unit. */
  priceAtomic: bigint;
  currencyAddress: string | null;
  currencySymbol: string;
  currencyDecimals: number;
  /** True when the order is payable in the chain's native token or its wrapped native (1:1). */
  nativeEquivalent: boolean;
};

/**
 * AUDIT lens 2 #1 (2026-09-06): consideration legs were summed as if every
 * leg were the chain's native token, so a 5 USDC ask displayed as
 * "0.000005" with the native icon and won the floor. Legs are now read per
 * item type and token: native legs price in native; ERC-20 legs priced in
 * that token; an order mixing tokens or priced in a non-native token is
 * reported with `nativeEquivalent: false` so callers can exclude it from
 * floor and cheapest math and label it honestly.
 */
export function priceForeignOrder(
  parameters: { consideration?: Array<{ itemType: number | string; token?: string | null; startAmount?: string | null }> | null },
  chain: { nativeCurrencySymbol: string; offerCurrencyAddress: string | null; offerCurrencySymbol: string }
): OrderPricing {
  let native = 0n;
  const erc20 = new Map<string, bigint>();
  for (const leg of parameters.consideration ?? []) {
    const amount = BigInt(leg.startAmount ?? "0");
    const itemType = Number(leg.itemType);
    if (itemType === ITEM_NATIVE) native += amount;
    else if (itemType === ITEM_ERC20) {
      const token = String(leg.token ?? "").toLowerCase();
      erc20.set(token, (erc20.get(token) ?? 0n) + amount);
    }
  }
  if (erc20.size === 0) {
    return { priceAtomic: native, currencyAddress: null, currencySymbol: chain.nativeCurrencySymbol, currencyDecimals: 18, nativeEquivalent: true };
  }
  if (erc20.size === 1 && native === 0n) {
    const [token, amount] = [...erc20.entries()][0];
    const wrapped = chain.offerCurrencyAddress?.toLowerCase() ?? null;
    if (wrapped && token === wrapped) {
      return { priceAtomic: amount, currencyAddress: token, currencySymbol: chain.offerCurrencySymbol, currencyDecimals: 18, nativeEquivalent: true };
    }
    return { priceAtomic: amount, currencyAddress: token, currencySymbol: "TOKEN", currencyDecimals: 18, nativeEquivalent: false };
  }
  return { priceAtomic: native, currencyAddress: null, currencySymbol: "MIXED", currencyDecimals: 18, nativeEquivalent: false };
}
