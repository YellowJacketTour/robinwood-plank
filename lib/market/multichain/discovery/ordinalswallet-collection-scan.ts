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
const PAGE_SIZE = 500;
/**
 * The BRC-20 BAND -- a middle section of this catalog, not its end.
 *
 * WHAT THE PREVIOUS MEASUREMENT MISSED
 * ------------------------------------
 * A 2026-09-08 pass sampled offsets 0 / 500 / 1000 / 1500 / 2000 / 3000, saw
 * real collections collapse from ~499 to ~2, and concluded "the catalog is
 * EXHAUSTED... no offset makes it produce what it does not have". It never
 * probed past 3,000, and the endpoint's own `total` of 425,243 was treated as
 * a vendor exaggeration.
 *
 * Re-measured live 2026-09-09, with real curl requests at wide offsets:
 *
 *   offset       returned   BRC-20   REAL NFT collections
 *        0            500        0     500
 *    20,000            500      488      12
 *   100,000            500      485      15
 *   150,000            500      497       3
 *   250,000            500        0     500
 *   350,000            500        0     500
 *   400,000            500        0     500
 *   420,000            500        0     500
 *   425,000            243        0     243   <- exactly total-425,000
 *
 * Zero slug overlap between pages. The endpoint paginates the whole 425,243,
 * and the final page's size matches the reported total exactly -- so the total
 * is honest and reachable.
 *
 * The fungible rows are a BAND (roughly 20k-150k), not a tail. Past ~250,000
 * the catalog is 100% real NFT collections, and none of them have ever been
 * reachable: `shouldWrapToStart` fired on the first all-BRC-20 page and sent
 * the walker back to offset 0, forever. That is why Bitcoin sat at ~19,600
 * collections against a source offering hundreds of thousands.
 *
 * So the old comment's instruction was right in spirit and wrong in fact:
 * lowering the number does not grow Bitcoin, but neither does wrapping. What
 * grows Bitcoin is SKIPPING the band and continuing.
 */

/**
 * Where the fungible-token band begins. Past this, an all-BRC-20 page means
 * "keep going", not "the catalog is over".
 */
const BRC20_BAND_START = 2_500;

/**
 * The end of the catalog, as the endpoint itself reports it. Only a page that
 * returns NOTHING AT ALL -- not merely nothing useful -- ends the walk.
 */
export function shouldWrapToStart(offset: number, realCollectionsOnPage: number, rowsOnPage?: number): boolean {
  // An empty page is a real end of catalog: there is nothing past it.
  if (rowsOnPage === 0) return true;
  // A page of pure BRC-20 inside the band is not an ending. Treating it as one
  // is what capped Bitcoin at 4.6% of this source for months.
  if (rowsOnPage != null && rowsOnPage > 0) return false;
  // Legacy two-argument call: preserve the old behaviour rather than silently
  // changing what a caller that has not been updated does.
  return offset > BRC20_BAND_START && realCollectionsOnPage === 0;
}

/** Exported so tests pin the band's start rather than let it drift silently. */
export const ORDINALSWALLET_BRC20_BAND_START = BRC20_BAND_START;


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
  // No documented OrdinalsWallet per-minute limit is cited in this file.
  // The real catalog is huge (total: 424,319 at 500/page, confirmed live in
  // the header above), so the old default of 10 pages/call would take
  // ~85 invocations just to reach the end once. Raised 50x.
  const maxPages = input.maxPages ?? 500;
  let offset = await readOffset();
  // THE HARD CAP THAT KEPT BITCOIN AT 4.6%.
  //
  // This reset ANY cursor past 2,500 back to zero on every invocation, so the
  // walker could never traverse the BRC-20 band even once. Combined with
  // shouldWrapToStart firing on the first all-fungible page, offsets above
  // ~2,500 were unreachable by construction -- and offsets 250,000-425,243 are
  // 100% real NFT collections (measured live 2026-09-09; see the band comment
  // above). Roughly 175,000 real collections sat permanently out of reach.
  //
  // The cursor is now only reset when it is past the catalog's actual END,
  // which is the one case where continuing really is pointless. A cursor deep
  // in the fungible band is left alone: walking through it is how the walker
  // reaches the real collections on the far side.
  // No pre-flight request is needed to decide this: the loop below reads
  // `page.total` on its first fetch and already breaks on `offset >= total`,
  // then wraps. Adding a probe here would double this lane's request count to
  // re-learn something the next line is about to fetch anyway.
  let total = offset;
  let pagesWalked = 0;
  let registered = 0;
  let skippedEmpty = 0;

  for (; pagesWalked < maxPages; pagesWalked++) {
    const page = await fetchPage(offset);
    total = page.total;
    if (page.collections.length === 0) break;

    let realThisPage = 0;
    for (const entry of page.collections) {
      const supply = entry.total_supply ?? 0;
      if (!entry.slug || supply <= 0) {
        skippedEmpty += 1;
        continue;
      }
      realThisPage += 1;
      await upsertTrackedCollection({
        chainSlug: CHAIN_SLUG,
        chainId: null,
        contractAddress: entry.slug,
        adapter: SOURCE,
        isVaultBacked: false,
        nameHint: entry.name?.trim() || null,
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
    // Pass the PAGE SIZE, not just the useful-row count. A page of pure
    // BRC-20 rows deep in the band is not the end of the catalog -- it is the
    // middle of it, and treating it as an ending is what made offsets past
    // ~2,500 unreachable and capped Bitcoin at 4.6% of this source.
    if (shouldWrapToStart(offset, realThisPage, page.collections.length)) {
      offset = 0;
      await writeOffset(offset);
      break;
    }
    // The real terminator, and the one that was always correct: the endpoint
    // reports its own total and the final page's size matches it exactly.
    if (offset >= total) {
      offset = 0;
      await writeOffset(offset);
      break;
    }
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
