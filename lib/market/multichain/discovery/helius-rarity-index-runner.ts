/**
 * Real per-token trait/rarity indexing for Solana, the exact same
 * shared core (computeGenericRaritySnapshot + replaceForeignRarity) as
 * rarity-index-runner.ts already uses for OpenSea-backed EVM chains --
 * this is the Solana producer for that same generic, chain-agnostic
 * storage layer (plank_foreign_rarity, keyed by chain_slug +
 * collection_slug). getForeignRarity/getForeignTraitIndex and the
 * /rarity, /trait-index API routes already read generically by
 * (chainSlug, collectionSlug) with no EVM-specific assumption, and
 * MultichainCollectionView.tsx already passes the Solana contract
 * address as collectionSlug for Solana routes -- so indexing here with
 * matching keys means the existing UI picks this up with ZERO frontend
 * changes.
 *
 * CORRECTS AN EARLIER SCOPING MISTAKE, VERIFIED LIVE 2026-08-20:
 * helius-collection-scan.ts's own header previously claimed legacy/pNFT
 * Solana collections (interface: "V1_NFT"/"ProgrammableNFT" -- what most
 * established projects like Mad Lads actually use) have "no clean
 * collection-identity signal" for member-asset enumeration. That claim
 * was about DISCOVERING new collections via a broad searchAssets call,
 * which is genuinely true (see that file). It does NOT apply here: once a
 * collection's own address is already known (which it is, for every row
 * this app tracks), Helius's real, documented `grouping` filter --
 * searchAssets({ grouping: ["collection", collectionMintAddress] }) --
 * cleanly and exhaustively enumerates that collection's real member NFTs
 * regardless of standard, INCLUDING legacy/pNFT collections. Confirmed
 * live against Mad Lads (a real, well-known pNFT collection, not
 * MplCoreCollection): returned real member assets with real full trait
 * attributes (Gender, Type, Expression, Eyes, Clothing, Background).
 */
import { computeGenericRaritySnapshot, type GenericRarityInput } from "@/lib/rarity-generic";
import { replaceForeignRarity, getForeignTraitIndex } from "@/lib/market/multichain/foreign-rarity-store";
import { listTrackedCollections } from "@/lib/market/multichain/store";
import { looksLikeSolanaPubkey } from "@/lib/market/multichain/solana-pubkey";
import { postgresQuery } from "@/lib/postgres";
import {
  readCollectionMembershipCursor,
  readProjectedRarityInputs,
  upsertCollectionTokenProjection,
  writeCollectionMembershipCursor,
} from "@/lib/market/multichain/collection-token-store";

const RPC_URL = "https://mainnet.helius-rpc.com";
const PAGE_SIZE = 1000;

function apiKey(): string {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) throw new Error("helius-rarity-index-runner: HELIUS_API_KEY is not configured");
  return key;
}

type HeliusGroupedAsset = {
  id: string;
  content?: {
    links?: { image?: string | null };
    files?: Array<{ uri?: string | null; mime?: string | null }>;
    metadata?: {
      name?: string | null;
      attributes?: Array<{ trait_type?: string; value?: string | number | null }>;
    };
  };
};

function motionFile(asset: HeliusGroupedAsset): { animationUrl: string | null; mediaType: string | null } {
  const file = asset.content?.files?.find((entry) =>
    typeof entry.uri === "string" && /^(video|model)\//i.test(entry.mime ?? ""));
  return { animationUrl: file?.uri ?? null, mediaType: file?.mime ?? null };
}

function assetsToItems(assets: HeliusGroupedAsset[]): GenericRarityInput[] {
  return assets.map((asset) => ({
    tokenId: asset.id,
    name: asset.content?.metadata?.name ?? null,
    traits: (asset.content?.metadata?.attributes ?? [])
      .filter((a) => a.trait_type && a.value != null)
      .map((a) => ({ traitType: a.trait_type!, value: String(a.value) })),
  }));
}

async function heliusRpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(`${RPC_URL}/?api-key=${apiKey()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "plank", method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`helius-rarity-index-runner: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`helius-rarity-index-runner: ${body.error.code} ${body.error.message}`);
  if (body.result == null) throw new Error(`helius-rarity-index-runner: empty ${method}`);
  return body.result;
}

