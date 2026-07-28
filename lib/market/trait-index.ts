import { promises as fs } from "node:fs";
import path from "node:path";
import { CHAIN } from "@/lib/constants";
import { fetchNftMetadata } from "@/lib/ipfs";
import type { NftAttribute } from "@/lib/ipfs";
import type { MarketCollection } from "@/lib/market/types";

/**
 * Server-side trait → token-id index for trait-scoped bids.
 *
 * WHY THIS EXISTS: a trait bid's Merkle root commits to "every token id whose
 * metadata carries trait X = Y" at bid time. That set must come from a source
 * the SERVER has verified — not from whatever list a client POSTs — otherwise
 * a malicious bidder could label an arbitrary token set "Holographic: Yes"
 * and mislead sellers. The orders route therefore requires a bid's claimed
 * snapshot to EXACTLY equal this index's set for the named trait.
 *
 * COST MODEL: 1,542 tokens, metadata immutable once revealed (IPFS,
 * content-addressed). The scan is bounded and done ONCE per process+disk:
 * results persist to .data/ and to globalThis, entries never expire, and a
 * supply increase (new mints) only scans the missing ids. No request ever
 * triggers a synchronous full scan — the build runs in the background and the
 * API reports progress until it completes.
 *
 * FAIL CLOSED: trait bids are only accepted while the index is COMPLETE
 * (every token scanned successfully). A partial index could under-commit a
 * trait set; refusing until the scan finishes is strictly safer.
 */

export type TraitIndex = {
  collectionSlug: string;
  totalSupply: number;
  /** tokenIds successfully scanned (metadata parsed). */
  scanned: number;
  /** tokenIds whose metadata could not be fetched (retried on next build tick). */
  failed: number[];
  /** traitType → value → sorted token-id list (decimal strings). */
  traits: Record<string, Record<string, string[]>>;
  builtAt: number;
};

type BuildState = {
  index: TraitIndex | null;
  building: boolean;
  lastSupplyCheck: number;
};

type GlobalTraitIndex = { __plankTraitIndex?: Record<string, BuildState> };

function g(): Record<string, BuildState> {
  const store = globalThis as GlobalTraitIndex;
  if (!store.__plankTraitIndex) store.__plankTraitIndex = {};
  return store.__plankTraitIndex;
}

function dataPath(slug: string): string {
  return path.join(process.cwd(), ".data", `trait-index-${slug}.json`);
}

const SUPPLY_RECHECK_MS = 10 * 60 * 1000;
const SCAN_CONCURRENCY = 8;
/** Traits with values longer than this are junk, not traits. */
const MAX_TRAIT_STRING = 64;

async function rpcBatch(calls: Array<{ to: string; data: string }>): Promise<(string | null)[]> {
  const payload = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));
  const res = await fetch(CHAIN.rpcUrls.default, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const json = (await res.json()) as Array<{ id: number; result?: string }>;
  if (!Array.isArray(json)) throw new Error("RPC batch failed");
  const out: (string | null)[] = new Array(calls.length).fill(null);
  for (const entry of json) {
    if (typeof entry?.id === "number" && typeof entry.result === "string") {
      out[entry.id] = entry.result;
    }
  }
  return out;
}

function decodeUint(hex: string | null): number | null {
  if (!hex || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  const v = Number(BigInt(hex));
  return Number.isSafeInteger(v) ? v : null;
}

function decodeString(hex: string | null): string | null {
  if (!hex || hex.length < 130) return null;
  try {
    const body = hex.slice(2);
    const len = parseInt(body.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0) return null;
    return Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8");
  } catch {
    return null;
  }
}

async function fetchTotalSupply(contractAddress: string): Promise<number> {
  const [hex] = await rpcBatch([{ to: contractAddress, data: "0x18160ddd" }]);
  const v = decodeUint(hex);
  if (v === null || v <= 0) throw new Error("Could not read totalSupply");
  return v;
}

/** Enumerate real token ids via ERC721Enumerable tokenByIndex, batched. */
async function enumerateTokenIds(contractAddress: string, totalSupply: number): Promise<string[]> {
  const ids: string[] = [];
  const CHUNK = 200;
  for (let start = 0; start < totalSupply; start += CHUNK) {
    const count = Math.min(CHUNK, totalSupply - start);
    const calls = Array.from({ length: count }, (_, i) => ({
      to: contractAddress,
      data: "0x4f6ccce7" + BigInt(start + i).toString(16).padStart(64, "0"), // tokenByIndex
    }));
    const results = await rpcBatch(calls);
    for (const r of results) {
      const v = r && /^0x[0-9a-fA-F]{64}$/.test(r) ? BigInt(r).toString() : null;
      if (v !== null) ids.push(v);
    }
  }
  return ids;
}

async function fetchTokenUris(
  contractAddress: string,
  tokenIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const CHUNK = 200;
  for (let start = 0; start < tokenIds.length; start += CHUNK) {
    const slice = tokenIds.slice(start, start + CHUNK);
    const calls = slice.map((id) => ({
      to: contractAddress,
      data: "0xc87b56dd" + BigInt(id).toString(16).padStart(64, "0"), // tokenURI
    }));
    const results = await rpcBatch(calls);
    for (let i = 0; i < slice.length; i++) {
      const uri = decodeString(results[i]);
      if (uri) out.set(slice[i], uri);
    }
  }
  return out;
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
      byValue[key].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    }
  }
}

