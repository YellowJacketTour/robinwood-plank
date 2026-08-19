/**
 * Marketplank-native BUNDLE listings on the foreign EVM chains -- roadmap
 * item #7 (see this session's conversation), same non-custodial pattern as
 * native-orders/route.ts (which this closely mirrors), just for
 * validateBundleListingOrder's multi-item shape and
 * lib/market/bundle-orders-store.ts's separate table.
 */
import { MARKETPLANK_NATIVE_LISTING_FEE_BPS } from "@/lib/constants";
import { ethCallForeignFree, ethGetCodeForeignFree } from "@/lib/market/fetch-rpc";
import type { Rpc } from "@/lib/market/signature";
import { verifyOrderSignature } from "@/lib/market/signature";
import { OrderValidationError, validateBundleListingOrder } from "@/lib/market/order-validation";
import { FOREIGN_SEAPORT_ADDRESS, foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getTrackedCollection } from "@/lib/market/multichain/store";
import {
  countBundleListingsByMaker,
  getBundleListings,
  putBundleListing,
  type BundleListing,
} from "@/lib/market/bundle-orders-store";
import type { MarketCollection } from "@/lib/market/types";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Deliberately small -- a bundle is a bigger, rarer commitment than a
// single listing, so a spammer gets far less mileage from flooding this
// table than market_orders'. Separate cap from MAX_ORDERS_PER_MAKER
// (native-orders/route.ts) since these are independent tables/concerns.
const MAX_BUNDLES_PER_MAKER = 20;
const MAX_BUNDLE_ITEMS = 20;
const MAX_BUNDLE_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

type PostBody = {
  chainSlug?: unknown;
  contractAddress?: unknown;
  rawOrder?: unknown;
};

async function ownsAllTokensOnChain(chainSlug: string, contractAddress: string, tokenIds: string[], maker: string): Promise<boolean> {
  for (const tokenId of tokenIds) {
    try {
      const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
      const result = await ethCallForeignFree(chainSlug, contractAddress, `0x6352211e${idHex}`); // ownerOf
      if (!result || result.length < 66) return false;
      const owner = `0x${result.slice(-40)}`;
      if (owner.toLowerCase() !== maker.toLowerCase()) return false;
    } catch {
      return false; // fail closed, same posture as native-orders' ownsTokenOnChain
    }
  }
  return true;
}

function foreignRpc(chainSlug: string): Rpc {
  return {
    getCode: (address: string) => ethGetCodeForeignFree(chainSlug, address),
    call: (to: string, data: string) => ethCallForeignFree(chainSlug, to, data),
  };
}

export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-multichain-native-bundle-orders-get", limit: 120, windowMs: 60_000 });
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const chainSlug = searchParams.get("chainSlug");
    const contractAddress = searchParams.get("contractAddress");
    if (!chainSlug || !contractAddress) {
      return publicJson({ error: "BAD_REQUEST", message: "chainSlug and contractAddress are required." }, 400);
    }
    if (!foreignChainByChainSlug(chainSlug)) {
      return publicJson({ error: "BAD_CHAIN", message: `"${chainSlug}" is not a supported foreign chain.` }, 400);
    }
    const collectionSlug = `${chainSlug}:${contractAddress.toLowerCase()}`;
    const bundles = await getBundleListings(chainSlug, collectionSlug);
    return publicJson({ bundles: bundles.map(({ ...b }) => b) });
  } catch (err) {
    return publicError(err, "Failed to load native bundle listings.");
  }
}

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-multichain-native-bundle-orders-post", limit: 15, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<PostBody>(req);

    const chainSlug = typeof body.chainSlug === "string" ? body.chainSlug : "";
    const chain = foreignChainByChainSlug(chainSlug);
    if (!chain) {
      return publicJson({ error: "BAD_CHAIN", message: `"${chainSlug}" is not a supported foreign chain.` }, 400);
    }

    const contractAddress = typeof body.contractAddress === "string" ? body.contractAddress.toLowerCase() : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
      return publicJson({ error: "BAD_CONTRACT", message: "contractAddress must be a real address." }, 400);
    }
    const tracked = await getTrackedCollection(chainSlug, contractAddress);
    if (!tracked) {
      return publicJson({ error: "BAD_COLLECTION", message: "This collection isn't tracked on this chain yet." }, 400);
    }

    const slug = `${chainSlug}:${contractAddress}`;
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

    let derived;
    try {
      derived = validateBundleListingOrder(body.rawOrder, collection, MAX_BUNDLE_ITEMS);
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
    if (expiryMs > Date.now() + MAX_BUNDLE_LIFETIME_MS) {
      return publicJson({ error: "BAD_EXPIRY", message: "Order expiry is too far out." }, 400);
    }

    if ((await countBundleListingsByMaker(derived.maker)) >= MAX_BUNDLES_PER_MAKER) {
      return publicJson({ error: "TOO_MANY", message: "You have too many open bundle listings." }, 429);
    }

    if (!(await ownsAllTokensOnChain(chainSlug, contractAddress, derived.tokenIds, derived.maker))) {
      return publicJson({ error: "NOT_OWNER", message: "You don't own every token in this bundle on this chain." }, 400);
    }

    const listing: BundleListing = {
      id: `native-bundle-${chainSlug}-${contractAddress}-${derived.maker}-${Date.now()}`,
      chainSlug,
      chainId: chain.chainId,
      collectionSlug: slug,
      maker: derived.maker,
      tokenIds: derived.tokenIds,
      priceWei: derived.priceWei,
      expiresAt: derived.expiresAt,
    };
    await putBundleListing(listing, body.rawOrder);
    return publicJson({ listing });
  } catch (err) {
    return publicError(err, "Unexpected error storing native bundle listing.");
  }
}
