import { CHAIN, MARKET_OFFER_CURRENCY } from "@/lib/constants";
import { getCollection } from "@/lib/market/collections";
import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";
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
  totalOrderCount,
} from "@/lib/market/orders-store";
import { getOrderLiveness, filterLiveOrders } from "@/lib/market/order-status";
import { verifyOrderSignature } from "@/lib/market/signature";
import { verifyMessage } from "ethers";

/** Message an offerer signs (personal_sign) to authorize deleting their own
 * order. Bound to the order id so a captured proof can't remove another. */
function deleteMessage(id: string): string {
  return `marketplank:delete-order:${id}`;
}
import {
  OrderValidationError,
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
};

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-orders-get", limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const collectionSlug = searchParams.get("collection") ?? undefined;
  const kind = searchParams.get("kind") === "offer" ? "offer" : "listing";

  const items =
    kind === "offer" ? await getOffers(collectionSlug) : await getListings(collectionSlug);
  // Drop orders that are dead on-chain (cancelled / filled / counter-advanced)
  // so users never click a listing that is guaranteed to revert. Cached
  // server-side; unknown-liveness rows are kept rather than hiding the whole
  // book during an RPC outage (audit finding 4).
  const live = await filterLiveOrders(
    items as Array<{ id?: string; rawOrder?: unknown }>
  );
  return publicJson({ kind, items: live });
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

/**
 * Resolve a token's own artwork once, at listing time.
 *
 * Done server-side and stored with the order so the grid doesn't fire N
 * IPFS requests per render — gateways are slow and flaky, and a grid of
 * broken images reads as a scam site. Returns undefined on any failure; the
 * card falls back to the collection image.
 */
async function resolveTokenImage(
  contractAddress: string,
  tokenId: string
): Promise<string | undefined> {
  try {
    const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
    const res = await fetch(CHAIN.rpcUrls.default, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: contractAddress, data: `0xc87b56dd${idHex}` }, "latest"], // tokenURI
      }),
      cache: "no-store",
    });
    const data = (await res.json()) as { result?: string };
    if (!data.result || data.result.length < 130) return undefined;

    const hex = data.result.slice(2);
    const len = parseInt(hex.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0) return undefined;
    const tokenUri = Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
    if (!tokenUri) return undefined;

    const metadata = await fetchNftMetadata(tokenUri);
    const image = metadata?.image;
    return typeof image === "string" && image ? resolveIpfsUrl(image) : undefined;
  } catch {
    return undefined;
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
    const res = await fetch(CHAIN.rpcUrls.default, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: contractAddress, data: `0x6352211e${idHex}` }, "latest"], // ownerOf
      }),
      cache: "no-store",
    });
    const data = (await res.json()) as { result?: string };
    if (!data.result || data.result.length < 66) return false;
    const owner = `0x${data.result.slice(-40)}`;
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

    // ── Everything below comes from the signed order, not the request body ──
    let derived;
    try {
      derived =
        kind === "listing"
          ? validateListingOrder(body.rawOrder, collection)
          : validateOfferOrder(body.rawOrder, collection, MARKET_OFFER_CURRENCY ?? "");
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
        imageUrl: await resolveTokenImage(collection.contractAddress, derived.tokenId),
      };
      await putListing(listing, body.rawOrder);
      return publicJson({ listing });
    }

    const offer: Offer = {
      id: `offer-${slug}-${derived.maker}-${derived.tokenId ?? "any"}-${Date.now()}`,
      collectionSlug: slug,
      tokenId: derived.tokenId,
      maker: derived.maker,
      priceWei: derived.priceWei,
      expiresAt: derived.expiresAt,
      imageUrl: derived.tokenId
        ? await resolveTokenImage(collection.contractAddress, derived.tokenId)
        : undefined,
    };
    await putOffer(offer, body.rawOrder);
    return publicJson({ offer });
  } catch (err) {
    return publicError(err, "Unexpected error storing order.");
  }
}
