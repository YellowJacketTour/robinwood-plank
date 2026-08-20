/**
 * Sync orchestrator: for every registered collection, call its adapter and
 * write the result. Deliberately sequential (same reasoning as
 * runChainIndexer in chain-indexer.ts) -- fanning out N free-tier API calls
 * concurrently is how you earn a rate limit, not how you avoid one.
 */
import { alchemyNftAdapter } from "@/lib/market/multichain/adapters/alchemy-nft";
import { magicEdenSolanaAdapter } from "@/lib/market/multichain/adapters/magiceden-solana";
import { defillamaNftAdapter } from "@/lib/market/multichain/adapters/defillama-nft";
import { unisatCollectionsAdapter } from "@/lib/market/multichain/adapters/unisat-collections";
import { robinhoodNativeAdapter } from "@/lib/market/multichain/adapters/robinhood-native";
import { heliusSolanaAdapter } from "@/lib/market/multichain/adapters/helius-solana";
import { ordiscanOrdinalsAdapter } from "@/lib/market/multichain/adapters/ordiscan-ordinals";
import {
  hasMultichainStore,
  listCollectionsForSync,
  writeSnapshot,
  writeSnapshotError,
} from "@/lib/market/multichain/store";
import type { ChainAdapter } from "@/lib/market/multichain/types";

const ADAPTERS: Record<string, ChainAdapter> = {
  [alchemyNftAdapter.name]: alchemyNftAdapter,
  [magicEdenSolanaAdapter.name]: magicEdenSolanaAdapter,
  [defillamaNftAdapter.name]: defillamaNftAdapter,
  [unisatCollectionsAdapter.name]: unisatCollectionsAdapter,
  [robinhoodNativeAdapter.name]: robinhoodNativeAdapter,
  [heliusSolanaAdapter.name]: heliusSolanaAdapter,
  [ordiscanOrdinalsAdapter.name]: ordiscanOrdinalsAdapter,
};

/**
 * Minimum gap between consecutive calls TO THE SAME ADAPTER, in ms.
 *
 * Not a theoretical precaution: syncing 363 real Magic Eden collections
 * with no pacing at all (this loop's original form) measured ~315 calls/min
 * and produced 99 real 429s out of 363 — confirmed live 2026-08-17, not
 * assumed. magic-eden's /stats endpoint's own response header advertises
 * x-ratelimit-limit: 180 (per minute); 400ms between calls caps this at
 * 150/min, a safety margin under that rather than racing right up to it.
 * alchemy-nft has no adapter-specific pacing need at this volume (its demo
 * key already warns loudly above; a real key raises the ceiling a lot more
 * than one extra 400ms per call would).
 */
const ADAPTER_MIN_INTERVAL_MS: Record<string, number> = {
  [magicEdenSolanaAdapter.name]: 400,
  // No documented rate limit found for UniSat's authenticated open-api
  // (checked the real docs repo -- nothing published). Paced anyway as a
  // precaution since this hits a keyed, presumably tiered API, unlike
  // Magic Eden's confirmed 180/min where the number above is measured.
  [unisatCollectionsAdapter.name]: 500,
  // No documented rate limit found for Ordiscan's authenticated API either
  // (checked the real docs repo -- nothing published there beyond the
  // page itself, which is Cloudflare-challenge-gated). Paced the same as
  // UniSat above, same reasoning: a keyed, presumably tiered API.
  [ordiscanOrdinalsAdapter.name]: 500,
};

const lastCallAt = new Map<string, number>();

async function pace(adapterName: string): Promise<void> {
  const minInterval = ADAPTER_MIN_INTERVAL_MS[adapterName];
  if (!minInterval) return;
  const last = lastCallAt.get(adapterName) ?? 0;
  const wait = minInterval - (Date.now() - last);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt.set(adapterName, Date.now());
}

export type MultichainSyncResult = {
  synced: number;
  failed: number;
  skipped: number;
  errors: Array<{ chainSlug: string; contractAddress: string; error: string }>;
};

/**
 * Default bound for one call -- real number chosen from real pacing math,
 * not guessed: the slowest-paced adapters (unisat-collections,
 * ordiscan-ordinals) wait 500ms between calls, so 800 rows caps one call at
 * ~7 real minutes worst case, small enough to run on every scheduled
 * refresh-market-data.ts pass without blocking everything else in that
 * script, large enough to make real visible progress against a 16,000+-row
 * (and growing) index. See listCollectionsForSync's own header for why
 * bounding + staleness ordering replaced the old unbounded chain_slug-order
 * walk that structurally starved every chain sorting after "robinhood".
 */
const DEFAULT_SYNC_BATCH_SIZE = 800;

export async function runMultichainSync(input: { maxCollections?: number } = {}): Promise<MultichainSyncResult> {
  if (!hasMultichainStore()) {
    throw new Error(
      "multichain sync requires PostgreSQL (PGHOST/PGDATABASE/PGUSER/PGPASSWORD) -- " +
        "the snapshot table has nowhere to write otherwise."
    );
  }
  if (!process.env.ALCHEMY_API_KEY?.trim()) {
    console.warn(
      "[multichain-sync] ALCHEMY_API_KEY is not set -- falling back to Alchemy's shared " +
        '"demo" key, which is heavily rate-limited and NOT suitable for production sync ' +
        "volume. Set a real key before relying on this outside local testing."
    );
  }

  const collections = await listCollectionsForSync(input.maxCollections ?? DEFAULT_SYNC_BATCH_SIZE);
  const result: MultichainSyncResult = { synced: 0, failed: 0, skipped: 0, errors: [] };

  for (const collection of collections) {
    const adapter = ADAPTERS[collection.adapter];
    if (!adapter) {
      result.skipped += 1;
      result.errors.push({
        chainSlug: collection.chainSlug,
        contractAddress: collection.contractAddress,
        error: `no adapter registered for "${collection.adapter}"`,
      });
      continue;
    }
    try {
      await pace(adapter.name);
      const snapshot = await adapter.fetchSnapshot({
        chainSlug: collection.chainSlug,
        contractAddress: collection.contractAddress,
      });
      await writeSnapshot(collection.id, snapshot);
      result.synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeSnapshotError(collection.id, message);
      result.failed += 1;
      result.errors.push({
        chainSlug: collection.chainSlug,
        contractAddress: collection.contractAddress,
        error: message,
      });
    }
  }

  return result;
}
