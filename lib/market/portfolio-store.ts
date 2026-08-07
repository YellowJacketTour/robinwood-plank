/**
 * Persistence for computed CohortPositions (lib/market/portfolio-pnl.ts) —
 * see migration 008_portfolio_pnl.sql. This is a cache of a pure
 * computation: rows here are fully rebuilt from vault-activity + NAV
 * history on every refresh-market-data run, never hand-edited, and safe to
 * drop/rebuild at any time.
 */

import { postgresQuery, hasPostgresConfig } from "@/lib/postgres";
import type { CohortPosition } from "@/lib/market/portfolio-pnl";

export async function upsertCohortPosition(pos: CohortPosition): Promise<void> {
  if (!hasPostgresConfig()) return;
  await postgresQuery(
    `INSERT INTO cohort_positions
       (wallet_address, vault_address, shares_held_wei, cost_basis_wei, realized_pnl_wei,
        realized_proceeds_wei, realized_cost_wei, fee_drag_wei, unmatched_shares_wei,
        unmatched_proceeds_wei, event_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
     ON CONFLICT (wallet_address, vault_address) DO UPDATE SET
       shares_held_wei = EXCLUDED.shares_held_wei,
       cost_basis_wei = EXCLUDED.cost_basis_wei,
       realized_pnl_wei = EXCLUDED.realized_pnl_wei,
       realized_proceeds_wei = EXCLUDED.realized_proceeds_wei,
       realized_cost_wei = EXCLUDED.realized_cost_wei,
       fee_drag_wei = EXCLUDED.fee_drag_wei,
       unmatched_shares_wei = EXCLUDED.unmatched_shares_wei,
       unmatched_proceeds_wei = EXCLUDED.unmatched_proceeds_wei,
       event_count = EXCLUDED.event_count,
       updated_at = NOW()`,
    [
      pos.wallet.toLowerCase(),
      pos.vaultAddress.toLowerCase(),
      pos.sharesHeld.toString(),
      pos.costBasisWei.toString(),
      pos.realizedPnlWei.toString(),
      pos.realizedProceedsWei.toString(),
      pos.realizedCostWei.toString(),
      pos.feeDragWei.toString(),
      pos.unmatchedSharesWei.toString(),
      pos.unmatchedProceedsWei.toString(),
      pos.eventCount,
    ]
  );
}

export type StoredCohortPosition = CohortPosition & { updatedAt: string };

export async function getWalletCohortPositions(wallet: string): Promise<StoredCohortPosition[]> {
  if (!hasPostgresConfig()) return [];
  const result = await postgresQuery<{
    wallet_address: string;
    vault_address: string;
    shares_held_wei: string;
    cost_basis_wei: string;
    realized_pnl_wei: string;
    realized_proceeds_wei: string;
    realized_cost_wei: string;
    fee_drag_wei: string;
    unmatched_shares_wei: string;
    unmatched_proceeds_wei: string;
    event_count: number;
    updated_at: string;
  }>(
    `SELECT wallet_address, vault_address, shares_held_wei, cost_basis_wei, realized_pnl_wei,
            realized_proceeds_wei, realized_cost_wei, fee_drag_wei, unmatched_shares_wei,
            unmatched_proceeds_wei, event_count, updated_at
     FROM cohort_positions
     WHERE wallet_address = $1`,
    [wallet.toLowerCase()]
  );
  return result.rows.map((row) => ({
    wallet: row.wallet_address,
    vaultAddress: row.vault_address,
    sharesHeld: BigInt(row.shares_held_wei),
    costBasisWei: BigInt(row.cost_basis_wei),
    realizedPnlWei: BigInt(row.realized_pnl_wei),
    realizedProceedsWei: BigInt(row.realized_proceeds_wei),
    realizedCostWei: BigInt(row.realized_cost_wei),
    feeDragWei: BigInt(row.fee_drag_wei),
    unmatchedSharesWei: BigInt(row.unmatched_shares_wei),
    unmatchedProceedsWei: BigInt(row.unmatched_proceeds_wei),
    eventCount: row.event_count,
    updatedAt: row.updated_at,
  }));
}
