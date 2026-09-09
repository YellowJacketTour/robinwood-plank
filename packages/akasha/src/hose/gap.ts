import type { ArchiveStore } from "./store.ts";
import type { ChainId, GapReason, Header } from "../shared/types.ts";
import type { EvmAdapter } from "./adapters/evm.ts";

export const GAP_BUDGET: Record<string, number> = {
  evm: 16,
  solana: 32,
  bitcoin: 1,
};

/**
 * MUST MATCH THE DATABASE'S CHECK CONSTRAINT, BOTH WAYS.
 *
 * There are three allowlists for a gap reason -- the GapReason union, this
 * runtime list, and the SQL CHECK in migration 104 -- and nothing forced them
 * to agree. They did not: SQL permitted `epoch_backfill`, which this list has
 * never contained, and `incomplete_tx_walk` was added to the TYPE and to SQL
 * without being added here.
 *
 * The failure is silent in the worst way: the gap is REJECTED at runtime, so a
 * block we know we only partly read produces no gap at all. Measured live
 * 2026-09-09: `repair fail 23, "illegal gap reason incomplete_tx_walk"` -- 23
 * truncated blocks whose shortfall was thrown away, leaving the archive with
 * neither coverage nor a gap for them.
 *
 * A test asserts this list against the migration's CHECK, so drift fails CI
 * rather than production.
 */
const LEGAL_REASONS: GapReason[] = [
  "reconnect",
  "reorg",
  "bloom_audit",
  "seq_gap",
  "attention_history",
  "epoch_backfill",
  "incomplete_tx_walk",
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
    // The second argument is whether an artifact genesis exists, so it must be
    // an actual lookup. It previously read `gap.reason !== "attention_history"`,
    // which is false for exactly the one reason that requires it: the guard
    // could never pass, and every attention_history gap threw. Inverting it to
    // `true` would have been worse -- a check that always passes -- so the gap
    // now carries the artifact it was opened for.
    assertLegalGap(gap.reason, !!gap.artifactId && !!this.store.getArtifact(gap.artifactId));
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
