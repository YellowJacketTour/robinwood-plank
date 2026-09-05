"use client";

import type { ReactNode } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { formatUsd, weiToUsd } from "@/lib/eth-price";
import { useVaultBook } from "@/lib/market/useVaultBook";
import {
  shortVault,
  vaultColorKind,
  vaultKindLabel,
  VAULT_LABEL_CLASS,
} from "@/lib/market/vault-registry";
import { SkeletonStats, SkeletonStatus } from "@/components/Skeleton";

type Props = {
  /** Selected Instant Swap vault — stats follow this address. */
  vaultAddress?: string | null;
  /** False while the owning tab is mounted but off screen — pauses polling. */
  active?: boolean;
};

function statCell(label: string, value: string, sub?: string, extra?: ReactNode) {
  return (
    <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
      <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">
        {label}
      </dt>
      <dd className="mt-1 text-xs font-bold text-foreground">{value}</dd>
      {sub && <p className="mt-0.5 text-[0.6rem] text-foreground/40">{sub}</p>}
      {extra}
    </div>
  );
}

/** "—" for a window that hasn't cleared computeLpApr's own real-data bar
 *  (see its docs in lib/market/vault-stats.ts) — never a fabricated 0%. */
function fmtAprWindow(pct: number | null): string {
  if (pct == null) return "—";
  return `${pct >= 1000 ? pct.toFixed(0) : pct.toFixed(1)}%`;
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
    return (
      <>
        <SkeletonStatus>Loading vault dashboard</SkeletonStatus>
        <SkeletonStats count={7} columns="grid-cols-2 sm:grid-cols-3" />
      </>
    );
  }

  const vaultBadge =
    colorKind === "unknown" ? (vaultAddress ? shortVault(vaultAddress) : null) : vaultKindLabel(colorKind);

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
        <span className="rounded-full border border-line px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-foreground/55">
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
          // "LP APR", not "APR" — swap-fee yield to liquidity providers,
          // never mint/redeem fee revenue (that pays the treasury — see the
          // aprPct docstring in lib/market/vault-stats.ts). This vault's
          // fee model decides whether there's anything to show at all: V1/V2
          // buyShares/sellShares apply no fee, so this is always "—" here —
          // not a stale replay, a real "there is nothing to measure." The
          // basis in the label is whatever window was actually measured,
          // never an asserted 24h.
          stats.aprPct != null && stats.aprBasisHours != null
            ? `LP APR (${stats.aprBasisHours.toFixed(1)}h basis)`
            : "LP APR",
          stats.aprPct != null
            ? `${stats.aprPct >= 1000 ? stats.aprPct.toFixed(0) : stats.aprPct.toFixed(1)}%`
            : "—",
          stats.aprPct != null
            ? "swap fees"
            : stats.feeModel === "share"
              ? "no swap fee on this pool"
              // Not "no swap history" — a pool can have traded and still be
              // too new or too thin to annualize. Permanent absence and
              // "too early to say" are different facts to an LP.
              : "not enough trading history yet",
          // Same LP APR, over a real fixed 24h/7d cutoff — see
          // computeLpAprWindows in lib/market/vault-stats.ts. A quiet vault
          // can legitimately show a real full-history figure above next to
          // a dashed 24h/7d here — that's the honest answer for a window
          // too thin to annualize, not a stale/broken read.
          stats.aprWindows && (
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 border-t border-line/60 pt-1 text-[0.56rem] tabular-nums text-foreground/60">
              <span>
                24h <span className="text-foreground">{fmtAprWindow(stats.aprWindows["24h"].aprPct)}</span>
              </span>
              <span>
                7d <span className="text-foreground">{fmtAprWindow(stats.aprWindows["7d"].aprPct)}</span>
              </span>
            </div>
          )
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        {stats.feeModel === "share" ? (
          <>
            <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
              <p className="text-[0.55rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">Mint fee</p>
              <p className="text-xs font-bold text-foreground">{((stats.mintFeeBps ?? 0) / 100).toFixed(2)}%</p>
            </div>
            <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
              <p className="text-[0.55rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">Redeem fee</p>
              <p className="text-xs font-bold text-foreground">{((stats.redeemFeeBps ?? 0) / 100).toFixed(2)}%</p>
            </div>
            <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
              <p className="text-[0.55rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">Redeem premium</p>
              <p className="text-xs font-bold text-foreground">{((stats.targetPremiumBps ?? 0) / 100).toFixed(2)}%</p>
            </div>
          </>
        ) : (
          // Eth-model (V3+): fees are flat ETH, not a percentage of share
          // value — printing a bps figure here would be a fabricated number.
          <>
            <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
              <p className="text-[0.55rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">Mint fee</p>
              <p className="text-xs font-bold text-foreground">{ethAndUsd(stats.mintFeeWei ?? "0", 5)}</p>
            </div>
            <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
              <p className="text-[0.55rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">Redeem fee</p>
              <p className="text-xs font-bold text-foreground">{ethAndUsd(stats.redeemFeeWei ?? "0", 5)}</p>
            </div>
            <div className="rounded-lg border border-line bg-wood-950 px-2 py-1.5">
              <p className="text-[0.55rem] font-black uppercase tracking-[0.06em] text-[#9e9279]">Redeem premium</p>
              <p className="text-xs font-bold text-foreground">{ethAndUsd(stats.targetPremiumWei ?? "0", 5)}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
