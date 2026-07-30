"use client";

import { useEffect, useState } from "react";
import { CHAIN, CONTRACT_ADDRESS } from "@/lib/constants";
import { explorerTokenUrl, shortAddress } from "@/lib/trade";

/** Only the fields this panel renders — the full shape lives in
 * app/api/trade/status/route.ts. Never fabricate a field that isn't here. */
type TradeStatus = {
  isOpen: boolean;
  paused: boolean;
  message: string;
  tradingApiConfigured: boolean;
  uniswapUrl: string | null;
  siteFee: { label: string; enabled: boolean; appliesTo: string };
};

/**
 * Live read of /api/trade/status — the same source CountdownTimer and
 * SwapWidget already trust. Renders only what the endpoint actually returns;
 * no hardcoded price, volume, or contract data (DESIGN.md).
 */
export default function TradeStatusPanel() {
  const [status, setStatus] = useState<TradeStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/trade/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
      .then((d: TradeStatus) => {
        if (!cancelled) setStatus(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const stateLabel = !status
    ? "Checking…"
    : status.paused
      ? "Stand by"
      : status.isOpen
        ? "Live"
        : "Opens soon";
  const stateTone = !status
    ? "border-line bg-panel text-cream-muted"
    : status.paused
      ? "border-amber-500/45 bg-amber-950/30 text-amber-200"
      : status.isOpen
        ? "border-emerald-500/40 bg-emerald-950/25 text-emerald-300"
        : "border-gold-500/35 bg-gold-500/10 text-gold-300";

  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.7rem] font-black uppercase tracking-[0.08em] text-cream">
          Trade status
        </p>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.65rem] font-bold ${stateTone}`}
        >
          {status && !status.paused && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${status.isOpen ? "bg-emerald-400" : "bg-gold-400"}`}
              aria-hidden="true"
            />
          )}
          {stateLabel}
        </span>
      </div>

      {failed ? (
        <p className="text-xs text-cream-muted">
          Could not reach the status endpoint — the widget below still enforces the same
          rules server-side.
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-panel-strong px-2.5 py-2">
            <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-cream-muted">
              Network
            </dt>
            <dd className="mt-0.5 font-semibold text-cream">{CHAIN.name}</dd>
          </div>
          <div className="rounded-lg border border-line bg-panel-strong px-2.5 py-2">
            <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-cream-muted">
              Site fee
            </dt>
            <dd className="mt-0.5 font-semibold text-cream">
              {status ? (status.siteFee.enabled ? status.siteFee.label : "None") : "—"}
            </dd>
          </div>
          <div className="rounded-lg border border-line bg-panel-strong px-2.5 py-2">
            <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-cream-muted">
              Routing engine
            </dt>
            <dd className="mt-0.5 font-semibold text-cream">
              {status
                ? status.tradingApiConfigured
                  ? "Uniswap Trading API"
                  : "Offline — use Uniswap directly"
                : "—"}
            </dd>
          </div>
          <div className="rounded-lg border border-line bg-panel-strong px-2.5 py-2">
            <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-cream-muted">
              Contract
            </dt>
            <dd className="mt-0.5">
              <a
                href={explorerTokenUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono font-semibold text-gold-300 underline-offset-2 hover:underline"
                title={CONTRACT_ADDRESS}
              >
                {shortAddress(CONTRACT_ADDRESS)} ↗
              </a>
            </dd>
          </div>
        </dl>
      )}

      {status?.uniswapUrl && (
        <a
          href={status.uniswapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-11 items-center justify-center rounded-lg border border-gold-500/35 bg-panel-strong px-3 text-center text-xs font-bold text-gold-300 underline-offset-2 hover:bg-gold-500/10 hover:underline"
        >
          Open official Uniswap ↗
        </a>
      )}
    </div>
  );
}
