/**
 * Season 2: King of the Hill for Largest Single $PLANK Buy — Postgres-backed
 * state. See deploy/inmotion/postgres/migrations/074_plank_koth.sql +
 * 075_plank_koth_usd_ranking.sql for the schema, lib/market/king-of-the-
 * hill-rules.ts for the actual decision rule (reused UNMODIFIED — see that
 * file's own header: it is deliberately asset-agnostic), and docs/
 * marketplank/GROK-FINDINGS-plank-koth-fraud-detection-2026-08-25.md for why
 * a candidate must pass a real fraud-gate pipeline
 * (lib/market/plank-koth-candidate.ts) before it ever reaches
 * offerPlankKothCandidate below.
 *
 * `priceWei` on a KothSale here holds the real USD value paid, as an
 * integer of MICRO-USD (dollars * 1_000_000, so the rule engine's plain
 * BigInt comparison stays exact) — the ranking metric — never the raw
 * PLANK amount or raw ETH-wei (see the fraud doc's section 1 on why raw
 * token amount is the spoofable side). USD, not raw ETH-wei, because a
 * real, fully legitimate buy can be denominated entirely in USDG (see
 * plank-pools.ts: one of the three canonical pools pairs PLANK with USDG,
 * not WETH) — ranking by ETH-wei alone would rank every such buy as
 * literally 0 and make it permanently unwinnable regardless of real value
 * paid. `ethPaidWei`/`plankAmount`/`usdValueAtBuy` are carried alongside
 * purely for display (ethPaidWei is 0 for a pure-USDG buy, by design).
 */

import { hasPostgresConfig, withPostgresTransaction } from "@/lib/postgres";
import {
  applyCandidateSale,
  finalizeIfDue,
  type KothSale,
  type KothState,
} from "@/lib/market/king-of-the-hill-rules";
import type { PoolClient } from "pg";

export function hasPlankKothStore(): boolean {
  return hasPostgresConfig();
}

export type PlankKothSale = Omit<KothSale, "priceWei"> & {
  /** Ranking key: USD value paid, as an integer of micro-USD. See header. */
  priceWei: string;
  ethPaidWei: string;
  plankAmount: string;
  usdValueAtBuy: number | null;
  blockNumber: number;
};

export type PlankKothState = {
  deadlineMs: number;
  leadingSale: PlankKothSale | null;
  winnerFinalizedAtMs: number | null;
  winnerSale: PlankKothSale | null;
};

type PlankKothRow = {
  deadline: Date;
  leading_tx_hash: string | null;
  leading_wallet: string | null;
  leading_eth_paid_wei: string | null;
  leading_plank_amount: string | null;
  leading_usd_value_at_buy: string | null;
  leading_value_micros: string | null;
  leading_block_number: string | null;
  winner_finalized_at: Date | null;
  winner_wallet: string | null;
  winner_tx_hash: string | null;
  winner_eth_paid_wei: string | null;
  winner_plank_amount: string | null;
  winner_usd_value_at_buy: string | null;
  winner_value_micros: string | null;
};

function rowToState(row: PlankKothRow): PlankKothState {
  return {
    deadlineMs: row.deadline.getTime(),
    leadingSale:
      row.leading_tx_hash && row.leading_value_micros && row.leading_plank_amount && row.leading_block_number
        ? {
            txHash: row.leading_tx_hash,
            tokenId: null,
            wallet: row.leading_wallet,
            priceWei: row.leading_value_micros,
            ethPaidWei: row.leading_eth_paid_wei ?? "0",
            plankAmount: row.leading_plank_amount,
            usdValueAtBuy: row.leading_usd_value_at_buy != null ? Number(row.leading_usd_value_at_buy) : null,
            blockNumber: Number(row.leading_block_number),
          }
        : null,
    winnerFinalizedAtMs: row.winner_finalized_at ? row.winner_finalized_at.getTime() : null,
    winnerSale:
      row.winner_tx_hash && row.winner_value_micros && row.winner_plank_amount
        ? {
            txHash: row.winner_tx_hash,
            tokenId: null,
            wallet: row.winner_wallet,
            priceWei: row.winner_value_micros,
            ethPaidWei: row.winner_eth_paid_wei ?? "0",
            plankAmount: row.winner_plank_amount,
            usdValueAtBuy: row.winner_usd_value_at_buy != null ? Number(row.winner_usd_value_at_buy) : null,
            blockNumber: 0,
          }
        : null,
  };
}

