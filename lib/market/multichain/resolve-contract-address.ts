import { getTrackedCollection } from "@/lib/market/multichain/store";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** True when `value` is a well-formed EVM address. Exported so callers stop
 *  re-writing the regex -- and stop using it as an identity test. */
export function isEvmAddress(value: string | null | undefined): boolean {
  return typeof value === "string" && EVM_ADDRESS.test(value);
}

/**
 * Successes are effectively immutable (a collection's contract does not
 * change); failures get a short window so a transient OpenSea error cannot
 * poison a collection for the process lifetime. That poisoning is a real bug
 * this codebase already hit once -- see resolveOpenSeaCollectionSlug's own
 * header for the same lesson learned the hard way.
 */
const addressCache = new Map<string, string>();
const addressMisses = new Map<string, number>();
const NEGATIVE_TTL_MS = 60_000;

/**
 * Resolve an EVM contract address from whatever identifier the caller has.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several routes gated real work behind `EVM_ADDRESS.test(collectionSlug)` and
 * silently did nothing when the slug was a human name -- which is how the app
 * actually links to collections. Measured live on Milady Maker
 * (`collectionSlug = "milady"`, contract 0x5af0d982…425a5):
 *
 *   /hydrate-token?collectionSlug=milady   -> {"resolved": false}
 *   /hydrate-token?collectionSlug=0x5af0…  -> full metadata, image and traits
 *
 * Same token, same route, same archive. The data was always there; the route
 * refused to look because the identifier was the wrong SHAPE. And because that
 * refusal is deterministic, waiting and refreshing could never fix it -- which
 * is exactly what "it never hydrates no matter how long I visit" looks like.
 *
 * A shape test is not an identity test.
 *
 * ORDER MATTERS, AND THE DB IS NOT ENOUGH
 * ---------------------------------------
 * `getTrackedCollection` queries `WHERE contract_address = $2`, so passing a
 * slug to it matches NOTHING. A first version of this function used only that
 * lookup and was a no-op for exactly the case it was written for. The
 * authoritative slug -> address mapping is OpenSea's collection metadata --
 * the same source the listings route already uses to fill in `contractAddress`
 * -- so that is the fallback, with the archive consulted first because it is
 * free.
 *
 * Returns null only when the collection is genuinely unresolvable: a real
 * "we don't know", distinguishable from "we didn't try".
 */
export async function resolveEvmContractAddress(
  chainSlug: string,
  collectionSlug: string,
): Promise<string | null> {
  if (EVM_ADDRESS.test(collectionSlug)) return collectionSlug;

  const cacheKey = `${chainSlug}:${collectionSlug.toLowerCase()}`;
  const cached = addressCache.get(cacheKey);
  if (cached) return cached;
  const missedAt = addressMisses.get(cacheKey);
  if (missedAt != null && Date.now() - missedAt < NEGATIVE_TTL_MS) return null;

  // 1. The archive, in case the slug happens to be stored as the key.
  const tracked = await getTrackedCollection(chainSlug, collectionSlug).catch(() => null);
  if (tracked?.contractAddress && EVM_ADDRESS.test(tracked.contractAddress)) {
    addressCache.set(cacheKey, tracked.contractAddress);
    return tracked.contractAddress;
  }

  // 2. OpenSea's collection metadata: the authoritative slug -> address map.
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain?.openSeaChain) {
    addressMisses.set(cacheKey, Date.now());
    return null;
  }
  try {
    const { openSeaCollectionContract } = await import("@/lib/market/multichain/trading/foreign-orders");
    const address = await openSeaCollectionContract(chain.openSeaChain, collectionSlug);
    if (address && EVM_ADDRESS.test(address)) {
      addressCache.set(cacheKey, address.toLowerCase());
      return address.toLowerCase();
    }
  } catch {
    // fall through to the negative window
  }
  addressMisses.set(cacheKey, Date.now());
  return null;
}
