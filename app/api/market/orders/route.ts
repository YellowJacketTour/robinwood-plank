import { MARKET_OFFER_CURRENCY } from "@/lib/constants";
import type { NormalisedForeignListing } from "@/lib/market/foreign-listings";
import { ethCallFree } from "@/lib/market/fetch-rpc";
import { getCollection } from "@/lib/market/collections";
import { resolveTokenImage } from "@/lib/market/token-image";
import {
  countOrdersByMaker,
  getListingRawOrder,
  getListings,
  getOfferRawOrder,
  getOffers,
  putListing,
  putOffer,
  removeListing,
  removeOffer,
  retireOrder,
  totalOrderCount,
} from "@/lib/market/orders-store";
import { getOrderLiveness, splitLiveOrders, computeOrderHash } from "@/lib/market/order-status";
import { markOrderServed } from "@/lib/market/served-orders";
import { verifyOrderSignature } from "@/lib/market/signature";
import { getVerifiedCriteriaTokenIds } from "@/lib/market/trait-index";
import {
  clausesToTraitLabels,
  parseCriteriaFromBody,
} from "@/lib/market/trait-criteria";
import { verifyMessage } from "ethers";

/** Message an offerer signs (personal_sign) to authorize deleting their own
 * order. Bound to the order id so a captured proof can't remove another. */
function deleteMessage(id: string): string {
  return `marketplank:delete-order:${id}`;
}
import {
  OrderValidationError,
  hasConfiguredRoyaltyConsideration,
  validateListingOrder,
  validateOfferOrder,
} from "@/lib/market/order-validation";
import type { Listing, Offer } from "@/lib/market/types";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Caps to keep a spammer from filling the store (and our KV bill). */
const MAX_ORDERS_TOTAL = 5_000;
const MAX_ORDERS_PER_MAKER = 100;
/** No order may sit in the book longer than this. */
const MAX_ORDER_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

type PostBody = {
  kind?: unknown;
  collectionSlug?: unknown;
  /**
   * NOTE: price, tokenId and maker are deliberately NOT read from the client.
   * They are derived from the signed order — see lib/market/order-validation.ts
   * for why (a client-supplied price could differ from the signed one, which
   * is how a marketplace robs its own users).
   */
  rawOrder?: unknown;
  /**
   * CRITERIA BID: labels only — token-id snapshot comes from the server's
   * verified trait index (AND of traits + optional rarity tier). Merkle root
   * on the signed order must match exactly. Accepts legacy `trait`, or
   * `traits` / `rarityTier` / nested `criteria`.
   */
  trait?: unknown;
  traits?: unknown;
  rarityTier?: unknown;
  criteria?: unknown;
};

function annotateRoyaltyEnforcement<T extends {
  collectionSlug: string;
  rawOrder: unknown;
  royaltyEnforced?: boolean;
}>(items: T[]): T[] {
  return items.map((item) => {
    const collection = getCollection(item.collectionSlug);
    return {
      ...item,
      royaltyEnforced:
        item.royaltyEnforced === true ||
        Boolean(collection && hasConfiguredRoyaltyConsideration(item.rawOrder, collection)),
    };
  });
}

export async function GET(req: Request) {
  try {
    return await handleGet(req);
  } catch (err) {
    // POST and DELETE have always wrapped; GET never did, so any throw here
    // escaped into the framework and surfaced as a 500 with an EMPTY body and
    // no content-type — which is close to undebuggable from the outside, and
    // cost two production rollbacks to track down. A readable JSON error is
    // the difference between "the book is broken" and knowing why.
    return publicError(err, "Failed to load the order book.");
  }
}

