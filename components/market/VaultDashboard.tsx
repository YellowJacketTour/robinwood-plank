"use client";

import { formatTokenAmount } from "@/lib/trade";
import { formatUsd, weiToUsd } from "@/lib/eth-price";
import { useVaultBook } from "@/lib/market/useVaultBook";
import {
  shortVault,
  vaultColorKind,
  VAULT_LABEL_CLASS,
} from "@/lib/market/vault-registry";

type Props = {
  /** Selected Instant Swap vault — stats follow this address. */
  vaultAddress?: string | null;
  /** False while the owning tab is mounted but off screen — pauses polling. */
  active?: boolean;
};

function statCell(label: string, value: string, sub?: string) {
  return (
    <div className="rounded-lg border border-gold-400/20 bg-wood-950 px-3 py-2.5">
      <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">
        {label}
      </dt>
      <dd className="mt-1 text-xs font-bold text-foreground">{value}</dd>
      {sub && <p className="mt-0.5 text-[0.6rem] text-foreground/40">{sub}</p>}
    </div>
  );
}

/**
 * Public vault dashboard — the numeric book at a glance: liquidity on both
 * sides, the live rate, holdings, fee-side costs, USD alongside ETH, and a
 * real (not fabricated) trailing APR estimate. Every number here comes
 * straight from app/api/market/vault/stats, which is itself either a direct
 * on-chain read or a replay of real Deposited/Redeemed events — see
 * lib/market/vault-stats.ts. Held artwork lives on the Living Liquidity
 * fence; this panel stays purely numeric.
 *
 * When `vaultAddress` is set (Instant Swap dual mode), numbers track that
 * vault only. Trades board stays dual elsewhere.
 */
export default function VaultDashboard({ vaultAddress = null, active = true }: Props) {
  const { stats } = useVaultBook(vaultAddress, { active });
  const colorKind = vaultColorKind(vaultAddress);

  if (!stats) {
    return <p className="py-4 text-center text-xs text-foreground/45">Reading vault dashboard…</p>;
  }

  const vaultBadge =
    colorKind === "v1" ? "V1" : colorKind === "v2" ? "V2" : vaultAddress ? shortVault(vaultAddress) : null;

  const ethUsd = stats.ethUsd ?? 0;
  const ethAndUsd = (wei: string, ethDecimals = 4) => {
    const eth = formatTokenAmount(wei, 18, ethDecimals);
    const usd = ethUsd > 0 ? formatUsd(weiToUsd(wei, ethUsd)) : null;
    return usd ? `${eth} Ξ · ${usd}` : `${eth} Ξ`;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {vaultBadge && (
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[0.65rem] font-extrabold uppercase tracking-wide ${VAULT_LABEL_CLASS[colorKind]}`}
            >
              {vaultBadge}
            </span>
          )}
          <p className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-foreground">
            Vault Book
          </p>
          {vaultAddress && (
            <span className="font-mono text-[0.6rem] text-foreground/40">{shortVault(vaultAddress)}</span>
          )}
        </div>
        <span className="rounded-full border border-gold-400/20 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-foreground/55">
          Live snapshot
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {statCell("ETH liquidity", ethAndUsd(stats.ethReserveWei))}
        {statCell("Share liquidity", `${formatTokenAmount(stats.shareReserveWei, 18, 2)} shares`)}
        {statCell(
          "Share price",
          stats.sharePriceWei ? `${ethAndUsd(stats.sharePriceWei, 5)}/share` : "—"
        )}
        {statCell("Held", String(stats.heldTokenCount))}
        {statCell(
          "APR",
          stats.aprPct != null
            ? `${stats.aprPct >= 1000 ? stats.aprPct.toFixed(0) : stats.aprPct.toFixed(1)}%`
            : "—",
          stats.aprPct != null
            ? stats.aprBasisHours != null
              ? `est. · ${stats.aprBasisHours.toFixed(1)}h fees`
              : "est. from mint/redeem fees"
            : stats.aprBasisHours != null
              ? `${stats.aprBasisHours.toFixed(1)}h history`
              : stats.depositCount > 0
                ? "computing…"
                : "no fee history"
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-gold-400/20 bg-wood-950 px-2 py-1.5">
          <p className="text-[0.55rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">Mint fee</p>
          <p className="text-xs font-bold text-foreground">{(stats.mintFeeBps / 100).toFixed(2)}%</p>
        </div>
        <div className="rounded-lg border border-gold-400/20 bg-wood-950 px-2 py-1.5">
          <p className="text-[0.55rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">Redeem fee</p>
          <p className="text-xs font-bold text-foreground">{(stats.redeemFeeBps / 100).toFixed(2)}%</p>
        </div>
        <div className="rounded-lg border border-gold-400/20 bg-wood-950 px-2 py-1.5">
          <p className="text-[0.55rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">Redeem premium</p>
          <p className="text-xs font-bold text-foreground">{(stats.targetPremiumBps / 100).toFixed(2)}%</p>
        </div>
      </div>
    </div>
  );
}
