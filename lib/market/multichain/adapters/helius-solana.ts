/**
 * Helius DAS (Digital Asset Standard) adapter -- Solana's second real
 * discovery source, alongside magiceden-solana.ts. Verified live 2026-08-20
 * against the real API, not assumed from docs (which were themselves
 * incomplete on key details): searchAssets requires owner_address when
 * combined with tokenType, limit=1000 times out server-side ("statement
 * timeout"), limit=100 works cleanly with real advancing cursor pagination,
 * and there is no reliable grand-total field in the response (unlike
 * UniSat's collection/list) -- "done" is detected the same way HyperSync's
 * own pagination is: a page returning fewer items than requested.
 *
 * SCOPE, STATED HONESTLY: this adapter only covers Metaplex's newer Core
 * standard (interface: "MplCoreCollection"), which IS cleanly, exhaustively
 * enumerable as a distinct collection-level asset type. Legacy-standard
 * collections (interface: "V1_NFT" -- what most established projects like
 * DeGods/Mad Lads use) do NOT have a clean "this is a collection identity,
 * not a member item" signal in a broad searchAssets call -- confirmed live,
 * not assumed -- searching V1_NFT returns individual member NFTs
 * indistinguishably from collection-identity NFTs, the same "500M+
 * individual items, no clean grouping key" scale problem already declined
 * for Bitcoin's raw parent-child inscription walk rather than force a
 * fragile heuristic. Legacy-collection coverage stays on
 * magiceden-solana.ts's ranked list until a real, clean legacy-collection
 * enumeration signal is found.
 *
 * Real name/image come directly from this same discovery response
 * (content.metadata.name / content.links.image) -- floor price and listed
 * count are NOT available from DAS (it's asset data, not marketplace
 * data), so fetchSnapshot here honestly returns null for both rather than
 * fabricating or cross-referencing a fragile name-match against another
 * marketplace.
 *
 * ON-CHAIN FALLBACK (added 2026-08-24, same pattern as alchemy-nft.ts's
 * onchainFallbackSnapshots): reserveDasSlot() returns null whenever every
 * configured DAS provider (Helius/QuickNode/Shyft) is simultaneously
 * jailed/exhausted/unconfigured -- previously fetchSnapshot just threw in
 * that case, with zero fallback, exactly the same single-vendor-dependency
 * gap the Alchemy fix addressed for EVM. solana-metaplex-reads.ts and
 * solana-editions.ts (this session's raw Metaplex Borsh readers) fill that
 * gap for free: a plain `getAccountInfo` against the public Solana RPC
 * needs no DAS provider at all. Tries the legacy Token Metadata PDA first
 * (covers the vast majority of real Solana NFTs), then Metaplex Core as a
 * second attempt (assetId IS the account address for Core assets) --
 * whichever standard the given id actually is. No floor/listed-count is
 * possible here either way (same honest limitation as the DAS path).
 */
import type { ChainAdapter, CollectionSnapshot } from "@/lib/market/multichain/types";
import { reserveDasSlot, settleDasSlot, type DasSlot } from "@/lib/market/multichain/discovery/solana-das-pool";
import { readTokenMetadata } from "@/lib/market/multichain/discovery/solana-metaplex-reads";
import { readMetaplexCoreAsset } from "@/lib/market/multichain/discovery/solana-editions";
import { magicEdenSolanaAdapter } from "@/lib/market/multichain/adapters/magiceden-solana";
import { durableKv } from "@/lib/market/durable-kv";
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";

const CHAIN_SLUG = "solana-mainnet";
const ME_MARKETPLACE = "magiceden";
/** A failed alias resolution is remembered this long before the row is tried again. */
const ALIAS_MISS_TTL_MS = 7 * 24 * 60 * 60_000;
const aliasMissKey = (collectionAddress: string) => `plank:market:me-alias-miss:${collectionAddress}`;

type HeliusAsset = {
  id: string;
  interface: string;
  content?: {
    metadata?: { name?: string | null; description?: string | null };
    links?: { image?: string | null; external_url?: string | null };
  };
  creators?: Array<{ address?: string | null; verified?: boolean; share?: number }>;
};