async function handleGet(req: Request) {
  const limited = rateLimit(req, { key: "market-orders-get", limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const collectionSlug = searchParams.get("collection") ?? undefined;
  const kind = searchParams.get("kind") === "offer" ? "offer" : "listing";

  const items =
    kind === "offer" ? await getOffers(collectionSlug) : await getListings(collectionSlug);
  // Drop orders that are dead on-chain (cancelled / filled / counter-advanced /
  // seller no longer holds or approves the token) so users never click a
  // listing that is guaranteed to revert. Cached server-side; unknown-liveness
  // rows are kept rather than hiding the whole book during an RPC outage
  // (audit finding 4).
  const { live, dead } = await splitLiveOrders(
    items as Array<{ id?: string; rawOrder?: unknown }>
  );

  // Retire them for good rather than hiding them on every request. Hiding alone
  // meant a seller who reacquired the token would have a stale listing silently
  // reappear at its old price. Fire-and-forget: the response must not wait on a
  // write, and a failed retirement just means we hide it again next time.
  for (const { item, reason } of dead) {
    if (!item.id) continue;
    void retireOrder(item.id).catch(() => {
      /* retried on the next read */
    });
    console.info(`[orders] retired ${item.id} (${reason})`);
  }

  // Listings only. Offers stay ours alone — a foreign offer is not something a
  // holder can accept from here, so surfacing one would be a dead end.
  const annotatedLive = annotateRoyaltyEnforcement(live as Array<{
    collectionSlug: string;
    rawOrder: unknown;
    royaltyEnforced?: boolean;
  }>);
  if (kind === "offer") return publicJson({ kind, items: annotatedLive });

  const { readOpenSeaListings } = await import("@/lib/market/opensea");
  const { readPulpListings } = await import("@/lib/market/pulp");
  const { mergeBook } = await import("@/lib/market/book");

  /**
   * Read one venue's cached rows without letting it affect the request.
   *
   * Each venue swallows its own failure, so one marketplace being unreadable
   * never removes another's rows. The TIMEOUT is the important part: this
   * route is already the most expensive read in the app on a cold start
   * (on-chain liveness for every one of our own orders), and the venue reads
   * are the cheapest thing in it — single cached-value lookups, ~5ms warm.
   * Bounding them guarantees that stays true, so adding a marketplace can
   * never be what tips this endpoint over a proxy timeout.
   *
   * Falling back to [] rather than failing: a book missing one venue's rows
   * is degraded, a book that does not load at all is broken.
   */
  const readVenue = async (
    label: string,
    read: () => Promise<NormalisedForeignListing[]>
  ): Promise<NormalisedForeignListing[]> => {
    try {
      return await Promise.race([
        read(),
        new Promise<NormalisedForeignListing[]>((resolve) =>
          setTimeout(() => {
            console.warn(`[market/orders] ${label} listings read timed out; serving without them`);
            resolve([]);
          }, 2_000)
        ),
      ]);
    } catch {
      return [];
    }
  };

  // Sequential, not Promise.all: these are milliseconds each, and running
  // them in parallel doubles the concurrent Postgres connections this route
  // holds against a pool whose default max is 4. There is nothing to win and
  // a contention mode to lose.
  const foreign = [
    ...(await readVenue("opensea", readOpenSeaListings)),
    ...(await readVenue("pulp", readPulpListings)),
  ];

  // Serve foreign listings OUR artwork. The collection image map already holds
  // every token, built by the cron from Blockscout + IPFS, so there is no
  // reason to depend on a marketplace for a picture we own — and without it
  // every foreign row falls back to the collection logo and the grid looks
  // broken.
  let imageByTokenId: Record<string, string> | undefined;
  if (foreign.length > 0) {
    try {
      const { getCollectionImageMap } = await import("@/lib/market/collection-index");
      const { NFT_CONTRACT_ADDRESS } = await import("@/lib/mint-contract");
      const { resolveIpfsUrl } = await import("@/lib/ipfs");
      const map = await getCollectionImageMap(NFT_CONTRACT_ADDRESS);
      // The index stores the RAW `ipfs://…` URI. A browser cannot load that, and
      // a raw gateway URL in <img src> is blocked by ORB — so resolve to our
      // same-origin proxy path here, exactly like our own listings do. Skipping
      // this is what left every OpenSea row with a blank card in production.
      // resolveIpfsUrl is idempotent, so an already-proxied value passes through.
      imageByTokenId = Object.fromEntries(
        Object.entries(map ?? {}).map(([id, rec]) => [
          id,
          rec?.imageUri ? resolveIpfsUrl(rec.imageUri) : "",
        ])
      );
    } catch {
      // No index yet — cards fall back to the collection logo, as before.
    }
  }

  const merged = mergeBook(
    annotatedLive as unknown as import("@/lib/market/types").Listing[],
    foreign,
    collectionSlug ?? "robinwood",
    imageByTokenId
  );

  // Normalise EVERY row's image, not just the ones the index supplied. Our own
  // listings carry whatever imageUrl was resolved when they were signed, and
  // some older rows stored a raw `https://gateway.pinata.cloud/…` URL — which
  // renders today but bypasses our proxy, so it is exposed to ORB and to that
  // gateway's uptime and rate limits. Measured on production: 2 of 61 rows.
  // resolveIpfsUrl is idempotent, so already-proxied rows pass through
  // untouched and this cannot double-wrap.
  const { resolveIpfsUrl } = await import("@/lib/ipfs");
  for (const item of merged) {
    if (item.imageUrl) item.imageUrl = resolveIpfsUrl(item.imageUrl);
  }

  return publicJson({ kind, items: merged });
}

/**
 * Drop an order that is already dead on-chain.
 *
 * Deliberately not "delete my order": that would let anyone remove anyone
 * else's listing. Instead the caller supplies only an id, and the order is
 * removed *only if Seaport itself reports it cancelled, filled, or invalidated
 * by a counter bump*. Nothing is taken on trust, so this cannot be used to
 * grief a competitor's listing — you would have to cancel it on-chain first,
 * which only its offerer can do.
 *
 * Fails closed when the RPC is unreachable: an unavailable node is not
 * evidence that an order is dead.
 */
export async function DELETE(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-orders-del", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) {
      return publicJson({ error: "BAD_ID", message: "id is required." }, 400);
    }

    const isOffer = id.startsWith("offer-");
    const rawOrder = isOffer ? await getOfferRawOrder(id) : await getListingRawOrder(id);
    if (!rawOrder) {
      // Already gone — nothing to do, and saying so is not an error.
      return publicJson({ removed: false, reason: "not-found" });
    }

    // (audit finding 2, corrected by a later security review) A forged /
    // never-signed order is never "dead" on-chain, so the on-chain-dead path
    // alone can never remove it — letting 100 forged orders permanently
    // exhaust MAX_ORDERS_PER_MAKER against a victim who then cannot list.
    //
    // The original fix here purged on `signatureFailsOffline` alone — an
    // OFFLINE ecrecover check. That is wrong for contract-wallet (EIP-1271)
    // orders: a Safe/smart-account order recovers to a random EOA under
    // plain ecrecover and would ALWAYS look "forged" by that check, even
    // when it is a perfectly genuine order. Since this endpoint requires no
    // proof of identity to call, that meant ANYONE could delete ANY
    // contract-wallet listing on demand — an unauthenticated deletion bug,
    // not just a false positive. Fixed to run the SAME fail-closed verifier
    // POST uses (on-chain EIP-1271 check included), and to purge only on a
    // genuine, non-transient failure — an RPC hiccup must never be grounds
    // to delete a listing that may be perfectly valid (see `transient` on
    // VerifyResult).
    const verified = await verifyOrderSignature(rawOrder);
    if (!verified.ok && !verified.transient) {
      if (isOffer) await removeOffer(id);
      else await removeListing(id);
      return publicJson({ removed: true, reason: "forged" });
    }

    // (audit finding 2c) Let the genuine offerer delete their own order by
    // proving control of the address, without waiting for an on-chain cancel.
    // The proof is a personal_sign over a message bound to this exact order id,
    // so it cannot be replayed against a different order.
    const proof =
      searchParams.get("proof") ||
      (typeof (rawOrder as { __deleteProof?: unknown })?.__deleteProof === "string"
        ? (rawOrder as { __deleteProof?: string }).__deleteProof
        : null);
    const offerer = (rawOrder as { parameters?: { offerer?: string } })?.parameters?.offerer;
    if (proof && typeof offerer === "string") {
      try {
        const recovered = verifyMessage(deleteMessage(id), proof);
        if (recovered.toLowerCase() === offerer.toLowerCase()) {
          if (isOffer) await removeOffer(id);
          else await removeListing(id);
          return publicJson({ removed: true, reason: "owner" });
        }
      } catch {
        // Bad proof — fall through to the on-chain-dead path. Fail closed:
        // an unparseable proof never authorizes removal.
      }
    }

    const liveness = await getOrderLiveness(rawOrder);
    if (!liveness.known) {
      return publicJson(
        { error: "UNVERIFIED", message: "Couldn't confirm order status on-chain." },
        503
      );
    }
    if (!liveness.dead) {
      return publicJson(
        { error: "STILL_LIVE", message: "That order is still fillable." },
        409
      );
    }

    if (isOffer) await removeOffer(id);
    else await removeListing(id);
    return publicJson({ removed: true, reason: liveness.reason });
  } catch (err) {
    return publicError(err, "Unexpected error removing order.");
  }
}

