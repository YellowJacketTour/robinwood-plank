/**
 * Bounded Blast-Radius Canary (BBRC) -- cap-enforcement plumbing ONLY.
 *
 * =====================================================================
 * SCOPE BOUNDARY -- READ BEFORE WIRING THIS INTO ANYTHING (2026-08-24)
 * =====================================================================
 * This module is COMPLETE, REAL, and TESTED (see
 * test/market/canary-limits.test.ts), but it is DELIBERATELY NOT CALLED
 * from foreign-fulfill.ts, native-fulfill.ts, foreign-offer.ts, or any
 * other function that can currently move real funds. Nothing about this
 * file changes what a live trade can do today.
 *
 * Why it exists in this state: a completed security audit found that all
 * cross-chain trading/fulfillment code in this directory (foreign-fulfill.ts,
 * native-fulfill.ts, foreign-offer.ts, magiceden-solana-trade.ts,
 * tensor-solana-trade.ts, bitcoin-utxo-safety.ts, native-bitcoin-listing.ts,
 * and similar) is UNAUDITED and self-admittedly untested against real
 * conditions in several places. The owner authorized building BBRC's
 * infrastructure -- this file, its migration, and its flag -- as an interim
 * risk-bounding posture for a FUTURE decision. The owner explicitly did NOT
 * authorize connecting it to let live foreign trades actually execute.
 * "Build it" and "turn on real trading through unaudited code" are two
 * separate decisions; only the first has been made.
 *
 * Connecting this module to a real fulfill/offer path requires a SEPARATE,
 * EXPLICIT authorization -- do not treat "canary-limits.ts exists and has
 * tests" as permission to wire it in. See this file's bottom comment for
 * exactly what that future wiring step would look like.
 *
 * See also:
 *   docs/marketplank/GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md
 *     (Issue 1 -- the design this implements)
 *   deploy/inmotion/postgres/migrations/058_canary_fill_ledger.sql
 *     (the ledger table this reads/writes)
 *   lib/constants.ts FOREIGN_TRADE_CANARY_ENABLED
 *     (the kill switch gating this whole mechanism)
 */

import { hasPostgresConfig, withPostgresTransaction } from "@/lib/postgres";
import { FOREIGN_TRADE_CANARY_ENABLED } from "@/lib/constants";
import type { PoolClient } from "pg";

/**
 * Alpha default caps in USD, matching the research doc's suggested figures
 * (docs/marketplank/GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md
 * Issue 1 table). Each is independently overridable via env var so the caps
 * can be tuned without a code change, but every override is parsed
 * defensively and falls back to the documented default on anything
 * malformed -- a bad env var must never silently become "no cap."
 */
export const CANARY_CAPS_USD = Object.freeze({
  /** Hard ceiling on a single trade's USD notional. */
  perTrade: parsePositiveUsd(process.env.CANARY_CAP_PER_TRADE_USD, 50),
  /** Rolling 24h sum ceiling for one wallet, across all venues/chains. */
  perWallet24h: parsePositiveUsd(process.env.CANARY_CAP_PER_WALLET_24H_USD, 200),
  /** Rolling 24h sum ceiling across every wallet and venue combined. */
  global24h: parsePositiveUsd(process.env.CANARY_CAP_GLOBAL_24H_USD, 2500),
  /**
   * Rolling 24h sum ceiling for one venue+chain bucket, AGGREGATE ACROSS
   * EVERY WALLET trading that venue/chain (matches the research doc's "BTC
   * $500/day, Sol $500/day" framing) -- independent of every other
   * venue/chain bucket, but not scoped to a single wallet the way
   * perWallet24h is. Deliberately larger than perWallet24h by design: it
   * bounds a venue's worst-case aggregate exposure across many small
   * wallets, not any one wallet's exposure.
   */
  perVenue24h: parsePositiveUsd(process.env.CANARY_CAP_PER_VENUE_24H_USD, 500),
});