/** The first verified creator's address, or the first creator at all if none are verified -- real DAS data, never fabricated. */
function pickCreatorAddress(creators: HeliusAsset["creators"]): string | null {
  if (!creators || creators.length === 0) return null;
  const verified = creators.find((c) => c.verified && c.address);
  return (verified ?? creators.find((c) => c.address))?.address ?? null;
}

/** Reserves+settles a FRESH key from the pool on every call (not once per run), same real per-attempt behavior as OpenSea's pool. `priority` "live" for a user-triggered fetchSnapshot, "background" for a discovery/sync supervisor. */
async function rpc<T>(method: string, params: Record<string, unknown>, priority: "live" | "background" = "live"): Promise<T> {
  const slot: DasSlot | null = await reserveDasSlot(1, { priority });
  if (!slot) throw new Error("helius-solana: no Solana DAS provider available (pool exhausted/jailed, or none of HELIUS_API_KEY(S)/QUICKNODE_SOLANA_URL/SHYFT_API_KEY configured)");
  let ok = false;
  try {
    const res = await fetch(slot.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "plank", method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`helius-solana: HTTP ${res.status} calling ${method} via ${slot.provider}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`helius-solana: ${method} via ${slot.provider} — ${body.error.code} ${body.error.message}`);
    ok = true;
    return body.result as T;
  } finally {
    await settleDasSlot(slot, 1, ok);
  }
}

/**
 * Real, free, no-DAS-provider-required fallback: reads the legacy Token
 * Metadata PDA, and if that's not a real account, tries Metaplex Core (the
 * two Solana NFT standards this app's on-chain readers cover -- see file
 * header). Returns null only when neither standard resolves anything real
 * for this id, never a fabricated snapshot.
 */
async function onchainFallbackSnapshot(assetId: string): Promise<CollectionSnapshot | null> {
  const legacy = await readTokenMetadata(assetId);
  if (legacy) {
    return {
      name: legacy.name || null,
      imageUrl: null, // legacy Metadata account only stores a URI to off-chain JSON, not a direct image URL -- resolving that JSON is real, separate scope this reader doesn't take on
      externalUrl: null,
      floorPriceWei: null,
      floorPriceCurrency: null,
      floorPriceMarketplace: null,
      totalSupply: null,
      listedCount: null,
      creatorAddress: legacy.creators?.find((c) => c.verified)?.address ?? legacy.creators?.[0]?.address ?? null,
      creatorHandle: null,
    };
  }
  const core = await readMetaplexCoreAsset(assetId);
  if (core) {
    return {
      name: core.name || null,
      imageUrl: null, // same reasoning as above -- core.uri is off-chain JSON, not a direct image URL
      externalUrl: null,
      floorPriceWei: null,
      floorPriceCurrency: null,
      floorPriceMarketplace: null,
      totalSupply: null,
      listedCount: null,
      creatorAddress: null,
      creatorHandle: null,
    };
  }
  return null;
}

/**
 * AUDIT lens 1 #7 (2026-09-06, Batch E4): a Helius-discovered row is keyed
 * by its collection asset id, which no marketplace stats API accepts, so
 * these rows never got a floor. The Magic Eden symbol is resolved through
 * real data only: one DAS `getAssetsByGroup` member of the collection ->
 * Magic Eden `GET /v2/tokens/{mint}` -> its `collection` field (the ME
 * symbol). Never a name match. Null when any step has no real answer.
 */
export type MagicEdenAliasDeps = {
  /** First DAS member mint of the collection (default: getAssetsByGroup page 1, limit 1). Null = no real member. */
  firstMember?: (collectionAddress: string) => Promise<string | null>;
  /** HTTP for the Magic Eden token lookup (default: global fetch). Injectable for unit tests. */
  fetchImpl?: typeof fetch;
};

async function firstDasMember(collectionAddress: string): Promise<string | null> {
  const members = await rpc<{ items?: Array<{ id?: string }> }>(
    "getAssetsByGroup",
    { groupKey: "collection", groupValue: collectionAddress, page: 1, limit: 1 },
    "background"
  );
  return members?.items?.[0]?.id ?? null;
}

export async function resolveMagicEdenAliasForCollection(collectionAddress: string, deps: MagicEdenAliasDeps = {}): Promise<string | null> {
  let memberMint: string | null = null;
  try {
    memberMint = await (deps.firstMember ?? firstDasMember)(collectionAddress);
  } catch {
    return null;
  }
  if (!memberMint) return null;
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(memberMint)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`helius-solana: magiceden HTTP ${res.status} resolving alias for ${collectionAddress}`);
  const body = (await res.json().catch(() => null)) as { collection?: unknown } | null;
  const symbol = body && typeof body.collection === "string" ? body.collection.trim() : "";
  return symbol ? symbol : null;
}

/** alias_symbol (migration 102) for one tracked Solana row, or null. */
export async function readAliasSymbol(collectionAddress: string): Promise<string | null> {
  if (!hasPostgresConfig()) return null;
  const r = await postgresQuery<{ alias_symbol: string | null }>(
    `SELECT alias_symbol FROM plank_multichain_collections WHERE chain_slug = $1 AND contract_address = $2`,
    [CHAIN_SLUG, collectionAddress]
  );
  return r.rows[0]?.alias_symbol ?? null;
}

async function writeAliasSymbol(collectionAddress: string, alias: string): Promise<void> {
  await postgresQuery(`UPDATE plank_multichain_collections SET alias_symbol = $3 WHERE chain_slug = $1 AND contract_address = $2`, [CHAIN_SLUG, collectionAddress, alias]);
}

/**
 * Floor/listed/holders for an aliased row, through the ME adapter. A 404
 * (collection delisted/renamed on ME) is returned as a null floor whose
 * marketplace is still "magiceden": writeSnapshot counts that as one
 * authoritative-source miss, and the second consecutive miss nulls the
 * stored floor (migration 102) instead of leaving it stale forever.
 */
export async function fetchMagicEdenStatsByAlias(alias: string): Promise<Pick<CollectionSnapshot, "floorPriceWei" | "floorPriceCurrency" | "floorPriceMarketplace" | "listedCount" | "holderCount">> {
  try {
    const me = await magicEdenSolanaAdapter.fetchSnapshot({ chainSlug: CHAIN_SLUG, contractAddress: alias });
    return {
      floorPriceWei: me.floorPriceWei,
      floorPriceCurrency: me.floorPriceWei ? me.floorPriceCurrency : null,
      floorPriceMarketplace: ME_MARKETPLACE,
      listedCount: me.listedCount,
      holderCount: me.holderCount ?? null,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/\b404\b/.test(msg)) {
      return { floorPriceWei: null, floorPriceCurrency: null, floorPriceMarketplace: ME_MARKETPLACE, listedCount: null, holderCount: null };
    }
    throw error;
  }
}

export type MagicEdenAliasLaneResult = {
  statsCandidates: number;
  statsWritten: number;
  statsMisses: number;
  aliasCandidates: number;
  aliasResolved: number;
  aliasMissed: number;
  errors: number;
};

/**
 * `magiceden-alias` mesh lane. Two bounded halves per tick: (1) refresh
 * floor/listed/holders for already-aliased Helius rows, oldest floor
 * observation first; (2) resolve aliases for un-aliased Helius rows not in
 * the 7-day negative cache. Both halves write through writeSnapshot so the
 * migration-102 floor_observed_at / miss-count rules apply unchanged.
 */
export async function runMagicEdenAliasLane(input: { statsLimit?: number; resolveLimit?: number } = {}): Promise<MagicEdenAliasLaneResult> {
  const out: MagicEdenAliasLaneResult = { statsCandidates: 0, statsWritten: 0, statsMisses: 0, aliasCandidates: 0, aliasResolved: 0, aliasMissed: 0, errors: 0 };
  if (!hasPostgresConfig()) return out;
  const { writeSnapshot } = await import("@/lib/market/multichain/store");
  const statsLimit = input.statsLimit ?? 20;
  const resolveLimit = input.resolveLimit ?? 10;

  const aliased = await postgresQuery<{ id: number; contract_address: string; alias_symbol: string }>(
    `SELECT c.id, c.contract_address, c.alias_symbol
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE c.chain_slug = $1 AND c.adapter = 'helius-solana' AND c.alias_symbol IS NOT NULL
     ORDER BY s.floor_observed_at ASC NULLS FIRST, c.id ASC
     LIMIT $2`,
    [CHAIN_SLUG, statsLimit]
  );
  out.statsCandidates = aliased.rows.length;
  for (const row of aliased.rows) {
    try {
      const stats = await fetchMagicEdenStatsByAlias(row.alias_symbol);
      await writeSnapshot(row.id, {
        name: null,
        imageUrl: null,
        externalUrl: `https://magiceden.io/marketplace/${row.alias_symbol}`,
        totalSupply: null,
        ...stats,
      });
      if (stats.floorPriceWei) out.statsWritten += 1;
      else out.statsMisses += 1;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/429|403|rate limit|quota/i.test(msg)) throw error; // let mesh-lane jail the source
      out.errors += 1;
    }
  }

  const unaliased = await postgresQuery<{ id: number; contract_address: string }>(
    `SELECT c.id, c.contract_address
     FROM plank_multichain_collections c
     WHERE c.chain_slug = $1 AND c.adapter = 'helius-solana' AND c.alias_symbol IS NULL
     ORDER BY c.id ASC
     LIMIT $2`,
    [CHAIN_SLUG, resolveLimit * 4]
  );
  for (const row of unaliased.rows) {
    if (out.aliasCandidates >= resolveLimit) break;
    const missedAt = await durableKv.get<number>(aliasMissKey(row.contract_address));
    if (missedAt && Date.now() - missedAt < ALIAS_MISS_TTL_MS) continue;
    out.aliasCandidates += 1;
    try {
      const alias = await resolveMagicEdenAliasForCollection(row.contract_address);
      if (alias) {
        await writeAliasSymbol(row.contract_address, alias);
        out.aliasResolved += 1;
      } else {
        await durableKv.set(aliasMissKey(row.contract_address), Date.now());
        out.aliasMissed += 1;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/429|403|rate limit|quota/i.test(msg)) throw error;
      out.errors += 1;
    }
  }
  return out;
}

