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
import { ordinalsWalletOrdinalsAdapter } from "@/lib/market/multichain/adapters/ordinalswallet-ordinals";
import {
  hasMultichainStore,
  listCollectionsForSync,
  writeSnapshot,
  writeSnapshotError,
} from "@/lib/market/multichain/store";
import { checkSourceBudget, recordSourceFailure, recordSourceSuccess } from "@/lib/market/multichain/discovery/source-budget";
import { jailSource } from "@/lib/market/multichain/mesh/jail";
import { hasUnindexedNativeBook } from "@/lib/market/multichain/venue-registry";
import type { ChainAdapter } from "@/lib/market/multichain/types";

const ADAPTERS: Record<string, ChainAdapter> = {
  [alchemyNftAdapter.name]: alchemyNftAdapter,
  [magicEdenSolanaAdapter.name]: magicEdenSolanaAdapter,
  [defillamaNftAdapter.name]: defillamaNftAdapter,
  [unisatCollectionsAdapter.name]: unisatCollectionsAdapter,
  [robinhoodNativeAdapter.name]: robinhoodNativeAdapter,
  [heliusSolanaAdapter.name]: heliusSolanaAdapter,
  [ordiscanOrdinalsAdapter.name]: ordiscanOrdinalsAdapter,
  [ordinalsWalletOrdinalsAdapter.name]: ordinalsWalletOrdinalsAdapter,
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
  // ordinalsWalletOrdinalsAdapter (turbo.ordinalswallet.com) deliberately has
  // NO entry here: it is keyless with no documented rate limit anywhere
  // (confirmed live), and per explicit owner direction this app does not
  // self-impose pacing/ceilings on a source with no real, documented
  // provider-side limit to stay under. Real HTTP round-trip time is the
  // only pacing.
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

export async function runMultichainSync(input: { maxCollections?: number; chainSlug?: string } = {}): Promise<MultichainSyncResult> {
  if (!hasMultichainStore()) {
    throw new Error(
      "multichain sync requires PostgreSQL (PGHOST/PGDATABASE/PGUSER/PGPASSWORD) -- " +
        "the snapshot table has nowhere to write otherwise."
    );
  }
  if (!process.env.ALCHEMY_API_KEY?.trim() && !process.env.ALCHEMY_API_KEYS?.trim()) {
    console.warn(
      "[multichain-sync] ALCHEMY_API_KEY is not set -- falling back to Alchemy's shared " +
        '"demo" key, which is heavily rate-limited and NOT suitable for production sync ' +
        "volume. Set a real key before relying on this outside local testing."
    );
  }

  // Real fix, 2026-08-25 ("follow through, no shortcuts" -- the flagged
  // remaining gap from the unified-Alchemy-jail audit): this only checked
  // the in-memory, per-process "alchemy-nft" state, not the shared,
  // durable alchemy-account jail every real Alchemy call site now
  // respects. A real, still-ongoing monthly quota jail set by a DIFFERENT
  // call site (rpc-provider-pool.ts, evm-log-scan.ts) was invisible here,
  // so this batch could still schedule alchemyNftAdapter collections that
  // were provably going to fail immediately downstream anyway.
  const { isAlchemyAccountJailed } = await import("@/lib/market/multichain/discovery/alchemy-account-jail");
  const alchemyGateAllowed = checkSourceBudget("alchemy-nft").allowed && !(await isAlchemyAccountJailed());
  const collections = await listCollectionsForSync(input.maxCollections ?? DEFAULT_SYNC_BATCH_SIZE, {
    skipAdapters: alchemyGateAllowed ? [] : [alchemyNftAdapter.name],
    chainSlug: input.chainSlug,
  });
  if (!alchemyGateAllowed) {
    console.warn(
      "[multichain-sync] alchemy-nft jailed (monthly 429) — skipping that adapter; OpenSea/CG/ME/UniSat spokes still run"
    );
  }
  const result: MultichainSyncResult = { synced: 0, failed: 0, skipped: 0, errors: [] };

  for (const collection of collections) {
    // A dedicated native-book adapter (CryptoPunks today, via the
    // "cryptopunks-native-book" cron step) already owns this collection's
    // floor/listing/supply fields end-to-end from its own real order book.
    // Whatever this row's `adapter` column says, never let the generic
    // per-adapter sync loop independently overwrite those fields too --
    // that dual-writer race is exactly what migration 045 had to patch
    // once already, for total_supply. See rarity-index-runner.ts's
    // identical guard for the sibling rarity/trait race.
    if (hasUnindexedNativeBook(collection.chainSlug, collection.contractAddress)) {
      result.skipped += 1;
      continue;
    }
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
    // Real, unifying fix, 2026-08-26: this per-collection try/catch used to
    // swallow every real error identically -- including a real, detected
    // rate-limit/quota condition, which means "every remaining collection
    // in this batch for the SAME adapter will fail the exact same way,"
    // not "just this one collection had a problem." Every OTHER real
    // provider in this app (OpenSea, Alchemy, Helius) already engages the
    // shared circuit breaker (checkSourceBudget/jailSource) the instant a
    // real 429/quota error is detected -- this loop never did, so a
    // rate-limited adapter (live-reproduced: Solana's public RPC via
    // @solana/web3.js's own Connection, 452+ real "Server responded with
    // 429" retries logged) burned real minutes retrying the same doomed
    // call across up to `maxCollections` more collections before this
    // single mesh-lane invocation ever returned. Checking checkSourceBudget
    // BEFORE each call, and jailing on a real detected quota error, brings
    // this path to the same fail-fast discipline every other provider
    // already has.
    if (!checkSourceBudget(adapter.name).allowed) {
      result.skipped += 1;
      continue;
    }
    try {
      await pace(adapter.name);
      const snapshot = await adapter.fetchSnapshot({
        chainSlug: collection.chainSlug,
        contractAddress: collection.contractAddress,
      });
      await writeSnapshot(collection.id, snapshot);
      recordSourceSuccess(adapter.name);
      result.synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isQuotaError = /429|403|rate limit|quota|too many requests/i.test(message);
      recordSourceFailure(adapter.name, isQuotaError);
      if (isQuotaError) {
        // Same 20-minute real cool-down every other provider's own
        // rate-limit detection uses (mesh-lane.ts's generic catch-all) --
        // stops THIS adapter specifically from being retried again for the
        // rest of this batch AND the next several mesh-tick passes,
        // without affecting other adapters' collections in the same batch.
        await jailSource(adapter.name, 20 * 60_000, true).catch(() => {});
      }
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
