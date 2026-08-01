"use client";

import { formatTokenAmount } from "@/lib/trade";
import { useVaultLive, type VaultTradeKind } from "@/lib/market/useVaultLive";
import { usePendingVaultTx } from "@/lib/market/pendingVaultTx";
import ScrollBox from "@/components/market/ScrollBox";
import {
  vaultColorKind,
  vaultKindLabel,
  VAULT_LABEL_CLASS,
} from "@/lib/market/vault-registry";

const KIND_LABEL: Record<VaultTradeKind, string> = {
  buy: "Buy shares",
  sell: "Sell shares",
  deposit: "Deposit NFT",
  redeem: "Redeem NFT",
  add_lp: "Add LP",
  remove_lp: "Remove LP",
};

/** Kind reads in cream like the mockup's .event-type; color survives only as
 * the small leading dot. */
const KIND_DOT: Record<VaultTradeKind, string> = {
  buy: "bg-emerald-400",
  sell: "bg-red-400",
  deposit: "bg-sky-400",
  redeem: "bg-amber-400",
  add_lp: "bg-violet-400",
  remove_lp: "bg-fuchsia-400",
};

/** Amount cell: LP always shows shares + ETH; buy/sell prefer ETH; NFT kinds show #id. */
function formatAmount(e: {
  kind: VaultTradeKind;
  ethWei: string | null;
  sharesWei?: string | null;
  tokenId: string | null;
}): string {
  if (e.kind === "add_lp" || e.kind === "remove_lp") {
    const parts: string[] = [];
    if (e.sharesWei != null && e.sharesWei !== "0") {
      parts.push(`${formatTokenAmount(e.sharesWei, 18, 4)} sh`);
    }
    if (e.ethWei != null && e.ethWei !== "0") {
      parts.push(`${formatTokenAmount(e.ethWei, 18, 4)} Ξ`);
    }
    return parts.length > 0 ? parts.join(" + ") : "—";
  }
  if (e.kind === "buy" || e.kind === "sell") {
    if (e.ethWei != null) return `${formatTokenAmount(e.ethWei, 18, 4)} Ξ`;
    if (e.sharesWei != null) return `${formatTokenAmount(e.sharesWei, 18, 4)} sh`;
    return "—";
  }
  if (e.tokenId != null) return `#${e.tokenId}`;
  return "—";
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function vaultTag(vaultAddress?: string): { text: string; className: string } | null {
  if (!vaultAddress) return null;
  const kind = vaultColorKind(vaultAddress);
  if (kind !== "unknown") {
    return { text: vaultKindLabel(kind), className: VAULT_LABEL_CLASS[kind] };
  }
  return {
    text: shortAddr(vaultAddress),
    className: VAULT_LABEL_CLASS.unknown,
  };
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
 * Vault share + NFT inventory ticker (buy/sell, deposit/redeem, add/remove LP).
 * NFT marketplace sales (Seaport/OpenSea) live on the Activity tab, not here.
 *
 * Rows this tab just submitted appear instantly as "Pending" (see
 * lib/market/pendingVaultTx.ts) — before confirmation, let alone before the
 * next stream tick picks them up — and flip to their real row once the
 * stream confirms the same tx hash.
 */
export default function VaultTradeHistory() {
  // `live` (data-freshness) drives the badge, not `connected` (literal SSE
  // socket state) — a routine ~1.5s reconnect used to flash "Reconnecting…"
  // even though the data on screen was still perfectly current, which read
  // as broken when nothing actually was. Both Activity and Instant Swap
  // render their own instance of this component, but both read the exact
  // same shared singleton (lib/market/useVaultLive.ts) — they can never
  // actually show different data; the badge flicker was the only thing
  // that ever made them look out of sync.
  const { activity, live, connected } = useVaultLive();
  const pending = usePendingVaultTx();
  const confirmedHashes = new Set(activity.map((e) => e.txHash));
  const visiblePending = pending.filter((p) => !confirmedHashes.has(p.txHash));
  const loading = activity.length === 0 && !live && visiblePending.length === 0;
  // Three real states, not two: `live` data current is "Live"; a socket
  // that's open/reconnecting but hasn't gone stale yet is "Updating…" (still
  // fine, just between ticks); only once the data has actually gone stale
  // AND there's no live socket does it read as "Reconnecting…" — the state
  // that's actually worth flagging as a problem.
  // If we already have trade rows, never label "Reconnecting…" — that was
  // thrashing Live ↔ Reconnecting while REST still had a full history.
  const badgeLabel =
    activity.length > 0 || live
      ? "Live"
      : connected
        ? "Updating…"
        : "Reconnecting…";

  return (
    <div className="space-y-1.5 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-center justify-between">
        <p className="text-[0.72rem] font-black text-foreground">
          Live Driftwood + WormWood trades
        </p>
        <span
          className={`flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[0.55rem] font-bold uppercase ${live ? "text-emerald-300/70" : connected ? "text-gold-300/70" : "text-foreground/30"}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-emerald-400" : connected ? "animate-pulse bg-gold-400" : "bg-foreground/30"}`}
          />
          {badgeLabel}
        </span>
      </div>
      {loading ? (
        <div className="space-y-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-7 animate-pulse rounded bg-panel" />
          ))}
        </div>
      ) : activity.length === 0 && visiblePending.length === 0 ? (
        <p className="rounded-lg border border-line bg-wood-950 px-3 py-4 text-center text-xs text-foreground/45">
          No vault trades yet.
        </p>
      ) : (
        <ScrollBox
          storageKey="vault-trades"
          defaultHeight={256}
          className="rounded-lg border border-line bg-wood-950"
        >
          <table className="w-full text-left text-[0.65rem]">
            <thead>
              <tr className="border-b border-line bg-[rgba(219,165,63,0.07)] text-[0.58rem] uppercase tracking-[0.08em] text-[#9e9279]">
                <th className="px-2 py-2 font-black">Kind</th>
                <th className="px-2 py-2 font-black">Amount</th>
                <th className="px-2 py-2 font-black">Price/share</th>
                <th className="px-2 py-2 font-black">Trader</th>
                <th className="px-2 py-2 text-right font-black">Time</th>
              </tr>
            </thead>
            <tbody>
              {visiblePending.map((p) => (
                <tr key={p.txHash} className="border-b border-line bg-gold-500/5 last:border-0">
                  <td className="px-2 py-1.5 font-bold text-foreground">
                    <span
                      className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${KIND_DOT[p.kind]}`}
                    />
                    {p.role === "settle" ? "Settle redeem" : KIND_LABEL[p.kind]}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-foreground/70">
                    {p.role === "settle"
                      ? "→ other wallet"
                      : formatAmount({
                          kind: p.kind,
                          ethWei: p.ethWei,
                          sharesWei: p.sharesWei ?? null,
                          tokenId: p.tokenId,
                        })}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-foreground/45">—</td>
                  <td className="px-2 py-1.5 font-mono text-foreground/45">
                    {p.role === "settle" ? "you (gas)" : "you"}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <span className="inline-flex items-center gap-1 text-amber-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                      Pending
                    </span>
                  </td>
                </tr>
              ))}
              {activity.map((e) => (
                <tr
                  key={`${e.vaultAddress || ""}:${e.txHash}:${e.kind}:${e.tokenId ?? ""}:${e.logIndex ?? ""}`}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-2 py-1.5 font-bold text-foreground">
                    <span
                      className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${KIND_DOT[e.kind]}`}
                    />
                    {KIND_LABEL[e.kind]}
                    {(() => {
                      const tag = vaultTag(e.vaultAddress);
                      if (!tag) return null;
                      return (
                        <span
                          className={`ml-1 inline-block rounded border px-1 py-px text-[0.55rem] font-extrabold uppercase tracking-wide ${tag.className}`}
                        >
                          {tag.text}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-foreground/70">
                    {formatAmount(e)}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-foreground/55">
                    {e.kind === "buy" || e.kind === "sell"
                      ? pricePerShare(e.ethWei, e.sharesWei)
                      : e.kind === "add_lp" || e.kind === "remove_lp"
                        ? pricePerShare(e.ethWei, e.sharesWei)
                        : "—"}
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
