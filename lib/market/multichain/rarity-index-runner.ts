/**
 * The shared indexing core behind scripts/index-foreign-rarity.ts (single
 * collection, hand-run) and scripts/scaffold-all-collections.ts (every
 * tracked EVM collection, unattended) -- extracted so both callers run the
 * IDENTICAL pagination/scoring/persistence logic instead of two copies
 * drifting apart. See migration 014_foreign_rarity.sql's header for why
 * this is a background job, never a live per-request compute.
 */
import { foreignChainByChainSlug, foreignRpcUrls } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { computeGenericRaritySnapshot } from "@/lib/rarity-generic";
import { replaceForeignRarity, getForeignTraitIndex, type ForeignTraitIndex } from "@/lib/market/multichain/foreign-rarity-store";
import { listTrackedCollections } from "@/lib/market/multichain/store";
import { postgresQuery } from "@/lib/postgres";
import {
  readCollectionMembershipCursor,
  readProjectedRarityInputs,
  upsertCollectionTokenProjection,
  writeCollectionMembershipCursor,
  readTokenMetadataWork,
  writeTokenMetadataResult,
} from "@/lib/market/multichain/collection-token-store";
import { SERVER_DISPLAY_RPC_URLS } from "@/lib/server/rpc-urls";
import { resolveEvmTokenMetadata, resolveOpenSeaTokenMetadata } from "@/lib/market/multichain/discovery/evm-token-metadata";
import { readSequentialMintBoundary } from "@/lib/market/multichain/collection-capabilities";

const PAGE_SIZE = 50;

/** First-pass item cap so we never block on Art Blocks / ENS. Ranks recompute as sample grows. */
export function itemCeiling(supply: number | null): number {
  if (supply == null || !Number.isFinite(supply) || supply <= 0) return 2_000;
  if (supply <= 12_000) return Math.ceil(supply);
  if (supply <= 40_000) return 12_000;
  return 8_000;
}

export type RarityIndexBackend = "helius" | "unisat" | "opensea-contract" | "opensea-slug";

/**
 * Same −log2 kernel for every chain. Enumerator differs:
 * Solana = Helius grouping, Bitcoin = UniSat activity (always partial),
 * Avalanche/ETH/Base/etc. = OpenSea NFT walk (contract or slug).
 */
export function rarityIndexBackend(chainSlug: string, lookup: string): RarityIndexBackend {
  if (chainSlug === "solana-mainnet") return "helius";
  if (chainSlug === "bitcoin-mainnet") return "unisat";
  if (/^0x[0-9a-fA-F]{40}$/.test(lookup)) return "opensea-contract";
  return "opensea-slug";
}

export type IndexRunResult = {
  chainSlug: string;
  collectionSlug: string;
  contractAddress: string;
  tokensIndexed: number;
  partial: boolean;
};

const OPENSEA_MEMBERSHIP_SOURCE = "opensea-nfts";
const SEQUENTIAL_MEMBERSHIP_SOURCE = "verified-sequential-mints";
const SEQUENTIAL_SEED_SIZE = 750;

/** Materialize a bounded slice of a publisher-verified contiguous token-id
 * universe. This makes an open-ended collection complete through the exact
 * on-chain boundary observed on this run, while later runs naturally append
 * newly minted ids. Metadata remains a separate bounded worker. */
export async function advanceVerifiedSequentialMembership(chainSlug: string, contractAddress: string) {
  const canonicalAddress = contractAddress.toLowerCase();
  const rpcUrls = chainSlug === "robinhood" ? SERVER_DISPLAY_RPC_URLS : foreignRpcUrls(chainSlug);
  const boundary = await readSequentialMintBoundary({ chainSlug, contractAddress: canonicalAddress, rpcUrls });
  if (!boundary) return null;
  const checkpoint = await readCollectionMembershipCursor(chainSlug, canonicalAddress, SEQUENTIAL_MEMBERSHIP_SOURCE);
  const firstPending = Math.max(boundary.firstTokenId, Number(checkpoint?.cursor ?? boundary.firstTokenId));
  const end = Math.min(boundary.lastTokenId, firstPending + SEQUENTIAL_SEED_SIZE - 1);
  const tokens = end >= firstPending
    ? Array.from({ length: end - firstPending + 1 }, (_, index) => ({
        tokenId: String(firstPending + index), name: null, imageUrl: null,
        animationUrl: null, traits: [],
      }))
    : [];
  const complete = end >= boundary.lastTokenId;
  const observedAt = new Date();
  await upsertCollectionTokenProjection(chainSlug, canonicalAddress, {
    // Membership can be complete while metadata/traits are still pending.
    // Keep the projection partial until advanceEvmTokenMetadata proves every
    // row terminal and writes the full-population rarity snapshot.
    tokens, expectedCount: boundary.expectedCount, partial: true,
    provenance: [boundary.provenance], sourceObservedAt: observedAt,
  });
  await writeCollectionMembershipCursor({
    chainSlug, collectionSlug: canonicalAddress, source: SEQUENTIAL_MEMBERSHIP_SOURCE,
    cursor: complete ? String(boundary.lastTokenId + 1) : String(end + 1),
    expectedCount: boundary.expectedCount, complete, sourceObservedAt: observedAt,
  });
  return { ...boundary, itemsObserved: tokens.length, complete, nextTokenId: complete ? null : end + 1 };
}