/** Confirms the maker actually holds the token they are trying to list. */
async function ownsToken(
  contractAddress: string,
  tokenId: string,
  maker: string
): Promise<boolean> {
  try {
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    // Free endpoints only, but with failover and caching — this used to post to
    // a single hardcoded public URL, so one endpoint hiccuping meant a real
    // owner could not list (the fail-closed branch below). It stays off the
    // metered provider deliberately: a security read must not be able to
    // escalate onto a paid endpoint under load.
    const result = await ethCallFree(contractAddress, `0x6352211e${idHex}`); // ownerOf
    if (!result || result.length < 66) return false;
    const owner = `0x${result.slice(-40)}`;
    return owner.toLowerCase() === maker.toLowerCase();
  } catch {
    // FAIL CLOSED (audit finding 5). Previously this returned `true` on any RPC
    // error, so a single unauthenticated RPC hiccup decided whether a listing
    // was real — an attacker who can nudge the node into errors could seed
    // listings for tokens the "maker" does not hold. A junk row that misleads
    // buyers is a real harm; refusing to list on an unverifiable owner is the
    // safe default. The maker can retry once the RPC recovers.
    return false;
  }
}

/**
 * Record this order's canonical Seaport hash as "ours" — the only honest
 * basis for Activity later labeling a fill "Marketplank" (see
 * lib/market/served-orders.ts for why "executed via our Seaport instance"
 * alone is not evidence: that contract is shared protocol infrastructure,
 * not ours to claim). Best-effort: a failure here must never break order
 * creation, so this never throws into its caller.
 */
