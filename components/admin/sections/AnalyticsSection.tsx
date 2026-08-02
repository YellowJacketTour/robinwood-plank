"use client";

import { useCallback, useEffect, useState } from "react";
import { MARKET_VAULT_ADDRESS } from "@/lib/constants";
import { vaultShortName } from "@/lib/market/vault-registry";
import { SkeletonBlock, SkeletonStats, SkeletonStatus } from "@/components/Skeleton";
import { BUTTON_SECONDARY, CARD, LABEL } from "../ui";

/**
 * Analytics section — aggregates the market/trade APIs the site already
 * computes into one admin overview. Nothing is recomputed here; each tile
 * names its source endpoint.
 */

type SalesStats = {
  saleCount: number;
  highestWei: string | null;
  totalVolumeWei: string | null;
};

type Pools = {
  totalLiquidityUsd?: number;
  totalVolumeUsd24h?: number;
  stale?: boolean;
};

// /api/trade/price-history's actual shape nests the window changes under
// priceChangePct (h1/h6/h24) — a flat top-level `changePct` never existed,
// so reading that field always rendered "—" regardless of live data.
type PriceHistory = {
  stats?: {
    priceUsd?: number;
    priceChangePct?: { h1?: number; h6?: number; h24?: number };
  } | null;
  candles?: unknown[];
  stale?: boolean;
};

type Activity = { events?: { kind: string }[] };

// The primary Instant Swap vault's live dashboard numbers — the same data
// the public /market Swap tab shows, surfaced here since deposits/redeems/
// reserves are otherwise invisible to admin despite the vault being the
// site's second trading surface.
type VaultStats = {
  ethReserveWei?: string;
  heldTokenCount?: number;
  depositCount?: number;
  redeemCount?: number;
  aprPct?: number | null;
  aprBasisHours?: number | null;
  vaultFeeRevenueWei?: string;
  poolOpen?: boolean;
};

function fromWei(wei: string | null | undefined, dp = 3): string {
  if (!wei) return "—";
  try {
    const v = BigInt(wei);
    const base = BigInt(10) ** BigInt(18);
    const fracStr = ((base + (v % base)).toString().slice(1, 1 + dp) || "0");
    return `${(v / base).toLocaleString()}.${fracStr}`;
  } catch {
    return "—";
  }
}

function usd(v: number | undefined): string {
  return typeof v === "number"
    ? v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "—";
}