/** Advance one OpenSea NFT page for a known EVM contract. The contract is
 * the durable key used by routes; the OpenSea slug is retained as an alias. */
export async function advanceEvmCollectionMembership(
  chainSlug: string,
  contractAddress: string,
  openSeaChainOverride?: string
) {
  const chain = foreignChainByChainSlug(chainSlug);
  const openSeaChain = openSeaChainOverride ?? chain?.openSeaChain;
  if (!openSeaChain) throw new Error(`${chainSlug} has no OpenSea NFT enumerator`);
  // Seed any independently verified on-chain universe before provider
  // pagination. Provider results enrich these rows; they do not define the
  // collection's size or decide whether a live mint exists.
  // A temporary RPC failure must not also discard the independent OpenSea
  // page available on this run. The sequential cursor remains unchanged and
  // will retry; provider pagination continues as additive evidence.
  await advanceVerifiedSequentialMembership(chainSlug, contractAddress).catch(() => null);
  const key = await getOpenSeaApiKey();
  if (!key) throw new Error("No OpenSea API key available.");
  const slug = await resolveOpenSeaSlug(chainSlug, contractAddress, key, openSeaChain);
  if (!slug) throw new Error(`no OpenSea slug for ${chainSlug}:${contractAddress}`);
  const checkpoint = await readCollectionMembershipCursor(chainSlug, contractAddress, OPENSEA_MEMBERSHIP_SOURCE);
  const url = new URL(`https://api.opensea.io/api/v2/chain/${openSeaChain}/contract/${contractAddress}/nfts`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  if (checkpoint?.cursor) url.searchParams.set("next", checkpoint.cursor);
  const observedAt = new Date();
  try {
    const response = await fetch(url, {
      headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`OpenSea ${response.status} enumerating ${contractAddress}`);
    const body = await response.json() as {
      nfts?: Array<{ identifier: string; name?: string | null; image_url?: string | null;
        display_image_url?: string | null; animation_url?: string | null;
        traits?: Array<{ trait_type?: string; value?: string | number | null }> }>;
      next?: string | null;
    };
    const nfts = body.nfts ?? [];
    const next = body.next ?? null;
    const complete = !next;
    await upsertCollectionTokenProjection(chainSlug, contractAddress, {
      tokens: nfts.map((nft) => ({
        tokenId: nft.identifier, name: nft.name ?? null,
        imageUrl: nft.display_image_url || nft.image_url || null,
        animationUrl: nft.animation_url ?? null,
        traits: (nft.traits ?? []).flatMap((trait) => trait.trait_type && trait.value != null
          ? [{ traitType: trait.trait_type, value: String(trait.value) }] : []),
      })),
      partial: !complete, provenance: [OPENSEA_MEMBERSHIP_SOURCE], sourceObservedAt: observedAt,
    });
    await writeCollectionMembershipCursor({ chainSlug, collectionSlug: contractAddress,
      source: OPENSEA_MEMBERSHIP_SOURCE, cursor: next, complete, sourceObservedAt: observedAt });
    if (complete) {
      const items = await readProjectedRarityInputs(chainSlug, contractAddress);
      const snapshot = { ...computeGenericRaritySnapshot(items), partial: false };
      const traitIndex: ForeignTraitIndex = {};
      for (const item of items) for (const trait of item.traits) {
        traitIndex[trait.traitType] ??= {};
        traitIndex[trait.traitType][trait.value] ??= [];
        traitIndex[trait.traitType][trait.value].push(item.tokenId);
      }
      await replaceForeignRarity(chainSlug, contractAddress, snapshot, traitIndex, [slug]);
      await upsertCollectionTokenProjection(chainSlug, contractAddress, {
        tokens: [...snapshot.byTokenId.values()].map((token) => ({ tokenId: token.tokenId,
          name: token.name, rarityScore: token.score, rarityRank: token.rank,
          rarityPercentile: token.percentile, rarityTier: token.tier })),
        expectedCount: items.length, partial: false,
        provenance: [OPENSEA_MEMBERSHIP_SOURCE, "bespoke-information-content-rarity"], sourceObservedAt: observedAt,
      });
    }
    return { chainSlug, contractAddress, slug, itemsObserved: nfts.length, complete, nextCursor: next };
  } catch (error) {
    await writeCollectionMembershipCursor({ chainSlug, collectionSlug: contractAddress,
      source: OPENSEA_MEMBERSHIP_SOURCE, cursor: checkpoint?.cursor ?? null, complete: false,
      lastError: error instanceof Error ? error.message : String(error) }).catch(() => {});
    throw error;
  }
}

export async function advanceNextTrackedEvmMembership(chainSlug: string) {
  const candidates = await postgresQuery<{ contract_address: string }>(
    `SELECT c.contract_address FROM plank_multichain_collections c
     LEFT JOIN plank_collection_membership_cursors m
       ON m.chain_slug = c.chain_slug AND lower(m.collection_slug) = lower(c.contract_address) AND m.source = $2
     WHERE c.chain_slug = $1 AND c.contract_address ~* '^0x[0-9a-f]{40}$'
     ORDER BY (m.complete IS NOT TRUE) DESC, m.updated_at ASC NULLS FIRST, c.id LIMIT 1`,
    [chainSlug, OPENSEA_MEMBERSHIP_SOURCE]);
  const address = candidates.rows[0]?.contract_address;
  return address ? advanceEvmCollectionMembership(chainSlug, address) : null;
}

export async function advanceNextRobinhoodMembership() {
  const candidates = await postgresQuery<{ contract_address: string }>(
    `SELECT c.contract_address FROM plank_multichain_collections c
     LEFT JOIN plank_collection_membership_cursors m
       ON m.chain_slug = c.chain_slug AND lower(m.collection_slug) = lower(c.contract_address) AND m.source = $2
     WHERE c.chain_slug = $1 AND c.contract_address ~* '^0x[0-9a-f]{40}$'
     ORDER BY (m.complete IS NOT TRUE) DESC, m.updated_at ASC NULLS FIRST, c.id LIMIT 1`,
    ["robinhood", OPENSEA_MEMBERSHIP_SOURCE]);
  const address = candidates.rows[0]?.contract_address;
  return address ? advanceEvmCollectionMembership("robinhood", address, "robinhood") : null;
}

/** Enrich a tiny durable batch from first-party tokenURI metadata. Public
 * requests never perform these RPC/IPFS calls. Missing metadata is recorded
 * honestly; transient failures are retried after a bounded cooldown. */
export async function advanceEvmTokenMetadata(chainSlug: string, limit = 6, collectionSlug?: string | null) {
  const chain = foreignChainByChainSlug(chainSlug);
  const openSeaChain = chainSlug === "robinhood" ? "robinhood" : chain?.openSeaChain;
  const rpcUrls = chainSlug === "robinhood" ? SERVER_DISPLAY_RPC_URLS : foreignRpcUrls(chainSlug);
  if (!openSeaChain || !rpcUrls.length) throw new Error(`${chainSlug} has no metadata enrichment route`);
  const work = await readTokenMetadataWork(chainSlug, limit, collectionSlug);
  const openSeaKey = await getOpenSeaApiKey();
  let complete = 0, empty = 0, retry = 0;
  const errors: string[] = [];
  for (const item of work) {
    try {
      const metadata = await resolveEvmTokenMetadata({ rpcUrls,
        contractAddress: item.collectionSlug, tokenId: item.tokenId }).catch(async (onchainError) => {
          if (!openSeaKey) throw onchainError;
          return resolveOpenSeaTokenMetadata({ apiKey: openSeaKey, openSeaChain,
            contractAddress: item.collectionSlug, tokenId: item.tokenId });
        });
      if (!metadata || (!metadata.name && !metadata.imageUrl && metadata.traits.length === 0)) {
        await writeTokenMetadataResult({ chainSlug, ...item, state: "empty" });
        empty += 1;
        continue;
      }
      await upsertCollectionTokenProjection(chainSlug, item.collectionSlug, {
        tokens: [{ tokenId: item.tokenId, ...metadata }], partial: true,
        preservePartial: true, provenance: ["robinhood-token-uri"], sourceObservedAt: new Date(),
      });
      await writeTokenMetadataResult({ chainSlug, ...item, state: "complete" });
      complete += 1;
    } catch (error) {
      await writeTokenMetadataResult({ chainSlug, ...item, state: "retry",
        error: error instanceof Error ? error.message : String(error) });
      if (errors.length < 3) errors.push(error instanceof Error ? error.message : String(error));
      retry += 1;
    }
  }
  let rarityFinalized = 0;
  for (const collectionSlug of new Set(work.map((item) => item.collectionSlug))) {
    const state = await postgresQuery<{ remaining: string; membership_complete: boolean }>(
      `SELECT COUNT(*) FILTER (WHERE t.metadata_state IN ('pending','retry'))::text AS remaining,
         EXISTS (
           SELECT 1 FROM plank_collection_membership_cursors m
           WHERE m.chain_slug = $1 AND lower(m.collection_slug) = lower($2) AND m.complete
         ) AS membership_complete
       FROM plank_collection_tokens t
       WHERE t.chain_slug = $1 AND lower(t.collection_slug) = lower($2)`,
      [chainSlug, collectionSlug]);
    if (Number(state.rows[0]?.remaining ?? 1) !== 0 || !state.rows[0]?.membership_complete) continue;
    const items = await readProjectedRarityInputs(chainSlug, collectionSlug);
    if (!items.length) continue;
    const snapshot = { ...computeGenericRaritySnapshot(items), partial: false };
    const traitIndex: ForeignTraitIndex = {};
    for (const item of items) for (const trait of item.traits) {
      traitIndex[trait.traitType] ??= {};
      traitIndex[trait.traitType][trait.value] ??= [];
      traitIndex[trait.traitType][trait.value].push(item.tokenId);
    }
    const slug = openSeaKey ? await resolveOpenSeaSlug(chainSlug, collectionSlug, openSeaKey, openSeaChain).catch(() => null) : null;
    await replaceForeignRarity(chainSlug, collectionSlug, snapshot, traitIndex, slug ? [slug] : []);
    await upsertCollectionTokenProjection(chainSlug, collectionSlug, {
      tokens: [...snapshot.byTokenId.values()].map((token) => ({ tokenId: token.tokenId,
        name: token.name, rarityScore: token.score, rarityRank: token.rank,
        rarityPercentile: token.percentile, rarityTier: token.tier })),
      expectedCount: items.length, partial: false,
      provenance: ["bespoke-information-content-rarity"], sourceObservedAt: new Date(),
    });
    rarityFinalized += 1;
  }
  return { attempted: work.length, complete, empty, retry, rarityFinalized, errors };
}

export async function advanceRobinhoodTokenMetadata(limit = 6) {
  return advanceEvmTokenMetadata("robinhood", limit);
}

export async function indexForeignCollectionRarity(chainSlug: string, collectionSlug: string): Promise<IndexRunResult> {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) throw new Error(`"${chainSlug}" is not in FOREIGN_CHAINS.`);
  // This whole runner scrapes OpenSea's own metadata/rarity -- meaningless
  // for a chain with no OpenSea integration (zkSync today). Callers must
  // filter these out before reaching here; see scaffoldAllTrackedCollections's
  // own openSeaChain filter below.
  if (!chain.openSeaChain) {
    throw new Error(`"${chainSlug}" has no OpenSea orderbook -- rarity indexing needs an OpenSea collection slug.`);
  }
  const key = await getOpenSeaApiKey();
  if (!key) throw new Error("No OpenSea API key available.");

  const collectionMeta = (await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(collectionSlug)}`, {
    headers: { "x-api-key": key, accept: "application/json" },
  }).then((r) => (r.ok ? r.json() : null))) as {
    name?: string;
    image_url?: string;
    contracts?: Array<{ address: string; chain: string }>;
    creator_username?: string | null;
    twitter_username?: string | null;
    owner?: string | null;
    total_supply?: number | null;
  } | null;
  // Real, confirmed API inconsistency (2026-08-18): OpenSea's own
  // /chain/{chain}/contract/{address} path segment for Polygon is "matic"
  // (confirmed live, and used correctly everywhere else in this app), but
  // THIS endpoint's contracts[].chain field returns "polygon" for the
  // exact same chain -- verified against a real Polygon collection
  // (c1-galaxy), while every other chain checked (base, ethereum) matches
  // its FOREIGN_CHAINS openSeaChain value exactly. Every Polygon
  // collection was failing this resolution 100% of the time before this
  // alias. Scoped narrowly to the one confirmed case, not a guess at
  // other chains that already match cleanly.
  const chainAliases: Record<string, string[]> = { matic: ["matic", "polygon"] };
  const acceptableChainValues = chainAliases[chain.openSeaChain] ?? [chain.openSeaChain];
  const contractAddress = collectionMeta?.contracts?.find((c) => acceptableChainValues.includes(c.chain))?.address;
  if (!contractAddress) throw new Error(`Could not resolve a ${chain.openSeaChain} contract for "${collectionSlug}".`);

  // Real OpenSea art/name/creator, persisted into the SAME registry row
  // the Global Market hub reads (plank_multichain_collections) -- fixes
  // DeFiLlama's dead img.reservoir.tools URLs (Reservoir shut down its
  // public infrastructure in 2025, see GlobalMarketHub.tsx's own header)
  // for free, during a pass that's already fetching this exact response.
  //
  // CREATOR ATTRIBUTION, ONLY WHEN REAL: confirmed live 2026-08-18 across
  // multiple collections that OpenSea's creator_username field is null
  // site-wide now (not just for this app's tracked set) -- twitter_username
  // and the owner wallet are the reliably-populated real fields, so those
  // are what this actually surfaces. Never a guessed/derived name.
  if (collectionMeta?.image_url || collectionMeta?.name || collectionMeta?.twitter_username || collectionMeta?.owner) {
    // Real ENS reverse lookup for the owner wallet, "whenever publicly
    // known" (lib/market/multichain/ens.ts) -- a real address-keyed
    // lookup, not scoped to this chain, so it resolves regardless of
    // which chain the collection itself lives on. Null (not an empty
    // string) when no name is set; never fabricated.
    const { resolveEnsName } = await import("@/lib/market/multichain/ens");
    const creatorEns = collectionMeta.owner ? await resolveEnsName(collectionMeta.owner).catch(() => null) : null;

    const { updateCollectionDisplay } = await import("@/lib/market/multichain/store");
    await updateCollectionDisplay(chainSlug, contractAddress, {
      name: collectionMeta.name ?? null,
      imageUrl: collectionMeta.image_url ?? null,
      creatorHandle: collectionMeta.creator_username ?? collectionMeta.twitter_username ?? null,
      creatorAddress: collectionMeta.owner ?? null,
      creatorEns,
    }).catch(() => {});
  }

  // Real 24h/7d/30d volume/sales (OpenSea /collections/{slug}/stats,
  // confirmed live) -- separate call, separate endpoint, same pass. The
  // same `intervals` response already carries "seven_day" and "thirty_day"
  // entries alongside "one_day", so reading those out is zero extra API
  // calls -- not a second fetch, not a fabricated multi-window figure
  // derived from a single data point.
  const stats = (await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(collectionSlug)}/stats`, {
    headers: { "x-api-key": key, accept: "application/json" },
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { intervals?: Array<{ interval: string; volume?: number; sales?: number }> } | null;
  const oneDay = stats?.intervals?.find((i) => i.interval === "one_day");
  const sevenDay = stats?.intervals?.find((i) => i.interval === "seven_day");
  const thirtyDay = stats?.intervals?.find((i) => i.interval === "thirty_day");
  if (oneDay || sevenDay || thirtyDay) {
    const { updateCollectionMarketStats } = await import("@/lib/market/multichain/store");
    const toWei = (v: number | undefined) => (typeof v === "number" ? BigInt(Math.round(v * 1e18)).toString() : null);
    await updateCollectionMarketStats(chainSlug, contractAddress, {
      volume24hWei: toWei(oneDay?.volume),
      sales24h: oneDay?.sales ?? null,
      volume7dWei: toWei(sevenDay?.volume),
      sales7d: sevenDay?.sales ?? null,
      volume30dWei: toWei(thirtyDay?.volume),
      sales30d: thirtyDay?.sales ?? null,
      currentFloorPriceWei: null,
    }).catch(() => {});
  }

  const supplyHint = typeof collectionMeta?.total_supply === "number" ? collectionMeta.total_supply : null;
  const cap = itemCeiling(supplyHint ?? null);
  const items: Array<{
    tokenId: string;
    name: string | null;
    imageUrl: string | null;
    traits: Array<{ traitType: string; value: string }>;
  }> = [];
  let cursor: string | null = null;
  let page = 0;
  const maxPages = Math.ceil(cap / PAGE_SIZE) + 1;

  do {
    const url = new URL(`https://api.opensea.io/api/v2/chain/${chain.openSeaChain}/contract/${contractAddress}/nfts`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (cursor) url.searchParams.set("next", cursor);
    const res: Response = await fetch(url.toString(), { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`OpenSea ${res.status} on page ${page}`);
    const data = (await res.json()) as {
      nfts?: Array<{
        identifier: string;
        name?: string;
        image_url?: string | null;
        display_image_url?: string | null;
        traits?: Array<{ trait_type: string; value: string }>;
      }>;
      next?: string | null;
    };
    for (const nft of data.nfts ?? []) {
      items.push({
        tokenId: nft.identifier,
        name: nft.name ?? null,
        imageUrl: nft.display_image_url || nft.image_url || null,
        traits: (nft.traits ?? []).filter((t) => t.trait_type && t.value != null).map((t) => ({ traitType: t.trait_type, value: String(t.value) })),
      });
    }
    cursor = data.next ?? null;
    page += 1;
  } while (cursor && page < maxPages && items.length < cap);

  const partial = Boolean(cursor) || (supplyHint != null && items.length < supplyHint);
  const snapshot = { ...computeGenericRaritySnapshot(items), partial };
  const traitIndex: ForeignTraitIndex = {};
  for (const item of items) {
    for (const t of item.traits) {
      traitIndex[t.traitType] ??= {};
      traitIndex[t.traitType][t.value] ??= [];
      traitIndex[t.traitType][t.value].push(item.tokenId);
    }
  }

  const aliases = collectionSlug.toLowerCase() === contractAddress.toLowerCase() ? [] : [contractAddress];
  const images = new Map(items.map((i) => [i.tokenId, i.imageUrl]));
  await replaceForeignRarity(chainSlug, collectionSlug, snapshot, traitIndex, aliases, images);

  return { chainSlug, collectionSlug, contractAddress, tokensIndexed: snapshot.byTokenId.size, partial };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveOpenSeaSlug(
  chainSlug: string,
  contractAddress: string,
  key: string,
  openSeaChainOverride?: string
): Promise<string | null> {
  const chain = foreignChainByChainSlug(chainSlug);
  const openSeaChain = openSeaChainOverride ?? chain?.openSeaChain;
  if (!openSeaChain) return null;
  const res = await fetch(`https://api.opensea.io/api/v2/chain/${openSeaChain}/contract/${contractAddress}`, {
    headers: { "x-api-key": key, accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { collection?: string };
  return data.collection ?? null;
}

/** Dispatches the same −log2 kernel to the chain's real enumerator. Never Alchemy. */
export async function indexRarityForCollectionLookup(chainSlug: string, lookup: string): Promise<IndexRunResult> {
  const backend = rarityIndexBackend(chainSlug, lookup);
  if (backend === "helius") {
    const { indexSolanaCollectionRarity } = await import("@/lib/market/multichain/discovery/helius-rarity-index-runner");
    const r = await indexSolanaCollectionRarity(lookup);
    return {
      chainSlug: r.chainSlug,
      collectionSlug: r.collectionAddress,
      contractAddress: r.collectionAddress,
      tokensIndexed: r.tokensIndexed,
      partial: r.partial,
    };
  }
  if (backend === "unisat") {
    const { indexBitcoinCollectionRarity } = await import("@/lib/market/multichain/discovery/unisat-rarity-index-runner");
    const r = await indexBitcoinCollectionRarity(lookup);
    return {
      chainSlug: r.chainSlug,
      collectionSlug: r.collectionId,
      contractAddress: r.collectionId,
      tokensIndexed: r.tokensIndexed,
      partial: r.partial,
    };
  }
  if (backend === "opensea-contract") {
    const key = await getOpenSeaApiKey();
    if (!key) throw new Error("No OpenSea API key available.");
    const slug = await resolveOpenSeaSlug(chainSlug, lookup, key);
    if (!slug) throw new Error(`no OpenSea slug for ${chainSlug}:${lookup}`);
    return indexForeignCollectionRarity(chainSlug, slug);
  }
  return indexForeignCollectionRarity(chainSlug, lookup);
}

export type ScaffoldAllResult = {
  totalTracked: number;
  evmInScope: number;
  solanaSkipped: number;
  /** EVM chains this app trades on natively but with no OpenSea integration to scrape (zkSync today) -- distinct from solanaSkipped, which is non-EVM entirely. */
  noOpenSeaSkipped: number;
  indexed: number;
  skippedFresh: number;
  failed: number;
};

/**
 * Scaffolds every tracked EVM collection to full rarity/trait parity --
 * the shared core behind scripts/scaffold-all-collections.ts (hand-run)
 * and refresh-market-data.ts's "scaffold-rarity" cron step (unattended,
 * so a newly-discovered/promoted collection gets this automatically). See
 * scripts/scaffold-all-collections.ts's own header for why Solana is
 * out of scope (Seaport-based pipeline, no Solana order book) and why
 * freshness-skip/pacing exist.
 */
export async function scaffoldAllTrackedCollections(opts?: {
  force?: boolean;
  freshDays?: number;
  delayMs?: number;
  limit?: number;
  onProgress?: (line: string) => void;
}): Promise<ScaffoldAllResult> {
  const force = opts?.force ?? false;
  const freshDays = opts?.freshDays ?? 7;
  const delayMs = opts?.delayMs ?? 1500;
  const limit = opts?.limit ?? Infinity;
  const log = opts?.onProgress ?? (() => {});

  const key = await getOpenSeaApiKey();
  if (!key) throw new Error("No OpenSea API key available.");

  const all = await listTrackedCollections();
  const solana = all.filter((c) => !foreignChainByChainSlug(c.chainSlug));
  // Also excludes chains with no OpenSea integration (zkSync today,
  // openSeaChain: null) -- this entire runner is OpenSea metadata/rarity
  // scraping, meaningless without an OpenSea collection slug to resolve.
  // Logged as its own count, not folded into `solana`, since it's a real,
  // distinct reason: these ARE EVM chains this app trades on natively,
  // just not through OpenSea's orderbook.
  const evm = all.filter((c) => foreignChainByChainSlug(c.chainSlug)?.openSeaChain).slice(0, limit);
  const noOpenSeaChain = all.filter((c) => foreignChainByChainSlug(c.chainSlug) && !foreignChainByChainSlug(c.chainSlug)?.openSeaChain);

  let indexed = 0;
  let skippedFresh = 0;
  let failed = 0;
  const skippedNoOpenSea = noOpenSeaChain.length;
  for (const c of noOpenSeaChain) {
    log(`SKIP ${c.chainSlug}:${c.contractAddress} -- no OpenSea orderbook for this chain`);
  }

  for (const c of evm) {
    const slug = await resolveOpenSeaSlug(c.chainSlug, c.contractAddress, key).catch(() => null);
    if (!slug) {
      log(`SKIP ${c.chainSlug}:${c.contractAddress} -- no OpenSea slug; Alchemy rarity is off (monthly cap). Helius/UniSat runners cover SOL/BTC.`);
      failed += 1;
      continue;
    }

    if (!force) {
      const existing = await getForeignTraitIndex(c.chainSlug, slug).catch(() => null);
      if (existing?.indexedAt) {
        const ageDays = (Date.now() - new Date(existing.indexedAt).getTime()) / 86_400_000;
        if (ageDays < freshDays) {
          skippedFresh += 1;
          continue;
        }
      }
    }

    try {
      const result = await indexForeignCollectionRarity(c.chainSlug, slug);
      log(`indexed ${slug} (${c.chainSlug}): ${result.tokensIndexed} tokens${result.partial ? " (PARTIAL)" : ""}`);
      indexed += 1;
    } catch (error) {
      log(`FAILED ${slug} (${c.chainSlug}): ${error instanceof Error ? error.message : error}`);
      failed += 1;
    }

    await sleep(delayMs);
  }

  return {
    totalTracked: all.length,
    evmInScope: evm.length,
    solanaSkipped: solana.length,
    noOpenSeaSkipped: skippedNoOpenSea,
    indexed,
    skippedFresh,
    failed,
  };
}
