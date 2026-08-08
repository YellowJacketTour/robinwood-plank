/**
 * King of the Hill — Postgres-backed state.
 *
 * See deploy/inmotion/postgres/migrations/009_king_of_the_hill.sql for the
 * schema and why it exists, and lib/market/king-of-the-hill-rules.ts for the
 * actual decision rule (pure, unit-tested independently of the database).
 * This file only loads/saves the singleton row and serializes concurrent
 * writers with a row lock — it contains no rule logic of its own.
 */

import { hasPostgresConfig, withPostgresTransaction } from "@/lib/postgres";
import {
  applyCandidateSale,
  finalizeIfDue,
  reconcileExistingSale,
  seedExistingSale,
  type KothSale,
  type KothState,
} from "@/lib/market/king-of-the-hill-rules";
import type { PoolClient } from "pg";

export function hasKingOfTheHillStore(): boolean {
  return hasPostgresConfig();
}

type KothRow = {
  deadline: Date;
  leading_tx_hash: string | null;
  leading_token_id: string | null;
  leading_price_wei: string | null;
  leading_wallet: string | null;
  winner_finalized_at: Date | null;
  winner_wallet: string | null;
  winner_tx_hash: string | null;
  winner_token_id: string | null;
  winner_price_wei: string | null;
};

function rowToState(row: KothRow): KothState {
  return {
    deadlineMs: row.deadline.getTime(),
    leadingSale:
      row.leading_tx_hash && row.leading_price_wei
        ? {
            txHash: row.leading_tx_hash,
            tokenId: row.leading_token_id,
            wallet: row.leading_wallet,
            priceWei: row.leading_price_wei,
          }
        : null,
    winnerFinalizedAtMs: row.winner_finalized_at ? row.winner_finalized_at.getTime() : null,
    winnerSale:
      row.winner_tx_hash && row.winner_price_wei
        ? {
            txHash: row.winner_tx_hash,
            tokenId: row.winner_token_id,
            wallet: row.winner_wallet,
            priceWei: row.winner_price_wei,
          }
        : null,
  };
}

async function readRowForUpdate(client: PoolClient): Promise<KothRow | null> {
  const result = await client.query<KothRow>(
    `SELECT deadline, leading_tx_hash, leading_token_id, leading_price_wei, leading_wallet,
            winner_finalized_at, winner_wallet, winner_tx_hash, winner_token_id, winner_price_wei
       FROM king_of_the_hill
      WHERE id = 1
      FOR UPDATE`
  );
  return result.rows[0] ?? null;
}

/**
 * The highest collection sale already present in the permanent ledger.
 *
 * Keep this population identical to salesStatsFromLedger(): KOTH's displayed
 * NFT and price must agree with the site's authoritative Highest Sale metric.
 * The ledger writer already supplies the sale evidence and the existing
 * candidate path uses these same rows; adding source/confirmation filters
 * here caused historical sales to disappear from KOTH only.
 */
async function readHighestLedgerSale(client: PoolClient): Promise<KothSale | null> {
  const result = await client.query<{
    tx_hash: string;
    token_id: string | null;
    to_address: string | null;
    price_wei: string;
  }>(
    `SELECT tx_hash, token_id, to_address, price_wei::text AS price_wei
       FROM plank_chain_events
      WHERE kind = 'sale'
        AND price_wei IS NOT NULL
      ORDER BY price_wei DESC, block_number DESC, log_index DESC
      LIMIT 1`
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    txHash: row.tx_hash,
    tokenId: row.token_id,
    wallet: row.to_address,
    priceWei: row.price_wei,
  };
}

async function seedLeadingSale(
  client: PoolClient,
  state: KothState,
  nowMs: number
): Promise<KothState> {
  if (state.winnerFinalizedAtMs != null || nowMs > state.deadlineMs) {
    return state;
  }
  const historical = await readHighestLedgerSale(client);
  if (!historical) return state;
  return state.leadingSale == null
    ? seedExistingSale(state, historical)
    : reconcileExistingSale(state, historical);
}

