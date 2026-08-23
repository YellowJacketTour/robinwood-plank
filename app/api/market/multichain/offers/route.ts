/**
 * Real active offers (bids) for ONE collection on a foreign chain -- the
 * Offers-tab equivalent for the multichain surface. Two real sources,
 * merged, each tagged with a real `native` flag:
 *
 * - OpenSea-sourced offers (fetchForeignCollectionOffers,
 *   lib/market/multichain/trading/foreign-orders.ts) -- VIEW-ONLY except
 *   for a plain single-token bid (`acceptable: true`). Accepting a
 *   CRITERIA OpenSea offer would need the original token-id set its
 *   Merkle root committed to, which this app has no provenance for (a
 *   foreign order sourced live from OpenSea's own book carries no such
 *   history) -- there is no safe way to reconstruct an arbitrary root's
 *   membership after the fact, so those stay view-only
 *   (`acceptable: false`).
 * - Marketplank-native offers (lib/market/orders-store.ts, via
 *   app/api/market/multichain/native-orders/route.ts) -- always
 *   `acceptable: true`, single-token AND criteria alike, since a native
 *   criteria offer's real token-id set IS stored alongside the order at
 *   creation time (Offer.criteriaTokenIds) and independently re-verified
 *   server-side at write time (see foreign-rarity-store.ts's
 *   getVerifiedForeignCriteriaTokenIds) -- real provenance the OpenSea
 *   case above lacks. Fulfillable via
 *   lib/market/multichain/trading/native-fulfill.ts's
 *   fulfillMarketplankNativeOrder(..., "offer").
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchForeignCollectionOffers, resolveOpenSeaCollectionSlug } from "@/lib/market/multichain/trading/foreign-orders";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { getOffers } from "@/lib/market/orders-store";
import { getCollectionAsync } from "@/lib/market/collections-server";
import { publicError, rateLimit } from "@/lib/security";
import { isNonEvmChainSlug, isRobinhoodChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPENSEA = "https://api.opensea.io/api/v2";
/** Same bound listings/route.ts uses for its per-token art fan-out. */
const MAX_ART_LOOKUPS = 30;

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-offers", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  const limitParam = Number(searchParams.get("limit") ?? "20");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 20;

  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }

  // Robinhood Chain's own book, same reasoning as listings/route.ts's
  // "robinhood" branch: no OpenSea equivalent exists for the home chain, so
  // native offers (lib/market/orders-store.ts) are adapted into the SAME
  // response shape this route returns for real foreign chains.
  if (isRobinhoodChainSlug(chainSlug)) {
    try {
      const collection = await getCollectionAsync(collectionSlug);
      if (!collection) {
        return NextResponse.json({ error: "NOT_FOUND", message: "Unknown Robinhood-Chain collection." }, { status: 404 });
      }
      const native = await getOffers(collectionSlug);
      const offers = native.slice(0, limit).map((o) => ({
        orderHash: o.id,
        maker: o.maker,
        priceWei: o.priceWei,
        expiresAt: o.expiresAt,
        // Native offers are always directly acceptable by the owner (no
        // foreign-orderbook provenance gap -- see the foreign branch's own
        // comment on why criteria offers stay view-only there); a native
        // offer either targets one token or is collection-wide, both fully
        // fillable through the existing native accept-offer flow.
        acceptable: true,
        // Native's Offer type (lib/market/types.ts) has no wildcard/criteria
        // concept distinct from "collection-wide" -- isWildcard has no real
        // native equivalent, so this is always false rather than guessed.
        isWildcard: false,
        tokenId: o.tokenId ?? null,
        contractAddress: collection.contractAddress,
        imageUrl: o.imageUrl ?? null,
        name: null,
      }));
      return NextResponse.json({ offers }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return publicError(error, "Failed to load Robinhood-Chain offers");
    }
  }

  // SOLANA / BITCOIN -- honest not-available state. Checked during this
  // pass: Magic Eden's documented v2 API has a real per-token
  // /tokens/{mint}/offers_received endpoint but no confirmed
  // per-COLLECTION open-bids listing endpoint (the plausible
  // /v2/collections/{symbol}/offers path returned a real 404, not a guess),
  // and UniSat's Marketplace API only documents the bid-creation flow, not
  // a browse-open-bids query. Rather than fabricate rows, this returns a
  // real empty list -- Offers stays truthfully unavailable for these two
  // chains until a real collection-wide bids source is found.
  if (isNonEvmChainSlug(chainSlug)) {
    return NextResponse.json({ offers: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!foreignChainByChainSlug(chainSlug)) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }

  try {
    const chain = foreignChainByChainSlug(chainSlug)!;
    // See resolveOpenSeaCollectionSlug's header (foreign-orders.ts) --
    // every card links here with a contract address, but OpenSea's
    // /offers/collection/{slug} endpoint needs OpenSea's own slug.
    // No OpenSea orderbook for this chain (zkSync today) -- fetchForeignCollectionOffers
    // already returns [] for that case, so this just skips the pointless slug resolve.
    const openSeaSlug =
      chain.openSeaChain && /^0x[0-9a-fA-F]{40}$/.test(collectionSlug)
        ? ((await resolveOpenSeaCollectionSlug(chain.openSeaChain, collectionSlug)) ?? collectionSlug)
        : collectionSlug;
    const orders = await fetchForeignCollectionOffers({ chainSlug, collectionSlug: openSeaSlug, limit });
    const rawOffers = orders
      .map((o) => {
        const bid = o.parameters.offer[0];
        const consideration = o.parameters.consideration[0];
        if (!bid) return null;
        // itemType 4 = ERC721_WITH_CRITERIA. identifierOrCriteria "0" is the
        // wildcard "any token in the collection" root (confirmed live: every
        // real GRiBBiTS collection-wide offer is this form) -- fulfilling it
        // needs a proof against a root with no defined membership at all,
        // the exact form native's own buildOffer calls "never proven
        // fillable." A NON-ZERO criteria root is a real trait-scoped bid
        // (ForeignOfferForm builds these) -- but accepting one needs the
        // ORIGINAL token-id set the bid's root committed to, which native
        // only has because ITS OWN DB stores the clause alongside the
        // order at creation time. A foreign offer sourced live from
        // OpenSea's public orderbook carries no such provenance -- there is
        // no safe way to reconstruct an arbitrary root's membership set
        // after the fact, so this stays view-only too, not just the
        // wildcard case.
        const isCriteria = consideration?.itemType === 4;
        return {
          orderHash: o.orderHash,
          maker: o.parameters.offerer,
          priceWei: bid.startAmount,
          expiresAt: new Date(Number(o.parameters.endTime) * 1000).toISOString(),
          acceptable: !isCriteria || (isCriteria && consideration?.identifierOrCriteria === "0"),
          isWildcard: isCriteria && consideration?.identifierOrCriteria === "0",
          tokenId: isCriteria ? null : (consideration?.identifierOrCriteria ?? null),
          contractAddress: isCriteria ? null : consideration?.token ?? null,
        };
      })
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? 1 : -1));

    // Real art for token-specific offers only -- same per-distinct-token,
    // bounded lookup listings/route.ts already does, so a single-token
    // offer renders as a real ListingCard instead of a text row.
    const specificTokenIds = [...new Set(rawOffers.filter((o) => o.tokenId).map((o) => o.tokenId!))].slice(
      0,
      MAX_ART_LOOKUPS
    );
    const key = (await pickOpenSeaKey("live"))?.apiKey ?? null;
    const artByToken = new Map<string, { imageUrl: string | null; name: string | null }>();
    if (key && specificTokenIds.length > 0) {
      const firstWithContract = rawOffers.find((o) => o.contractAddress);
      const contractAddress = firstWithContract?.contractAddress;
      if (contractAddress) {
        await Promise.all(
          specificTokenIds.map(async (tokenId) => {
            const res = await fetch(`${OPENSEA}/chain/${chain.openSeaChain}/contract/${contractAddress}/nfts/${tokenId}`, {
              headers: { "x-api-key": key, accept: "application/json" },
            });
            if (!res.ok) return;
            const data = (await res.json()) as { nft?: { name?: string; image_url?: string } };
            artByToken.set(tokenId, { imageUrl: data.nft?.image_url ?? null, name: data.nft?.name ?? null });
          })
        );
      }
    }

    const openSeaOffers = rawOffers.map((o) => ({
      ...o,
      native: false,
      imageUrl: o.tokenId ? artByToken.get(o.tokenId)?.imageUrl ?? null : null,
      name: o.tokenId ? artByToken.get(o.tokenId)?.name ?? null : null,
    }));

    // MARKETPLANK-NATIVE offers on this foreign chain -- a real gap this
    // route previously had no coverage for at all (same class of bug fixed
    // for listings in my-listings/route.ts). `acceptable: true` -- unlike
    // an OpenSea-sourced criteria offer (whose token-id set can't be
    // safely reconstructed after the fact, see the comment above), a
    // native criteria offer's real token-id set is stored alongside the
    // order at creation time (Offer.criteriaTokenIds), so it IS directly
    // fulfillable via native-fulfill.ts.
    const nativeCollectionSlug = `${chainSlug}:${collectionSlug.toLowerCase()}`;
    const nativeOffers = await getOffers(nativeCollectionSlug, chainSlug);
    const mappedNative = nativeOffers.map((o) => ({
      orderHash: o.id,
      maker: o.maker,
      priceWei: o.priceWei,
      expiresAt: o.expiresAt,
      acceptable: true,
      isWildcard: false,
      tokenId: o.tokenId ?? null,
      contractAddress: collectionSlug,
      native: true,
      imageUrl: o.imageUrl ?? null,
      name: null,
      // Present only for a criteria (trait/rarity) native offer -- the real
      // token-id set this offer's signed Merkle root committed to at
      // creation time, re-verified server-side (see this route's own
      // header). Needed client-side to compute the accepting seller's
      // fulfillment proof via assertAcceptableTraitOffer.
      criteriaTokenIds: o.criteriaTokenIds ?? null,
      traits: o.traits ?? null,
    }));

    return NextResponse.json({ offers: [...mappedNative, ...openSeaOffers] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to load multichain offers");
  }
}
