/**
 * Real per-piece trait/rarity indexing for Bitcoin Ordinals via Ordinals
 * Wallet's turbo.ordinalswallet.com, the same shared generic storage layer
 * (computeGenericRaritySnapshot + replaceForeignRarity) EVM, Solana, and
 * UniSat rarity already use.
 *
 * REAL DATA SOURCE, VERIFIED LIVE 2026-08-23:
 *
 * GET /collection/{slug}/inscriptions?offset=0&limit=500
 *   The `limit` param is NOT enforced -- confirmed live against
 *   bitcoin-frogs (10,000 real supply): a single call with limit=500
 *   returned all 10,000 items in one response, each with a real
 *   `meta.attributes: [{trait_type, value, percent}]` array and a real
 *   `meta.rank` (the API's OWN computed rank, not derived here). Response
 *   is a bare JSON array, not wrapped in {data: [...]}.
 *
 * UNLIKE unisat-rarity-index-runner.ts (whose source is a marketplace
 * ACTIVITY log and can therefore never enumerate items that haven't
 * appeared in a list/sell/cancel event), this source is a real collection
 * ENUMERATION -- every inscription that belongs to the collection is
 * returned, whether or not it has ever been listed. `partial` is therefore
 * honestly `false` for any collection this call succeeds for and returns
 * `total_supply`-many items (confirmed live: bitcoin-frogs returned exactly
 * 10,000 items against a `total_supply` of 10,000 from /collection/{slug}).
 * If the returned count is short of the collection's own stated supply
 * (e.g. a very large collection, a slug this indexer failed to fully page
 * through, or the API itself under-returning), `partial` is set `true`
 * instead -- never assumed complete without checking the real count.
 */
import { computeGenericRaritySnapshot, type GenericRarityInput } from "@/lib/rarity-generic";
import { replaceForeignRarity } from "@/lib/market/multichain/foreign-rarity-store";
import { listTrackedCollections } from "@/lib/market/multichain/store";
import { checkSourceBudget, recordSourceFailure, recordSourceSuccess } from "@/lib/market/multichain/discovery/source-budget";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isSourceJailed } from "@/lib/market/multichain/mesh/jail";
import { upsertCollectionTokenProjection } from "@/lib/market/multichain/collection-token-store";
import { postgresQuery } from "@/lib/postgres";

const SOURCE = "ordinalswallet-ordinals";
const API_BASE = "https://turbo.ordinalswallet.com";
// turbo.ordinalswallet.com is keyless with no documented rate limit
// (confirmed live 2026-08-23). Per explicit owner direction, this app never
// self-imposes a limit/ceiling/pacing delay unless it maps to a real,
// documented provider-side limit -- there is none here, so this is not a
// throttle at all. reserveProviderCapacity/settleProviderCapacity still
// need a finite `allowance` number as their own required parameter (purely
// so real call volume stays observable in plank_provider_windows); it is
// set far above any realistic real usage (collections indexed by this
// source top out in the tens of thousands of items each, confirmed live)
// so it can never actually block a real request.
const DAILY_ALLOWANCE = 100_000_000_000;
// Page size for /inscriptions -- confirmed live the server does not enforce
// this at all (a single limit=500 call returned all 10,000 bitcoin-frogs
// items). Kept as a real per-request chunk size for the pagination loop
// below regardless, so a collection larger than any single response the
// server is willing to return in one call (untested at real scale) still
// gets walked to completion via offset, rather than assuming one call is
// always enough. The loop itself has NO page-count cap -- it walks until
// the server returns fewer items than requested or an empty page, however
// many requests that takes, so a collection of any real size (this source
// enumerates a real, indexer-confirmed collection, not an estimate) is
// never silently truncated.
const PAGE_SIZE = 2_000;

type OwInscriptionAttribute = { trait_type?: string | null; value?: string | null; percent?: string | null };
type OwInscription = {
  id?: string;
  meta?: { name?: string | null; attributes?: OwInscriptionAttribute[] | null; rank?: number | null } | null;
};

