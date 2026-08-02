/**
 * Alchemy NFT API client — collection-wide reads instead of per-token eth_call.
 *
 * Why this exists: the provider bills per call, and the app's expensive shape
 * was never "one costly method", it was "the same cheap method, N times". The
 * egress cache in rpc-cache.ts cannot help there — its production hit rate sat
 * at ~10-11% precisely because the reads are DISTINCT (ownerOf(1), ownerOf(2),
 * ... ), not repeats. No TTL collapses a fan-out over 1,542 token ids.
 *
 * getOwnersForContract answers the whole collection in ONE request: 600 compute
 * units against 1,542 x 26 = ~40,000 for the token-by-token equivalent, a ~67x
 * reduction for strictly more data.
 *
 * Three-tier sourcing, cheapest-that-suffices first:
 *   1. Blockscout  — keyless, unmetered, and it already returns `owner` on the
 *                    token-instances endpoint. Preferred for bulk work.
 *   2. Alchemy NFT — one metered call, used when Blockscout is down or slow.
 *   3. caller's RPC fallback — never from here; see the security note below.
 *
 * SECURITY: nothing in this module is authoritative. Aggregator indexes lag the
 * chain by some blocks and are outside our trust boundary. Ownership reads that
 * gate a decision — order validation, transfer authorization, settlement — must
 * stay on SERVER_RPC_URLS via lib/market/fetch-rpc.ts. This is for display.
 */

import { recordRpc } from "@/lib/market/rpc-meter";
import { fetchTokenInstances } from "@/lib/market/blockscout";

/**
 * Alchemy's network slug for Robinhood Chain mainnet (chain 4663, an Arbitrum
 * L2 — a stale comment elsewhere in the repo calls it an L3, which is wrong).
 * Overridable because the testnet slug differs (robinhood-testnet).
 */
const DEFAULT_NETWORK = "robinhood-mainnet";