async function loadPersisted(slug: string): Promise<TraitIndex | null> {
  try {
    const raw = await fs.readFile(dataPath(slug), "utf8");
    const parsed = JSON.parse(raw) as TraitIndex;
    if (parsed && parsed.collectionSlug === slug && parsed.traits) return parsed;
  } catch {
    /* no persisted index yet */
  }
  return null;
}

async function persist(index: TraitIndex): Promise<void> {
  try {
    await fs.mkdir(path.dirname(dataPath(index.collectionSlug)), { recursive: true });
    await fs.writeFile(dataPath(index.collectionSlug), JSON.stringify(index), "utf8");
  } catch {
    // Best-effort; the in-memory copy still serves this instance.
  }
}

/** Which token ids the index already covers (scanned successfully). */
function coveredIds(index: TraitIndex): Set<string> {
  const covered = new Set<string>();
  for (const byValue of Object.values(index.traits)) {
    for (const list of Object.values(byValue)) {
      for (const id of list) covered.add(id);
    }
  }
  return covered;
}

async function buildMissing(collection: MarketCollection, state: BuildState): Promise<void> {
  const totalSupply = await fetchTotalSupply(collection.contractAddress);
  const index: TraitIndex = state.index ?? {
    collectionSlug: collection.slug,
    totalSupply,
    scanned: 0,
    failed: [],
    traits: {},
    builtAt: 0,
  };
  index.totalSupply = totalSupply;

  const allIds = await enumerateTokenIds(collection.contractAddress, totalSupply);
  const covered = coveredIds(index);
  // NOTE: a token with metadata but zero valid attributes would re-scan each
  // build; harmless (metadata layer caches) and vanishingly rare here — every
  // revealed RobinWood carries Base/Background/Holographic.
  const missing = allIds.filter((id) => !covered.has(id));
  if (missing.length === 0) {
    index.scanned = allIds.length;
    index.failed = [];
    index.builtAt = Date.now();
    state.index = index;
    await persist(index);
    return;
  }

  const uris = await fetchTokenUris(collection.contractAddress, missing);
  const failed: string[] = [];
  let cursor = 0;
  let sincePersist = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= missing.length) return;
      const tokenId = missing[i];
      const uri = uris.get(tokenId);
      if (!uri) {
        failed.push(tokenId);
        continue;
      }
      try {
        const metadata = await fetchNftMetadata(uri);
        const attrs = Array.isArray(metadata.attributes) ? metadata.attributes : [];
        if (attrs.length === 0) {
          failed.push(tokenId); // unrevealed — retry on a later build
          continue;
        }
        addAttributes(index, tokenId, attrs);
        index.scanned = coveredIds(index).size;
        if (++sincePersist >= 100) {
          sincePersist = 0;
          sortIndex(index);
          await persist(index);
        }
      } catch {
        failed.push(tokenId);
      }
    }
  }

  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, () => worker()));

  sortIndex(index);
  index.scanned = coveredIds(index).size;
  index.failed = failed.map((id) => Number(id)).filter((n) => Number.isSafeInteger(n));
  index.builtAt = Date.now();
  state.index = index;
  await persist(index);
}

/**
 * Current index state; kicks a background (re)build when needed. Never blocks
 * on the scan itself.
 */
export async function getTraitIndex(
  collection: MarketCollection
): Promise<{ index: TraitIndex | null; complete: boolean; building: boolean }> {
  const store = g();
  const state = (store[collection.slug] ??= {
    index: null,
    building: false,
    lastSupplyCheck: 0,
  });

  if (!state.index) {
    state.index = await loadPersisted(collection.slug);
  }

  const now = Date.now();
  const needsSupplyCheck = now - state.lastSupplyCheck > SUPPLY_RECHECK_MS;
  const incomplete =
    !state.index ||
    state.index.failed.length > 0 ||
    state.index.scanned < state.index.totalSupply;

  if (!state.building && (incomplete || needsSupplyCheck)) {
    state.building = true;
    state.lastSupplyCheck = now;
    void buildMissing(collection, state)
      .catch(() => {
        /* transient RPC/IPFS failure — next request retries */
      })
      .finally(() => {
        state.building = false;
      });
  }

  const index = state.index;
  const complete = Boolean(
    index && index.failed.length === 0 && index.scanned >= index.totalSupply && index.builtAt > 0
  );
  return { index, complete, building: state.building };
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