/**
 * Magic Eden stores Solana collections by marketplace SYMBOL (claynosaurz).
 * Helius grouping needs the Metaplex collection mint. Resolve via a listed
 * member NFT's DAS grouping — fail closed if neither is a real mint.
 */
async function resolveCollectionMint(lookup: string): Promise<{ mint: string; aliases: string[] }> {
  const aliases = [lookup];
  if (looksLikeSolanaPubkey(lookup)) {
    const first = await fetchGroupedPage(lookup, 1);
    if (first.length > 0) return { mint: lookup, aliases };
  }
  const meRes = await fetch(
    `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(lookup)}/listings?limit=1`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
  );
  if (!meRes.ok) {
    if (looksLikeSolanaPubkey(lookup)) return { mint: lookup, aliases };
    throw new Error(`helius-rarity-index-runner: Magic Eden ${meRes.status} resolving "${lookup}"`);
  }
  const listings = (await meRes.json()) as Array<{ tokenMint?: string }>;
  const memberMint = listings[0]?.tokenMint;
  if (!memberMint || !looksLikeSolanaPubkey(memberMint)) {
    if (looksLikeSolanaPubkey(lookup)) return { mint: lookup, aliases };
    throw new Error(`helius-rarity-index-runner: no listed mint for "${lookup}"`);
  }
  const asset = await heliusRpc<{ grouping?: Array<{ group_key?: string; group_value?: string }> }>("getAsset", { id: memberMint });
  const coll = asset.grouping?.find((g) => g.group_key === "collection")?.group_value;
  if (coll && looksLikeSolanaPubkey(coll)) {
    if (coll !== lookup) aliases.push(coll);
    return { mint: coll, aliases };
  }
  if (looksLikeSolanaPubkey(lookup)) return { mint: lookup, aliases };
  throw new Error(`helius-rarity-index-runner: DAS grouping missing collection for ${memberMint}`);
}

async function fetchGroupedPage(collectionAddress: string, page: number): Promise<HeliusGroupedAsset[]> {
  return (await fetchGroupedPageWithTotal(collectionAddress, page)).items;
}

async function fetchGroupedPageWithTotal(collectionAddress: string, page: number): Promise<{
  items: HeliusGroupedAsset[]; total: number | null;
}> {
  const res = await fetch(`${RPC_URL}/?api-key=${apiKey()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "plank",
      method: "searchAssets",
      params: { grouping: ["collection", collectionAddress], page, limit: PAGE_SIZE },
    }),
  });
  if (!res.ok) throw new Error(`helius-rarity-index-runner: HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: { items: HeliusGroupedAsset[]; total?: number };
    error?: { code: number; message: string };
  };
  if (body.error) throw new Error(`helius-rarity-index-runner: ${body.error.code} ${body.error.message}`);
  return { items: body.result?.items ?? [], total: body.result?.total ?? null };
}

export type SolanaRarityIndexResult = {
  chainSlug: "solana-mainnet";
  collectionAddress: string;
  tokensIndexed: number;
  partial: boolean;
};

/** Advance exactly one durable DAS membership page. Rarity is rebuilt from
 * the local projection only when the provider walk reaches its honest end. */
export async function advanceSolanaCollectionMembership(collectionAddress: string): Promise<
  SolanaRarityIndexResult & { nextPage: number; complete: boolean }
