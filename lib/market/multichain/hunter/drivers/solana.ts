import type { HunterDriver, HunterFinding } from "../types";

/**
 * Solana driver: listings are ON CHAIN. Tensor's list-state accounts are
 * read with getProgramAccounts over the app's Solana RPC pool (no vendor
 * key) by the existing scanner, which upserts tensor_onchain_listings and
 * reaps stale ones. The driver turns that table into per-collection
 * listing-book findings (listed count + floor), which the sink writes
 * under provenance rank "hunter-solana" (chain-derived), above every REST
 * vendor. Magic Eden M2 trade state follows the same shape once its
 * program-wide sweep lands (adapters/magiceden-m2-onchain.ts reads single
 * PDAs today).
 */
export function createSolanaHunter(): HunterDriver {
  return {
    family: "solana",
    async hunt(cursor, ctx) {
      const { scanTensorListings } = await import("@/lib/market/multichain/discovery/tensor-listing-scan");
      const { postgresQuery } = await import("@/lib/postgres");
      let calls = 0;
      let scanNote = "";
      try {
        const r = await scanTensorListings();
        calls += 1;
        scanNote = `tensor: ${JSON.stringify(r).slice(0, 160)}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { findings: [], cursorAfter: cursor, sourceCalls: calls + 1, sourceStatus: /429|rate/i.test(msg) ? "rate-limited" : "error", note: msg.slice(0, 160) };
      }
      const rows = await postgresQuery<{ collection_slug: string; listed: string; floor: string | null }>(
        `SELECT t.collection_slug, COUNT(*)::text AS listed, MIN(l.price_lamports)::text AS floor
           FROM tensor_onchain_listings l
           JOIN plank_collection_tokens t ON t.chain_slug = l.chain_slug AND t.token_id = l.mint
          WHERE l.chain_slug = 'solana-mainnet' AND l.is_active = TRUE
          GROUP BY t.collection_slug`
      );
      const observedAt = new Date().toISOString();
      const findings: HunterFinding[] = rows.rows.map((r) => ({
        kind: "listing-book",
        chainSlug: ctx.chainSlug,
        collectionKey: r.collection_slug,
        venue: "tensor",
        listedCount: Number(r.listed),
        floorAtomic: r.floor,
        observedAt,
      }));
      const slot = Date.now();
      return { findings, cursorAfter: { kind: "signature", signature: null, slot }, sourceCalls: calls, sourceStatus: "ok", note: scanNote };
    },
  };
}