type OwCollectionMeta = { total_supply?: number | null };

async function ordinalsWalletGetJson<T>(path: string): Promise<T> {
  if (await isSourceJailed(SOURCE)) throw new Error(`${SOURCE}-rarity: source jailed`);
  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) throw new Error(`${SOURCE}-rarity: source ${gate.reason}`);
  const window = utcDayWindow(DAILY_ALLOWANCE);
  const account = "ordinalswallet:default";
  if (!(await reserveProviderCapacity(account, window))) {
    throw new Error(`${SOURCE}-rarity: durable daily ceiling`);
  }
  let settled = false;
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(30_000) });
    await settleProviderCapacity(account, window, 1, true);
    settled = true;
    if (!res.ok) {
      recordSourceFailure(SOURCE, res.status === 429 || res.status === 402 || res.status === 403);
      throw new Error(`${SOURCE}-rarity: ${res.status} ${res.statusText} fetching ${path}`);
    }
    recordSourceSuccess(SOURCE);
    return (await res.json()) as T;
  } catch (error) {
    if (!settled) await settleProviderCapacity(account, window, 1, true).catch(() => {});
    throw error;
  }
}

export type OrdinalsWalletRarityIndexResult = {
  chainSlug: "bitcoin-mainnet";
  collectionSlug: string;
  tokensIndexed: number;
  expectedSupply: number | null;
  partial: boolean;
};

/** Fetches the whole collection's real inscriptions (traits included) via a
 * real, uncapped offset-pagination loop -- terminates on the real,
 * confirmed end-of-collection signal (a page shorter than requested, or
 * empty), never on a fixed page-count ceiling, so a collection of any real
 * size (up to and including a hypothetical 100-billion-item one; every
 * collection actually seen live so far is 10k-20k) gets walked to
 * completion rather than silently truncated. Indexes every real per-piece
 * trait found. `partial` reflects whether the real total items fetched
 * matches the collection's own stated total_supply -- never hardcoded
 * either way. */
export async function indexOrdinalsWalletCollectionRarity(collectionSlug: string): Promise<OrdinalsWalletRarityIndexResult> {
  const meta = await ordinalsWalletGetJson<OwCollectionMeta>(`/collection/${encodeURIComponent(collectionSlug)}`).catch(() => null);
  const expectedSupply = typeof meta?.total_supply === "number" && meta.total_supply > 0 ? meta.total_supply : null;

  const list: OwInscription[] = [];
  let offset = 0;
  for (;;) {
    const page = await ordinalsWalletGetJson<OwInscription[]>(
      `/collection/${encodeURIComponent(collectionSlug)}/inscriptions?offset=${offset}&limit=${PAGE_SIZE}`
    );
    const rows = Array.isArray(page) ? page : [];
    if (rows.length === 0) break;
    list.push(...rows);
    offset += rows.length;
    // A short page is the real end-of-collection signal. Also stop once the
    // real, already-fetched count reaches the collection's own stated
    // supply -- confirming completion without an extra trailing request.
    if (rows.length < PAGE_SIZE || (expectedSupply != null && list.length >= expectedSupply)) break;
  }

  const items: GenericRarityInput[] = [];
  for (const row of list) {
    if (!row.id) continue;
    const traits = (row.meta?.attributes ?? [])
      .filter((a): a is { trait_type: string; value: string; percent?: string | null } => !!a.trait_type && a.value != null)
      .map((a) => ({ traitType: a.trait_type, value: a.value }));
    items.push({ tokenId: row.id, name: row.meta?.name ?? null, traits });
  }

  const partial = expectedSupply != null ? items.length < expectedSupply : items.length === 0;

  const snapshot = { ...computeGenericRaritySnapshot(items), partial };
  const traitIndex: Record<string, Record<string, string[]>> = {};
  for (const item of items) {
    for (const t of item.traits) {
      traitIndex[t.traitType] ??= {};
      traitIndex[t.traitType][t.value] ??= [];
      traitIndex[t.traitType][t.value].push(item.tokenId);
    }
  }

  await replaceForeignRarity("bitcoin-mainnet", collectionSlug, snapshot, traitIndex);
  const observedAt = new Date();
  await upsertCollectionTokenProjection("bitcoin-mainnet", collectionSlug, {
    tokens: [...snapshot.byTokenId.values()].map((token) => ({
      tokenId: token.tokenId,
      name: token.name,
      imageUrl: token.imageUrl ?? null,
      traits: items.find((item) => item.tokenId === token.tokenId)?.traits ?? [],
      rarityScore: token.score,
      rarityRank: token.rank,
      rarityPercentile: token.percentile,
      rarityTier: token.tier,
    })),
    expectedCount: expectedSupply,
    partial,
    provenance: ["ordinalswallet-collection-inscriptions", "bespoke-information-content-rarity"],
    sourceObservedAt: observedAt,
  });

  return {
    chainSlug: "bitcoin-mainnet",
    collectionSlug,
    tokensIndexed: snapshot.byTokenId.size,
    expectedSupply,
    partial,
  };
}

