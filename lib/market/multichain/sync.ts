/**
 * Sync orchestrator: for every registered collection, call its adapter and
 * write the result. Deliberately sequential (same reasoning as
 * runChainIndexer in chain-indexer.ts) -- fanning out N free-tier API calls
 * concurrently is how you earn a rate limit, not how you avoid one.
 */
import { alchemyNftAdapter } from "@/lib/market/multichain/adapters/alchemy-nft";
import { magicEdenSolanaAdapter } from "@/lib/market/multichain/adapters/magiceden-solana";
import {
  hasMultichainStore,
  listTrackedCollections,
  writeSnapshot,
  writeSnapshotError,
} from "@/lib/market/multichain/store";
import type { ChainAdapter } from "@/lib/market/multichain/types";

const ADAPTERS: Record<string, ChainAdapter> = {
  [alchemyNftAdapter.name]: alchemyNftAdapter,
  [magicEdenSolanaAdapter.name]: magicEdenSolanaAdapter,
};

export type MultichainSyncResult = {
  synced: number;
  failed: number;
  skipped: number;
  errors: Array<{ chainSlug: string; contractAddress: string; error: string }>;
};

export async function runMultichainSync(): Promise<MultichainSyncResult> {
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

  const collections = await listTrackedCollections();
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
