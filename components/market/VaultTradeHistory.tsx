"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";

type VaultTradeKind = "buy" | "sell" | "deposit" | "redeem";

type VaultTradeEvent = {
  kind: VaultTradeKind;
  address: string;
  ethWei: string | null;
  sharesWei: string | null;
  tokenId: string | null;
  txHash: string;
  timestamp: string | null;
};

const KIND_LABEL: Record<VaultTradeKind, string> = {
  buy: "Buy",
  sell: "Sell",
  deposit: "Deposit",
  redeem: "Redeem",
};

const KIND_COLOR: Record<VaultTradeKind, string> = {
  buy: "text-emerald-300",
  sell: "text-red-300",
  deposit: "text-sky-300",
  redeem: "text-amber-300",
};

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Real on-chain vault trade ticker (buy/sell/deposit/redeem), the dextools-
 * style trade table for Instant Swap — fed by /api/market/vault/activity,
 * which replays the vault's own events directly (lib/market/vault-activity.ts).
 * The NFT-collection Transfer-based /api/market/activity feed that drives
 * the Activity tab has no visibility into these at all, since vault swaps
 * trade the vault's internal share token, not the NFT collection itself.
 */
export default function VaultTradeHistory() {
  const [events, setEvents] = useState<VaultTradeEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/market/vault/activity")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data: { events?: VaultTradeEvent[] }) => {
        if (!cancelled) setEvents(data.events ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return <p className="py-3 text-center text-xs text-red-300">Could not load trade history.</p>;
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">Vault trades</p>
      {events == null ? (
        <div className="space-y-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-7 animate-pulse rounded bg-wood-900/60" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gold-500/25 bg-black/10 px-3 py-4 text-center text-xs text-foreground/45">
          No vault trades yet.
        </p>
      ) : (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-gold-500/15 bg-black/10">
          <table className="w-full text-left text-[0.65rem]">
            <tbody>
              {events.map((e) => (
                <tr key={e.txHash + e.kind + (e.tokenId ?? "")} className="border-b border-gold-500/10 last:border-0">
                  <td className={`px-2 py-1.5 font-bold ${KIND_COLOR[e.kind]}`}>{KIND_LABEL[e.kind]}</td>
                  <td className="px-2 py-1.5 font-mono text-foreground/70">
                    {e.ethWei != null
                      ? `${formatTokenAmount(e.ethWei, 18, 4)} Ξ`
                      : e.tokenId != null
                        ? `#${e.tokenId}`
                        : "—"}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-foreground/45">{shortAddr(e.address)}</td>
                  <td className="px-2 py-1.5 text-right text-foreground/40">{timeAgo(e.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
