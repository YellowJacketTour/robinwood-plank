/**
 * Smart client cache for plank.love chain + IPFS data.
 *
 * Immutable (long TTL / permanent once known):
 *   - tokenURI by tokenId
 *   - NFT metadata by tokenURI (content-addressed IPFS)
 *
 * Semi-stable (medium TTL):
 *   - owner by tokenId (transfers are rare)
 *   - wallet → tokenIds inventory
 *
 * Live (short TTL):
 *   - mint contract stats / totalSupply
 *
 * Storage: in-memory Map + localStorage (best-effort, size-capped).
 */

import type { NftAttribute, NftMetadata } from "@/lib/ipfs";

const STORAGE_KEY = "plank.love:nft-cache:v1";
const MAX_STORED_TOKENS = 2_000;
const MAX_STORED_METADATA = 2_000;

/** tokenURI + metadata rarely change after mint/reveal */
export const TTL_IMMUTABLE_MS = 7 * 24 * 60 * 60 * 1000;
/** owners can transfer — refresh in background */
export const TTL_OWNER_MS = 10 * 60 * 1000;
/** wallet bag composition */
export const TTL_INVENTORY_MS = 45_000;
/** mint phase / supply / prices */
export const TTL_STATS_MS = 10_000;

export type CachedTokenRecord = {
  tokenId: number;
  tokenUri: string;
  name: string;
  description: string;
  imageUri: string;
  attributes: NftAttribute[];
  owner: string;
  ownerAt: number;
  uriAt: number;
  metaAt: number;
  error?: string;
};

export type CachedMintStats = {
  phase: number;
  paused: boolean;
  total: number;
  community: number;
  free: number;
  allowlist: number;
  paid: number;
  remainingCommunity: number;
  remainingTotal: number;
  remainingPaidSupply: number;
  priceWei: string;
  communityReleased: boolean;
  at: number;
};

type PersistShape = {
  tokens: Record<string, CachedTokenRecord>;
  metadata: Record<string, { data: NftMetadata; at: number }>;
  inventory: Record<string, { ids: number[]; at: number }>;
  stats: CachedMintStats | null;
  supply: { value: number; at: number } | null;
};

const memory: {
  tokens: Map<number, CachedTokenRecord>;
  metadata: Map<string, { data: NftMetadata; at: number }>;
  inventory: Map<string, { ids: number[]; at: number }>;
  stats: CachedMintStats | null;
  supply: { value: number; at: number } | null;
  hydrated: boolean;
  writeTimer: ReturnType<typeof setTimeout> | null;
} = {
  tokens: new Map(),
  metadata: new Map(),
  inventory: new Map(),
  stats: null,
  supply: null,
  hydrated: false,
  writeTimer: null,
};

function now() {
  return Date.now();
}

function isFresh(at: number, ttl: number) {
  return at > 0 && now() - at < ttl;
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function hydrateFromStorage() {
  if (memory.hydrated) return;
  memory.hydrated = true;
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistShape;
    if (parsed.tokens) {
      for (const [key, value] of Object.entries(parsed.tokens)) {
        const id = Number(key);
        if (Number.isFinite(id) && value) memory.tokens.set(id, value);
      }
    }
    if (parsed.metadata) {
      for (const [uri, value] of Object.entries(parsed.metadata)) {
        if (uri && value?.data) memory.metadata.set(uri, value);
      }
    }
    if (parsed.inventory) {
      for (const [wallet, value] of Object.entries(parsed.inventory)) {
        if (wallet && value?.ids) memory.inventory.set(wallet.toLowerCase(), value);
      }
    }
    if (parsed.stats) memory.stats = parsed.stats;
    if (parsed.supply) memory.supply = parsed.supply;
  } catch {
    /* corrupt cache — ignore */
  }
}

function schedulePersist() {
  if (typeof window === "undefined") return;
  if (memory.writeTimer) return;
  memory.writeTimer = setTimeout(() => {
    memory.writeTimer = null;
    persistNow();
  }, 750);
}

