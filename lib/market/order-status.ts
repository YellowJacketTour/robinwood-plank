import { Interface } from "ethers";
import { SEAPORT_ADDRESS } from "@/lib/constants";
import { ethCallFree } from "@/lib/market/fetch-rpc";

/**
 * On-chain order liveness, read straight from Seaport.
 *
 * Why this exists: cancelling an order on-chain does not remove it from our
 * relay, so a cancelled listing kept showing in the book. Buyers would click
 * it, sign, and watch the transaction revert — which reads as a broken
 * marketplace and burns their gas.
 *
 * The obvious fix (a "delete my order" endpoint) would let anyone delete
 * anyone else's listing, so instead nothing is taken on trust: we ask Seaport
 * whether the order is actually dead, and only then drop it. That makes
 * removal unforgeable — a griefer cannot invalidate an order they don't own,
 * because they'd have to cancel it on-chain first, which only the offerer can
 * do.
 */

const SEAPORT_ABI = new Interface([
  "function getOrderHash((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter) order) view returns (bytes32)",
  "function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)",
  "function getCounter(address offerer) view returns (uint256)",
]);

const ERC721_ABI = new Interface([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
]);

/** Seaport ERC-721 offer item type. */
const ITEM_TYPE_ERC721 = 2;

type OrderComponentsLike = {
  offerer: string;
  zone?: string;
  offer: unknown[];
  consideration: unknown[];
  orderType?: number | string;
  startTime: string | number;
  endTime: string | number;
  zoneHash?: string;
  salt?: string | number;
  conduitKey?: string;
  counter?: string | number;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "0".repeat(64);

/**
 * Free endpoints, with failover and caching.
 *
 * Liveness runs up to six eth_calls per order across the whole book, so this is
 * the highest-volume server read in the app. It posted to a single hardcoded
 * public URL: no failover, and no coalescing despite a validation pass asking
 * the same getCounter for the same offerer repeatedly. ethCallFree keeps it at
 * zero cost while adding both.
 *
 * Deliberately never the metered provider. Liveness gates whether a listing is
 * shown, so letting it escalate onto a paid endpoint would put a security read
 * on the bill precisely when the book is busiest.
 */
async function ethCallTo(to: string, data: string): Promise<string | null> {
  try {
    return await ethCallFree(to, data);
  } catch {
    return null;
  }
}

async function ethCall(data: string): Promise<string | null> {
  return ethCallTo(SEAPORT_ADDRESS, data);
}

/** The single ERC-721 being sold, or null if this order isn't that shape. */
function erc721OfferItem(
  p: OrderComponentsLike
): { token: string; tokenId: string } | null {
  const offer = Array.isArray(p.offer) ? p.offer : [];
  if (offer.length !== 1) return null;
  const item = offer[0] as {
    itemType?: number | string;
    token?: string;
    identifierOrCriteria?: string | number;
  };
  if (Number(item?.itemType) !== ITEM_TYPE_ERC721) return null;
  if (!item.token || item.identifierOrCriteria == null) return null;
  return { token: item.token, tokenId: String(item.identifierOrCriteria) };
}

/**
 * Can Seaport still pull this token from the offerer at fill time?
 *
 * Seaport's own getOrderStatus knows nothing about this: an order stays
 * "valid" after the seller transfers the NFT away or revokes approval, and
 * only reverts when someone actually tries to buy it. Measured on production
 * 2026-07-31, 9 of 29 live listings (31%) were unfillable for exactly this
 * reason — every one of them a seller who had moved the token on. Buyers
 * experienced that as "the Buy button doesn't work".
 *
 * Returns null when the chain could not be read, so callers keep failing open
 * rather than hiding a listing on an RPC hiccup.
 */
async function canStillTransfer(
  offerer: string,
  token: string,
  tokenId: string
): Promise<boolean | null> {
  let id: bigint;
  try {
    id = BigInt(tokenId);
  } catch {
    return null;
  }

  const ownerRes = await ethCallTo(
    token,
    ERC721_ABI.encodeFunctionData("ownerOf", [id])
  );
  // A burned or nonexistent token reverts ownerOf and returns "0x" — that is a
  // definitive "not fillable", not an unknown.
  if (ownerRes === null) return null;
  if (ownerRes === "0x") return false;

  let owner: string;
  try {
    [owner] = ERC721_ABI.decodeFunctionResult("ownerOf", ownerRes) as unknown as [string];
  } catch {
    return null;
  }
  if (owner.toLowerCase() !== offerer.toLowerCase()) return false;

  // Marketplank only ever produces zero-conduit orders, so Seaport itself is
  // the operator that must be approved (see lib/market/order-validation.ts).
  const allRes = await ethCallTo(
    token,
    ERC721_ABI.encodeFunctionData("isApprovedForAll", [offerer, SEAPORT_ADDRESS])
  );
  if (allRes === null) return null;
  if (allRes !== "0x") {
    try {
      const [approved] = ERC721_ABI.decodeFunctionResult(
        "isApprovedForAll",
        allRes
      ) as unknown as [boolean];
      if (approved) return true;
    } catch {
      /* fall through to the per-token check */
    }
  }

  const oneRes = await ethCallTo(
    token,
    ERC721_ABI.encodeFunctionData("getApproved", [id])
  );
  if (oneRes === null) return null;
  if (oneRes === "0x") return false;
  try {
    const [operator] = ERC721_ABI.decodeFunctionResult(
      "getApproved",
      oneRes
    ) as unknown as [string];
    return operator.toLowerCase() === SEAPORT_ADDRESS.toLowerCase();
  } catch {
    return null;
  }
}

export type OrderLiveness =
  | {
      known: true;
      dead: true;
      reason: "cancelled" | "filled" | "counter-advanced" | "not-owned" | "not-approved";
    }
  | { known: true; dead: false }
  /** RPC unavailable — caller must not treat this as permission to delete. */
  | { known: false };

/**
 * Ask Seaport whether an order can still be filled.
 *
 * Returns `known: false` on any RPC problem. Callers must fail closed on that:
 * an unreachable node is not evidence that an order is dead.
 */
/**
 * The canonical Seaport order hash for a raw order — asks Seaport itself
 * rather than re-deriving the struct hash locally, so this can never drift
 * from what the contract actually computes. Returns null on any failure
 * (malformed order, unreachable RPC) — callers must not treat null as "no
 * hash" in a way that admits or attributes anything.
 */
export async function computeOrderHash(rawOrder: unknown): Promise<string | null> {
  const order = rawOrder as { parameters?: OrderComponentsLike } | null;
  const p = order?.parameters;
  if (!p || !p.offerer) return null;

  const components = {
    offerer: p.offerer,
    zone: p.zone ?? ZERO_ADDRESS,
    offer: p.offer ?? [],
    consideration: p.consideration ?? [],
    orderType: Number(p.orderType ?? 0),
    startTime: String(p.startTime ?? 0),
    endTime: String(p.endTime ?? 0),
    zoneHash: p.zoneHash ?? ZERO_HASH,
    salt: String(p.salt ?? 0),
    conduitKey: p.conduitKey ?? ZERO_HASH,
    counter: String(p.counter ?? 0),
  };

  try {
    const encoded = SEAPORT_ABI.encodeFunctionData("getOrderHash", [components]);
    const result = await ethCall(encoded);
    if (!result || result === "0x") return null;
    const [hash] = SEAPORT_ABI.decodeFunctionResult("getOrderHash", result) as unknown as [string];
    return hash;
  } catch {
    return null;
  }
}

export async function getOrderLiveness(rawOrder: unknown): Promise<OrderLiveness> {
  const order = rawOrder as { parameters?: OrderComponentsLike } | null;
  const p = order?.parameters;
  if (!p || !p.offerer) return { known: false };

  const orderHash = await computeOrderHash(rawOrder);
  if (!orderHash) return { known: false };

  try {
    const statusCall = SEAPORT_ABI.encodeFunctionData("getOrderStatus", [orderHash]);
    const statusRes = await ethCall(statusCall);
    if (!statusRes || statusRes === "0x") return { known: false };
    const [, isCancelled, totalFilled, totalSize] = SEAPORT_ABI.decodeFunctionResult(
      "getOrderStatus",
      statusRes
    ) as unknown as [boolean, boolean, bigint, bigint];

    if (isCancelled) return { known: true, dead: true, reason: "cancelled" };
    if (totalSize > BigInt(0) && totalFilled >= totalSize) {
      return { known: true, dead: true, reason: "filled" };
    }

    // A bulk cancel works by incrementing the offerer's counter, which
    // invalidates every order signed against the old one without touching
    // their individual statuses.
    const counterCall = SEAPORT_ABI.encodeFunctionData("getCounter", [p.offerer]);
    const counterRes = await ethCall(counterCall);
    if (counterRes && counterRes !== "0x") {
      const [current] = SEAPORT_ABI.decodeFunctionResult("getCounter", counterRes) as unknown as [bigint];
      if (current !== BigInt(String(p.counter ?? 0))) {
        return { known: true, dead: true, reason: "counter-advanced" };
      }
    }

    // Seaport says the order is valid. That is necessary but not sufficient:
    // it has no idea whether the offerer still holds the token or still
    // approves Seaport to move it. Check the collection directly.
    const item = erc721OfferItem(p);
    if (item) {
      const transferable = await canStillTransfer(p.offerer, item.token, item.tokenId);
      if (transferable === false) {
        return { known: true, dead: true, reason: "not-owned" };
      }
      // null means the chain could not be read — fall through to "live" so an
      // RPC hiccup never hides a good listing.
    }

    return { known: true, dead: false };
  } catch {
    return { known: false };
  }
}

/**
 * Read-time liveness filter (audit finding 4).
 *
 * GET previously served every non-expired order, including ones cancelled,
 * filled, or counter-invalidated on-chain — so users clicked listings that
 * were guaranteed to revert and burned gas. This checks each order's on-chain
 * status and drops the dead ones, with a short server-side cache so a busy
 * book doesn't hammer the RPC on every request.
 *
 * Fail-open-for-DISPLAY on purpose: when the RPC can't confirm status
 * (`known:false`) the order is KEPT, so an RPC outage does not blank the entire
 * marketplace. This is the opposite tradeoff from removal/admission (which fail
 * closed) and is safe because showing a possibly-dead order at worst wastes a
 * click, whereas hiding the whole book breaks the product. A stale row is also
 * bounded — the cache TTL forces a recheck within 30s.
 */
const LIVENESS_TTL_MS = 30_000;
type LivenessCacheEntry = { dead: boolean; at: number; reason?: string };
const livenessCache = new Map<string, LivenessCacheEntry>();
const MAX_LIVENESS_CACHE = 10_000;

function orderCacheKey(item: { id?: string }): string {
  return typeof item.id === "string" ? item.id : "";
}

export type LiveOrderSplit<T> = {
  live: T[];
  /** Provably unfillable on-chain. Safe to retire — the evidence is not forgeable. */
  dead: Array<{ item: T; reason: string }>;
};

/**
 * Split a book into orders that can still be filled and orders that provably
 * cannot. Unknown liveness counts as live: an unreachable node is not evidence.
 */
export async function splitLiveOrders<T extends { id?: string; rawOrder?: unknown }>(
  items: T[]
): Promise<LiveOrderSplit<T>> {
  const now = Date.now();
  if (livenessCache.size > MAX_LIVENESS_CACHE) {
    for (const [k, v] of livenessCache) {
      if (now - v.at > LIVENESS_TTL_MS) livenessCache.delete(k);
    }
  }

  const live: T[] = [];
  const dead: Array<{ item: T; reason: string }> = [];
  for (const item of items) {
    const key = orderCacheKey(item);
    const cached = key ? livenessCache.get(key) : undefined;
    if (cached && now - cached.at < LIVENESS_TTL_MS) {
      if (cached.dead) dead.push({ item, reason: cached.reason ?? "dead" });
      else live.push(item);
      continue;
    }

    const liveness = await getOrderLiveness(item.rawOrder);
    if (liveness.known) {
      const reason = liveness.dead ? liveness.reason : undefined;
      if (key) livenessCache.set(key, { dead: liveness.dead, at: now, reason });
      if (liveness.dead) dead.push({ item, reason: reason ?? "dead" });
      else live.push(item);
    } else {
      // Unknown — keep it (fail open for display) and do not cache the miss.
      live.push(item);
    }
  }
  return { live, dead };
}

export async function filterLiveOrders<T extends { id?: string; rawOrder?: unknown }>(
  items: T[]
): Promise<T[]> {
  return (await splitLiveOrders(items)).live;
}
