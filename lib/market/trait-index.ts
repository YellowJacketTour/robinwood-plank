import {
  durableKv as kv,
  hasDurableKv,
} from "@/lib/market/durable-kv";
import { fetchNftMetadata } from "@/lib/ipfs";
import type { NftAttribute } from "@/lib/ipfs";
import { fetchTokenInstances } from "@/lib/market/blockscout";
import { pickCanonicalTraits } from "@/lib/rarity";
import { robinwoodTokenUri } from "@/lib/market/token-image";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import {
  getRobinwoodMetadataMap,
  ROBINWOOD_SUPPLY as ROBINWOOD_CANONICAL_SUPPLY,
} from "@/lib/market/robinwood-metadata";
import type { MarketCollection } from "@/lib/market/types";
import { getRaritySnapshot } from "@/lib/market/rarity-snapshot";
import {
  resolveCriteriaTokenIds,
  type CriteriaClause,
} from "@/lib/market/trait-criteria";

/**
 * Server-side trait → token-id index for trait-scoped bids / sweeps.
 *
 * For RobinWood (the only collection registered today), this is built
 * straight from the canonical IPFS-sourced metadata store
 * (lib/market/robinwood-metadata.ts) — no Blockscout, no per-request IPFS
 * reads. That store already resolved every token offline and idempotently,
 * so an in-request rebuild here is just an in-memory scan.
 *
 * Any OTHER collection (none registered yet) falls back to the original
 * Blockscout REST + IPFS-backfill path below, since it has no canonical
 * store of its own. That path still runs in Cloudflare Workers, which
 * cannot rely on:
 *  - process.cwd()/.data filesystem (ephemeral / unwritable)
 *  - fire-and-forget background scans (isolate freezes after the response)
 *
 * Durable storage is PostgreSQL either way, with in-request build + inflight
 * dedupe on a cold miss.
 *
 * FAIL CLOSED: trait bids only when complete (every token successfully
 * attributed, failed empty). Partial indexes never leave the API as traits.
 */

export type TraitIndex = {
  collectionSlug: string;
  totalSupply: number;
  /** tokenIds successfully scanned (metadata parsed with ≥1 attribute). */
  scanned: number;
  /** tokenIds whose metadata could not be fetched (retried on rebuild). */
  failed: number[];
  /** traitType → value → sorted token-id list (decimal strings). */
  traits: Record<string, Record<string, string[]>>;
  builtAt: number;
};

const KV_PREFIX = "plank:market:trait-index-v1:";
const KV_TTL_SEC = 7 * 24 * 60 * 60; // 7d — metadata immutable post-reveal
/** Official RobinWood supply used when RPC is unavailable. */
const ROBINWOOD_SUPPLY = 1542;
const MAX_IPFS_BACKFILL = 800;
const IPFS_CONCURRENCY = 12;
const MAX_TRAIT_STRING = 64;

type BuildState = {
  index: TraitIndex | null;
  building: boolean;
  inflight: Promise<TraitIndex | null> | null;
};

type GlobalTraitIndex = { __plankTraitIndexV2?: Record<string, BuildState> };

function g(): Record<string, BuildState> {
  const store = globalThis as GlobalTraitIndex;
  if (!store.__plankTraitIndexV2) store.__plankTraitIndexV2 = {};
  return store.__plankTraitIndexV2;
}

function hasKv(): boolean {
  return hasDurableKv();
}

function kvKey(slug: string): string {
  return `${KV_PREFIX}${slug}`;
}

function cleanTrait(s: unknown): string | null {
  const v = String(s ?? "").trim();
  if (!v || v.length > MAX_TRAIT_STRING) return null;
  return v;
}

function addAttributes(index: TraitIndex, tokenId: string, attributes: NftAttribute[]): void {
  for (const a of attributes) {
    const traitType = cleanTrait(a.trait_type);
    const value = cleanTrait(a.value);
    if (!traitType || !value) continue;
    const byValue = (index.traits[traitType] ??= {});
    const list = (byValue[value] ??= []);
    if (!list.includes(tokenId)) list.push(tokenId);
  }
}

function sortIndex(index: TraitIndex): void {
  for (const byValue of Object.values(index.traits)) {
    for (const key of Object.keys(byValue)) {
      byValue[key].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    }
  }
}

function coveredIds(index: TraitIndex): Set<string> {
  const covered = new Set<string>();
  for (const byValue of Object.values(index.traits)) {
    for (const list of Object.values(byValue)) {
      for (const id of list) covered.add(id);
    }
  }
  return covered;
}