async function readRowForUpdate(client: PoolClient): Promise<PlankKothRow | null> {
  const result = await client.query<PlankKothRow>(
    `SELECT deadline, leading_tx_hash, leading_wallet, leading_eth_paid_wei, leading_plank_amount,
            leading_usd_value_at_buy, leading_value_micros, leading_block_number,
            winner_finalized_at, winner_wallet, winner_tx_hash, winner_eth_paid_wei, winner_plank_amount,
            winner_usd_value_at_buy, winner_value_micros
       FROM plank_koth
      WHERE id = 1
      FOR UPDATE`
  );
  return result.rows[0] ?? null;
}

async function writeState(client: PoolClient, state: PlankKothState): Promise<void> {
  await client.query(
    `UPDATE plank_koth
        SET deadline = $1,
            leading_tx_hash = $2,
            leading_wallet = $3,
            leading_eth_paid_wei = $4::numeric,
            leading_plank_amount = $5::numeric,
            leading_usd_value_at_buy = $6,
            leading_value_micros = $7::numeric,
            leading_block_number = $8,
            winner_finalized_at = $9,
            winner_wallet = $10,
            winner_tx_hash = $11,
            winner_eth_paid_wei = $12::numeric,
            winner_plank_amount = $13::numeric,
            winner_usd_value_at_buy = $14,
            winner_value_micros = $15::numeric,
            updated_at = NOW()
      WHERE id = 1`,
    [
      new Date(state.deadlineMs).toISOString(),
      state.leadingSale?.txHash ?? null,
      state.leadingSale?.wallet ?? null,
      state.leadingSale?.ethPaidWei ?? null,
      state.leadingSale?.plankAmount ?? null,
      state.leadingSale?.usdValueAtBuy ?? null,
      state.leadingSale?.priceWei ?? null,
      state.leadingSale?.blockNumber ?? null,
      state.winnerFinalizedAtMs == null ? null : new Date(state.winnerFinalizedAtMs).toISOString(),
      state.winnerSale?.wallet ?? null,
      state.winnerSale?.txHash ?? null,
      state.winnerSale?.ethPaidWei ?? null,
      state.winnerSale?.plankAmount ?? null,
      state.winnerSale?.usdValueAtBuy ?? null,
      state.winnerSale?.priceWei ?? null,
    ]
  );
}

/**
 * Read the current round, lazily finalizing it first if real time has passed
 * the deadline — same lazy check-on-read discipline as the NFT KOTH's own
 * getKingOfTheHill (see that file's header: idempotent, safe to call on
 * every API read, no separate cron required).
 */
export async function getPlankKoth(nowMs: number = Date.now()): Promise<PlankKothState | null> {
  if (!hasPlankKothStore()) return null;
  return withPostgresTransaction(async (client) => {
    const row = await readRowForUpdate(client);
    if (!row) return null;
    const state = rowToState(row);
    const finalized = finalizeIfDue(state as KothState, nowMs) as PlankKothState;
    if (finalized !== state) await writeState(client, finalized);
    return finalized;
  });
}

/**
 * Offer a CONFIRMED (post fraud-gate, post-finality — see
 * plank-koth-candidate.ts) buy as a KOTH candidate. Safe to call for every
 * confirmed buy, including ones that don't beat the record, arrive after the
 * deadline, or land after the round already finalized — applyCandidateSale/
 * finalizeIfDue make all of those a no-op. Also safe to call twice for the
 * same tx.
 */
export async function offerPlankKothCandidate(sale: PlankKothSale, nowMs: number = Date.now()): Promise<void> {
  if (!hasPlankKothStore()) return;
  await withPostgresTransaction(async (client) => {
    const row = await readRowForUpdate(client);
    if (!row) return;
    let state = rowToState(row);
    state = finalizeIfDue(state as KothState, nowMs) as PlankKothState;
    const next = applyCandidateSale(state as KothState, sale, nowMs) as PlankKothState;
    if (next !== state) await writeState(client, next);
  });
}
