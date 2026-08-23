/**
 * Third Bitcoin Ordinals collection-discovery source, alongside
 * unisat-collection-list-scan.ts and ordiscan-collection-scan.ts. Verified
 * live 2026-08-23:
 *
 * GET /collections?offset=N&limit=500
 *   response: {"total": 424319, "collections": [{id, name, icon,
 *   banner_icon, icon_inscription, description, slug, active,
 *   sponsored_priority, featured_priority, highest_inscription_num,
 *   lowest_inscription_num, total_supply, socials, creator_address,
 *   gallery_inscription_id, verified, floor_price, listed, volume_*,
 *   owners}, ...]}. `total` (424,319, confirmed live) is FAR larger than
 *   UniSat's (~2,625) or Ordiscan's registries -- this catalog includes
 *   every rune-ticker/junk entry OrdinalsWallet has ever indexed a
 *   floor-price row for, not just curated NFT-style Ordinals collections
 *   (confirmed live: paging near the end of the list surfaces entries like
 *   "rune-BATMAN•FAKE•TO•THE•MOOON" with total_supply: 0 and no real icon).
 *   This scan therefore filters to entries with a real total_supply > 0,
 *   same "has real content" discipline unisat-collection-list-scan.ts
 *   already applies, to avoid registering thousands of empty placeholder
 *   rows.
 *
 * Registers every entry under its OWN "ordinalswallet-ordinals" adapter
 * (lib/market/multichain/adapters/ordinalswallet-ordinals.ts) -- kept
 * distinct from "unisat-collections" and "ordiscan-ordinals" for the exact
 * same reason ordiscan-collection-scan.ts's own header already documents:
 * three different indexers' own identity strings (UniSat collectionId,
 * Ordiscan slug, OrdinalsWallet slug) for what may or may not be the same
 * real-world collection are not assumed interchangeable. Registering under
 * a distinct adapter name means upsertTrackedCollection's ON CONFLICT DO
 * UPDATE SET adapter=... never silently reassigns a row another source
 * already owns; an accidental (chain_slug, contract_address) string
 * collision just re-confirms that row as OrdinalsWallet-sourced.
 */
import { postgresQuery } from "@/lib/postgres";
import { upsertTrackedCollection, updateCollectionDisplay } from "@/lib/market/multichain/store";
import { extractHandleFromTwitterUrl } from "@/lib/market/multichain/twitter-handle";
import { checkSourceBudget, recordSourceFailure, recordSourceSuccess } from "@/lib/market/multichain/discovery/source-budget";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isSourceJailed } from "@/lib/market/multichain/mesh/jail";

const SOURCE = "ordinalswallet-ordinals";
const API_BASE = "https://turbo.ordinalswallet.com/collections";
const PAGE_SIZE = 500; // real, confirmed unenforced-but-generous page size; kept well under the whole-catalog inscriptions call's own size
const CHAIN_SLUG = "bitcoin-mainnet";
const CURSOR_KEY = "bitcoin-mainnet:ordinalswallet-collection-list";
// Not a real throttle -- see source-budget.ts's own DAILY_CEILING comment:
// keyless, no documented rate limit, so no self-imposed ceiling applies.
// This number is only the required `allowance` parameter for the durable
// reserveProviderCapacity bookkeeping window (real-usage observability in
// plank_provider_windows); set far above any realistic real usage so it
// can never actually block a request.
const DAILY_ALLOWANCE = 100_000_000_000;

type OrdinalsWalletCollectionEntry = {
  name?: string | null;
  icon?: string | null;
  slug: string;
  total_supply?: number | null;
  socials?: { discord?: string | null; twitter?: string | null; website?: string | null } | null;
  floor_price?: number | null;
};

async function fetchPage(offset: number): Promise<{ total: number; collections: OrdinalsWalletCollectionEntry[] }> {
  if (await isSourceJailed(SOURCE)) throw new Error(`${SOURCE}-scan: source jailed`);
  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) throw new Error(`${SOURCE}-scan: source ${gate.reason}`);
  const window = utcDayWindow(DAILY_ALLOWANCE);
  const account = "ordinalswallet:default";
  if (!(await reserveProviderCapacity(account, window))) {
    throw new Error(`${SOURCE}-scan: durable daily ceiling`);
  }
  let settled = false;
  try {
    const res = await fetch(`${API_BASE}?offset=${offset}&limit=${PAGE_SIZE}`, { signal: AbortSignal.timeout(20_000) });
    await settleProviderCapacity(account, window, 1, true);
    settled = true;
    if (!res.ok) {
      recordSourceFailure(SOURCE, res.status === 429 || res.status === 402 || res.status === 403);
      throw new Error(`${SOURCE}-scan: ${res.status} ${res.statusText} fetching collections offset ${offset}`);
    }
    recordSourceSuccess(SOURCE);
    return (await res.json()) as { total: number; collections: OrdinalsWalletCollectionEntry[] };
  } catch (error) {
    if (!settled) await settleProviderCapacity(account, window, 1, true).catch(() => {});
    throw error;
  }
}

async function readOffset(): Promise<number> {
  const result = await postgresQuery<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM plank_multichain_discovery_cursor WHERE chain_slug = $1`,
    [CURSOR_KEY]
  );
  return result.rows[0] ? Number(result.rows[0].last_scanned_block) : 0;
}

async function writeOffset(offset: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_multichain_discovery_cursor (chain_slug, last_scanned_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chain_slug) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = NOW()`,
    [CURSOR_KEY, offset]
  );
}

export type OrdinalsWalletCollectionScanResult = {
  offset: number;
  total: number;
  pagesWalked: number;
  registered: number;
  skippedEmpty: number;
  done: boolean;
  error?: string;
};

/** Walks a bounded number of pages per call (resumable via its own cursor
 * row in the same discovery cursor table the other two Bitcoin scans use,
 * no migration needed), registering every real, non-empty (total_supply >
 * 0) collection. `done: true` once `offset` reaches the catalog's own
 * reported `total` -- the entire real list has been walked, not an
 * estimate. */
export async function runOrdinalsWalletCollectionScan(input: { maxPages?: number } = {}): Promise<OrdinalsWalletCollectionScanResult> {
  const maxPages = input.maxPages ?? 10;
  let offset = await readOffset();
  let total = offset;
  let pagesWalked = 0;
  let registered = 0;
  let skippedEmpty = 0;

  for (; pagesWalked < maxPages; pagesWalked++) {
    const page = await fetchPage(offset);
    total = page.total;
    if (page.collections.length === 0) break;

    for (const entry of page.collections) {
      const supply = entry.total_supply ?? 0;
      if (!entry.slug || supply <= 0) {
        skippedEmpty += 1;
        continue;
      }
      await upsertTrackedCollection({
        chainSlug: CHAIN_SLUG,
        chainId: null,
        contractAddress: entry.slug,
        adapter: SOURCE,
        isVaultBacked: false,
      });
      const creatorHandle = extractHandleFromTwitterUrl(entry.socials?.twitter);
      if (entry.name || entry.icon || creatorHandle) {
        await updateCollectionDisplay(CHAIN_SLUG, entry.slug, {
          name: entry.name?.trim() || null,
          imageUrl: entry.icon || null,
          creatorHandle,
        });
      }
      registered += 1;
    }

    offset += page.collections.length;
    if (offset >= total) break;
  }

  await writeOffset(offset);
  return {
    offset,
    total,
    pagesWalked,
    registered,
    skippedEmpty,
    done: offset >= total,
  };
}
