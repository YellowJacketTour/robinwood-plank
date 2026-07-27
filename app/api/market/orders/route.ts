import { getCollection } from "@/lib/market/collections";
import {
  getListings,
  getOffers,
  putListing,
  putOffer,
} from "@/lib/market/orders-store";
import type { Listing, Offer } from "@/lib/market/types";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PostBody = {
  kind: "listing" | "offer";
  collectionSlug?: string;
  tokenId?: string;
  traits?: Array<{ traitType: string; value: string }>;
  maker?: string;
  priceWei?: string;
  expiresAt?: string;
  /** The full Seaport order object + signature, as returned by seaport-js's executeAllActions(). */
  rawOrder?: unknown;
};

function isAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
}

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-orders-get", limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const collectionSlug = searchParams.get("collection") ?? undefined;
  const kind = searchParams.get("kind") === "offer" ? "offer" : "listing";

  const items = kind === "offer" ? await getOffers(collectionSlug) : await getListings(collectionSlug);
  return publicJson({ kind, items });
}

/**
 * Store a signed order. The server never builds or modifies an order — it
 * only accepts one the maker already signed client-side (lib/market/seaport.ts)
 * and re-validates the parts that matter before storing it.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-orders-post", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<PostBody>(req);

    if (body.kind !== "listing" && body.kind !== "offer") {
      return publicJson({ error: "BAD_KIND", message: "kind must be listing or offer." }, 400);
    }
    if (!body.collectionSlug || !getCollection(body.collectionSlug)) {
      return publicJson(
        { error: "BAD_COLLECTION", message: "Unknown or unlisted collection." },
        400
      );
    }
    if (!isAddress(body.maker)) {
      return publicJson({ error: "BAD_MAKER", message: "maker must be a valid address." }, 400);
    }
    if (!body.priceWei || !/^\d+$/.test(body.priceWei) || body.priceWei === "0") {
      return publicJson(
        { error: "BAD_PRICE", message: "priceWei must be a positive integer string." },
        400
      );
    }
    if (!body.expiresAt || Number.isNaN(Date.parse(body.expiresAt))) {
      return publicJson({ error: "BAD_EXPIRY", message: "expiresAt must be a valid date." }, 400);
    }
    if (!body.rawOrder || typeof body.rawOrder !== "object") {
      return publicJson({ error: "BAD_ORDER", message: "rawOrder is required." }, 400);
    }

    const id = `${body.kind}-${body.collectionSlug}-${body.maker}-${Date.now()}`;

    if (body.kind === "listing") {
      if (!body.tokenId) {
        return publicJson({ error: "BAD_TOKEN", message: "tokenId is required for a listing." }, 400);
      }
      const listing: Listing = {
        id,
        collectionSlug: body.collectionSlug,
        tokenId: body.tokenId,
        maker: body.maker,
        priceWei: body.priceWei,
        expiresAt: body.expiresAt,
        kind: "fixed",
      };
      await putListing(listing, body.rawOrder);
      return publicJson({ listing });
    }

    const offer: Offer = {
      id,
      collectionSlug: body.collectionSlug,
      tokenId: body.tokenId,
      traits: body.traits,
      maker: body.maker,
      priceWei: body.priceWei,
      expiresAt: body.expiresAt,
    };
    await putOffer(offer, body.rawOrder);
    return publicJson({ offer });
  } catch (err) {
    return publicError(err, "Unexpected error storing order.");
  }
}
