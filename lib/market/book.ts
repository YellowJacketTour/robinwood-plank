import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { openSeaTokenUrl } from "@/lib/market/opensea";
import { pulpTokenUrl } from "@/lib/market/pulp";
import type { NormalisedForeignListing } from "@/lib/market/foreign-listings";
import type { Listing, ListingVenue } from "@/lib/market/types";

/**
 * Where a foreign row links to, per venue. Adding a marketplace means adding
 * a line here and nothing else in this file.
 *
 * Partial, not Record<ListingVenue, ...>: this map only ever needs to cover
 * the venues that actually flow through THIS RobinWood-native merge path
 * (readOpenSeaListings/readPulpListings, both scoped to RobinWood's own
 * collection). magiceden/unisat listings never reach mergeBook -- they come
 * from the separate multichain listings route
 * (app/api/market/multichain/listings/route.ts), which already stamps its
 * own externalUrl per row. The lookup below already fails soft with a
 * warning for any venue with no entry, so a Partial here is honest about
 * that, not a functional change.
 */
const EXTERNAL_URL: Partial<Record<ListingVenue, (contract: string, tokenId: string) => string>> = {
  opensea: openSeaTokenUrl,
  pulp: pulpTokenUrl,
};

/**
 * Combine our own book with every foreign venue's into one view of the market.
 *
 * The collection genuinely trades on other marketplaces, so a book showing
 * only our listings tells buyers the market is thinner and pricier than it is.
 * Showing all of them is the honest picture — but only if which is which is
 * unmistakable, so every foreign row is tagged and links out rather than
 * offering a Buy button.
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
  /** Every foreign venue's rows, already normalised and concatenated. */
  theirs: NormalisedForeignListing[],
  collectionSlug: string,
  /**
   * tokenId -> artwork URI, from our own collection index.
   *
   * Foreign listings arrive with no usable image. Left unresolved they fall
   * back to the collection logo, so a grid of foreign rows renders as
   * identical placeholders — which reads as broken, and the art is the
   * product. We already know every token's artwork: the index holds all
   * 1,542, built from Blockscout and IPFS. Never take a venue's image; we
   * have it, and theirs would be a third-party dependency for something we
   * own. (PulpMarket's is additionally a relative path on their own image
   * proxy, so it would hotlink and bypass our same-origin proxy contract.)
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

  // Stable ordering before the cheapest-wins pass. Two venues can hold the
  // same token at the SAME price, and without this the winner would depend on
  // the order the callers happened to concatenate their arrays in — so the
  // grid could reshuffle between refreshes with no data change. Venue name is
  // arbitrary but deterministic, which is the only property that matters.
  // Defensive on `venue` even though the venue modules now stamp it on read.
  // An earlier version dereferenced it directly, which threw a TypeError on
  // every stored OpenSea row written before the field existed — and took the
  // whole order book down, because a row from a cache is only ever as new as
  // the writer that wrote it.
  const foreign = [...theirs].sort((a, b) =>
    String(a.venue ?? "").localeCompare(String(b.venue ?? ""))
  );

  for (const t of foreign) {
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

    // Skip a row whose venue we have no link for rather than throwing. One
    // malformed row from one marketplace module must not take down the whole
    // order book request — the same fail-soft posture the venue modules take
    // when a marketplace is down.
    const externalUrlFor = EXTERNAL_URL[t.venue];
    if (typeof externalUrlFor !== "function") {
      // Unreachable now that both venue modules stamp on read, so this is
      // pure defence. LOUD defence: silently dropping rows here would have
      // hidden 52 real OpenSea listings behind a guard whose stated purpose
      // was to protect the book — losing the inventory it meant to save.
      console.warn(
        `[book] dropping listing for token ${t.tokenId}: unknown venue ${JSON.stringify(t.venue)}`
      );
      continue;
    }

    byToken.set(tokenId, {
      id: `${t.venue}-${collectionSlug}-${tokenId}`,
      collectionSlug,
      tokenId,
      maker: t.maker,
      priceWei: t.priceWei,
      // Not every venue publishes an end time. A far-future value keeps this
      // out of "expiring soon" treatments without inventing a deadline.
      expiresAt: t.expiresAt ?? new Date(Date.now() + 365 * 86_400_000).toISOString(),
      kind: "fixed",
      venue: t.venue,
      externalUrl: externalUrlFor(NFT_CONTRACT_ADDRESS, tokenId),
      // Ours first (already resolved at listing time), then our own index.
      ...(() => {
        const img = existing?.imageUrl || lookupImage(tokenId);
        return img ? { imageUrl: img } : {};
      })(),
    });
  }

  return [...byToken.values()];
}