function isComplete(index: TraitIndex | null | undefined): boolean {
  return Boolean(
    index &&
      index.builtAt > 0 &&
      index.failed.length === 0 &&
      index.scanned >= index.totalSupply &&
      index.totalSupply > 0
  );
}

async function readKv(slug: string): Promise<TraitIndex | null> {
  if (!hasKv()) return null;
  try {
    let raw = await kv.get<TraitIndex | string | { value?: TraitIndex; ex?: number }>(kvKey(slug));
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw) as TraitIndex | { value?: TraitIndex };
      } catch {
        return null;
      }
    }
    // Tolerate a mis-seeded wrapper { value: TraitIndex, ex } from raw REST writes.
    if (
      raw &&
      typeof raw === "object" &&
      "value" in raw &&
      (raw as { value?: TraitIndex }).value &&
      typeof (raw as { value?: TraitIndex }).value === "object" &&
      (raw as { value: TraitIndex }).value.traits
    ) {
      raw = (raw as { value: TraitIndex }).value;
    }
    const idx = raw as TraitIndex | null;
    if (!idx || idx.collectionSlug !== slug || !idx.traits) return null;
    if (idx.scanned < 50) return null;
    return idx;
  } catch {
    return null;
  }
}

async function writeKv(index: TraitIndex): Promise<void> {
  if (!hasKv()) return;
  try {
    await kv.set(kvKey(index.collectionSlug), index, { ex: KV_TTL_SEC });
  } catch {
    /* best-effort */
  }
}

async function traitsFromIpfs(tokenId: number): Promise<NftAttribute[]> {
  try {
    const meta = await fetchNftMetadata(robinwoodTokenUri(tokenId));
    return Array.isArray(meta.attributes) ? meta.attributes : [];
  } catch {
    return [];
  }
}

async function backfillIpfs(
  index: TraitIndex,
  missingIds: number[]
): Promise<number[]> {
  const queue = missingIds.slice(0, MAX_IPFS_BACKFILL);
  const stillFailed: number[] = missingIds.slice(MAX_IPFS_BACKFILL);
  for (let i = 0; i < queue.length; i += IPFS_CONCURRENCY) {
    const slice = queue.slice(i, i + IPFS_CONCURRENCY);
    await Promise.all(
      slice.map(async (id) => {
        const attrs = await traitsFromIpfs(id);
        if (attrs.length === 0) {
          stillFailed.push(id);
          return;
        }
        addAttributes(index, String(id), attrs);
      })
    );
  }
  return stillFailed;
}

function isRobinwoodCollection(collection: MarketCollection): boolean {
  return collection.contractAddress.toLowerCase() === NFT_CONTRACT_ADDRESS.toLowerCase();
}

/**
 * Build straight from the canonical IPFS-sourced metadata store — no
 * Blockscout, no per-request IPFS reads. That store is built offline
 * (scripts/refresh-market-data.ts --metadata) and idempotently covers every
 * token, so this is just inverting attributes[] -> traitType -> value ->
 * tokenIds over an in-memory map.
 */
async function buildIndexFromCanonicalStore(collection: MarketCollection): Promise<TraitIndex> {
  const totalSupply = ROBINWOOD_CANONICAL_SUPPLY;
  const index: TraitIndex = {
    collectionSlug: collection.slug,
    totalSupply,
    scanned: 0,
    failed: [],
    traits: {},
    builtAt: 0,
  };

  const metadata = await getRobinwoodMetadataMap();
  const failed: number[] = [];
  for (let id = 1; id <= totalSupply; id += 1) {
    const entry = metadata.get(id);
    if (!entry || pickCanonicalTraits(entry.attributes).length === 0) {
      failed.push(id);
      continue;
    }
    addAttributes(index, String(id), entry.attributes);
  }

  sortIndex(index);
  index.scanned = coveredIds(index).size;
  index.failed = failed;
  index.builtAt = Date.now();
  return index;
}

/**
 * Build from Blockscout token instances (CF-safe REST) + IPFS for gaps.
 * Prefer RobinWood fixed supply 1..N so missing Blockscout pages still leave
 * a concrete work list. Only reached for a collection with no canonical
 * metadata store of its own (i.e. not RobinWood — see isRobinwoodCollection).
 */
