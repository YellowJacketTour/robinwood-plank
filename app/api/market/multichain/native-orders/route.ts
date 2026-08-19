/**
 * Marketplank-native listings/offers on the foreign EVM chains -- step 3 of
 * the plan (see this session's plan doc). A seller signs a real Seaport
 * order client-side (lib/market/seaport.ts's now chain-parameterized
 * buildListing/buildOffer); this route validates, verifies, checks
 * ownership, and stores it exactly like /api/market/orders does for
 * Robinhood Chain -- just against a foreign chain's collection
 * (plank_multichain_collections, not the curated MARKET_COLLECTIONS
 * allowlist) and always at MARKETPLANK_NATIVE_LISTING_FEE_BPS, never a
 * per-collection override.
 *
 * Deliberately a NEW, additive route rather than a branch bolted onto
 * /api/market/orders -- that route is shaped throughout around
 * getCollectionAsync()'s curated MarketCollection rows (criteria bids,
 * royalty annotation, OpenSea/Pulp merge); branching all of that for a
 * fundamentally different collection shape risks the kind of accidental
 * scope-widening this codebase's own audit history warns against.
 *
 * Royalty starts at 0 for every foreign-chain native listing this pass --
 * no real per-chain EIP-2981 read exists yet for collections Marketplank
 * doesn't curate. Treat a live royalty read as an explicit fast-follow, not
 * silently-assumed-safe scope creep into this route's first cut (flagged
 * to the repo owner directly when this feature was scoped, not a silent
 * decision).
 */
import { MARKETPLANK_NATIVE_LISTING_FEE_BPS } from "@/lib/constants";
import { ethCallForeignFree, ethGetCodeForeignFree } from "@/lib/market/fetch-rpc";
import type { Rpc } from "@/lib/market/signature";
import {
  countOrdersByMaker,
  getListings,
  getOffers,
  putListing,
  putOffer,
  totalOrderCount,
} from "@/lib/market/orders-store";
import { verifyOrderSignature } from "@/lib/market/signature";
import {
  OrderValidationError,
  validateListingOrder,
  validateOfferOrder,
} from "@/lib/market/order-validation";
import { FOREIGN_SEAPORT_ADDRESS, foreignChainByChainSlug, foreignOfferCurrency } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getTrackedCollection } from "@/lib/market/multichain/store";
import { getVerifiedForeignCriteriaTokenIds } from "@/lib/market/multichain/foreign-rarity-store";
import { parseCriteriaFromBody, clausesToTraitLabels } from "@/lib/market/trait-criteria";
import type { Listing, MarketCollection, Offer } from "@/lib/market/types";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Same caps as /api/market/orders -- see that route for the reasoning.
// Kept as separate local constants (not shared/exported) since the two
// routes' order books are independent capacity concerns.
const MAX_ORDERS_TOTAL = 5_000;
const MAX_ORDERS_PER_MAKER = 100;
const MAX_ORDER_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

type PostBody = {
  chainSlug?: unknown;
  kind?: unknown;
  contractAddress?: unknown;
  rawOrder?: unknown;
  /** CRITERIA OFFER: labels only -- token-id snapshot is re-resolved from THIS route's own verified foreign trait index, never trusted from the client. Same shape/precedence as /api/market/orders' own body. */
  trait?: unknown;
  traits?: unknown;
  rarityTier?: unknown;
  criteria?: unknown;
};

/** Confirms the maker actually holds the token they're trying to list, on THIS chain. */
async function ownsTokenOnChain(chainSlug: string, contractAddress: string, tokenId: string, maker: string): Promise<boolean> {
  try {
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    const result = await ethCallForeignFree(chainSlug, contractAddress, `0x6352211e${idHex}`); // ownerOf
    if (!result || result.length < 66) return false;
    const owner = `0x${result.slice(-40)}`;
    return owner.toLowerCase() === maker.toLowerCase();
  } catch {
    // FAIL CLOSED, same posture as /api/market/orders' ownsToken -- an
    // unverifiable owner must never be treated as a real one.
    return false;
  }
}

