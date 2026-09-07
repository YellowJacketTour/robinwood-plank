import type { HunterDriver } from "../types";

/**
 * Bitcoin driver: settlement-first. For every tracked inscription the
 * ledger knows a prior location for, mempool.space's keyless tx/outspends
 * endpoints say whether that UTXO was spent and whether the same tx paid
 * the seller -- a real sale, inferred from the chain, not a venue. The
 * existing scanner owns the ledger cursor and the inference; the driver
 * reports its progress as a finding so receipts and lane health see it.
 */
export function createBitcoinHunter(): HunterDriver {
  return {
    family: "bitcoin",
    async hunt(cursor, ctx) {
      const { runBitcoinSettlementScan } = await import("@/lib/market/multichain/discovery/bitcoin-settlement-scan");
      try {
        const r = await runBitcoinSettlementScan();
        const cursorAfter = Number.isFinite(r.toId) ? { kind: "ledger-id" as const, id: r.toId } : cursor;
        return {
          findings: r.written > 0 ? [{ kind: "settlements" as const, chainSlug: ctx.chainSlug, written: r.written }] : [],
          cursorAfter,
          sourceCalls: Math.max(1, r.candidates),
          sourceStatus: r.errors > 0 && r.written === 0 && r.candidates > 0 ? "error" : "ok",
          note: `candidates ${r.candidates}, written ${r.written}, errors ${r.errors}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { findings: [], cursorAfter: cursor, sourceCalls: 1, sourceStatus: /429|rate/i.test(msg) ? "rate-limited" : "error", note: msg.slice(0, 160) };
      }
    },
  };
}
