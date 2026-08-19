/**
 * The shared indexing core behind scripts/index-foreign-rarity.ts (single
 * collection, hand-run) and scripts/scaffold-all-collections.ts (every
 * tracked EVM collection, unattended) -- extracted so both callers run the
 * IDENTICAL pagination/scoring/persistence logic instead of two copies
 * drifting apart. See migration 014_foreign_rarity.sql's header for why
 * this is a background job, never a live per-request compute.
 */
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { computeGenericRaritySnapshot } from "@/lib/rarity-generic";
import { replaceForeignRarity, getForeignTraitIndex, type ForeignTraitIndex } from "@/lib/market/multichain/foreign-rarity-store";
import { listTrackedCollections } from "@/lib/market/multichain/store";

const PAGE_SIZE = 200;
/**
 * Hard ceiling so a misconfigured run can't paginate forever against a
 * huge or misidentified contract.
 *
 * RAISED 2026-08-19 from 100 (20,000 tokens) to 2,500 (500,000 tokens).
 * The old ceiling silently truncated every collection larger than 20k --
 * which is not an edge case: Art Blocks, ENS names, Pudgy-scale and most
 * open-edition/1155 collections all exceed it, so their rarity and trait
 * index were built from a partial token set and every rank derived from
 * it was wrong for the tail. It was at least reported honestly (the
 * `partial` flag), but "reported partial" is still partial, and the goal
 * here is full coverage. 500k comfortably covers every real NFT
 * collection while still bounding a runaway/misidentified contract.
 */
const MAX_PAGES = 2_500;

export type IndexRunResult = {
  chainSlug: string;
  collectionSlug: string;
  contractAddress: string;
  tokensIndexed: number;
  partial: boolean;
};

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

  // Real 24h volume/sales (OpenSea /collections/{slug}/stats, confirmed
  // live) -- separate call, separate endpoint, same pass.
  const stats = (await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(collectionSlug)}/stats`, {
    headers: { "x-api-key": key, accept: "application/json" },
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { intervals?: Array<{ interval: string; volume?: number; sales?: number }> } | null;
  const oneDay = stats?.intervals?.find((i) => i.interval === "one_day");
  if (oneDay) {
    const { updateCollectionMarketStats } = await import("@/lib/market/multichain/store");
    const volume24hWei = typeof oneDay.volume === "number" ? BigInt(Math.round(oneDay.volume * 1e18)).toString() : null;
    await updateCollectionMarketStats(chainSlug, contractAddress, {
      volume24hWei,
      sales24h: oneDay.sales ?? null,
      currentFloorPriceWei: null,
    }).catch(() => {});
  }

  const items: Array<{ tokenId: string; name: string | null; traits: Array<{ traitType: string; value: string }> }> = [];
  let cursor: string | null = null;
  let page = 0;

  do {
    const url = new URL(`https://api.opensea.io/api/v2/chain/${chain.openSeaChain}/contract/${contractAddress}/nfts`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (cursor) url.searchParams.set("next", cursor);
    const res: Response = await fetch(url.toString(), { headers: { "x-api-key": key, accept: "application/json" } });
    if (!res.ok) throw new Error(`OpenSea ${res.status} on page ${page}`);
    const data = (await res.json()) as {
      nfts?: Array<{ identifier: string; name?: string; traits?: Array<{ trait_type: string; value: string }> }>;
      next?: string | null;
    };
    for (const nft of data.nfts ?? []) {
      items.push({
        tokenId: nft.identifier,
        name: nft.name ?? null,
        traits: (nft.traits ?? []).map((t) => ({ traitType: t.trait_type, value: t.value })),
      });
    }
    cursor = data.next ?? null;
    page += 1;
  } while (cursor && page < MAX_PAGES);

  const partial = page >= MAX_PAGES && Boolean(cursor);

  const snapshot = computeGenericRaritySnapshot(items);
  const traitIndex: ForeignTraitIndex = {};
  for (const item of items) {
    for (const t of item.traits) {
      traitIndex[t.traitType] ??= {};
      traitIndex[t.traitType][t.value] ??= [];
      traitIndex[t.traitType][t.value].push(item.tokenId);
    }
  }

  await replaceForeignRarity(chainSlug, collectionSlug, snapshot, traitIndex);

  return { chainSlug, collectionSlug, contractAddress, tokensIndexed: snapshot.byTokenId.size, partial };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveOpenSeaSlug(chainSlug: string, contractAddress: string, key: string): Promise<string | null> {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) return null;
  const res = await fetch(`https://api.opensea.io/api/v2/chain/${chain.openSeaChain}/contract/${contractAddress}`, {
    headers: { "x-api-key": key, accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { collection?: string };
  return data.collection ?? null;
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
  let skippedNoOpenSea = noOpenSeaChain.length;
  for (const c of noOpenSeaChain) {
    log(`SKIP ${c.chainSlug}:${c.contractAddress} -- no OpenSea orderbook for this chain`);
  }

  for (const c of evm) {
    const slug = await resolveOpenSeaSlug(c.chainSlug, c.contractAddress, key).catch(() => null);
    if (!slug) {
      log(`SKIP ${c.chainSlug}:${c.contractAddress} -- could not resolve an OpenSea collection slug`);
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