function persistNow() {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    // Prefer newest token ids when capping
    const tokenEntries = Array.from(memory.tokens.entries()).sort(
      (a, b) => b[0] - a[0],
    );
    const tokens: Record<string, CachedTokenRecord> = {};
    for (const [id, rec] of tokenEntries.slice(0, MAX_STORED_TOKENS)) {
      tokens[String(id)] = rec;
    }

    const metaEntries = Array.from(memory.metadata.entries()).sort(
      (a, b) => b[1].at - a[1].at,
    );
    const metadata: Record<string, { data: NftMetadata; at: number }> = {};
    for (const [uri, value] of metaEntries.slice(0, MAX_STORED_METADATA)) {
      metadata[uri] = value;
    }

    const inventory: Record<string, { ids: number[]; at: number }> = {};
    for (const [wallet, value] of memory.inventory.entries()) {
      inventory[wallet] = value;
    }

    const payload: PersistShape = {
      tokens,
      metadata,
      inventory,
      stats: memory.stats,
      supply: memory.supply,
    };
    ls.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded — drop oldest half of metadata and retry once
    try {
      const metaKeys = Array.from(memory.metadata.keys());
      for (let i = 0; i < Math.floor(metaKeys.length / 2); i += 1) {
        memory.metadata.delete(metaKeys[i]);
      }
      ls.setItem(
        STORAGE_KEY,
        JSON.stringify({
          tokens: Object.fromEntries(
            Array.from(memory.tokens.entries())
              .sort((a, b) => b[0] - a[0])
              .slice(0, Math.floor(MAX_STORED_TOKENS / 2)),
          ),
          metadata: Object.fromEntries(memory.metadata),
          inventory: Object.fromEntries(memory.inventory),
          stats: memory.stats,
          supply: memory.supply,
        } satisfies PersistShape),
      );
    } catch {
      /* give up */
    }
  }
}

// ─── Metadata (by tokenURI) ─────────────────────────────────────────────────

export function getCachedMetadata(tokenUri: string): NftMetadata | null {
  if (!tokenUri) return null;
  hydrateFromStorage();
  const hit = memory.metadata.get(tokenUri);
  if (!hit) return null;
  if (!isFresh(hit.at, TTL_IMMUTABLE_MS)) return hit.data; // still return stale immutable
  return hit.data;
}

export function setCachedMetadata(tokenUri: string, data: NftMetadata) {
  if (!tokenUri) return;
  hydrateFromStorage();
  memory.metadata.set(tokenUri, { data, at: now() });
  schedulePersist();
}

// ─── Per-token records ──────────────────────────────────────────────────────

export function getCachedToken(tokenId: number): CachedTokenRecord | null {
  hydrateFromStorage();
  return memory.tokens.get(tokenId) ?? null;
}

export function getCachedTokensInRange(
  fromId: number,
  toId: number,
): CachedTokenRecord[] {
  hydrateFromStorage();
  const out: CachedTokenRecord[] = [];
  for (let id = fromId; id <= toId; id += 1) {
    const rec = memory.tokens.get(id);
    if (rec) out.push(rec);
  }
  return out;
}

export function hasFreshMetadata(tokenId: number): boolean {
  const rec = getCachedToken(tokenId);
  if (!rec?.tokenUri || !rec.metaAt) return false;
  return Boolean(rec.imageUri || rec.name) && isFresh(rec.metaAt, TTL_IMMUTABLE_MS);
}

export function hasFreshOwner(tokenId: number): boolean {
  const rec = getCachedToken(tokenId);
  if (!rec?.owner || !rec.ownerAt) return false;
  return isFresh(rec.ownerAt, TTL_OWNER_MS);
}

export function putTokenUri(tokenId: number, tokenUri: string) {
  hydrateFromStorage();
  const prev = memory.tokens.get(tokenId);
  const next: CachedTokenRecord = {
    tokenId,
    tokenUri,
    name: prev?.name || `RobinWood Plank #${tokenId}`,
    description: prev?.description || "",
    imageUri: prev?.imageUri || "",
    attributes: prev?.attributes || [],
    owner: prev?.owner || "",
    ownerAt: prev?.ownerAt || 0,
    uriAt: now(),
    metaAt: prev?.metaAt || 0,
    error: prev?.error,
  };
  memory.tokens.set(tokenId, next);
  schedulePersist();
  return next;
}