function Tile({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source: string;
}) {
  return (
    <div className="rounded-md border border-line bg-panel-strong p-3">
      <p className={LABEL}>{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums text-gold-300">{value}</p>
      <p className="mt-1 font-mono text-[0.6rem] text-cream-muted/70">{source}</p>
    </div>
  );
}

// Read-only — ignores the shell's `address` prop.
export default function AnalyticsSection() {
  const [sales, setSales] = useState<SalesStats | null>(null);
  const [pools, setPools] = useState<Pools | null>(null);
  const [price, setPrice] = useState<PriceHistory | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [vault, setVault] = useState<VaultStats | null>(null);
  const [loading, setLoading] = useState(true);
  // Distinguishes the first, cold load (nothing to show yet — skeleton) from
  // a Refresh click (stale tiles already on screen — keep them, just mark
  // the button busy).
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const grab = async <T,>(url: string): Promise<T | null> => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        return res.ok ? ((await res.json()) as T) : null;
      } catch {
        return null;
      }
    };
    const [s, p, ph, a, v] = await Promise.all([
      grab<SalesStats>("/api/market/sales-stats"),
      grab<Pools>("/api/trade/pools"),
      grab<PriceHistory>("/api/trade/price-history?range=24H"),
      grab<Activity>("/api/market/activity"),
      grab<VaultStats>("/api/market/vault/stats"),
    ]);
    setSales(s);
    setPools(p);
    setPrice(ph);
    setActivity(a);
    setVault(v);
    setLoading(false);
    setLoadedOnce(true);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const eventCounts = (activity?.events ?? []).reduce<Record<string, number>>(
    (acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    },
    {}
  );

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">Analytics</h2>
          <p className={`mt-1 ${LABEL}`}>
            Aggregated from the live market &amp; trade APIs
          </p>
        </div>
        <button
          type="button"
          className={BUTTON_SECONDARY}
          onClick={() => void load()}
          disabled={loading}
        >
          {loading && loadedOnce ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {loading && !loadedOnce ? (
        <div className="mt-4">
          <SkeletonStatus>Loading marketplace and vault analytics</SkeletonStatus>
          <SkeletonStats count={9} />
          <div className="mt-3 rounded-md border border-line bg-panel-strong p-3">
            <SkeletonBlock className="h-2.5 w-56" />
            <div className="mt-2 flex flex-wrap gap-2">
              {Array.from({ length: 4 }, (_, i) => (
                <SkeletonBlock key={i} className="h-6 w-24 rounded-full" />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Tile
              label="NFT sales (all time)"
              value={sales ? sales.saleCount.toLocaleString() : "—"}
              source="/api/market/sales-stats"
            />
            <Tile
              label="NFT volume"
              value={sales ? `${fromWei(sales.totalVolumeWei)} ETH` : "—"}
              source="/api/market/sales-stats"
            />
            <Tile
              label="Highest sale"
              value={sales ? `${fromWei(sales.highestWei)} ETH` : "—"}
              source="/api/market/sales-stats"
            />
            <Tile
              label="$PLANK liquidity"
              value={usd(pools?.totalLiquidityUsd)}
              source="/api/trade/pools"
            />
            <Tile
              label="$PLANK 24h volume"
              value={usd(pools?.totalVolumeUsd24h)}
              source="/api/trade/pools"
            />
            <Tile
              label="$PLANK 24h change"
              value={
                typeof price?.stats?.priceChangePct?.h24 === "number"
                  ? `${price.stats.priceChangePct.h24 > 0 ? "+" : ""}${price.stats.priceChangePct.h24.toFixed(2)}%`
                  : "—"
              }
              source="/api/trade/price-history"
            />
            <Tile
              label={`${vaultShortName(MARKET_VAULT_ADDRESS)} ETH reserve`}
              value={vault ? `${fromWei(vault.ethReserveWei)} ETH` : "—"}
              source="/api/market/vault/stats"
            />
            <Tile
              label="Instant Swap NFTs held"
              value={
                vault
                  ? `${vault.heldTokenCount?.toLocaleString() ?? "0"}${
                      vault.poolOpen === false ? " (pool closed)" : ""
                    }`
                  : "—"
              }
              source="/api/market/vault/stats"
            />
            <Tile
              label="Instant Swap deposits / redeems"
              value={
                vault
                  ? `${vault.depositCount?.toLocaleString() ?? "0"} / ${vault.redeemCount?.toLocaleString() ?? "0"}`
                  : "—"
              }
              source="/api/market/vault/stats"
            />
            <Tile
              // "LP APR", not "APR" — this is specifically swap-fee yield to
              // liquidity providers (see the aprPct docstring in
              // lib/market/vault-stats.ts for the contract-level proof that
              // mint/redeem fees pay the treasury, not LPs). The basis is
              // whatever window the replay actually measured, not a fixed
              // 24h — asserting an unmeasured window is exactly the
              // fabricated-APR bug this endpoint was fixed to stop doing.
              label={
                typeof vault?.aprPct === "number" && typeof vault?.aprBasisHours === "number"
                  ? `Instant Swap LP APR (${vault.aprBasisHours.toFixed(1)}h basis)`
                  : "Instant Swap LP APR"
              }
              value={typeof vault?.aprPct === "number" ? `${vault.aprPct.toFixed(1)}%` : "—"}
              source="/api/market/vault/stats"
            />
            <Tile
              // Real mint/redeem fee revenue — but it pays the treasury, not
              // LPs. Named for what it is rather than folded into the LP APR
              // tile above.
              label="Instant Swap treasury revenue (mint/redeem fees)"
              value={vault ? `${fromWei(vault.vaultFeeRevenueWei)} ETH` : "—"}
              source="/api/market/vault/stats"
            />
          </div>

          <div className="mt-3 rounded-md border border-line bg-panel-strong p-3">
            <p className={LABEL}>Recent on-chain activity (last fetch window)</p>
            {Object.keys(eventCounts).length === 0 ? (
              <p className="mt-2 text-sm text-cream-muted">No events returned.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2 text-sm">
                {Object.entries(eventCounts).map(([kind, count]) => (
                  <li
                    key={kind}
                    className="rounded-full border border-line px-3 py-1 text-cream"
                  >
                    {kind}: <span className="tabular-nums text-gold-300">{count}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 font-mono text-[0.6rem] text-cream-muted/70">
              /api/market/activity
            </p>
          </div>
        </>
      )}
    </section>
  );
}