function parsePositiveUsd(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type CanaryLimitResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Check every BBRC bucket for a would-be canary fill and, only if every
 * bucket has room, record it in the same short transaction so the check and
 * the write can never race apart (two concurrent calls for the same wallet
 * cannot both "pass" and jointly bust a cap -- see the row-level advisory
 * lock note below).
 *
 * KILL-SWITCH BEHAVIOR (documented choice, see module header for which
 * option was picked): when FOREIGN_TRADE_CANARY_ENABLED is false, this
 * function ALWAYS returns `{ allowed: false, reason: "canary disabled" }`
 * and never touches Postgres. It does not throw and does not silently allow
 * -- a caller that forgets to check the flag itself still fails closed.
 * This is the "always return allowed: false" option from the task, chosen
 * over "don't call it at all" so the function is safe to call unconditionally
 * without every call site needing its own flag check first.
 *
 * NOTE ON TESTING THIS FLAG: FOREIGN_TRADE_CANARY_ENABLED is a module-level
 * constant in lib/constants.ts, fixed at first import for the life of the
 * process (see that constant's own comment). test/market/canary-limits.test.ts
 * covers the enabled path; test/market/canary-limits-disabled.test.ts covers
 * the disabled path in its own file specifically so each gets a fresh
 * process from the test runner and the flag value each file sets before its
 * first dynamic import actually takes effect.
 *
 * PGPOOL_MAX=4 discipline: this issues exactly one short transaction (one
 * connection, held only for a handful of fast indexed queries) and returns.
 * No connection is held across anything slow (no external HTTP calls, no
 * price lookups -- usd_notional is supplied by the caller, already priced).
 *
 * NOT CALLED FROM ANY LIVE PATH YET -- see this file's header.
 */
export async function checkAndRecordCanaryLimit(
  wallet: string,
  venue: string,
  chain: string,
  usdNotional: number,
  txRef?: string | null
): Promise<CanaryLimitResult> {
  if (!FOREIGN_TRADE_CANARY_ENABLED) {
    return { allowed: false, reason: "canary disabled" };
  }
  if (!hasPostgresConfig()) {
    return { allowed: false, reason: "canary ledger unavailable (no Postgres config)" };
  }
  if (!(Number.isFinite(usdNotional) && usdNotional > 0)) {
    return { allowed: false, reason: "invalid usd_notional" };
  }
  const normalizedWallet = wallet.trim();
  const normalizedVenue = venue.trim().toLowerCase();
  const normalizedChain = chain.trim().toLowerCase();
  if (!normalizedWallet || !normalizedVenue || !normalizedChain) {
    return { allowed: false, reason: "wallet, venue, and chain are required" };
  }

  return withPostgresTransaction(async (client) => {
    // Serialize concurrent canary checks against the SAME wallet with a
    // Postgres advisory transaction lock keyed on the wallet string, so two
    // simultaneous requests for one wallet can't both read "under cap" and
    // both insert, jointly busting the per-wallet (or global) cap. This is
    // the check-then-insert pattern the research doc calls out as the
    // PGPOOL_MAX=4-friendly alternative to `SELECT ... FOR UPDATE` on a
    // bucket row (there is no pre-existing bucket row to lock -- see the
    // migration's header on why this ledger has no separate bucket table).
    // hashtextextended gives a stable 64-bit key from the wallet string;
    // the global/venue caps are covered transitively because every canary
    // insert for ANY wallet still goes through this same transaction
    // machinery serially enough at canary volume (single-digit trades/day
    // by design) that the subsequent SUM() queries below, taken inside the
    // same transaction as the eventual INSERT, are consistent for the
    // purpose these caps serve: bounding worst case, not perfect
    // linearizability under adversarial concurrency this mechanism isn't
    // meant to withstand pre-audit anyway.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      normalizedWallet,
    ]);

    if (usdNotional > CANARY_CAPS_USD.perTrade) {
      return {
        allowed: false,
        reason: `per-trade cap exceeded: $${usdNotional} > $${CANARY_CAPS_USD.perTrade}`,
      };
    }

    const walletTotal = await rollingSum(client, "wallet = $1", [normalizedWallet]);
    if (walletTotal + usdNotional > CANARY_CAPS_USD.perWallet24h) {
      return {
        allowed: false,
        reason:
          `per-wallet 24h cap exceeded: $${walletTotal.toFixed(2)} + $${usdNotional} > ` +
          `$${CANARY_CAPS_USD.perWallet24h}`,
      };
    }

    const venueTotal = await rollingSum(client, "venue = $1 AND chain = $2", [
      normalizedVenue,
      normalizedChain,
    ]);
    if (venueTotal + usdNotional > CANARY_CAPS_USD.perVenue24h) {
      return {
        allowed: false,
        reason:
          `per-venue 24h cap exceeded (${normalizedVenue}/${normalizedChain}): ` +
          `$${venueTotal.toFixed(2)} + $${usdNotional} > $${CANARY_CAPS_USD.perVenue24h}`,
      };
    }

    const globalTotal = await rollingSum(client, "TRUE", []);
    if (globalTotal + usdNotional > CANARY_CAPS_USD.global24h) {
      return {
        allowed: false,
        reason:
          `global 24h cap exceeded: $${globalTotal.toFixed(2)} + $${usdNotional} > ` +
          `$${CANARY_CAPS_USD.global24h}`,
      };
    }

    await client.query(
      `INSERT INTO canary_fill_ledger (wallet, venue, chain, usd_notional, tx_ref)
       VALUES ($1, $2, $3, $4, $5)`,
      [normalizedWallet, normalizedVenue, normalizedChain, usdNotional, txRef ?? null]
    );

    return { allowed: true };
  });
}