export const heliusSolanaAdapter: ChainAdapter = {
  name: "helius-solana",
  async fetchSnapshot({ contractAddress: assetId }): Promise<CollectionSnapshot> {
    let asset: HeliusAsset;
    let base: CollectionSnapshot;
    try {
      asset = await rpc<HeliusAsset>("getAsset", { id: assetId });
      base = {
        name: asset.content?.metadata?.name ?? null,
        imageUrl: asset.content?.links?.image ?? null,
        externalUrl: asset.content?.links?.external_url ?? null,
        // DAS is asset/metadata data, not marketplace data -- no real floor
        // or listed-count source exists here. Never fabricated.
        floorPriceWei: null,
        floorPriceCurrency: null,
        floorPriceMarketplace: null,
        totalSupply: null,
        listedCount: null,
        // Real DAS creators[] data -- first verified creator, else first
        // listed creator. Never fabricated; null when the asset has none.
        creatorAddress: pickCreatorAddress(asset.creators),
        creatorHandle: null,
      };
    } catch (error) {
      const fallback = await onchainFallbackSnapshot(assetId);
      if (!fallback) throw error; // real on-chain fallback also found nothing recoverable -- surface the real DAS error rather than a fabricated empty snapshot
      base = fallback;
    }
    // AUDIT lens 1 #7: floor/listed/holders route through Magic Eden by
    // alias_symbol when one has been resolved (magiceden-alias lane). No
    // alias = exactly the old honest null floor.
    const alias = await readAliasSymbol(assetId).catch(() => null);
    if (!alias) return base;
    try {
      return { ...base, ...(await fetchMagicEdenStatsByAlias(alias)) };
    } catch {
      return base; // a transient ME failure must not fail the DAS snapshot write
    }
  },
};
