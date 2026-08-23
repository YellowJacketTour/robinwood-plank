/**
 * Second Bitcoin Ordinals collection-discovery source, alongside
 * unisat-collection-list-scan.ts. Verified live 2026-08-19 against the real
 * API (Ordiscan's own /docs/api page is Cloudflare-challenge-gated and
 * unreachable via automated fetch, so the real endpoint shapes here come
 * from live curl probing with the real key, not the docs):
 *
 * GET /v1/collections?page=N
 *   headers: Authorization: Bearer <ORDISCAN_API_KEY>
 *   response: {"data": [{name, slug, description, twitter_link,
 *   discord_link, website_link, item_count}, ...]}. Page size is a real,
 *   confirmed 20 items; an empty `data` array is genuine "end of catalog",
 *   not an error -- confirmed by walking past the end live.
 *
 * Registers every entry under the "ordiscan-ordinals" adapter
 * (lib/market/multichain/adapters/ordiscan-ordinals.ts) -- kept distinct
 * from "unisat-collections" because UniSat's collectionId and Ordiscan's
 * slug are two different indexers' own identity strings for what may or may
 * not be the exact same real-world collection (Ordinals collections are not
 * a native protocol object -- see unisat-collection-list-scan.ts's own
 * header for this same point). Registering under a distinct adapter name
 * means a slug that happens to string-match an existing UniSat
 * collectionId does NOT flip that row's adapter or steal its sync source --
 * upsertTrackedCollection's ON CONFLICT DO UPDATE SET adapter=... would do
 * exactly that if this file reused "unisat-collections", so it deliberately
 * does not. Any accidental (chain_slug, contract_address) collision instead
 * just means this call's upsert re-confirms that row as Ordiscan-sourced,
 * which only happens if the two indexers' identifier strings happen to be
 * byte-identical -- not assumed to be common.
 */
import { postgresQuery } from "@/lib/postgres";
import { upsertTrackedCollection, updateCollectionDisplay } from "@/lib/market/multichain/store";
import { extractHandleFromTwitterUrl } from "@/lib/market/multichain/twitter-handle";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isSourceJailed } from "@/lib/market/multichain/mesh/jail";

const API_BASE = "https://api.ordiscan.com/v1/collections";
const CHAIN_SLUG = "bitcoin-mainnet";
const CURSOR_KEY = "bitcoin-mainnet:ordiscan-collection-list";

type OrdiscanCollectionEntry = {
  name?: string | null;
  slug: string;
  description?: string | null;
  twitter_link?: string | null;
  discord_link?: string | null;
  website_link?: string | null;
  item_count?: number | null;
};

function requireApiKey(): string {
  const key = process.env.ORDISCAN_API_KEY?.trim();
  if (!key) throw new Error("ordiscan-collection-scan: ORDISCAN_API_KEY is not configured");
  return key;
}

async function fetchPage(page: number): Promise<OrdiscanCollectionEntry[]> {
  if (await isSourceJailed("ordiscan")) throw new Error("ordiscan-collection-scan: source jailed");
  const key = requireApiKey();
  const window = utcDayWindow(24);
  if (!(await reserveProviderCapacity("ordiscan:default", window))) {
    throw new Error("ordiscan-collection-scan: durable daily ceiling");
  }
  try {
    const res = await fetch(`${API_BASE}?page=${page}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`ordiscan-collection-scan: ${res.status} ${res.statusText} fetching collections page ${page}`);
    }
    return ((await res.json()) as { data: OrdiscanCollectionEntry[] }).data ?? [];
  } finally {
    await settleProviderCapacity("ordiscan:default", window, 1, true).catch(() => {});
  }
}

async function readPage(): Promise<number> {
  const result = await postgresQuery<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM plank_multichain_discovery_cursor WHERE chain_slug = $1`,
    [CURSOR_KEY]
  );
  return result.rows[0] ? Number(result.rows[0].last_scanned_block) : 1;
}

async function writePage(page: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_multichain_discovery_cursor (chain_slug, last_scanned_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chain_slug) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = NOW()`,
    [CURSOR_KEY, page]
  );
}

export type OrdiscanCollectionScanResult = {
  page: number;
  pagesWalked: number;
  registered: number;
  skippedEmpty: number;
  done: boolean;
  error?: string;
};

/** Walks a bounded number of pages per call (resumable via its own cursor
 * row in the same discovery cursor table unisat's scan uses, no migration
 * needed), registering every real, non-empty collection. `done: true` once
 * a page comes back with an empty `data` array -- the real, confirmed
 * end-of-catalog signal, not an estimate. */
export async function runOrdiscanCollectionScan(input: { maxPages?: number } = {}): Promise<OrdiscanCollectionScanResult> {
  const maxPages = input.maxPages ?? 10;
  let page = await readPage();
  let pagesWalked = 0;
  let registered = 0;
  let skippedEmpty = 0;
  let done = false;

  for (; pagesWalked < maxPages; pagesWalked++) {
    const entries = await fetchPage(page);
    if (entries.length === 0) {
      done = true;
      break;
    }

    for (const entry of entries) {
      if (!entry.slug || !((entry.item_count ?? 0) > 0)) {
        skippedEmpty += 1;
        continue;
      }
      await upsertTrackedCollection({
        chainSlug: CHAIN_SLUG,
        chainId: null,
        contractAddress: entry.slug,
        adapter: "ordiscan-ordinals",
        isVaultBacked: false,
      });
      const creatorHandle = extractHandleFromTwitterUrl(entry.twitter_link);
      if (creatorHandle) {
        await updateCollectionDisplay(CHAIN_SLUG, entry.slug, {
          name: null,
          imageUrl: null,
          creatorHandle,
        });
      }
      registered += 1;
    }

    page += 1;
  }

  await writePage(page);
  return { page, pagesWalked, registered, skippedEmpty, done };
}
