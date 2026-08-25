/**
 * Exhaustive Bitcoin Ordinals collection discovery -- the real answer to
 * "discover absolutely everything" for a chain with no protocol-level
 * collection concept (Ordinals inscriptions have no ERC-721-style contract
 * address; grouping raw inscriptions by their formal parent-child
 * provenance field would mean walking a real, live-confirmed 503+ million
 * individual inscription events, genuinely a much bigger and slower
 * problem than EVM's few-thousand-candidate-contract scan).
 *
 * UniSat's own collection registry (v1/collection-indexer/collection/list)
 * provides one important venue catalog: verified live 2026-08-20, that
 * venue reported `total: 2625` collection records. This is complete only
 * for that observed UniSat registry snapshot. It is NOT the Bitcoin
 * inscription universe, a protocol-level collection registry, or proof
 * that every parent/child convention and marketplace catalog is covered.
 * It is different from the ranked/curated top-N used by
 * unisat-collections.ts's discoverTopCollections.
 * discoverTopCollections. At limit=100/page that's ~27 calls to walk in full,
 * genuinely achievable to exhaust completely in minutes rather than the
 * multi-hour-per-chain reality of the EVM backfill.
 *
 * Registers every entry under the SAME "unisat-collections" adapter
 * unisat-collections.ts already implements (its fetchSnapshot already
 * takes a collectionId as contractAddress and resolves real floor/stats
 * via a different UniSat endpoint) -- this module's only job is
 * discovery/registration, not floor pricing; the existing sync pipeline
 * (sync.ts) handles keeping every registered collection's stats current
 * from here on, same as any other chain.
 */
import { postgresQuery } from "@/lib/postgres";
import { upsertTrackedCollection, updateCollectionDisplay } from "@/lib/market/multichain/store";
import { extractHandleFromTwitterUrl } from "@/lib/market/multichain/twitter-handle";
import { reserveProviderCapacity, settleProviderCapacity, unisatBackgroundDayWindow } from "@/lib/market/multichain/control-plane";

const API_BASE = "https://open-api.unisat.io/v1/collection-indexer/collection";
const PAGE_SIZE = 100;
const CHAIN_SLUG = "bitcoin-mainnet";
const CURSOR_KEY = "bitcoin-mainnet:collection-list";

type UniSatCollectionListEntry = {
  collectionId: string;
  name?: string | null;
  supply?: string | number | null;
  totalItems?: number | null;
  hide?: boolean;
  twitter?: string | null;
  discord?: string | null;
  website?: string | null;
};

function requireApiKey(): string {
  const key = process.env.UNISAT_API_KEY?.trim();
  if (!key) throw new Error("unisat-collection-list-scan: UNISAT_API_KEY is not configured");
  return key;
}

async function fetchPage(start: number): Promise<{ total: number; list: UniSatCollectionListEntry[] }> {
  const key = requireApiKey();
  const window = unisatBackgroundDayWindow();
  if (!(await reserveProviderCapacity("unisat:default", window))) {
    throw new Error("unisat-collection-list-scan: durable daily ceiling");
  }
  try {
    const res = await fetch(`${API_BASE}/list?start=${start}&limit=${PAGE_SIZE}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`unisat-collection-list-scan: ${res.status} ${res.statusText} fetching collection/list`);
    }
    const body = (await res.json()) as { code: number; msg: string; data: { total: number; list: UniSatCollectionListEntry[] } };
    if (body.code !== 0) {
      throw new Error(`unisat-collection-list-scan: API error ${body.code} ${body.msg}`);
    }
    return body.data;
  } finally {
    await settleProviderCapacity("unisat:default", window, 1, true).catch(() => {});
  }
}

async function readStart(): Promise<number> {
  const result = await postgresQuery<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM plank_multichain_discovery_cursor WHERE chain_slug = $1`,
    [CURSOR_KEY]
  );
  return result.rows[0] ? Number(result.rows[0].last_scanned_block) : 0;
}

async function writeStart(start: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_multichain_discovery_cursor (chain_slug, last_scanned_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chain_slug) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = NOW()`,
    [CURSOR_KEY, start]
  );
}

export type CollectionListScanResult = {
  start: number;
  total: number;
  pagesWalked: number;
  registered: number;
  skippedHiddenOrEmpty: number;
  done: boolean;
  error?: string;
};

/** Walks a bounded number of pages per call (resumable via its own cursor
 * in the same discovery cursor table, no migration needed), registering
 * every real, non-hidden, non-empty collection. `done: true` once `start`
 * reaches the catalog's own reported total -- the entire real list has
 * been walked, not an estimate. */
export async function runUnisatCollectionListScan(input: { maxPages?: number } = {}): Promise<CollectionListScanResult> {
  // No documented UniSat per-minute limit is cited in this file (the real
  // control is reserveProviderCapacity's durable daily ceiling in
  // fetchPage above, not this page count). Raised 10x from the arbitrary
  // cron-pacing default of 10.
  const maxPages = input.maxPages ?? 100;
  let start = await readStart();
  let total = start; // updated by the first real page fetched
  let pagesWalked = 0;
  let registered = 0;
  let skippedHiddenOrEmpty = 0;

  for (; pagesWalked < maxPages; pagesWalked++) {
    const page = await fetchPage(start);
    total = page.total;
    if (page.list.length === 0) break;

    for (const entry of page.list) {
      const supply = typeof entry.supply === "string" ? Number(entry.supply) : entry.supply;
      const hasRealContent = !entry.hide && entry.collectionId && ((supply ?? 0) > 0 || (entry.totalItems ?? 0) > 0);
      if (!hasRealContent) {
        skippedHiddenOrEmpty += 1;
        continue;
      }
      await upsertTrackedCollection({
        chainSlug: CHAIN_SLUG,
        chainId: null,
        contractAddress: entry.collectionId,
        adapter: "unisat-collections",
        isVaultBacked: false,
        nameHint: entry.name?.trim() || null,
      });
      const creatorHandle = extractHandleFromTwitterUrl(entry.twitter);
      if (creatorHandle) {
        await updateCollectionDisplay(CHAIN_SLUG, entry.collectionId, {
          name: null,
          imageUrl: null,
          creatorHandle,
        });
      }
      registered += 1;
    }

    start += page.list.length;
    if (start >= total) break;
  }

  await writeStart(start);
  return {
    start,
    total,
    pagesWalked,
    registered,
    skippedHiddenOrEmpty,
    done: start >= total,
  };
}
