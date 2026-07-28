"use client";

import { formatTokenAmount } from "@/lib/trade";
import { useVaultLive, type VaultTradeKind } from "@/lib/market/useVaultLive";
import { usePendingVaultTx } from "@/lib/market/pendingVaultTx";
import ScrollBox from "@/components/market/ScrollBox";

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

function pricePerShare(ethWei: string | null, sharesWei: string | null): string {
  if (ethWei == null || sharesWei == null || Number(sharesWei) === 0) return "—";
  // Both amounts are wei-scaled (18 decimals), so their ratio is already
  // the ETH-per-share price — no rescaling needed.
  return `${(Number(ethWei) / Number(sharesWei)).toFixed(5)} Ξ`;
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
 * style trade table for Instant Swap — fed by the shared live stream
 * (lib/market/useVaultLive.ts, backed by /api/market/vault/stream), which
 * replays the vault's own events directly. The NFT-collection Transfer-based
 * /api/market/activity feed that drives the Activity tab has no visibility
 * into these at all, since vault swaps trade the vault's internal share
 * token, not the NFT collection itself.
 *
 * Rows this tab just submitted appear instantly as "Pending" (see
 * lib/market/pendingVaultTx.ts) — before confirmation, let alone before the
 * next stream tick picks them up — and flip to their real row once the
 * stream confirms the same tx hash.
 */
export default function VaultTradeHistory() {
  const { activity, connected } = useVaultLive();
  const pending = usePendingVaultTx();
  const confirmedHashes = new Set(activity.map((e) => e.txHash));
  const visiblePending = pending.filter((p) => !confirmedHashes.has(p.txHash));
  const loading = activity.length === 0 && !connected && visiblePending.length === 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          Liquidity pool trades <span className="font-normal normal-case text-foreground/35">· source: vault AMM</span>
        </p>
        <span
          className={`flex items-center gap-1 text-[0.55rem] font-bold uppercase ${connected ? "text-emerald-300/70" : "text-foreground/30"}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "animate-pulse bg-emerald-400" : "bg-foreground/30"}`} />
          {connected ? "Live" : "Reconnecting…"}
        </span>
      </div>
      {loading ? (
        <div className="space-y-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-7 animate-pulse rounded bg-wood-900/60" />
          ))}
        </div>
      ) : activity.length === 0 && visiblePending.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gold-500/25 bg-black/10 px-3 py-4 text-center text-xs text-foreground/45">
          No vault trades yet.
        </p>
      ) : (
        <ScrollBox
          storageKey="vault-trades"
          defaultHeight={256}
          className="rounded-lg border border-gold-500/15 bg-black/10"
        >
          <table className="w-full text-left text-[0.65rem]">
            <thead>
              <tr className="border-b border-gold-500/15 text-[0.55rem] uppercase tracking-wide text-foreground/35">
                <th className="px-2 py-1 font-bold">Kind</th>
                <th className="px-2 py-1 font-bold">Amount</th>
                <th className="px-2 py-1 font-bold">Price/share</th>
                <th className="px-2 py-1 font-bold">Trader</th>
                <th className="px-2 py-1 text-right font-bold">Time</th>
              </tr>
            </thead>
            <tbody>
              {visiblePending.map((p) => (
                <tr key={p.txHash} className="border-b border-gold-500/10 bg-gold-500/5 last:border-0">
                  <td className={`px-2 py-1.5 font-bold ${KIND_COLOR[p.kind]}`}>{KIND_LABEL[p.kind]}</td>
                  <td className="px-2 py-1.5 font-mono text-foreground/70">
                    {p.ethWei != null ? `${formatTokenAmount(p.ethWei, 18, 4)} Ξ` : p.tokenId != null ? `#${p.tokenId}` : "—"}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-foreground/45">—</td>
                  <td className="px-2 py-1.5 font-mono text-foreground/45">you</td>
                  <td className="px-2 py-1.5 text-right">
                    <span className="inline-flex items-center gap-1 text-amber-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                      Pending
                    </span>
                  </td>
                </tr>
              ))}
              {activity.map((e) => (
                <tr key={e.txHash + e.kind + (e.tokenId ?? "")} className="border-b border-gold-500/10 last:border-0">
                  <td className={`px-2 py-1.5 font-bold ${KIND_COLOR[e.kind]}`}>{KIND_LABEL[e.kind]}</td>
                  <td className="px-2 py-1.5 font-mono text-foreground/70">
                    {e.ethWei != null
                      ? `${formatTokenAmount(e.ethWei, 18, 4)} Ξ`
                      : e.tokenId != null
                        ? `#${e.tokenId}`
                        : "—"}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-foreground/55">
                    {e.kind === "buy" || e.kind === "sell" ? pricePerShare(e.ethWei, e.sharesWei) : "—"}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-foreground/45">{shortAddr(e.address)}</td>
                  <td className="px-2 py-1.5 text-right text-foreground/40">{timeAgo(e.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollBox>
      )}
    </div>
  );
}