function alchemyKey(): string | null {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

function alchemyNetwork(): string {
  return process.env.ALCHEMY_NETWORK?.trim() || DEFAULT_NETWORK;
}

/** True when a key is configured. Every caller must have a keyless fallback. */
export function hasAlchemyNft(): boolean {
  return alchemyKey() !== null;
}

function nftBaseUrl(): string | null {
  const key = alchemyKey();
  if (!key) return null;
  return `https://${alchemyNetwork()}.g.alchemy.com/nft/v3/${key}`;
}

/**
 * NFT API endpoints this module may call. Each is recorded into the same meter
 * as JSON-RPC — lib/market/rpc-meter.ts holds the single copy of their
 * compute-unit costs under `alchemy_*` — so /api/market/rpc-usage keeps
 * reporting the whole bill rather than the half of it that happens to be eth_*.
 */
type NftEndpoint =
  | "getOwnersForContract"
  | "getNFTsForOwner"
  | "getNFTsForContract"
  | "getNFTMetadata";

async function alchemyNftGet<T>(
  endpoint: NftEndpoint,
  params: Record<string, string>,
  timeoutMs = 20_000
): Promise<T> {
  const base = nftBaseUrl();
  if (!base) throw new Error("ALCHEMY_API_KEY is not set");

  const qs = new URLSearchParams(params).toString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  // Counted before the await: a call that times out or 429s is still billed.
  recordRpc(`alchemy_${endpoint}`);
  try {
    const res = await fetch(`${base}/${endpoint}?${qs}`, {
      headers: { Accept: "application/json" },
      signal: ac.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Alchemy NFT ${endpoint} HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export type OwnerMap = Map<string, string>;

export type OwnerMapResult = {
  /** tokenId (decimal string) -> owner address (lowercase). */
  owners: OwnerMap;
  source: "alchemy" | "blockscout";
  /** True when the walk completed; a partial page walk still returns rows. */
  complete: boolean;
};

type AlchemyOwnersResponse = {
  owners?: Array<{
    ownerAddress?: string;
    tokenBalances?: Array<{ tokenId?: string; balance?: number | string }>;
  }>;
  pageKey?: string | null;
};

/** Alchemy returns token ids as decimal or hex strings depending on age. */
function normalizeTokenId(raw: string): string | null {
  try {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const value = trimmed.startsWith("0x") ? BigInt(trimmed) : BigInt(trimmed);
    return value.toString();
  } catch {
    return null;
  }
}

/**
 * Every (tokenId -> owner) pair in the collection from Alchemy, in as few calls
 * as the owner count allows. `withTokenBalances` is what makes this a token-level
 * index rather than a bare list of holders.
 */
async function ownerMapFromAlchemy(contractAddress: string): Promise<OwnerMapResult> {
  const owners: OwnerMap = new Map();
  let pageKey: string | undefined;
  let complete = false;

  // Bounded: 50,000 owners per page, so this only ever loops for a collection
  // far larger than ours. The cap stops a malformed pageKey spinning forever.
  for (let page = 0; page < 20; page += 1) {
    const params: Record<string, string> = {
      contractAddress,
      withTokenBalances: "true",
    };
    if (pageKey) params.pageKey = pageKey;

    const data = await alchemyNftGet<AlchemyOwnersResponse>("getOwnersForContract", params);
    for (const entry of data.owners ?? []) {
      const address = entry.ownerAddress?.toLowerCase();
      if (!address) continue;
      for (const balance of entry.tokenBalances ?? []) {
        if (!balance.tokenId) continue;
        const tokenId = normalizeTokenId(balance.tokenId);
        if (tokenId) owners.set(tokenId, address);
      }
    }
    if (!data.pageKey) {
      complete = true;
      break;
    }
    pageKey = data.pageKey;
  }

  return { owners, source: "alchemy", complete };
}

/**
 * Same index from Blockscout's token-instances endpoint, which carries `owner`
 * per instance. Keyless and unmetered, so this is the DEFAULT path — Alchemy is
 * the backstop, not the other way around. Verified live against the chain:
 * Blockscout and ownerOf agree for the collection's tokens.
 */
async function ownerMapFromBlockscout(contractAddress: string): Promise<OwnerMapResult> {
  // 50 instances per page; the collection is 1,542 tokens, so ~31 pages.
  const items = await fetchTokenInstances(contractAddress, { maxPages: 60 });
  const owners: OwnerMap = new Map();
  for (const item of items) {
    const owner = (item as { owner?: { hash?: string } }).owner?.hash;
    if (!owner || item.id == null) continue;
    const tokenId = normalizeTokenId(String(item.id));
    if (tokenId) owners.set(tokenId, owner.toLowerCase());
  }
  return { owners, source: "blockscout", complete: owners.size > 0 };
}

/**
 * The collection's full ownership index.
 *
 * Both sources are tried; only the order changes. Blockscout is free but slow —
 * 31 pages, ~75s measured for this collection — while Alchemy answers in one
 * request for 600 CU. So:
 *
 *   - bulk/scheduled work (`preferFast: false`, the default) takes the free path
 *     first, because nobody is waiting on the cron;
 *   - a cold rebuild on a user request (`preferFast: true`) takes the fast path
 *     first when a key exists, because 75s inside a request is not acceptable.
 *
 * If both fail the error propagates — callers hold a durable last-known-good
 * snapshot and must prefer it over inventing an answer. There is deliberately no
 * per-token RPC fallback: that is the exact fan-out this module exists to delete.
 */
export async function fetchCollectionOwners(
  contractAddress: string,
  opts?: { preferFast?: boolean }
): Promise<OwnerMapResult> {
  const errors: string[] = [];

  const viaBlockscout = async (): Promise<OwnerMapResult | null> => {
    try {
      const result = await ownerMapFromBlockscout(contractAddress);
      if (result.owners.size > 0) return result;
      errors.push("blockscout returned 0 owners");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return null;
  };

  const viaAlchemy = async (): Promise<OwnerMapResult | null> => {
    if (!hasAlchemyNft()) {
      errors.push("ALCHEMY_API_KEY not set");
      return null;
    }
    try {
      const result = await ownerMapFromAlchemy(contractAddress);
      if (result.owners.size > 0) return result;
      errors.push("alchemy returned 0 owners");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return null;
  };

  const order =
    opts?.preferFast && hasAlchemyNft()
      ? [viaAlchemy, viaBlockscout]
      : [viaBlockscout, viaAlchemy];

  for (const attempt of order) {
    const result = await attempt();
    if (result) return result;
  }

  throw new Error(`Could not build owner index: ${errors.join(" | ")}`);
}

type AlchemyNftsForOwnerResponse = {
  ownedNfts?: Array<{ tokenId?: string; contract?: { address?: string } }>;
  pageKey?: string | null;
};

/**
 * Token ids a wallet holds in one collection, in a single metered call rather
 * than balanceOf + N x tokenOfOwnerByIndex.
 *
 * Returns null when no key is configured so callers fall through to their
 * existing path instead of treating "unconfigured" as "owns nothing" — an
 * empty bag rendered as truth is how treasury NFTs went missing before.
 */
export async function fetchOwnedTokenIds(
  contractAddress: string,
  owner: string
): Promise<string[] | null> {
  if (!hasAlchemyNft()) return null;

  const ids: string[] = [];
  let pageKey: string | undefined;

  try {
    for (let page = 0; page < 10; page += 1) {
      const params: Record<string, string> = {
        owner,
        "contractAddresses[]": contractAddress,
        withMetadata: "false",
        pageSize: "100",
      };
      if (pageKey) params.pageKey = pageKey;

      const data = await alchemyNftGet<AlchemyNftsForOwnerResponse>("getNFTsForOwner", params);
      for (const nft of data.ownedNfts ?? []) {
        if (!nft.tokenId) continue;
        const tokenId = normalizeTokenId(nft.tokenId);
        if (tokenId) ids.push(tokenId);
      }
      if (!data.pageKey) break;
      pageKey = data.pageKey;
    }
  } catch {
    // Fail soft to null, never to []. See the note above.
    return null;
  }

  return ids;
}