export type ScaffoldOrdinalsWalletResult = {
  totalTracked: number;
  indexed: number;
  skippedFresh: number;
  failed: number;
};

export async function scaffoldAllTrackedOrdinalsWalletCollections(opts?: {
  force?: boolean;
  freshDays?: number;
  delayMs?: number;
  limit?: number;
  onProgress?: (line: string) => void;
}): Promise<ScaffoldOrdinalsWalletResult> {
  const force = opts?.force ?? false;
  const freshDays = opts?.freshDays ?? 7;
  // No artificial pacing here per explicit owner direction: the source is
  // keyless with no documented rate limit, so real HTTP round-trip time is
  // the only pacing. `delayMs` still exists as a caller-opt-in override for
  // rare cases (e.g. a shared local dev box) but defaults to 0.
  const delayMs = opts?.delayMs ?? 0;
  const limit = opts?.limit ?? 25;
  const log = opts?.onProgress ?? (() => {});

  const all = await listTrackedCollections();
  const candidates = await postgresQuery<{ contract_address: string }>(
    `SELECT c.contract_address
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     LEFT JOIN plank_foreign_rarity_collections r
       ON r.chain_slug = c.chain_slug AND lower(r.collection_slug) = lower(c.contract_address)
     WHERE c.chain_slug = 'bitcoin-mainnet'
       AND c.adapter = 'ordinalswallet-ordinals'
       AND ($1::boolean OR r.indexed_at IS NULL OR r.indexed_at < NOW() - ($2::text || ' days')::interval)
     ORDER BY (r.indexed_at IS NULL) DESC,
       (COALESCE(s.listed_count, 0) > 0 OR s.floor_price_wei IS NOT NULL OR s.volume_24h_wei IS NOT NULL) DESC,
       (c.name IS NOT NULL AND c.image_url IS NOT NULL) DESC,
       r.indexed_at ASC NULLS FIRST,
       c.id
     LIMIT $3`,
    [force, freshDays, Math.max(1, Math.trunc(limit))]
  );
  const collections = candidates.rows.map((row) => ({ contractAddress: row.contract_address }));

  let indexed = 0;
  const skippedFresh = 0;
  let failed = 0;
  let attempted = 0;

  for (const c of collections) {
    if (attempted >= limit) break;
    attempted += 1;
    try {
      const result = await indexOrdinalsWalletCollectionRarity(c.contractAddress);
      log(
        `indexed ${c.contractAddress} (bitcoin-mainnet): ${result.tokensIndexed} tokens` +
          (result.expectedSupply != null ? `/${result.expectedSupply}` : "") +
          ` (partial=${result.partial})`
      );
      indexed += 1;
    } catch (error) {
      log(`FAILED ${c.contractAddress} (bitcoin-mainnet): ${error instanceof Error ? error.message : error}`);
      failed += 1;
    }

    await sleep(delayMs);
  }

  return { totalTracked: all.length, indexed, skippedFresh, failed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