async function rollingSum(
  client: PoolClient,
  whereClause: string,
  params: readonly unknown[]
): Promise<number> {
  const result = await client.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(usd_notional), 0)::text AS total
       FROM canary_fill_ledger
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND (${whereClause})`,
    [...params]
  );
  return Number(result.rows[0]?.total ?? "0");
}

/**
 * =====================================================================
 * FUTURE WIRING STEP (documentation only -- NOT implemented here)
 * =====================================================================
 * If/when the owner separately authorizes connecting BBRC to a live
 * fund-moving path, the call site would look like this at the top of
 * the fulfill functions that actually broadcast a foreign-chain
 * transaction -- e.g. in foreign-fulfill.ts's fulfillForeignListing
 * (or the equivalent entry point once reviewed against its current
 * signature), before any PSBT/tx construction:
 *
 *   const usdNotional = await priceListingInUsd(listing); // pricing TBD
 *   const canary = await checkAndRecordCanaryLimit(
 *     buyerWallet,
 *     listing.venue,
 *     listing.chain,
 *     usdNotional,
 *     null // tx_ref unknown before broadcast; a follow-up UPDATE could
 *          // attach it after the tx confirms, or it can stay null --
 *          // TBD as part of the wiring decision itself
 *   );
 *   if (!canary.allowed) {
 *     throw new Error(`Foreign trade blocked by canary limit: ${canary.reason}`);
 *   }
 *   // ... existing fulfill logic continues only if canary.allowed ...
 *
 * The equivalent call would also be needed in native-fulfill.ts wherever
 * IT constructs a foreign-chain-settling transaction, and in
 * foreign-offer.ts wherever an offer becomes a real on-chain commitment
 * (an offer that can be withdrawn without ever settling may not need a
 * canary check at offer-creation time at all -- that's a judgment call
 * for whoever does this wiring, not something decided here).
 *
 * Open questions deliberately left for that future, separately-authorized
 * step (not decided by this file):
 *   - Where does usdNotional come from at each call site (existing price
 *     oracle/quote data already computed for the trade, most likely)?
 *   - Should a rejected canary check surface a specific user-facing error
 *     ("this trade exceeds today's safety limit") vs. a generic failure?
 *   - Should tx_ref be backfilled after broadcast, and does that matter
 *     given the ledger's purpose is capping, not settlement tracking?
 *   - Does an offer (vs. a fulfill) need its own, possibly smaller, cap
 *     given it doesn't move funds until accepted?
 * None of these need to be answered to ship this file; they need to be
 * answered before anyone connects it to a real trade.
 */
