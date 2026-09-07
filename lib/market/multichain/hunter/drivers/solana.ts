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
      // Union of every on-chain venue we sweep: Tensor list state and Magic
      // Eden M2 seller trade state. Listed = distinct mints with an open
      // listing on any venue; floor = cheapest ask; venue = who holds it.
      const rows = await postgresQuery<{ collection_slug: string; listed: string; floor: string | null; venue: string | null }>(
        `WITH asks AS (
           SELECT l.mint, l.price_lamports, 'tensor'::text AS venue FROM tensor_onchain_listings l WHERE l.chain_slug = 'solana-mainnet' AND l.is_active = TRUE
           UNION ALL
           SELECT m.mint, m.price_lamports, 'magiceden'::text AS venue FROM m2_onchain_listings m WHERE m.chain_slug = 'solana-mainnet' AND m.is_active = TRUE
         ), joined AS (
           SELECT t.collection_slug, a.mint, a.price_lamports, a.venue
             FROM asks a JOIN plank_collection_tokens t ON t.chain_slug = 'solana-mainnet' AND t.token_id = a.mint
         ), floors AS (
           SELECT DISTINCT ON (collection_slug) collection_slug, price_lamports, venue FROM joined ORDER BY collection_slug, price_lamports ASC
         )
         SELECT j.collection_slug, COUNT(DISTINCT j.mint)::text AS listed, MIN(j.price_lamports)::text AS floor, f.venue
           FROM joined j JOIN floors f ON f.collection_slug = j.collection_slug
          GROUP BY j.collection_slug, f.venue`
      );
      const observedAt = new Date().toISOString();
      const findings: HunterFinding[] = rows.rows.map((r) => ({
        kind: "listing-book",
        chainSlug: ctx.chainSlug,
        collectionKey: r.collection_slug,
        venue: r.venue ?? "tensor",
        listedCount: Number(r.listed),
        // Solana floors are stored scaled to 18 dp everywhere else (lamports * 1e9): review H1.
        floorAtomic: r.floor == null ? null : (BigInt(r.floor) * 1_000_000_000n).toString(),
        observedAt,
      }));
      // One pass per run (review H2): the cursor does not move, so the engine stops after this chunk.
      return { findings, cursorAfter: cursor, sourceCalls: calls, sourceStatus: "ok", note: scanNote };
    },
  };
}
