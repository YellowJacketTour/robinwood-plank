/**
 * Fulfills a Marketplank-native listing/offer on a foreign EVM chain --
 * step 3 of the plan. Deliberately a SEPARATE file from foreign-fulfill.ts:
 * that file's connectedRouter()/buyNow() is a DIFFERENT mechanism (fulfills
 * a THIRD-PARTY OpenSea order via MarketplankForeignFeeRouter, an
 * undeployed, out-of-scope contract -- every FOREIGN_FEE_ROUTER_ADDRESS
 * entry is null). Mixing the two in one file risks a future edit
 * accidentally routing a native fulfill through a router that doesn't
 * exist. This path is the "plain, direct call to Seaport's canonical
 * contract, no wrapper contract" one: fetch the raw signed order, switch
 * chains, then call seaport.ts's now chain-parameterized fulfillOrder()
 * directly -- no new fulfillment logic beyond what already exists for
 * Robinhood Chain, just a different `chain` argument.
 */
import { fulfillOrder, type FulfillableOrder, type SeaportChain } from "@/lib/market/seaport";
import type { InputCriteria } from "@opensea/seaport-js/lib/types";
import {
  FOREIGN_SEAPORT_ADDRESS,
  chainDisplayName,
  foreignChainByChainSlug,
  foreignRpcUrls,
} from "@/lib/market/multichain/trading/foreign-chain-registry";

function seaportChainFor(chainSlug: string): SeaportChain {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) throw new Error(`native-fulfill: "${chainSlug}" is not a supported foreign chain.`);
  return {
    chainSlug,
    chainId: chain.chainId,
    chainName: chainDisplayName(chainSlug),
    nativeCurrencySymbol: chain.nativeCurrencySymbol,
    rpcUrl: foreignRpcUrls(chainSlug)[0],
    blockExplorerUrl: chain.blockExplorerUrl,
    seaportAddress: FOREIGN_SEAPORT_ADDRESS,
  };
}

/**
 * Fetches the real signed order by id (the same server-only proxy route
 * Robinhood-chain fulfillment already uses -- native-order/route.ts is
 * chain-agnostic by construction, see its own header) and fulfills it
 * directly against Seaport on the target foreign chain.
 */
export async function fulfillMarketplankNativeOrder(
  chainSlug: string,
  orderId: string,
  kind: "listing" | "offer",
  /** TRAIT-criteria offers only -- the concrete token id + Merkle proof from assertAcceptableTraitOffer (lib/market/seaport.ts). Never construct ad hoc. */
  considerationCriteria?: InputCriteria[]
): Promise<{ order: unknown | null; txHashes: string[] }> {
  const res = await fetch(`/api/market/native-order?id=${encodeURIComponent(orderId)}&kind=${kind}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || `Could not load order ${orderId}.`);
  }
  const { rawOrder } = (await res.json()) as { rawOrder: FulfillableOrder };

  const { getEthereumProvider } = await import("@/lib/wallet");
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const accountAddress = accounts[0];
  if (!accountAddress) throw new Error("No connected account.");

  return fulfillOrder(rawOrder, accountAddress, considerationCriteria, seaportChainFor(chainSlug));
}