async function writeState(client: PoolClient, state: KothState): Promise<void> {
  await client.query(
    `UPDATE king_of_the_hill
        SET deadline = $1,
            leading_tx_hash = $2,
            leading_token_id = $3,
            leading_price_wei = $4::numeric,
            leading_wallet = $5,
            winner_finalized_at = $6,
            winner_wallet = $7,
            winner_tx_hash = $8,
            winner_token_id = $9,
            winner_price_wei = $10::numeric,
            updated_at = NOW()
      WHERE id = 1`,
    [
      new Date(state.deadlineMs).toISOString(),
      state.leadingSale?.txHash ?? null,
      state.leadingSale?.tokenId ?? null,
      state.leadingSale?.priceWei ?? null,
      state.leadingSale?.wallet ?? null,
      state.winnerFinalizedAtMs == null ? null : new Date(state.winnerFinalizedAtMs).toISOString(),
      state.winnerSale?.wallet ?? null,
      state.winnerSale?.txHash ?? null,
      state.winnerSale?.tokenId ?? null,
      state.winnerSale?.priceWei ?? null,
    ]
  );
}

/**
 * Read the current round, lazily finalizing it first if real time has passed
 * the deadline. This is the single source of truth the API route and the
 * sale-ingestion path both call through — a client polling the API can
 * trigger finalize just by reading, so no separate cron is required, but
 * nothing about this is less correct than a cron: finalizeIfDue is
 * idempotent and the row lock below serializes it against a concurrent sale
 * arriving in the same instant.
 */
export async function getKingOfTheHill(nowMs: number = Date.now()): Promise<KothState | null> {
  if (!hasKingOfTheHillStore()) return null;
  return withPostgresTransaction(async (client) => {
    const row = await readRowForUpdate(client);
    if (!row) return null;
    const state = await seedLeadingSale(client, rowToState(row), nowMs);
    const finalized = finalizeIfDue(state, nowMs);
    if (finalized !== state) await writeState(client, finalized);
    return finalized;
  });
}

/**
 * Offer a confirmed sale as a KOTH candidate. Call this from the same code
 * path that appends a confirmed sale into the chain-event ledger
 * (lib/market/chain-indexer.ts indexSource / reindexNftRange) — see the
 * `kohtCandidateFromLedgerRow` mapper below for turning a ChainEventRow into
 * the shape this needs.
 *
 * Safe to call for every sale row, including ones that turn out not to beat
 * the record, arrive after the deadline, or land after the round already
 * finalized — applyCandidateSale/finalizeIfDue make all of those a no-op.
 * Also safe to call twice for the exact same sale (e.g. a re-indexed range):
 * a sale that is not STRICTLY higher than the already-stored leading sale
 * changes nothing.
 */
export async function offerKingOfTheHillCandidate(
  sale: KothSale,
  nowMs: number = Date.now()
): Promise<void> {
  if (!hasKingOfTheHillStore()) return;
  await withPostgresTransaction(async (client) => {
    const row = await readRowForUpdate(client);
    if (!row) return;
    let state = await seedLeadingSale(client, rowToState(row), nowMs);
    // Finalize first: a sale that arrives after the deadline must never
    // resurrect an already-over round, and finalizing here (rather than only
    // on read) means the ledger's own write path is itself sufficient to
    // close out a round even if nobody ever hits the read API again.
    state = finalizeIfDue(state, nowMs);
    const next = applyCandidateSale(state, sale, nowMs);
    if (next !== state) await writeState(client, next);
  });
}

/** ChainEventRow-shaped input, kept minimal so chain-indexer.ts need not import chain-events types here. */
export function kothCandidateFromSaleRow(row: {
  txHash: string;
  tokenId: string | null;
  toAddress: string | null;
  priceWei: string | null;
}): KothSale | null {
  if (!row.priceWei) return null;
  try {
    if (BigInt(row.priceWei) <= BigInt(0)) return null;
  } catch {
    return null;
  }
  return {
    txHash: row.txHash,
    tokenId: row.tokenId,
    wallet: row.toAddress,
    priceWei: row.priceWei,
  };
}
