"use client";

import { useEffect, useState } from "react";

/**
 * Biggest Buyer Board for one collection -- driven only by real indexed
 * fills (lib/market/multichain/biggest-buyers.ts). Shows USD when the fill
 * carried one, exact native amounts otherwise, and says how many fills had
 * no price rather than blending. Empty ledger = an honest empty board.
 */

type Board = {
  windowHours: number;
  totalSales: number;
  coverageNote: string;
  buyers: Array<{ buyer: string; sales: number; usd: number | null; unpricedSales: number; amountAtomic: string | null; currencySymbol: string | null; lastBuyAt: string | null; distinctTokens: number }>;
};

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function usd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function native(atomic: string | null, symbol: string | null): string {
  if (!atomic) return "—";
  try {
    const decimals = symbol === "SOL" ? 9 : symbol === "BTC" ? 8 : 18;
    const v = Number(BigInt(atomic)) / 10 ** decimals;
    return `${v.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${symbol ?? ""}`.trim();
  } catch {
    return "—";
  }
}

export default function BiggestBuyersBoard({ chainSlug, collectionKey }: { chainSlug: string; collectionKey: string }) {
  const [hours, setHours] = useState(168);
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unavailable">("loading");
  useEffect(() => {
    let alive = true;
    setState("loading");
    fetch(`/api/market/multichain/biggest-buyers?chainSlug=${encodeURIComponent(chainSlug)}&collectionKey=${encodeURIComponent(collectionKey)}&hours=${hours}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as Board) : null))
      .then((b) => {
        if (!alive) return;
        setBoard(b);
        setState(b ? "ok" : "unavailable");
      })
      .catch(() => alive && setState("unavailable"));
    return () => {
      alive = false;
    };
  }, [chainSlug, collectionKey, hours]);

  return (
    <section className="rounded-lg border border-line bg-panel p-3" aria-label="Biggest buyers">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Biggest buyers</h3>
        <div className="flex gap-1 text-[0.66rem]">
          {[24, 168, 720].map((h) => (
            <button key={h} type="button" onClick={() => setHours(h)} className={`rounded border px-1.5 py-0.5 ${hours === h ? "border-gold-400/60 text-foreground" : "border-line text-foreground/50"}`}>
              {h === 24 ? "24h" : h === 168 ? "7d" : "30d"}
            </button>
          ))}
        </div>
      </div>
      {state === "loading" && <p className="text-xs text-foreground/50">Loading…</p>}
      {state === "unavailable" && <p className="text-xs text-foreground/50">No fill ledger for this collection yet.</p>}
      {state === "ok" && board && (
        <>
          {board.buyers.length === 0 ? (
            <p className="text-xs text-foreground/50">No indexed sales in this window.</p>
          ) : (
            <ol className="space-y-1 text-xs">
              {board.buyers.slice(0, 10).map((b, i) => (
                <li key={b.buyer} className="flex items-center justify-between gap-2 rounded-md border border-line/60 bg-background/50 px-2 py-1">
                  <span className="flex items-center gap-2">
                    <span className="w-5 text-right font-semibold text-gold-300">{i + 1}</span>
                    <span className="font-mono">{short(b.buyer)}</span>
                    <span className="text-foreground/50">{b.sales} buy{b.sales === 1 ? "" : "s"} · {b.distinctTokens} token{b.distinctTokens === 1 ? "" : "s"}</span>
                  </span>
                  <span className="text-right">
                    <span className="block font-semibold">{b.usd != null ? usd(b.usd) : native(b.amountAtomic, b.currencySymbol)}</span>
                    {b.unpricedSales > 0 && <span className="block text-[0.6rem] text-foreground/40">{b.unpricedSales} unpriced</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-2 text-[0.62rem] text-foreground/40">{board.totalSales} indexed sales in window. {board.coverageNote}</p>
        </>
      )}
    </section>
  );
}