export function putTokenOwner(tokenId: number, owner: string) {
  hydrateFromStorage();
  const prev = memory.tokens.get(tokenId);
  const next: CachedTokenRecord = {
    tokenId,
    tokenUri: prev?.tokenUri || "",
    name: prev?.name || `RobinWood Plank #${tokenId}`,
    description: prev?.description || "",
    imageUri: prev?.imageUri || "",
    attributes: prev?.attributes || [],
    owner,
    ownerAt: now(),
    uriAt: prev?.uriAt || 0,
    metaAt: prev?.metaAt || 0,
    error: prev?.error,
  };
  memory.tokens.set(tokenId, next);
  schedulePersist();
  return next;
}

export function putTokenMetadata(
  tokenId: number,
  fields: {
    tokenUri: string;
    name: string;
    description: string;
    imageUri: string;
    attributes: NftAttribute[];
    owner?: string;
    error?: string;
  },
) {
  hydrateFromStorage();
  const prev = memory.tokens.get(tokenId);
  const t = now();
  const next: CachedTokenRecord = {
    tokenId,
    tokenUri: fields.tokenUri || prev?.tokenUri || "",
    name: fields.name,
    description: fields.description,
    imageUri: fields.imageUri,
    attributes: fields.attributes,
    owner: fields.owner ?? prev?.owner ?? "",
    ownerAt: fields.owner !== undefined ? t : prev?.ownerAt || 0,
    uriAt: fields.tokenUri ? t : prev?.uriAt || 0,
    metaAt: t,
    error: fields.error,
  };
  memory.tokens.set(tokenId, next);
  if (next.tokenUri) {
    setCachedMetadata(next.tokenUri, {
      name: next.name,
      description: next.description,
      image: next.imageUri,
      attributes: next.attributes,
    });
  }
  schedulePersist();
  return next;
}

// ─── Wallet inventory ───────────────────────────────────────────────────────

export function getCachedInventory(
  wallet: string,
): { ids: number[]; at: number; fresh: boolean } | null {
  hydrateFromStorage();
  const hit = memory.inventory.get(wallet.toLowerCase());
  if (!hit) return null;
  return { ...hit, fresh: isFresh(hit.at, TTL_INVENTORY_MS) };
}

export function setCachedInventory(wallet: string, ids: number[]) {
  hydrateFromStorage();
  memory.inventory.set(wallet.toLowerCase(), { ids, at: now() });
  schedulePersist();
}

// ─── Supply / mint stats ────────────────────────────────────────────────────

export function getCachedSupply(): { value: number; fresh: boolean } | null {
  hydrateFromStorage();
  if (!memory.supply) return null;
  return {
    value: memory.supply.value,
    fresh: isFresh(memory.supply.at, TTL_STATS_MS),
  };
}

export function setCachedSupply(value: number) {
  hydrateFromStorage();
  memory.supply = { value, at: now() };
  schedulePersist();
}

export function getCachedMintStats(): CachedMintStats | null {
  hydrateFromStorage();
  if (!memory.stats) return null;
  return memory.stats;
}

export function getCachedMintStatsIfFresh(): CachedMintStats | null {
  const stats = getCachedMintStats();
  if (!stats || !isFresh(stats.at, TTL_STATS_MS)) return null;
  return stats;
}

export function setCachedMintStats(stats: Omit<CachedMintStats, "at">) {
  hydrateFromStorage();
  memory.stats = { ...stats, at: now() };
  setCachedSupply(stats.total);
  schedulePersist();
}

/** Proofs.json is static for a deploy — cache in memory only. */
let proofsCache: { data: unknown; at: number } | null = null;
const TTL_PROOFS_MS = 60 * 60 * 1000;

export function getCachedProofs(): unknown | null {
  if (!proofsCache) return null;
  if (!isFresh(proofsCache.at, TTL_PROOFS_MS)) return proofsCache.data;
  return proofsCache.data;
}

export function setCachedProofs(data: unknown) {
  proofsCache = { data, at: now() };
}

/** Ensure storage is loaded (call once on client mount). */
export function ensureNftCacheHydrated() {
  hydrateFromStorage();
}
