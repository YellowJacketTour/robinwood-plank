import type { ArchiveStore } from "./store.ts";
import type { ChainId, GapReason, Header } from "../shared/types.ts";
import type { EvmAdapter } from "./adapters/evm.ts";

export const GAP_BUDGET: Record<string, number> = {
  evm: 16,
  solana: 32,
  bitcoin: 1,
};

const LEGAL_REASONS: GapReason[] = [
  "reconnect",
  "reorg",
  "bloom_audit",
  "seq_gap",
  "attention_history",
];

export function assertLegalGap(reason: GapReason, hasArtifact: boolean): void {
  if (!LEGAL_REASONS.includes(reason)) {
    throw new Error(`illegal gap reason ${reason}`);
  }
  if (reason === "attention_history" && !hasArtifact) {
    throw new Error("attention_history gap requires an existing artifact genesis");
  }
}

export class GapWorker {
  private store: ArchiveStore;
  private evm: Map<ChainId, EvmAdapter>;
  private fetchHeader: (chain: ChainId, height: number) => Promise<Header | undefined>;
  constructor(
    store: ArchiveStore,
    evm: Map<ChainId, EvmAdapter>,
    fetchHeader: (chain: ChainId, height: number) => Promise<Header | undefined>,
  ) {
    this.store = store;
    this.evm = evm;
    this.fetchHeader = fetchHeader;
  }

  async step(): Promise<boolean> {
    const gap = this.store.popGap();
    if (!gap) return false;
    assertLegalGap(gap.reason, gap.reason !== "attention_history");
    const family = gap.chain === "solana" ? "solana" : gap.chain === "bitcoin" ? "bitcoin" : "evm";
    const budget = GAP_BUDGET[family] ?? 8;
    const end = Math.min(gap.toHeight, gap.fromHeight + budget - 1);
    const adapter = this.evm.get(gap.chain);
    for (let h = gap.fromHeight; h <= end; h++) {
      const header = await this.fetchHeader(gap.chain, h);
      if (!header) continue;
      if (adapter) await adapter.onHead(header);
    }
    if (end < gap.toHeight) {
      this.store.enqueueGap({
        ...gap,
        fromHeight: end + 1,
        attempts: gap.attempts + 1,
      });
    }
    return true;
  }
}
