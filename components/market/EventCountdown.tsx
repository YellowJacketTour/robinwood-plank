"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { formatTokenAmount, shortAddress } from "@/lib/trade";

type Remaining = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  complete: boolean;
};

function getRemaining(target: number): Remaining {
  const distance = Math.max(0, target - Date.now());
  return {
    days: Math.floor(distance / 86_400_000),
    hours: Math.floor((distance / 3_600_000) % 24),
    minutes: Math.floor((distance / 60_000) % 60),
    seconds: Math.floor((distance / 1_000) % 60),
    complete: distance === 0,
  };
}

function pad(n: number | undefined) {
  return typeof n === "number" ? String(n).padStart(2, "0") : "—";
}

type RecordSale = { tokenId: string; priceWei: string; buyer: string; image: string | null };

type KothResponse = {
  available: boolean;
  deadline?: string;
  leadingSale?: { tokenId: string | null; priceWei: string; wallet: string | null } | null;
  finalized?: boolean;
  winner?: { tokenId: string | null; priceWei: string; wallet: string | null } | null;
};

type KothLive = { target: number | null; record: RecordSale | null | undefined; finalized: boolean };

/**
 * King of the Hill — the real, server-persisted round (deadline + leading
 * sale + permanent winner once finalized) from /api/market/king-of-the-hill
 * (lib/market/king-of-the-hill.ts, migration 009_king_of_the_hill.sql).
 * Replaces the previous hardcoded client-only TARGET_ISO constant and the
 * separate /api/market/sales-stats "highest sale" fetch with this single
 * authoritative source, matching the tweet's stated king-of-the-hill rules.
 */
function useKingOfTheHill(): KothLive {
  const [state, setState] = useState<KothLive>({ target: null, record: undefined, finalized: false });

  useEffect(() => {
    let cancelled = false;
    import("@/lib/market/swr-fetch")
      .then(({ swrJson }) =>
        swrJson<KothResponse>("/api/market/king-of-the-hill", {
          ttlMs: 60_000,
          swrMs: 300_000,
          session: true,
        })
      )
      .then((data) => {
        if (cancelled) return;
        if (!data.available) {
          setState({ target: null, record: null, finalized: false });
          return;
        }
        const leading = data.finalized ? data.winner : data.leadingSale;
        const record: RecordSale | null =
          leading && leading.tokenId
            ? {
                tokenId: leading.tokenId,
                priceWei: leading.priceWei,
                buyer: leading.wallet ? shortAddress(leading.wallet) : "",
                image: null,
              }
            : null;
        setState({
          target: data.deadline ? Date.parse(data.deadline) : null,
          record,
          finalized: Boolean(data.finalized),
        });
        if (record?.tokenId) {
          fetch(`/api/market/token?tokenId=${encodeURIComponent(record.tokenId)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((t) => {
              if (!cancelled && t?.image) {
                setState((prev) =>
                  prev.record ? { ...prev, record: { ...prev.record, image: t.image } } : prev
                );
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (!cancelled) setState({ target: null, record: null, finalized: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * Compact event banner for the Buy & Sell / Activity tab headers: the real
 * King of the Hill countdown alongside the current leading sale (or, once
 * the round is finalized, the permanent winner).
 */
export default function EventCountdown() {
  const { target, record, finalized } = useKingOfTheHill();
  const [remaining, setRemaining] = useState<Remaining | null>(null);

  useEffect(() => {
    if (target == null) return;
    // Show second precision so the countdown stays useful near the deadline.
    const update = () => setRemaining(getRemaining(target));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [target]);

  if (target == null) return null;
  if (remaining?.complete && !finalized) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-3 py-2">
      {record ? (
        <div className="flex min-w-0 items-center gap-2.5">
          {record.image ? (
            <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-md border border-line-strong">
              <Image src={record.image} alt={`#${record.tokenId}`} fill sizes="36px" className="object-cover" unoptimized />
            </div>
          ) : (
            <div className="h-9 w-9 shrink-0 rounded-md border border-line-strong bg-wood-900" />
          )}
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[0.72rem] font-bold text-gold-300">
              {finalized ? "Winner" : "King of the Hill"}: Plank #{record.tokenId} ·{" "}
              {formatTokenAmount(record.priceWei, 18, 4)} ETH
            </p>
            <p className="truncate text-[0.62rem] text-foreground/55">
              {record.buyer ? `${record.buyer} · ` : ""}
              {finalized ? "round closed" : "verified order"}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-xs font-bold uppercase tracking-wide text-gold-300">King of the Hill</p>
      )}
      <div className="shrink-0 text-right leading-tight" role="timer" aria-live="off">
        <p className="text-[0.58rem] font-bold uppercase tracking-wider text-foreground/45">
          {finalized ? "Event closed" : "Event closes in"}
        </p>
        <p className="font-mono text-sm font-bold text-foreground">
          {pad(remaining?.days)}d {pad(remaining?.hours)}h {pad(remaining?.minutes)}m {pad(remaining?.seconds)}s
        </p>
      </div>
    </div>
  );
}
