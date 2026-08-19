/**
 * Marketplank-native SWAP/OTC listings on the foreign EVM chains -- roadmap
 * item: "nft for nft trades... otc nft and coin trades for any asset
 * combination." Same non-custodial pattern as native-orders/route.ts and
 * native-bundle-orders/route.ts (which this closely mirrors), just for
 * validateSwapOrder's arbitrary-multi-contract shape and
 * lib/market/swap-orders-store.ts's separate table.
 *
 * NO getTrackedCollection GATE, UNLIKE EVERY OTHER NATIVE ROUTE
 * -----------------------------------------------------------------
 * Every other native order type requires its collection be in
 * plank_multichain_collections (this app's own discovery index) before it
 * can be listed, since that row supplies the display name/image the
 * listing needs. A swap has no single collection -- its offer and
 * consideration sides can each span multiple different contracts, some of
 * which this app may not have discovered/tracked yet (a user might
 * legitimately want to swap for an NFT from a brand-new collection).
 * Requiring every contract involved be pre-tracked would block real,
 * valid swaps for no security reason -- ownership is verified directly
 * on-chain per item below regardless of tracking status, which is the
 * actual security property that matters.
 */
import { ethCallForeignFree, ethGetCodeForeignFree } from "@/lib/market/fetch-rpc";
import type { Rpc } from "@/lib/market/signature";
import { verifyOrderSignature } from "@/lib/market/signature";
import { OrderValidationError, validateSwapOrder } from "@/lib/market/order-validation";
import { FOREIGN_SEAPORT_ADDRESS, foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import {
  countSwapListingsByMaker,
  getSwapListings,
  getSwapListingsByMaker,
  putSwapListing,
  type SwapListing,
} from "@/lib/market/swap-orders-store";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Same "bigger, rarer commitment" reasoning as MAX_BUNDLES_PER_MAKER --
// independent cap, independent table/concern.
const MAX_SWAPS_PER_MAKER = 20;
const MAX_SWAP_ITEMS_PER_SIDE = 10;
const MAX_SWAP_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

type PostBody = {
  chainSlug?: unknown;
  rawOrder?: unknown;
};

function foreignRpc(chainSlug: string): Rpc {
  return {
    getCode: (address: string) => ethGetCodeForeignFree(chainSlug, address),
    call: (to: string, data: string) => ethCallForeignFree(chainSlug, to, data),
  };
}

/** Verifies the maker owns every OFFER item -- the only side that matters at listing time (consideration items belong to whoever eventually accepts, checked at fulfillment instead). Spans however many distinct contracts are involved, unlike ownsAllTokensOnChain's single-contract loop in native-bundle-orders/route.ts. */
async function ownsAllOfferItems(
  chainSlug: string,
  items: { contractAddress: string; tokenId: string }[],
  maker: string
): Promise<boolean> {
  for (const item of items) {
    try {
      const idHex = BigInt(item.tokenId).toString(16).padStart(64, "0");
      const result = await ethCallForeignFree(chainSlug, item.contractAddress, `0x6352211e${idHex}`); // ownerOf
      if (!result || result.length < 66) return false;
      const owner = `0x${result.slice(-40)}`;
      if (owner.toLowerCase() !== maker.toLowerCase()) return false;
    } catch {
      return false; // fail closed, same posture as every other native order route
    }
  }
  return true;
}

export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-multichain-native-swap-orders-get", limit: 120, windowMs: 60_000 });
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const chainSlug = searchParams.get("chainSlug");
    if (!chainSlug) {
      return publicJson({ error: "BAD_REQUEST", message: "chainSlug is required." }, 400);
    }
    if (!foreignChainByChainSlug(chainSlug)) {
      return publicJson({ error: "BAD_CHAIN", message: `"${chainSlug}" is not a supported foreign chain.` }, 400);
    }
    const maker = searchParams.get("maker");
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;

    const swaps = maker ? await getSwapListingsByMaker(chainSlug, maker) : await getSwapListings(chainSlug, { limit });
    return publicJson({ swaps: swaps.map(({ ...s }) => s) });
  } catch (err) {
    return publicError(err, "Failed to load native swap listings.");
  }
}

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-multichain-native-swap-orders-post", limit: 15, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<PostBody>(req);

    const chainSlug = typeof body.chainSlug === "string" ? body.chainSlug : "";
    const chain = foreignChainByChainSlug(chainSlug);
    if (!chain) {
      return publicJson({ error: "BAD_CHAIN", message: `"${chainSlug}" is not a supported foreign chain.` }, 400);
    }

    let derived;
    try {
      derived = validateSwapOrder(body.rawOrder, MAX_SWAP_ITEMS_PER_SIDE);
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
    if (expiryMs > Date.now() + MAX_SWAP_LIFETIME_MS) {
      return publicJson({ error: "BAD_EXPIRY", message: "Order expiry is too far out." }, 400);
    }

    if ((await countSwapListingsByMaker(derived.maker)) >= MAX_SWAPS_PER_MAKER) {
      return publicJson({ error: "TOO_MANY", message: "You have too many open swap listings." }, 429);
    }

    if (!(await ownsAllOfferItems(chainSlug, derived.offerItems, derived.maker))) {
      return publicJson({ error: "NOT_OWNER", message: "You don't own every item you're offering." }, 400);
    }

    const listing: SwapListing = {
      id: `native-swap-${chainSlug}-${derived.maker}-${Date.now()}`,
      chainSlug,
      chainId: chain.chainId,
      maker: derived.maker,
      offerItems: derived.offerItems,
      considerationItems: derived.considerationItems,
      considerationNativeWei: derived.considerationNativeWei,
      expiresAt: derived.expiresAt,
    };
    await putSwapListing(listing, body.rawOrder);
    return publicJson({ listing });
  } catch (err) {
    return publicError(err, "Unexpected error storing native swap listing.");
  }
}