async function buildIndex(collection: MarketCollection): Promise<TraitIndex> {
  if (isRobinwoodCollection(collection)) {
    return buildIndexFromCanonicalStore(collection);
  }
  const totalSupply = ROBINWOOD_SUPPLY;
  const index: TraitIndex = {
    collectionSlug: collection.slug,
    totalSupply,
    scanned: 0,
    failed: [],
    traits: {},
    builtAt: 0,
  };

  try {
    const items = await fetchTokenInstances(collection.contractAddress, { maxPages: 40 });
    for (const it of items) {
      const id = String(it.id);
      const attrs = (it.metadata?.attributes || []).map((a) => ({
        trait_type: String(a.trait_type || ""),
        value: a.value as string | number | boolean,
      }));
      // Same trap as rarity-snapshot's `loaded` check: a pre-reveal stub is
      // [{ trait_type: "Status", value: "Unrevealed" }], so it is non-empty and
      // would be indexed as real coverage — which then excludes the token from
      // the IPFS backfill below and freezes the stub in place. Require a
      // canonical trait before treating Blockscout's answer as the truth.
      if (pickCanonicalTraits(attrs).length === 0) continue;
      addAttributes(index, id, attrs);
    }
  } catch {
    // Blockscout down — fall through to pure IPFS fill
  }

  const covered = coveredIds(index);
  const missing: number[] = [];
  for (let id = 1; id <= totalSupply; id += 1) {
    if (!covered.has(String(id))) missing.push(id);
  }

  if (missing.length > 0) {
    const stillFailed = await backfillIpfs(index, missing);
    index.failed = stillFailed;
  } else {
    index.failed = [];
  }

  sortIndex(index);
  index.scanned = coveredIds(index).size;
  index.builtAt = Date.now();
  return index;
}

/**
 * Current index state. On cold miss, AWAITS a real build (Blockscout + IPFS)
 * so Cloudflare actually finishes instead of returning forever-zero.
 */
export async function getTraitIndex(
  collection: MarketCollection
): Promise<{ index: TraitIndex | null; complete: boolean; building: boolean }> {
  const store = g();
  const state = (store[collection.slug] ??= {
    index: null,
    building: false,
    inflight: null,
  });

  if (isComplete(state.index)) {
    return { index: state.index, complete: true, building: false };
  }

  // Warm from KV once per isolate
  if (!state.index) {
    const fromKv = await readKv(collection.slug);
    if (fromKv) {
      state.index = fromKv;
      if (isComplete(fromKv)) {
        return { index: fromKv, complete: true, building: false };
      }
    }
  }

  // Rebuild if incomplete / missing
  if (!isComplete(state.index)) {
    if (!state.inflight) {
      state.building = true;
      state.inflight = buildIndex(collection)
        .then(async (idx) => {
          state.index = idx;
          if (isComplete(idx) || idx.scanned > (state.index?.scanned ?? 0)) {
            await writeKv(idx);
          }
          return idx;
        })
        .catch(() => state.index)
        .finally(() => {
          state.building = false;
          state.inflight = null;
        });
    }
    // Await the in-flight build so this request (and concurrent ones) get
    // a real result when the Worker still has CPU budget.
    try {
      await state.inflight;
    } catch {
      /* leave state as-is */
    }
  }

  const index = state.index;
  return {
    index,
    complete: isComplete(index),
    building: state.building || Boolean(state.inflight),
  };
}

/**
 * The verified token-id set for one trait — ONLY if the index is complete.
 * Returns null otherwise (fail closed: trait bids wait for a full scan).
 */
export async function getVerifiedTraitSet(
  collection: MarketCollection,
  traitType: string,
  value: string
): Promise<string[] | null> {
  const { index, complete } = await getTraitIndex(collection);
  if (!index || !complete) return null;
  const list = index.traits[traitType]?.[value];
  return list && list.length > 0 ? [...list] : null;
}

/**
 * Verified token-id set for multi-clause criteria (AND of traits + optional
 * rarity tier). Same fail-closed rules as getVerifiedTraitSet.
 */
export async function getVerifiedCriteriaTokenIds(
  collection: MarketCollection,
  clauses: readonly CriteriaClause[]
): Promise<{ tokenIds: string[] } | null> {
  const { index, complete } = await getTraitIndex(collection);
  if (!index || !complete || clauses.length === 0) return null;
  let rankings: Record<string, number> | null = null;
  if (clauses.some((clause) => clause.kind === "rank")) {
    try {
      const rarity = await getRaritySnapshot();
      rankings = {};
      for (const [tokenId, item] of rarity.byTokenId) {
        rankings[String(tokenId)] = item.rank;
      }
    } catch {
      return null;
    }
  }
  const tokenIds = resolveCriteriaTokenIds(index.traits, clauses, rankings);
  if (tokenIds.length === 0) return null;
  return { tokenIds };
}
