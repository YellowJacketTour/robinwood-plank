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

type SaleEvent = { kind: string; tokenId: string; priceWei: string | null; to: string; timestamp: string | null };
type RecordSale = { tokenId: string; priceWei: string; buyer: string; image: string | null };

/**
 * Highest confirmed marketplace sale to date — walked from the SAME full
 * activity history the price chart uses (/api/market/activity?full=1), not
 * a hardcoded number, so it stays correct as new sales land. Vault AMM
 * trades are a different mechanism (buying a random/any share of the pool,
 * not a specific listed Plank) and are deliberately excluded from "highest
 * sale" — that title belongs to a real fixed-price sale of a specific NFT.
 */
function useRecordSale(): RecordSale | null | undefined {
  const [record, setRecord] = useState<RecordSale | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/market/activity?full=1")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data: { events?: SaleEvent[] }) => {
        if (cancelled) return;
        const sales = (data.events ?? []).filter(
          (e): e is SaleEvent & { priceWei: string } => e.kind === "sale" && e.priceWei != null
        );
        if (sales.length === 0) {
          setRecord(null);
          return;
        }
        const top = sales.reduce((max, e) => (BigInt(e.priceWei) > BigInt(max.priceWei) ? e : max));
        setRecord({ tokenId: top.tokenId, priceWei: top.priceWei, buyer: top.to, image: null });
        fetch(`/api/market/token?tokenId=${encodeURIComponent(top.tokenId)}`)
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
    const update = () => setRemaining(getRemaining(target));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [target]);

  if (remaining?.complete) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gold-500/30 bg-wood-900/70 px-3 py-2">
      {record ? (
        <div className="flex min-w-0 items-center gap-2">
          {record.image ? (
            <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-md border border-gold-500/40">
              <Image src={record.image} alt={`#${record.tokenId}`} fill sizes="32px" className="object-cover" unoptimized />
            </div>
          ) : (
            <div className="h-8 w-8 shrink-0 rounded-md border border-gold-500/40 bg-wood-900" />
          )}
          <p className="min-w-0 truncate text-[0.7rem] text-foreground/70">
            <span className="font-bold text-gold-300">Highest sale: {formatTokenAmount(record.priceWei, 18, 4)} Ξ</span>
            {" · "}Plank #{record.tokenId} {" · "}
            <span className="font-mono">{shortAddress(record.buyer)}</span>
          </p>
        </div>
      ) : (
        <p className="text-xs font-bold uppercase tracking-wide text-gold-300">Special event</p>
      )}
      <div className="flex shrink-0 items-center gap-1.5 font-mono text-sm text-foreground" role="timer" aria-live="off">
        <span>{pad(remaining?.days)}d</span>
        <span className="text-foreground/40">:</span>
        <span>{pad(remaining?.hours)}h</span>
        <span className="text-foreground/40">:</span>
        <span>{pad(remaining?.minutes)}m</span>
        <span className="text-foreground/40">:</span>
        <span>{pad(remaining?.seconds)}s</span>
      </div>
    </div>
  );
}
