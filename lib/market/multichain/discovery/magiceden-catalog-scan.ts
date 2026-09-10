/**
 * Resumable discovery of the accessible Magic Eden Solana catalog.
 * The documented maximum page size is 500. Live paging metadata on
 * 2026-09-09 advertised 37,941 records, but offset >30,000 returned 400.
 * Larger pages recover the reachable tail; a rejected frontier remains
 * incomplete and schedules a head rescan without retrying it continuously.
 * Helius and other discovery lanes contribute additional independent coverage.
 */
import { durableKv } from "@/lib/market/durable-kv";
import { upsertTrackedCollection } from "@/lib/market/multichain/store";

const CHAIN_SLUG = "solana-mainnet";
// Documented maximum, verified live 2026-09-09. Offset 30000 returns 500
// records; higher offsets currently return HTTP 400 despite paging.total
// reporting more records. Never call that provider boundary full coverage.
const PAGE_SIZE = 500;
const CURSOR_KEY = "plank:market:magiceden-catalog-scan-cursor";

// Same reasoning as helius-collection-scan.ts's own RESCAN_INTERVAL_MS:
// Magic Eden's catalog endpoint has no "since" filter, so the only real
// way to catch newly-created collections after a full walk completes is
// a periodic full re-walk. 6h matches the sibling scanner's own pacing.
const RESCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

type MagicEdenCollectionListItem = {
  symbol?: string;
  name?: string;
  image?: string;
};

async function fetchPage(offset: number): Promise<{ items: MagicEdenCollectionListItem[]; boundary?: boolean; total?: number }> {
  const res = await fetch(
    `https://api-mainnet.magiceden.dev/v2/collections?offset=${offset}&limit=${PAGE_SIZE}`,
    { headers: { accept: "application/json", "ME-Pub-API-Metadata": '{"paging":true}' }, signal: AbortSignal.timeout(15_000) }
  );
  // This exact response was verified above the source's current offset
  // boundary. Other 400s still fail visibly; credentials/errors aren't EOF.
  if (res.status === 400 && offset > 30_000) {
    const error = await res.json() as { msg?: string };
    if (error.msg === "offset and limit must be a multiple of 20, offset must be a multiple of the limit") {
      return { items: [], boundary: true };
    }
  }
  if (!res.ok) throw new Error(`magiceden-catalog-scan: HTTP ${res.status}`);
  const body = (await res.json()) as MagicEdenCollectionListItem[] | { msg?: string };
  if (!Array.isArray(body)) throw new Error(`magiceden-catalog-scan: ${(body as { msg?: string }).msg ?? "unexpected response shape"}`);
  let total: number | undefined;
  try {
    const metadata = JSON.parse(res.headers.get("ME-Pub-API-Metadata") ?? "null");
    if (Number.isSafeInteger(metadata?.paging?.total) && metadata.paging.total >= 0) total = metadata.paging.total;
  } catch { /* optional source metadata */ }
  return { items: body, total };
}

type StoredCursor = { offset: number; done: boolean; doneAt?: number; retryAt?: number; advertisedTotal?: number; blockedOffset?: number };

async function readCursor(): Promise<StoredCursor> {
  const stored = await durableKv.get<StoredCursor>(CURSOR_KEY);
  if (!stored) return { offset: 0, done: false };
  if (stored.retryAt && Date.now() >= stored.retryAt) return { offset: 0, done: false };
  if (stored.done && (Date.now() - (stored.doneAt ?? 0)) > RESCAN_INTERVAL_MS) {
    return { offset: 0, done: false };
  }
  return stored;
}

async function writeCursorValue(offset: number, done: boolean, extra: Partial<StoredCursor> = {}): Promise<void> {
  await durableKv.set(CURSOR_KEY, { ...extra, offset, done, doneAt: done ? Date.now() : undefined } satisfies StoredCursor);
}

export type MagicEdenCatalogScanResult = {
  pagesWalked: number;
  registered: number;
  done: boolean;
  retryAt?: number;
  advertisedTotal?: number;
  blockedOffset?: number;
};

export async function runMagicEdenCatalogScan(input: { maxPages?: number } = {}): Promise<MagicEdenCatalogScanResult> {
  const maxPages = Math.max(1, Math.min(25, input.maxPages ?? 1));
  const stored = await readCursor();
  if (stored.done) {
    return { pagesWalked: 0, registered: 0, done: true };
  }
  if (stored.retryAt && Date.now() < stored.retryAt) {
    return { pagesWalked: 0, registered: 0, done: false, retryAt: stored.retryAt, advertisedTotal: stored.advertisedTotal, blockedOffset: stored.blockedOffset };
  }

  // Old cursors advanced by 20. Revisit the containing 500-row page rather
  // than skipping identities when changing the page size.
  let offset = Math.floor(stored.offset / PAGE_SIZE) * PAGE_SIZE;
  let pagesWalked = 0;
  let registered = 0;
  let done = false;
  let advertisedTotal = stored.advertisedTotal;

  for (; pagesWalked < maxPages;) {
    const fetched = await fetchPage(offset);
    if (fetched.boundary) {
      const retryAt = Date.now() + RESCAN_INTERVAL_MS;
      await writeCursorValue(offset, false, { retryAt, advertisedTotal, blockedOffset: offset });
      return { pagesWalked, registered, done: false, retryAt, advertisedTotal, blockedOffset: offset };
    }
    const page = fetched.items;
    advertisedTotal = fetched.total ?? advertisedTotal;
    for (const item of page) {
      // A real symbol is the only thing this catalog identity needs --
      // name/image are nice-to-have and get backfilled by the existing
      // rarity/metadata pipeline once tracked, same as every other
      // discovery scanner in this directory.
      if (!item.symbol) continue;
      await upsertTrackedCollection({
        chainSlug: CHAIN_SLUG,
        chainId: null,
        contractAddress: item.symbol,
        adapter: "magiceden-solana",
        isVaultBacked: false,
      });
      registered += 1;
    }
    offset += PAGE_SIZE;
    pagesWalked += 1;
    done = page.length < PAGE_SIZE;
    // Commit each completed page: a failed later request must not discard
    // the cursor and force another walk over already persisted identities.
    await writeCursorValue(offset, done, { advertisedTotal });
    if (page.length < PAGE_SIZE) {
      break;
    }
  }

  return { pagesWalked, registered, done, advertisedTotal };
}


