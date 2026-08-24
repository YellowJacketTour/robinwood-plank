/**
 * Exhaustive Solana collection discovery via Magic Eden's real, free,
 * keyless, paginated collection catalog -- fixes the actual biggest real
 * gap in Solana coverage, flagged live 2026-08-24 ("i want solana to have
 * full coverage").
 *
 * THE REAL GAP THIS CLOSES
 * ------------------------
 * This app already had two Solana discovery paths, both honestly
 * documented as partial:
 *   - helius-collection-scan.ts: exhaustive, but ONLY for Metaplex Core
 *     collections (interface: "MplCoreCollection") -- a newer standard.
 *   - magiceden-solana.ts's discoverTopCollections(): only the top-N
 *     collections by a ranking metric (volume/etc), never exhaustive.
 * Neither one ever finds the long tail of real, legitimate legacy-standard
 * (pre-Metaplex-Core) collections that simply aren't in the current "top
 * N" window -- confirmed live this session as a real, structural blind
 * spot, not a bug in either existing scanner.
 *
 * Confirmed live before writing this: `GET /v2/collections?offset=N&limit=20`
 * (api-mainnet.magiceden.dev) is a genuine, free, no-API-key, deeply
 * paginated FULL catalog listing -- verified real, obscure, low-volume
 * collections (e.g. an 80-piece PFP set, a 555-piece set) appear at
 * offset=0 and beyond, not just top-ranked ones, and pagination was
 * confirmed working past offset=20000 with no ceiling hit. offset/limit
 * must both be exact multiples of 20 (a real, confirmed API constraint,
 * not a guess -- a non-conforming request returns a real validation
 * error naming this exact rule).
 */
import { durableKv } from "@/lib/market/durable-kv";
import { upsertTrackedCollection } from "@/lib/market/multichain/store";

const CHAIN_SLUG = "solana-mainnet";
const PAGE_SIZE = 20; // the real, confirmed-required multiple -- see this file's header
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

async function fetchPage(offset: number): Promise<MagicEdenCollectionListItem[]> {
  const res = await fetch(
    `https://api-mainnet.magiceden.dev/v2/collections?offset=${offset}&limit=${PAGE_SIZE}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) throw new Error(`magiceden-catalog-scan: HTTP ${res.status}`);
  const body = (await res.json()) as MagicEdenCollectionListItem[] | { msg?: string };
  if (!Array.isArray(body)) throw new Error(`magiceden-catalog-scan: ${(body as { msg?: string }).msg ?? "unexpected response shape"}`);
  return body;
}

type StoredCursor = { offset: number; done: boolean; doneAt?: number };

async function readCursor(): Promise<StoredCursor> {
  const stored = await durableKv.get<StoredCursor>(CURSOR_KEY);
  if (!stored) return { offset: 0, done: false };
  if (stored.done && (Date.now() - (stored.doneAt ?? 0)) > RESCAN_INTERVAL_MS) {
    return { offset: 0, done: false };
  }
  return stored;
}

async function writeCursorValue(offset: number, done: boolean): Promise<void> {
  await durableKv.set(CURSOR_KEY, { offset, done, doneAt: done ? Date.now() : undefined } satisfies StoredCursor);
}

export type MagicEdenCatalogScanResult = {
  pagesWalked: number;
  registered: number;
  done: boolean;
};

export async function runMagicEdenCatalogScan(input: { maxPages?: number } = {}): Promise<MagicEdenCatalogScanResult> {
  const maxPages = input.maxPages ?? 25;
  const stored = await readCursor();
  if (stored.done) {
    return { pagesWalked: 0, registered: 0, done: true };
  }

  let offset = stored.offset;
  let pagesWalked = 0;
  let registered = 0;
  let done = false;

  for (; pagesWalked < maxPages; pagesWalked++) {
    const page = await fetchPage(offset);
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
    if (page.length < PAGE_SIZE) {
      done = true;
      break;
    }
  }

  await writeCursorValue(offset, done);
  return { pagesWalked, registered, done };
}
