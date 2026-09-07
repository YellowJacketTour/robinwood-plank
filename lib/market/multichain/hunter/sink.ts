import type { HunterFinding } from "./types";
import type { HuntSink } from "./engine";

/**
 * The one sink for hunter findings. Transfer tallies feed the activity
 * axis directly (the same table the grade reads) and the admission law;
 * listing books go through provenance-ranked cell writes; settlements are
 * already in the ledger when the driver reports them.
 *
 * Admission law (FAILURES-AND-INVENTIONS failure 4), first cut: a contract
 * the hunter has never seen enters the tracked set only with real breadth
 * in ONE chunk -- at least ADMIT_MIN_TRANSFERS transfers across at least
 * ADMIT_MIN_DISTINCT distinct token ids. One-token airdrop spam and ERC-20
 * look-alikes never qualify; a real collection trading normally does
 * within minutes. Name and image hydrate through the existing metadata
 * lane once the row exists.
 */
export const ADMIT_MIN_TRANSFERS = 25;
export const ADMIT_MIN_DISTINCT = 25;

export function admissible(transfers: number, distinctTokens: number): boolean {
  return transfers >= ADMIT_MIN_TRANSFERS && distinctTokens >= ADMIT_MIN_DISTINCT;
}

export function createHunterSink(): HuntSink {
  return async (f: HunterFinding): Promise<number> => {
    if (f.kind === "transfer-tally") {
      const { recordActivity, upsertTrackedCollection } = await import("@/lib/market/multichain/store");
      // Review H3: sync.ts switches on adapter names and skips unknown ones forever; admit under the real EVM adapter.
      const { alchemyNftAdapter } = await import("@/lib/market/multichain/adapters/alchemy-nft");
      const { chainManifest } = await import("@/lib/market/multichain/chains/manifest");
      await recordActivity(f.chainSlug, f.tally);
      let admitted = 0;
      const chainId = chainManifest(f.chainSlug)?.chainId ?? null;
      for (const [contract, transfers] of f.tally) {
        if (!admissible(transfers, f.distinctTokens.get(contract) ?? 0)) continue;
        await upsertTrackedCollection({ chainSlug: f.chainSlug, chainId, contractAddress: contract, adapter: alchemyNftAdapter.name }).catch(() => undefined);
        admitted += 1;
      }
      return f.tally.size + admitted;
    }
    if (f.kind === "listing-book") {
      const { writeCells } = await import("@/lib/market/multichain/cell-provenance");
      const r = await writeCells({
        chainSlug: f.chainSlug,
        collectionKey: f.collectionKey,
        source: f.chainSlug === "solana-mainnet" ? "hunter-solana" : f.chainSlug === "bitcoin-mainnet" ? "hunter-bitcoin" : "hunter-evm",
        observedAt: f.observedAt,
        floorAtomic: f.floorAtomic,
        listedCount: f.listedCount,
      });
      return (r.floor ? 1 : 0) + (r.listed ? 1 : 0);
    }
    if (f.kind === "settlements") return f.written;
    return 0;
  };
}
