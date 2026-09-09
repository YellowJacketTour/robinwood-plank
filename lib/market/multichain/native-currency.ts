import { chainManifest } from "./chains/manifest";

/** Offer currency need not be native: Polygon offers use WETH, not POL. */
export function wrappedNativeAddress(chainSlug: string): string | null {
  // Uniswap SDK's canonical Polygon wrapper (formerly named WMATIC):
  // https://github.com/Uniswap/sdk-core/blob/main/src/entities/weth9.ts
  if (chainSlug === "polygon-mainnet") return "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
  const chain = chainManifest(chainSlug);
  return chain?.offerCurrencySymbol === `W${chain.nativeCurrencySymbol}`
    ? chain.offerCurrencyAddress?.toLowerCase() ?? null
    : null;
}
