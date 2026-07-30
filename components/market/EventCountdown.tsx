"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { formatTokenAmount, shortAddress } from "@/lib/trade";

/** 8/4/26 — assumed UTC midnight; adjust if a specific timezone was meant. */
const TARGET_ISO = "2026-08-04T00:00:00Z";

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

/**
 * Highest confirmed marketplace sale — from the durable on-chain sales
 * catalog (/api/market/sales-stats), seeded from Blockscout marketplace
 * fills (Seaport + other venues). Vault AMM is excluded.
 */
function useRecordSale(): RecordSale | null | undefined {
  const [record, setRecord] = useState<RecordSale | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    import("@/lib/market/swr-fetch")
      .then(({ swrJson }) =>
        swrJson<{
          highestWei?: string | null;
          highestTokenId?: string | null;
          highestPlatform?: string | null;
        }>("/api/market/sales-stats", {
          ttlMs: 60_000,
          swrMs: 300_000,
          session: true,
        })
      )
      .then((data) => {
        if (cancelled) return;
        if (!data.highestWei || !data.highestTokenId) {
          setRecord(null);
          return;
        }
        setRecord({
          tokenId: data.highestTokenId,
          priceWei: data.highestWei,
          buyer: data.highestPlatform === "seaport" ? "OpenSea/Seaport" : data.highestPlatform || "",
          image: null,
        });
        fetch(`/api/market/token?tokenId=${encodeURIComponent(data.highestTokenId)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((t) => {
            if (!cancelled && t?.image) {
              setRecord((prev) => (prev ? { ...prev, image: t.image } : prev));
            }
          })
          .catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setRecord(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return record;
}

/**
 * Compact event banner for the Buy & Sell / Activity tab headers: the
 * countdown to 8/4/26 alongside the highest confirmed sale to date —
 * TODO: the specific event feature/name wasn't fully specified ("features
 * the king of the...", message cut off), so the countdown side reads
 * generically as "Special event" until that's confirmed.
 */
export default function EventCountdown() {
  const target = Date.parse(TARGET_ISO);
  const [remaining, setRemaining] = useState<Remaining | null>(null);
  const record = useRecordSale();

  useEffect(() => {
    // The banner shows day/hour/minute precision (finalized mockup) — a
    // minute cadence is enough and avoids a whole-banner re-render every second.
    const update = () => setRemaining(getRemaining(target));
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, [target]);

  if (remaining?.complete) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gold-500/30 bg-wood-900/90 px-3 py-2">
      {record ? (
        <div className="flex min-w-0 items-center gap-2.5">
          {record.image ? (
            <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-md border border-gold-500/40">
              <Image src={record.image} alt={`#${record.tokenId}`} fill sizes="36px" className="object-cover" unoptimized />
            </div>
          ) : (
            <div className="h-9 w-9 shrink-0 rounded-md border border-gold-500/40 bg-wood-900" />
          )}
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[0.72rem] font-bold text-gold-300">
              Record sale: Plank #{record.tokenId} · {formatTokenAmount(record.priceWei, 18, 4)} ETH
            </p>
            <p className="truncate text-[0.62rem] text-foreground/55">
              {record.buyer
                ? `on ${record.buyer.startsWith("0x") ? shortAddress(record.buyer) : record.buyer} · `
                : ""}
              royalty paid · verified order
            </p>
          </div>
        </div>
      ) : (
        <p className="text-xs font-bold uppercase tracking-wide text-gold-300">Special event</p>
      )}
      <div className="shrink-0 text-right leading-tight" role="timer" aria-live="off">
        <p className="text-[0.58rem] font-bold uppercase tracking-wider text-foreground/45">
          Event closes in
        </p>
        <p className="font-mono text-sm font-bold text-foreground">
          {pad(remaining?.days)}d {pad(remaining?.hours)}h {pad(remaining?.minutes)}m
        </p>
      </div>
    </div>
  );
}
