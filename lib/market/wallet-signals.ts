/**
 * Unified wallet-risk signal ledger. See deploy/inmotion/postgres/
 * migrations/077_wallet_signals.sql for the full "why" -- a shared,
 * additive cross-reference table every real wallet-risk-producing feature
 * (Bad Boards, the $PLANK KOTH fraud-gate pipeline, and whatever comes
 * next) writes to, and any wallet-risk-consuming feature can read from,
 * without either feature needing to know about the other.
 */
import { postgresQuery } from "@/lib/postgres";

export type WalletSignal = {
  wallet: string;
  chainSlug: string;
  source: string;
  severity: number;
  reason: string;
  evidence?: Record<string, unknown>;
  txHash?: string | null;
};

/** Best-effort by design: a failure here must never block the feature that
 * produced the signal (same "side-channel, not source of truth" discipline
 * this app already applies to freshness-budget.ts's own recordProviderCall
 * and archival-ledger.ts's opportunistic writes). */
export async function recordWalletSignal(signal: WalletSignal): Promise<void> {
  try {
    await postgresQuery(
      `INSERT INTO wallet_signals (wallet, chain_slug, source, severity, reason, evidence, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        signal.wallet.toLowerCase(),
        signal.chainSlug,
        signal.source,
        Math.max(0, Math.min(1, signal.severity)),
        signal.reason,
        JSON.stringify(signal.evidence ?? {}),
        signal.txHash ?? null,
      ]
    );
  } catch (error) {
    console.error("[wallet-signals] record failed", error instanceof Error ? error.message : error);
  }
}

export type WalletSignalRow = WalletSignal & { createdAt: string };

/** Every real signal any feature has ever recorded for this wallet, newest
 * first -- a consumer applies its own judgment across sources (see the
 * migration's own header on why severities are never pre-combined). */
export async function getWalletSignals(wallet: string, chainSlug?: string, limit = 50): Promise<WalletSignalRow[]> {
  const result = await postgresQuery<{
    wallet: string;
    chain_slug: string;
    source: string;
    severity: string;
    reason: string;
    evidence: Record<string, unknown>;
    tx_hash: string | null;
    created_at: Date;
  }>(
    chainSlug
      ? `SELECT wallet, chain_slug, source, severity, reason, evidence, tx_hash, created_at
           FROM wallet_signals WHERE wallet = $1 AND chain_slug = $2 ORDER BY created_at DESC LIMIT $3`
      : `SELECT wallet, chain_slug, source, severity, reason, evidence, tx_hash, created_at
           FROM wallet_signals WHERE wallet = $1 ORDER BY created_at DESC LIMIT $2`,
    chainSlug ? [wallet.toLowerCase(), chainSlug, limit] : [wallet.toLowerCase(), limit]
  );
  return result.rows.map((row) => ({
    wallet: row.wallet,
    chainSlug: row.chain_slug,
    source: row.source,
    severity: Number(row.severity),
    reason: row.reason,
    evidence: row.evidence,
    txHash: row.tx_hash,
    createdAt: row.created_at.toISOString(),
  }));
}