> {
  const { mint, aliases } = await resolveCollectionMint(collectionAddress);
  const projectionKey = collectionAddress;
  const rarityAliases = [...new Set([mint, ...aliases])].filter((key) => key !== projectionKey);
  const source = "helius-das-grouping";
  const checkpoint = await readCollectionMembershipCursor("solana-mainnet", projectionKey, source);
  const page = Math.max(1, Number.parseInt(checkpoint?.cursor ?? "1", 10) || 1);
  const observedAt = new Date();
  try {
    const result = await fetchGroupedPageWithTotal(mint, page);
    const expected = result.total ?? checkpoint?.expectedCount ?? null;
    const projectedAfter = checkpoint?.observedCount ?? 0;
    const complete = result.items.length < PAGE_SIZE ||
      (expected !== null && projectedAfter + result.items.length >= expected);
    await upsertCollectionTokenProjection("solana-mainnet", projectionKey, {
      tokens: result.items.map((asset) => ({
        tokenId: asset.id,
        name: asset.content?.metadata?.name ?? null,
        imageUrl: asset.content?.links?.image ?? null,
        ...motionFile(asset),
        traits: assetsToItems([asset])[0]?.traits ?? [],
      })),
      expectedCount: expected,
      partial: !complete,
      provenance: [source],
      sourceObservedAt: observedAt,
    });
    await writeCollectionMembershipCursor({
      chainSlug: "solana-mainnet", collectionSlug: projectionKey, source,
      cursor: complete ? null : String(page + 1), expectedCount: expected,
      complete, sourceObservedAt: observedAt,
    });
    if (!complete) {
      return { chainSlug: "solana-mainnet", collectionAddress: projectionKey,
        tokensIndexed: result.items.length, partial: true, nextPage: page + 1, complete: false };
    }
    const items = await readProjectedRarityInputs("solana-mainnet", projectionKey);
    const indexed = await persistSolanaSnapshot(projectionKey, items, false, rarityAliases);
    await upsertCollectionTokenProjection("solana-mainnet", projectionKey, {
      tokens: [...computeGenericRaritySnapshot(items).byTokenId.values()].map((token) => ({
        tokenId: token.tokenId, name: token.name, rarityScore: token.score,
        rarityRank: token.rank, rarityPercentile: token.percentile, rarityTier: token.tier,
      })),
      expectedCount: expected, partial: false,
      provenance: [source, "bespoke-information-content-rarity"], sourceObservedAt: observedAt,
    });
    return { ...indexed, nextPage: page, complete: true };
  } catch (error) {
    await writeCollectionMembershipCursor({
      chainSlug: "solana-mainnet", collectionSlug: projectionKey, source, cursor: String(page),
      expectedCount: checkpoint?.expectedCount, complete: false,
      lastError: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

/** Fair, durable Solana work selector. Incomplete walks win; completed
 * collections rotate oldest-first, so a live cron neither restarts page one
 * nor permanently starves collections discovered later. */
export async function advanceNextTrackedSolanaMembership() {
  const source = "helius-das-grouping";
  const candidates = await postgresQuery<{ contract_address: string }>(
    `SELECT c.contract_address
     FROM plank_multichain_collections c
     LEFT JOIN plank_collection_membership_cursors m
       ON m.chain_slug = c.chain_slug
      AND lower(m.collection_slug) = lower(c.contract_address)
      AND m.source = $1
     WHERE c.chain_slug = 'solana-mainnet'
     ORDER BY (m.complete IS NOT TRUE) DESC, m.updated_at ASC NULLS FIRST, c.id
     LIMIT 1`,
    [source]
  );
  const collectionAddress = candidates.rows[0]?.contract_address;
  return collectionAddress ? advanceSolanaCollectionMembership(collectionAddress) : null;
}

async function persistSolanaSnapshot(
  collectionKey: string,
  items: GenericRarityInput[],
  partial: boolean,
  aliases: string[]
): Promise<SolanaRarityIndexResult> {
  const snapshot = { ...computeGenericRaritySnapshot(items), partial };
  const traitIndex: Record<string, Record<string, string[]>> = {};
  for (const item of items) {
    for (const t of item.traits) {
      traitIndex[t.traitType] ??= {};
      traitIndex[t.traitType][t.value] ??= [];
      traitIndex[t.traitType][t.value].push(item.tokenId);
    }
  }
  await replaceForeignRarity(
    "solana-mainnet",
    collectionKey,
    snapshot,
    traitIndex,
    aliases.filter((a) => a !== collectionKey)
  );
  const { updateCollectionSupplyFields } = await import("@/lib/market/multichain/store");
  for (const key of [collectionKey, ...aliases]) {
    await updateCollectionSupplyFields("solana-mainnet", key, {
      listedCount: null,
      totalSupply: snapshot.sampleSize,
    }).catch(() => {});
  }
  return { chainSlug: "solana-mainnet", collectionAddress: collectionKey, tokensIndexed: snapshot.byTokenId.size, partial };
}

async function itemsFromMagicEdenListings(symbol: string): Promise<GenericRarityInput[]> {
  const res = await fetch(
    `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/listings?limit=20`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) return [];
  const raw = (await res.json()) as Array<{
    tokenMint?: string;
    token?: { name?: string | null; attributes?: Array<{ trait_type?: string; value?: string | number | null }> };
  }>;
  return raw
    .filter((l) => l.tokenMint)
    .map((l) => ({
      tokenId: l.tokenMint!,
      name: l.token?.name ?? null,
      traits: (l.token?.attributes ?? [])
        .filter((a) => a.trait_type && a.value != null)
        .map((a) => ({ traitType: a.trait_type!, value: String(a.value) })),
    }));
}

export async function indexSolanaCollectionRarity(collectionAddress: string): Promise<SolanaRarityIndexResult> {
  try {
    const { mint, aliases } = await resolveCollectionMint(collectionAddress);
    const items: GenericRarityInput[] = [];
    let page = 1;
    let lastPageSize = PAGE_SIZE;

    while (lastPageSize === PAGE_SIZE) {
      const assets = await fetchGroupedPage(mint, page);
      items.push(...assetsToItems(assets));
      lastPageSize = assets.length;
      page += 1;
    }

    if (items.length === 0) {
      throw new Error(`helius-rarity-index-runner: no member NFTs for "${collectionAddress}" (mint ${mint})`);
    }
    return persistSolanaSnapshot(mint, items, false, aliases);
  } catch (primary) {
    const listed = await itemsFromMagicEdenListings(collectionAddress);
    const withTraits = listed.filter((i) => i.traits.length > 0);
    if (withTraits.length === 0) throw primary;
    return persistSolanaSnapshot(collectionAddress, withTraits, true, []);
  }
}

export type ScaffoldSolanaResult = {
  totalTracked: number;
  indexed: number;
  skippedFresh: number;
  failed: number;
};

/**
 * Scaffolds every tracked Solana collection to real trait/rarity parity --
 * same freshness-skip/pacing shape as rarity-index-runner.ts's own
 * scaffoldAllTrackedCollections (EVM), so the two read the same way in
 * refresh-market-data.ts's step log.
 */
export async function scaffoldAllTrackedSolanaCollections(opts?: {
  force?: boolean;
  freshDays?: number;
  delayMs?: number;
  limit?: number;
  onProgress?: (line: string) => void;
}): Promise<ScaffoldSolanaResult> {
  const force = opts?.force ?? false;
  const freshDays = opts?.freshDays ?? 7;
  const delayMs = opts?.delayMs ?? 1000;
  const limit = opts?.limit ?? Infinity;
  const log = opts?.onProgress ?? (() => {});

  const all = await listTrackedCollections();
  const solana = all.filter((c) => c.chainSlug === "solana-mainnet").slice(0, limit);

  let indexed = 0;
  let skippedFresh = 0;
  let failed = 0;

  for (const c of solana) {
    if (!force) {
      const existing = await getForeignTraitIndex("solana-mainnet", c.contractAddress).catch(() => null);
      // REAL BUG FIXED 2026-08-23, same shape as rarity-index-runner.ts's
      // (EVM) and ordinalswallet-rarity-index-runner.ts's own fix: a prior
      // PARTIAL index (Helius DAS grouping walk still mid-page, or the
      // Magic Eden listings fallback which is only ever partial) must not
      // be shielded behind the freshDays window -- only a genuinely
      // complete (non-partial) result should suppress a re-attempt.
      if (existing?.indexedAt && existing.partial !== true) {
        const ageDays = (Date.now() - new Date(existing.indexedAt).getTime()) / 86_400_000;
        if (ageDays < freshDays) {
          skippedFresh += 1;
          continue;
        }
      }
    }

    try {
      const result = await advanceSolanaCollectionMembership(c.contractAddress);
      log(`indexed ${c.contractAddress} (solana-mainnet): ${result.tokensIndexed} tokens${result.partial ? " (PARTIAL)" : ""}`);
      indexed += 1;
    } catch (error) {
      log(`FAILED ${c.contractAddress} (solana-mainnet): ${error instanceof Error ? error.message : error}`);
      failed += 1;
    }

    await sleep(delayMs);
  }

  return { totalTracked: all.length, indexed, skippedFresh, failed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