/** signature.ts's Rpc, backed by the target foreign chain instead of Robinhood Chain's defaultRpc(). */
function foreignRpc(chainSlug: string): Rpc {
  return {
    getCode: (address: string) => ethGetCodeForeignFree(chainSlug, address),
    call: (to: string, data: string) => ethCallForeignFree(chainSlug, to, data),
  };
}
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-multichain-native-orders-get", limit: 120, windowMs: 60_000 });
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const chainSlug = searchParams.get("chainSlug");
    const contractAddress = searchParams.get("contractAddress");
    const kind = searchParams.get("kind") === "offer" ? "offer" : "listing";
    if (!chainSlug || !contractAddress) {
      return publicJson({ error: "BAD_REQUEST", message: "chainSlug and contractAddress are required." }, 400);
    }
    if (!foreignChainByChainSlug(chainSlug)) {
      return publicJson({ error: "BAD_CHAIN", message: `"${chainSlug}" is not a supported foreign chain.` }, 400);
    }

    // Native orders are keyed by the synthetic slug every write in this
    // route uses (see POST below) -- foreign collections have no curated
    // MarketCollection slug, so this is the real collectionSlug column
    // value on these rows.
    const collectionSlug = `${chainSlug}:${contractAddress.toLowerCase()}`;
    const items = kind === "offer" ? await getOffers(collectionSlug, chainSlug) : await getListings(collectionSlug, chainSlug);
    return publicJson({ kind, items });
  } catch (err) {
    return publicError(err, "Failed to load native foreign-chain orders.");
  }
}

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-multichain-native-orders-post", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<PostBody>(req);

    const chainSlug = typeof body.chainSlug === "string" ? body.chainSlug : "";
    const chain = foreignChainByChainSlug(chainSlug);
    if (!chain) {
      return publicJson({ error: "BAD_CHAIN", message: `"${chainSlug}" is not a supported foreign chain.` }, 400);
    }

    const kind = body.kind === "offer" ? "offer" : body.kind === "listing" ? "listing" : null;
    if (!kind) {
      return publicJson({ error: "BAD_KIND", message: "kind must be listing or offer." }, 400);
    }

    const contractAddress = typeof body.contractAddress === "string" ? body.contractAddress.toLowerCase() : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
      return publicJson({ error: "BAD_CONTRACT", message: "contractAddress must be a real address." }, 400);
    }
    const tracked = await getTrackedCollection(chainSlug, contractAddress);
    if (!tracked) {
      return publicJson(
        { error: "BAD_COLLECTION", message: "This collection isn't tracked on this chain yet." },
        400
      );
    }

    const slug = `${chainSlug}:${contractAddress}`;
    // Adapter object matching MarketCollection's shape -- feeBps is ALWAYS
    // MARKETPLANK_NATIVE_LISTING_FEE_BPS here, never tracked.feeBps (that
    // field doesn't exist on TrackedCollection anyway -- foreign
    // collections have no per-collection fee override, every one of them
    // gets Marketplank's own native rate). royaltyBps starts at 0 -- see
    // this file's own header.
    const collection: MarketCollection = {
      slug,
      name: tracked.name ?? contractAddress,
      contractAddress,
      tokenStandard: "ERC721",
      image: tracked.imageUrl ?? "",
      trustBadges: [],
      feeBps: MARKETPLANK_NATIVE_LISTING_FEE_BPS,
      royaltyBps: 0,
      royaltyRecipient: "0x0000000000000000000000000000000000000000",
    };

    // ── CRITERIA OFFER: resolve labels against THIS route's own verified
    // foreign trait index (foreign-rarity-store.ts) -- snapshot never comes
    // from the client, matching /api/market/orders' identical discipline.
    let traitLabels: Array<{ traitType: string; value: string }> | null = null;
    let traitTokenIds: string[] | null = null;
    const hasCriteriaInput =
      body.trait !== undefined || body.traits !== undefined || body.rarityTier !== undefined || body.criteria !== undefined;
    if (hasCriteriaInput) {
      if (kind !== "offer") {
        return publicJson({ error: "BAD_ORDER", message: "Only offers can target criteria." }, 400);
      }
      const parsed = parseCriteriaFromBody({ trait: body.trait, traits: body.traits, rarityTier: body.rarityTier, criteria: body.criteria });
      if (parsed.error) {
        return publicJson({ error: "BAD_TRAIT", message: parsed.error }, 400);
      }
      if (parsed.clauses.length === 0) {
        return publicJson({ error: "BAD_TRAIT", message: "Add at least one trait or rarity clause." }, 400);
      }
      const verifiedCriteria = await getVerifiedForeignCriteriaTokenIds(chainSlug, contractAddress, parsed.clauses);
      if (!verifiedCriteria) {
        return publicJson(
          {
            error: "TRAIT_UNAVAILABLE",
            message: "Those criteria aren't available for bidding yet (empty match, unknown trait, or this collection's trait index isn't built yet).",
          },
          503
        );
      }
      traitTokenIds = verifiedCriteria.tokenIds;
      traitLabels = clausesToTraitLabels(parsed.clauses);
    }

    let derived;
    try {
      derived =
        kind === "listing"
          ? validateListingOrder(body.rawOrder, collection)
          : validateOfferOrder(
              body.rawOrder,
              collection,
              foreignOfferCurrency(chainSlug) ?? "",
              traitTokenIds ? { criteriaTokenIds: traitTokenIds } : undefined
            );
    } catch (err) {
      if (err instanceof OrderValidationError) {
        return publicJson({ error: "BAD_ORDER", message: err.message }, 400);
      }
      throw err;
    }

    const verified = await verifyOrderSignature(body.rawOrder, foreignRpc(chainSlug), {
      chainId: chain.chainId,
      seaportAddress: FOREIGN_SEAPORT_ADDRESS,
    });
    if (!verified.ok) {
      return publicJson({ error: "BAD_SIGNATURE", message: verified.reason }, 400);
    }

    const expiryMs = Date.parse(derived.expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) {
      return publicJson({ error: "EXPIRED", message: "Order has already expired." }, 400);
    }
    if (expiryMs > Date.now() + MAX_ORDER_LIFETIME_MS) {
      return publicJson({ error: "BAD_EXPIRY", message: "Order expiry is too far out." }, 400);
    }

    // Global caps, shared across ALL chains (Robinhood + every foreign
    // chain) -- deliberate, see this route's plan doc: scoping either cap
    // per-chain would let a spammer get an effective 8x limit by rotating
    // chains.
    if ((await totalOrderCount()) >= MAX_ORDERS_TOTAL) {
      return publicJson({ error: "BOOK_FULL", message: "Order book is at capacity." }, 429);
    }
    if ((await countOrdersByMaker(derived.maker)) >= MAX_ORDERS_PER_MAKER) {
      return publicJson({ error: "TOO_MANY", message: "You have too many open orders." }, 429);
    }

    if (kind === "listing") {
      if (!derived.tokenId) {
        return publicJson({ error: "BAD_ORDER", message: "Listing has no token ID." }, 400);
      }
      if (!(await ownsTokenOnChain(chainSlug, contractAddress, derived.tokenId, derived.maker))) {
        return publicJson({ error: "NOT_OWNER", message: "You don't own that token on this chain." }, 400);
      }

      const listing: Listing = {
        id: `native-listing-${chainSlug}-${contractAddress}-${derived.maker}-${derived.tokenId}-${Date.now()}`,
        collectionSlug: slug,
        chainSlug,
        tokenId: derived.tokenId,
        maker: derived.maker,
        priceWei: derived.priceWei,
        expiresAt: derived.expiresAt,
        kind: "fixed",
        royaltyEnforced: true,
      };
      await putListing(listing, body.rawOrder);
      return publicJson({ listing });
    }

    if (!derived.tokenId && !derived.criteriaRoot) {
      // Collection-wide ("any") offers stay disabled -- same wildcard-
      // root stance /api/market/orders already takes (never proven
      // fillable, see buildOffer's own header). A criteria (trait/rarity)
      // offer IS supported -- it lands here with a real criteriaRoot from
      // validateOfferOrder above, not a bare tokenId.
      return publicJson({ error: "BAD_ORDER", message: "Bid on a specific token or a trait/rarity instead." }, 400);
    }
    // A criteria-labelled request whose signed order is NOT a criteria
    // order (or vice versa) must not be stored under a mismatched label.
    if (traitLabels && !derived.criteriaRoot) {
      return publicJson({ error: "BAD_ORDER", message: "Trait bid is not a criteria order." }, 400);
    }

    const offer: Offer = {
      id: `native-offer-${chainSlug}-${contractAddress}-${derived.maker}-${derived.tokenId ?? (traitLabels ? "trait" : "any")}-${Date.now()}`,
      collectionSlug: slug,
      chainSlug,
      tokenId: derived.tokenId,
      maker: derived.maker,
      priceWei: derived.priceWei,
      expiresAt: derived.expiresAt,
      royaltyEnforced: true,
      ...(traitLabels && traitTokenIds ? { traits: traitLabels, criteriaTokenIds: traitTokenIds } : {}),
    };
    await putOffer(offer, body.rawOrder);
    return publicJson({ offer });
  } catch (err) {
    return publicError(err, "Unexpected error storing native foreign-chain order.");
  }
}
