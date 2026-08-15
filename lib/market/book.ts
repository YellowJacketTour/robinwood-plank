import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import {
  openSeaTokenUrl,
  type NormalisedOpenSeaListing,
} from "@/lib/market/opensea";
import type { Listing } from "@/lib/market/types";

/**
 * Combine our own book with OpenSea's into one view of the market.
 *
 * The collection genuinely trades on both venues, so a book showing only our
 * listings tells buyers the market is thinner and pricier than it is. Showing
 * both is the honest picture — but only if which is which is unmistakable, so
 * every foreign row is tagged and links out rather than offering a Buy button.
 */

/**
 * One row per token, cheapest wins.
 *
 * A seller can list the same plank on both venues at once; both orders stay
 * valid until one fills. Rendering both would put the same item on screen twice
 * at two prices, which reads as a bug. Ours wins an exact tie: no reason to send
 * a buyer elsewhere for the same money, and our fill pays the creator royalty.
 */
export function mergeBook(
  ours: Listing[],
  theirs: NormalisedOpenSeaListing[],
  collectionSlug: string,
  /**
   * tokenId -> artwork URI, from our own collection index.
   *
   * Foreign listings arrive with no image. Left unresolved they fall back to
   * the collection logo, so a grid of OpenSea rows renders as identical
   * placeholders — which reads as broken, and the art is the product. We
   * already know every token's artwork: the index holds all 1,542, built from
   * Blockscout and IPFS. Never ask OpenSea for it; we have it, theirs would be
   * a third-party dependency for something we own.
   */
  imageByTokenId?: Map<string, string> | Record<string, string>
): Listing[] {
  const lookupImage = (tokenId: string): string | undefined => {
    if (!imageByTokenId) return undefined;
    const v =
      imageByTokenId instanceof Map
        ? imageByTokenId.get(tokenId)
        : imageByTokenId[tokenId];
    return v && v.length > 0 ? v : undefined;
  };

  const byToken = new Map<string, Listing>();
  for (const l of ours) byToken.set(String(l.tokenId), l);

  for (const t of theirs) {
    const tokenId = String(t.tokenId);
    const existing = byToken.get(tokenId);
    let cheaper = true;
    if (existing) {
      try {
        cheaper = BigInt(t.priceWei) < BigInt(existing.priceWei);
      } catch {
        cheaper = false;
      }
    }
    if (!cheaper) continue;

    byToken.set(tokenId, {
      id: `opensea-${collectionSlug}-${tokenId}`,
      collectionSlug,
      tokenId,
      maker: t.maker,
      priceWei: t.priceWei,
      // OpenSea does not always give an end time. A far-future value keeps this
      // out of "expiring soon" treatments without inventing a deadline.
      expiresAt: t.expiresAt ?? new Date(Date.now() + 365 * 86_400_000).toISOString(),
      kind: "fixed",
      venue: "opensea",
      externalUrl: openSeaTokenUrl(NFT_CONTRACT_ADDRESS, tokenId),
      // Ours first (already resolved at listing time), then our own index.
      ...(() => {
        const img = existing?.imageUrl || lookupImage(tokenId);
        return img ? { imageUrl: img } : {};
      })(),
    });
  }

  return [...byToken.values()];
}