async function recordServed(rawOrder: unknown): Promise<void> {
  try {
    const hash = await computeOrderHash(rawOrder);
    if (hash) await markOrderServed(hash);
  } catch {
    // Non-fatal — the order was already stored; a missed attribution
    // record only means a future fill of it under-counts as "Marketplank"
    // rather than mis-counts as someone else's, which is the safe direction.
  }
}

/**
 * Store a signed order. The server never builds or alters an order — it
 * accepts one the maker already signed client-side, re-derives every
 * displayed field from that signature's payload, and rejects anything whose
 * contents don't match the collection it claims to belong to.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-orders-post", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<PostBody>(req);

    const kind = body.kind === "offer" ? "offer" : body.kind === "listing" ? "listing" : null;
    if (!kind) {
      return publicJson({ error: "BAD_KIND", message: "kind must be listing or offer." }, 400);
    }

    const slug = typeof body.collectionSlug === "string" ? body.collectionSlug : "";
    const collection = getCollection(slug);
    if (!collection) {
      return publicJson(
        { error: "BAD_COLLECTION", message: "Unknown or unlisted collection." },
        400
      );
    }

    // ── CRITERIA BID: resolve labels against the SERVER's verified index.
    // Snapshot never comes from the client; signed root must match exactly.
    let traitLabels: Array<{ traitType: string; value: string }> | null = null;
    let traitTokenIds: string[] | null = null;
    const hasCriteriaInput =
      body.trait !== undefined ||
      body.traits !== undefined ||
      body.rarityTier !== undefined ||
      body.criteria !== undefined;
    if (hasCriteriaInput) {
      if (kind !== "offer") {
        return publicJson(
          { error: "BAD_ORDER", message: "Only offers can target criteria." },
          400
        );
      }
      const parsed = parseCriteriaFromBody({
        trait: body.trait,
        traits: body.traits,
        rarityTier: body.rarityTier,
        criteria: body.criteria,
      });
      if (parsed.error) {
        return publicJson({ error: "BAD_TRAIT", message: parsed.error }, 400);
      }
      if (parsed.clauses.length === 0) {
        return publicJson(
          { error: "BAD_TRAIT", message: "Add at least one trait or rarity clause." },
          400
        );
      }
      const verified = await getVerifiedCriteriaTokenIds(collection, parsed.clauses);
      if (!verified) {
        return publicJson(
          {
            error: "TRAIT_UNAVAILABLE",
            message:
              "Those criteria aren't available for bidding yet (empty match, unknown trait, or the trait index is still building).",
          },
          503
        );
      }
      traitTokenIds = verified.tokenIds;
      traitLabels = clausesToTraitLabels(parsed.clauses);
    }

    // ── Everything below comes from the signed order, not the request body ──
    let derived;
    try {
      derived =
        kind === "listing"
          ? validateListingOrder(body.rawOrder, collection)
          : validateOfferOrder(
              body.rawOrder,
              collection,
              MARKET_OFFER_CURRENCY ?? "",
              traitTokenIds ? { criteriaTokenIds: traitTokenIds } : undefined
            );
    } catch (err) {
      if (err instanceof OrderValidationError) {
        return publicJson({ error: "BAD_ORDER", message: err.message }, 400);
      }
      throw err;
    }

    // ── SIGNATURE VERIFICATION (audit finding 1) ──────────────────────────
    // The single most important check: prove the claimed offerer actually
    // signed this exact order. Without it anyone could list in a victim's name
    // with a garbage signature. Fails closed on any RPC problem — an order is
    // admitted only on positive proof (EOA ecrecover or EIP-1271 magic value)
    // AND a matching on-chain counter.
    const verified = await verifyOrderSignature(body.rawOrder);
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

    if ((await totalOrderCount()) >= MAX_ORDERS_TOTAL) {
      return publicJson({ error: "BOOK_FULL", message: "Order book is at capacity." }, 429);
    }
    if ((await countOrdersByMaker(derived.maker)) >= MAX_ORDERS_PER_MAKER) {
      return publicJson(
        { error: "TOO_MANY", message: "You have too many open orders." },
        429
      );
    }

    if (kind === "listing") {
      if (!derived.tokenId) {
        return publicJson({ error: "BAD_ORDER", message: "Listing has no token ID." }, 400);
      }
      if (!(await ownsToken(collection.contractAddress, derived.tokenId, derived.maker))) {
        return publicJson(
          { error: "NOT_OWNER", message: "You don't own that token." },
          400
        );
      }

      const listing: Listing = {
        id: `listing-${slug}-${derived.maker}-${derived.tokenId}-${Date.now()}`,
        collectionSlug: slug,
        tokenId: derived.tokenId,
        maker: derived.maker,
        priceWei: derived.priceWei,
        expiresAt: derived.expiresAt,
        kind: "fixed",
        royaltyEnforced: true,
        imageUrl: await resolveTokenImage(collection.contractAddress, derived.tokenId),
      };
      await putListing(listing, body.rawOrder);
      await recordServed(body.rawOrder);
      return publicJson({ listing });
    }

    // A criteria-labelled request whose signed order is NOT a criteria order
    // (or vice versa) must not be stored under a mismatched label.
    if (traitLabels && !derived.criteriaRoot) {
      return publicJson(
        { error: "BAD_ORDER", message: "Trait bid is not a criteria order." },
        400
      );
    }

    const offer: Offer = {
      id: `offer-${slug}-${derived.maker}-${derived.tokenId ?? (traitLabels ? "trait" : "any")}-${Date.now()}`,
      collectionSlug: slug,
      tokenId: derived.tokenId,
      maker: derived.maker,
      priceWei: derived.priceWei,
      expiresAt: derived.expiresAt,
      royaltyEnforced: true,
      imageUrl: derived.tokenId
        ? await resolveTokenImage(collection.contractAddress, derived.tokenId)
        : undefined,
      ...(traitLabels && traitTokenIds
        ? { traits: traitLabels, criteriaTokenIds: traitTokenIds }
        : {}),
    };
    await putOffer(offer, body.rawOrder);
    await recordServed(body.rawOrder);
    return publicJson({ offer });
  } catch (err) {
    return publicError(err, "Unexpected error storing order.");
  }
}
