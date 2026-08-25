/**
 * The shared indexing core behind scripts/index-foreign-rarity.ts (single
 * collection, hand-run) and scripts/scaffold-all-collections.ts (every
 * tracked EVM collection, unattended) -- extracted so both callers run the
 * IDENTICAL pagination/scoring/persistence logic instead of two copies
 * drifting apart. See migration 014_foreign_rarity.sql's header for why
 * this is a background job, never a live per-request compute.
 */
import { foreignChainByChainSlug, foreignRpcUrls } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { hasUnindexedNativeBook } from "@/lib/market/multichain/venue-registry";
import { pickOpenSeaKey, reserveOpenSeaKey, settleOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { computeGenericRaritySnapshot } from "@/lib/rarity-generic";
import { replaceForeignRarity, getForeignTraitIndex, type ForeignTraitIndex } from "@/lib/market/multichain/foreign-rarity-store";
import { listTrackedCollections } from "@/lib/market/multichain/store";
import { postgresQuery } from "@/lib/postgres";
import {
  readCollectionMembershipCursor,
  readProjectedRarityInputs,
  readProjectedTokensByIds,
  upsertCollectionTokenProjection,
  writeCollectionMembershipCursor,
  readTokenMetadataWork,
  writeTokenMetadataResult,
} from "@/lib/market/multichain/collection-token-store";
import { SERVER_DISPLAY_RPC_URLS } from "@/lib/server/rpc-urls";
import { resolveEvmTokenMetadata, resolveOpenSeaTokenMetadata } from "@/lib/market/multichain/discovery/evm-token-metadata";
import { readSequentialMintBoundary } from "@/lib/market/multichain/collection-capabilities";
import { recordArchivalHydration, maybeExpandSiblingTokens } from "@/lib/market/multichain/archival-ledger";

const PAGE_SIZE = 50;

/**
 * This whole runner is a background job (see header) -- every OpenSea key
 * lookup below prefers the MOST-loaded key with remaining capacity, via
 * `pickOpenSeaKey("background")`, so it naturally avoids contending with
 * live, user-facing requests (token-art.ts, listings/route.ts) for the
 * SAME key when more than one real key is configured. This file never
 * reserved provider-window capacity of its own, so this is a pure key
 * SELECTION swap -- no new capacity bookkeeping added here.
 */
async function backgroundOpenSeaKey(): Promise<string | null> {
  const slot = await pickOpenSeaKey("background");
  return slot?.apiKey ?? null;
}

/**
 * REAL FIX 2026-08-23: every fetch in this file used to be made with ONE key
 * string, selected once at the top of a run (`backgroundOpenSeaKey()`) and
 * held for every subsequent call -- including inside indexForeignCollectionRarity's
 * own up-to-500-page NFT walk and its bounded 429 retry loop. That bypassed
 * the whole point of a multi-key pool: it never reserved/settled durable
 * capacity (so `plank_provider_windows` and getPoolHealth() saw zero usage
 * from this file's actual heaviest OpenSea consumer), never recorded
 * success/failure for the per-key circuit breaker, and -- worst of all for
 * "never fail" -- if that ONE borrowed key got jailed or exhausted mid-walk,
 * every remaining retry kept hammering the SAME bad key while N-1 other
 * healthy keys sat idle in the pool.
 *
 * This reserves (and settles) a FRESH key from the pool on every single
 * call, so a bad/exhausted key naturally fails over to the next-best key on
 * the very next attempt, and every call now participates in both the
 * durable per-key capacity ledger and the per-key circuit breaker. Returns
 * `exhausted: true` when the ENTIRE pool is out of capacity/jailed right
 * now -- callers must treat that as a normal, expected outcome (skip/defer/
 * partial), never let it propagate as an unhandled rejection.
 */
export type ReservedFetchResult =
  | { ok: true; res: Response }
  | { ok: false; exhausted: true }
  | { ok: false; exhausted: false; status: number | null; detail: string };

async function reservedBackgroundFetch(url: string): Promise<ReservedFetchResult> {
  const slot = await reserveOpenSeaKey(1, { priority: "background" });
  if (!slot) return { ok: false, exhausted: true };
  let res: Response;
  let settled = false;
  try {
    res = await fetch(url, { headers: { "x-api-key": slot.apiKey, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    await settleOpenSeaKey(slot, 1, true);
    settled = true;
  } catch (error) {
    if (!settled) await settleOpenSeaKey(slot, 1, true).catch(() => {});
    recordSourceFailure(slot.providerAccount, false);
    return { ok: false, exhausted: false, status: null, detail: error instanceof Error ? error.message : String(error) };
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    recordSourceFailure(slot.providerAccount, res.status === 429 || res.status === 403);
    return { ok: false, exhausted: false, status: res.status, detail: bodyText.slice(0, 200) };
  }
  recordSourceSuccess(slot.providerAccount);
  return { ok: true, res };
}

export type RarityIndexBackend = "helius" | "unisat" | "opensea-contract" | "opensea-slug";

/**
 * Same -log2 kernel for every chain. Enumerator differs:
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
  // A revisit of an unchanged, already-complete mint boundary is a no-op.
  // Rewriting the projection as partial here used to regress a fully verified
  // trait/rarity catalog every time visitor demand re-ran membership.
  if (checkpoint?.complete && checkpoint.expectedCount === boundary.expectedCount) {
    return { ...boundary, itemsObserved: 0, complete: true, nextTokenId: null };
  }
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
  const slug = await resolveOpenSeaSlug(chainSlug, contractAddress, openSeaChain);
  if (!slug) throw new Error(`no OpenSea slug for ${chainSlug}:${contractAddress} (no OpenSea key with capacity, or the collection genuinely has no slug)`);
  const checkpoint = await readCollectionMembershipCursor(chainSlug, contractAddress, OPENSEA_MEMBERSHIP_SOURCE);
  const url = new URL(`https://api.opensea.io/api/v2/chain/${openSeaChain}/contract/${contractAddress}/nfts`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  if (checkpoint?.cursor) url.searchParams.set("next", checkpoint.cursor);
  const observedAt = new Date();
  try {
    const fetched = await reservedBackgroundFetch(url.toString());
    if (!fetched.ok) {
      throw new Error(fetched.exhausted
        ? `OpenSea pool exhausted/jailed enumerating ${contractAddress}`
        : `OpenSea ${fetched.status ?? "error"} enumerating ${contractAddress} -- ${fetched.detail}`);
    }
    const response = fetched.res;
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

/**
 * Real-time, single-token hydration for exactly the piece a visitor just
 * clicked -- fixes a real gap flagged live 2026-08-24 ("when a user...
 * clicks a particular piece, we need to intelligently deliver hydration
 * intelligently to everything theyre exploring immediately"): the
 * existing per-collection metadata-work queue (readTokenMetadataWork,
 * consumed by advanceEvmTokenMetadata below) always processes the
 * OLDEST pending token first -- opening a specific unresolved token's
 * detail view triggered zero hydration of THAT token, so a visitor could
 * click into a real piece and see nothing better than the still-empty
 * grid tile. Reuses the exact same real resolvers (resolveEvmTokenMetadata
 * -> resolveOpenSeaTokenMetadata fallback) and the exact same persistence
 * calls (upsertCollectionTokenProjection, writeTokenMetadataResult) the
 * batch worker uses, just targeted at one specific tokenId instead of
 * whatever the queue would have picked next -- this token's future queue
 * turn is also consumed by this call (writeTokenMetadataResult marks it
 * complete/empty/retry), so the batch worker never redoes the same work.
 */
export async function hydrateSpecificToken(
  chainSlug: string, collectionSlug: string, tokenId: string
): Promise<{ resolved: boolean; token?: { tokenId: string; name: string | null; imageUrl: string | null; animationUrl: string | null; mediaType: string | null; traits: Array<{ traitType: string; value: string }> } }> {
  const chain = foreignChainByChainSlug(chainSlug);
  const openSeaChain = chainSlug === "robinhood" ? "robinhood" : chain?.openSeaChain;
  const rpcUrls = chainSlug === "robinhood" ? SERVER_DISPLAY_RPC_URLS : foreignRpcUrls(chainSlug);
  if (!rpcUrls.length) return { resolved: false };
  const openSeaKey = openSeaChain ? await backgroundOpenSeaKey() : null;
  const item = { chainSlug, collectionSlug, tokenId };
  try {
    // Opportunistic Archival Ledger (docs/marketplank/GROK-FINDINGS-
    // sustainable-archival-mining-2026-08-25.md): read whether this exact
    // token was already archived BEFORE this hydrate, so a successful write
    // below can honestly report isNewToken to recordArchivalHydration --
    // tokens_ever_hydrated must count distinct tokens, not every re-hydrate.
    const priorState = await readProjectedTokensByIds(chainSlug, collectionSlug, [tokenId]);
    const wasAlreadyArchived = (() => {
      const prior = priorState.get(tokenId);
      return !!prior && (!!prior.name || !!prior.imageUrl || prior.traits.length > 0);
    })();
    const metadata = await resolveEvmTokenMetadata({ rpcUrls, contractAddress: collectionSlug, tokenId }).catch(async (onchainError) => {
      if (!openSeaKey || !openSeaChain) throw onchainError;
      return resolveOpenSeaTokenMetadata({ apiKey: openSeaKey, openSeaChain, contractAddress: collectionSlug, tokenId });
    });
    if (!metadata || (!metadata.name && !metadata.imageUrl && metadata.traits.length === 0)) {
      await writeTokenMetadataResult({ ...item, state: "empty" });
      return { resolved: false };
    }
    await upsertCollectionTokenProjection(chainSlug, collectionSlug, {
      tokens: [{ tokenId, ...metadata }], partial: true,
      preservePartial: true, provenance: ["on-demand-click-hydration"], sourceObservedAt: new Date(),
    });
    await writeTokenMetadataResult({ ...item, state: "complete" });
    // Counter updates + bounded sibling expansion run AFTER the real write
    // above succeeds -- best-effort bookkeeping that must never fail this
    // request even if it errors.
    await recordArchivalHydration(chainSlug, collectionSlug, { isNewToken: !wasAlreadyArchived }).catch(() => {});
    await maybeExpandSiblingTokens(chainSlug, collectionSlug).catch(() => {});
    return { resolved: true, token: { tokenId, ...metadata } };
  } catch (error) {
    await writeTokenMetadataResult({ ...item, state: "retry", error: error instanceof Error ? error.message : String(error) });
    return { resolved: false };
  }
}

/** Enrich a tiny durable batch from first-party tokenURI metadata. Public
 * requests never perform these RPC/IPFS calls. Missing metadata is recorded
 * honestly; transient failures are retried after a bounded cooldown. */
export async function advanceEvmTokenMetadata(chainSlug: string, limit = 6, collectionSlug?: string | null) {
  const chain = foreignChainByChainSlug(chainSlug);
  const openSeaChain = chainSlug === "robinhood" ? "robinhood" : chain?.openSeaChain;
  const rpcUrls = chainSlug === "robinhood" ? SERVER_DISPLAY_RPC_URLS : foreignRpcUrls(chainSlug);
  if (!rpcUrls.length) throw new Error(`${chainSlug} has no metadata enrichment route`);
  const work = await readTokenMetadataWork(chainSlug, limit, collectionSlug);
  const openSeaKey = openSeaChain ? await backgroundOpenSeaKey() : null;
  let complete = 0, empty = 0, retry = 0;
  const errors: string[] = [];
  for (const item of work) {
    try {
      const metadata = await resolveEvmTokenMetadata({ rpcUrls,
        contractAddress: item.collectionSlug, tokenId: item.tokenId }).catch(async (onchainError) => {
          if (!openSeaKey || !openSeaChain) throw onchainError;
          return resolveOpenSeaTokenMetadata({ apiKey: openSeaKey, openSeaChain,
            contractAddress: item.collectionSlug, tokenId: item.tokenId });
        });
      if (!metadata || (!metadata.name && !metadata.imageUrl && metadata.traits.length === 0)) {
        await writeTokenMetadataResult({ chainSlug, ...item, state: "empty" });
        empty += 1;
        continue;
      }
      // Same honest isNewToken check as hydrateSpecificToken's single-click
      // path -- this bulk background lane is the app's actual highest-
      // throughput metadata source (mesh-tick runs it continuously), and
      // until this call the archival ledger only ever advanced from a
      // real person clicking one token at a time, undercounting the
      // system's real, already-running work. Real bug found and fixed
      // 2026-08-25, live-reproduced: collection_archival_stats stayed at
      // zero rows for collections with thousands of real background-
      // hydrated tokens.
      const priorBulkState = await readProjectedTokensByIds(chainSlug, item.collectionSlug, [item.tokenId]).catch(() => new Map());
      const priorBulkToken = priorBulkState.get(item.tokenId);
      const wasAlreadyArchivedInBulk = Boolean(priorBulkToken?.name || priorBulkToken?.imageUrl);
      await upsertCollectionTokenProjection(chainSlug, item.collectionSlug, {
        tokens: [{ tokenId: item.tokenId, ...metadata }], partial: true,
        preservePartial: true, provenance: ["robinhood-token-uri"], sourceObservedAt: new Date(),
      });
      await writeTokenMetadataResult({ chainSlug, ...item, state: "complete" });
      await recordArchivalHydration(chainSlug, item.collectionSlug, { isNewToken: !wasAlreadyArchivedInBulk }).catch(() => {});
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
    const slug = openSeaChain ? await resolveOpenSeaSlug(chainSlug, collectionSlug, openSeaChain).catch(() => null) : null;
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

export async function indexForeignCollectionRarity(chainSlug: string, collectionSlug: string, knownContractAddress?: string | null): Promise<IndexRunResult> {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) throw new Error(`"${chainSlug}" is not in FOREIGN_CHAINS.`);
  // This whole runner scrapes OpenSea's own metadata/rarity -- meaningless
  // for a chain with no OpenSea integration (zkSync today). Callers must
  // filter these out before reaching here; see scaffoldAllTrackedCollections's
  // own openSeaChain filter below.
  if (!chain.openSeaChain) {
    throw new Error(`"${chainSlug}" has no OpenSea orderbook -- rarity indexing needs an OpenSea collection slug.`);
  }
  // Every fetch below reserves a fresh key from the pool per call (see
  // reservedBackgroundFetch's own header) instead of holding one key for
  // this entire function -- a key that goes bad mid-run now fails over to
  // the next-best key on the very next call rather than dragging the whole
  // collection down with it. No upfront "no key at all" gate here either:
  // a momentarily fully-exhausted/jailed pool degrades to `collectionMeta:
  // null` below the same way a single failed fetch always has, and the
  // real, honest failure surfaces at the one place that actually needs a
  // result (`contractAddress` unresolved) -- which the caller
  // (scaffoldAllTrackedCollections) already isolates per-collection.
  const collectionMetaFetch = await reservedBackgroundFetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(collectionSlug)}`);
  const collectionMeta = (collectionMetaFetch.ok ? await collectionMetaFetch.res.json() : null) as {
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
  // REAL BUG FIXED 2026-08-23: OpenSea's v2 /collections/{slug} resource
  // (this fetch, right above) genuinely does not exist for the vast
  // majority of BNB Chain (bsc) collections -- confirmed live against even
  // famous, high-volume BSC collections (Pancake Bunnies, Pancake Squad):
  // /chain/bsc/contract/{address} resolves a real slug, but /collections/
  // {slug} and /collections/{slug}/stats both 404 "Collection ... not
  // found" for that exact same slug. This is a real, structural OpenSea
  // coverage gap for BNB specifically (Polygon/Ethereum/Base collections,
  // including obscure zero-volume ones, resolve fine on this same
  // endpoint) -- not a wrong chain-slug mapping (bsc is correct) and not
  // fixable from this app's side. Every real caller of this function
  // (scaffoldAllTrackedCollections, indexRarityForCollectionLookup's
  // opensea-contract branch) already knows the real contract address
  // before calling in -- it derived `collectionSlug` FROM that address via
  // the working /chain/{chain}/contract/{address} endpoint one step
  // earlier. Threading that known address through here (instead of
  // re-deriving it from the broken /collections/{slug} response) means a
  // 404 on this best-effort display/stats fetch no longer blocks the
  // per-token walk below (`/chain/{chain}/contract/{address}/nfts`, which
  // DOES work for BSC and already carries real images/traits) from ever
  // running. `collectionMeta` (possibly null) is still used below for
  // name/image/creator display enrichment on chains where it succeeds.
  const contractAddress = knownContractAddress
    ?? collectionMeta?.contracts?.find((c) => acceptableChainValues.includes(c.chain))?.address;
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
  const statsFetch = await reservedBackgroundFetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(collectionSlug)}/stats`).catch(() => null);
  const stats = (statsFetch?.ok ? await statsFetch.res.json() : null) as { intervals?: Array<{ interval: string; volume?: number; sales?: number }> } | null;
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
  const items: Array<{
    tokenId: string;
    name: string | null;
    imageUrl: string | null;
    traits: Array<{ traitType: string; value: string }>;
  }> = [];
  let cursor: string | null = null;
  let page = 0;
  // Real bug (2026-08-23): this loop used to run unbounded until `cursor`
  // went null. That's fine for a normal-sized PFP collection, but a
  // collection the size of Courtyard.io (400k+ real graded-card NFTs) needs
  // ~8,000 pages to fully enumerate -- with no incremental persistence, a
  // single transient OpenSea error (rate limit, timeout) anywhere in that
  // walk discarded every page already fetched and the collection stayed
  // unindexed forever, run after run. MAX_PAGES bounds one run to a real,
  // honest partial sample (same "provider ceiling -> partial:true" shape
  // unisat-rarity-index-runner.ts already uses for Bitcoin), and a bounded
  // retry-with-backoff absorbs a transient 429/5xx instead of losing the
  // whole walk to it. Subsequent scheduled runs extend coverage further
  // (existing freshDays/partial re-attempt logic in scaffoldAllTrackedCollections).
  const MAX_PAGES = 500;
  const MAX_RETRIES = 3;

  do {
    const url = new URL(`https://api.opensea.io/api/v2/chain/${chain.openSeaChain}/contract/${contractAddress}/nfts`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (cursor) url.searchParams.set("next", cursor);
    let res: Response | null = null;
    let lastPageError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Reserve a FRESH key on every attempt -- if the key attempt N just
      // used got jailed/exhausted by that very call, attempt N+1 naturally
      // fails over to a different, healthy key in the pool instead of
      // retrying the same bad one (see reservedBackgroundFetch's header).
      const fetched = await reservedBackgroundFetch(url.toString());
      if (fetched.ok) { res = fetched.res; break; }
      // Pool-exhausted (every key jailed/out of capacity right now) is
      // retried with backoff same as a 429 -- a jail cools down, and a
      // multi-key pool commonly has SOME capacity return within seconds as
      // other in-flight reservations settle.
      const retryable = fetched.exhausted || fetched.status === 429;
      lastPageError = new Error(fetched.exhausted
        ? `OpenSea pool exhausted/jailed on page ${page}`
        : `OpenSea ${fetched.status ?? "error"} on page ${page} -- ${fetched.detail}`);
      if (!retryable || attempt === MAX_RETRIES) break;
      await sleep(1_500 * (attempt + 1));
    }
    if (!res) {
      // A page beyond the first is a real, honest partial sample -- keep
      // what was already fetched instead of throwing it all away. Only a
      // total failure to fetch even page 0 is fatal (nothing to persist).
      if (page === 0) throw lastPageError instanceof Error ? lastPageError : new Error(String(lastPageError));
      cursor = null;
      break;
    }
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
    if (page >= MAX_PAGES && cursor) break;
  } while (cursor);

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

  // REAL BUG FIXED 2026-08-23: this used to stop at replaceForeignRarity,
  // which only writes the AGGREGATE snapshot (plank_foreign_rarity_collections
  // + trait index -- what the sidebar's "floors by rarity" counts read). It
  // never wrote the per-token rarity_score/rarity_rank/rarity_tier back onto
  // plank_collection_tokens the way advanceEvmCollectionMembership (line
  // ~224) and advanceEvmTokenMetadata (line ~326) already do for their own
  // paths -- so every card in the grid/detail view (which reads the
  // plank_collection_tokens projection, not the aggregate snapshot) rendered
  // with no tier badge for any collection indexed through THIS function.
  // Generic bug, not chain- or token-standard-specific: this hit Courtyard
  // (and any other collection large/slow enough to be indexed by this
  // sampled/paginated walk instead of the verified-sequential-membership
  // fast path) regardless of ERC-721 vs ERC-1155 or EVM chain. Write the
  // same per-token page here, preserving whatever membership-completeness
  // state an independent enumerator (e.g. hypersync-evm-scan.ts) already
  // established -- this rarity walk's own `partial` reflects only ITS
  // sample coverage, not the collection's true membership size.
  if (items.length) {
    // REAL BUG FIXED 2026-08-23 (same class as the rarity-tier fix directly
    // above): OpenSea's /nfts response parsed into `items` above already
    // carries `imageUrl` per token (line ~509-514) -- it was captured into
    // `images` for replaceForeignRarity's aggregate snapshot (line ~533) but
    // silently dropped from THIS per-token projection write, which is what
    // the grid/detail view actually renders cards from. Confirmed live
    // against Courtyard.io on 2026-08-23: 24,750 tokens had a real
    // rarity_tier written by this same function, 0 had image_url --
    // every one of those cards showed "ART PENDING" despite this exact walk
    // having already seen a real display_image_url/image_url for each of
    // them in the very same OpenSea response used to compute its tier.
    await upsertCollectionTokenProjection(chainSlug, contractAddress, {
      tokens: [...snapshot.byTokenId.values()].map((token) => ({
        tokenId: token.tokenId, name: token.name,
        imageUrl: images.get(token.tokenId) ?? null,
        rarityScore: token.score, rarityRank: token.rank,
        rarityPercentile: token.percentile, rarityTier: token.tier,
      })),
      partial, preservePartial: true,
      provenance: [OPENSEA_MEMBERSHIP_SOURCE, "bespoke-information-content-rarity"],
      sourceObservedAt: new Date(),
    }).catch(() => {});
  }

  return { chainSlug, collectionSlug, contractAddress, tokensIndexed: snapshot.byTokenId.size, partial };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveOpenSeaSlug(
  chainSlug: string,
  contractAddress: string,
  openSeaChainOverride?: string
): Promise<string | null> {
  const chain = foreignChainByChainSlug(chainSlug);
  const openSeaChain = openSeaChainOverride ?? chain?.openSeaChain;
  if (!openSeaChain) return null;
  const fetched = await reservedBackgroundFetch(`https://api.opensea.io/api/v2/chain/${openSeaChain}/contract/${contractAddress}`);
  if (!fetched.ok) return null;
  const res = fetched.res;
  const data = (await res.json()) as { collection?: string };
  return data.collection ?? null;
}

/** Dispatches the same -log2 kernel to the chain's real enumerator. Never Alchemy. */
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
    const slug = await resolveOpenSeaSlug(chainSlug, lookup);
    if (!slug) throw new Error(`no OpenSea slug for ${chainSlug}:${lookup} (no OpenSea key with capacity, or the collection genuinely has no slug)`);
    return indexForeignCollectionRarity(chainSlug, slug, lookup);
  }
  return indexForeignCollectionRarity(chainSlug, lookup);
}

export type ScaffoldAllResult = {
  totalTracked: number;
  evmInScope: number;
  solanaSkipped: number;
  /** EVM chains this app trades on natively but with no OpenSea integration to scrape (zkSync today) -- distinct from solanaSkipped, which is non-EVM entirely. */
  noOpenSeaSkipped: number;
  /** Collections owned by a dedicated native-book adapter (CryptoPunks today) -- see NATIVE_BOOK_COLLECTIONS. Never independently re-indexed here. */
  nativeBookSkipped: number;
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

  // REAL FIX 2026-08-23: this used to grab ONE key upfront and throw for the
  // ENTIRE run if the pool happened to be empty/jailed at that exact instant
  // -- discarding every collection's chance to be scaffolded this pass, even
  // ones that end up skipped for entirely unrelated reasons (fresh, no-
  // OpenSea-chain, native-book-owned) that need no OpenSea call at all. Per
  // this repo's own resumable-cursor philosophy ("persist at complete
  // success", never "all or nothing"), there is no upfront gate now --
  // resolveOpenSeaSlug/indexForeignCollectionRarity each reserve their own
  // key per call and degrade to a per-collection skip/fail (see their own
  // headers), so a transient pool exhaustion costs this pass only the
  // collections it actually touched while exhausted, not the whole run.
  const all = await listTrackedCollections();
  const solana = all.filter((c) => !foreignChainByChainSlug(c.chainSlug));
  // Also excludes chains with no OpenSea integration (zkSync today,
  // openSeaChain: null) -- this entire runner is OpenSea metadata/rarity
  // scraping, meaningless without an OpenSea collection slug to resolve.
  // Logged as its own count, not folded into `solana`, since it's a real,
  // distinct reason: these ARE EVM chains this app trades on natively,
  // just not through OpenSea's orderbook.
  // Collections with a dedicated native-book adapter (CryptoPunks today) own
  // their own rarity/trait snapshot end-to-end -- see
  // native-market-adapters/cryptopunks.ts's syncCryptoPunksTraits, driven by
  // the "cryptopunks-native-book" cron step. This generic OpenSea walk must
  // never independently re-index them: doing so silently overwrote the
  // CC0-CSV-derived canonical rarity snapshot with an OpenSea-derived one
  // (same plank_foreign_rarity rows, keyed by contract address), which is
  // exactly the class of bug migration 045 already had to patch once for
  // total_supply. hasUnindexedNativeBook matches case-insensitively.
  const evmAll = all.filter((c) => foreignChainByChainSlug(c.chainSlug)?.openSeaChain);
  const nativeBookOwned = evmAll.filter((c) => hasUnindexedNativeBook(c.chainSlug, c.contractAddress));
  const evm = evmAll.filter((c) => !hasUnindexedNativeBook(c.chainSlug, c.contractAddress)).slice(0, limit);
  const noOpenSeaChain = all.filter((c) => foreignChainByChainSlug(c.chainSlug) && !foreignChainByChainSlug(c.chainSlug)?.openSeaChain);

  let indexed = 0;
  let skippedFresh = 0;
  let failed = 0;
  const skippedNoOpenSea = noOpenSeaChain.length;
  for (const c of noOpenSeaChain) {
    log(`SKIP ${c.chainSlug}:${c.contractAddress} -- no OpenSea orderbook for this chain`);
  }
  for (const c of nativeBookOwned) {
    log(`SKIP ${c.chainSlug}:${c.contractAddress} -- owned by a dedicated native-book adapter; OpenSea rarity would overwrite its canonical snapshot`);
  }

  for (const c of evm) {
    const slug = await resolveOpenSeaSlug(c.chainSlug, c.contractAddress).catch(() => null);
    if (!slug) {
      // REAL FIX 2026-08-24, flagged live (a real audit found millions of
      // tokens across base/opt/avax/arb/bnb/zksync sitting at near-0%
      // metadata coverage): this used to just give up here, with a STALE,
      // inaccurate log message -- resolveOpenSeaSlug (opensea-stats.ts)
      // has zero Alchemy dependency at all, "Alchemy rarity is off" was
      // simply wrong. The real, free, on-chain-first fallback already
      // exists (advanceEvmTokenMetadata -> resolveEvmTokenMetadata tries
      // raw tokenURI() reads before ever touching OpenSea) but was only
      // ever invoked on-demand via mesh-lane (source=evm-metadata), never
      // from this always-running background scaffold -- so a collection
      // with no real OpenSea listing (common: dead/spam contracts,
      // zkSync entirely since openSeaChain is null there, or a real
      // collection OpenSea simply hasn't indexed) had NO continuous path
      // to real metadata at all. Now runs a real, bounded on-chain pass
      // for exactly this case instead of skipping outright.
      const batch = await advanceEvmTokenMetadata(c.chainSlug, 25, c.contractAddress).catch(() => null);
      if (batch && batch.attempted > 0) {
        log(`ONCHAIN-FALLBACK ${c.chainSlug}:${c.contractAddress} -- no OpenSea slug; hydrated ${batch.complete}/${batch.attempted} via direct tokenURI reads (${batch.empty} empty, ${batch.retry} retry)`);
        indexed += 1;
      } else {
        log(`SKIP ${c.chainSlug}:${c.contractAddress} -- no OpenSea slug, and no on-chain metadata work available (no pending token rows yet, or contract has no readable tokenURI)`);
        failed += 1;
      }
      continue;
    }

    if (!force) {
      const existing = await getForeignTraitIndex(c.chainSlug, slug).catch(() => null);
      // REAL BUG FIXED 2026-08-23, same shape as ordinalswallet-rarity-index-
      // runner.ts's own fix: a prior PARTIAL index (OpenSea pagination cut
      // short, or a run that only reached a subset of the collection) must
      // not be shielded behind the freshDays window -- only a genuinely
      // complete (non-partial) result should suppress a re-attempt.
      // Otherwise a collection stuck partial the first time it was indexed
      // stays partial for the entire freshDays window every single pass.
      if (existing?.indexedAt && existing.partial !== true) {
        const ageDays = (Date.now() - new Date(existing.indexedAt).getTime()) / 86_400_000;
        if (ageDays < freshDays) {
          skippedFresh += 1;
          continue;
        }
      }
    }

    try {
      const result = await indexForeignCollectionRarity(c.chainSlug, slug, c.contractAddress);
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
    nativeBookSkipped: nativeBookOwned.length,
    indexed,
    skippedFresh,
    failed,
  };
}
