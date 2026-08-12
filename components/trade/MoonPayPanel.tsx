"use client";

import { useEffect, useState } from "react";
import { CreditCard, ExternalLink, Landmark } from "lucide-react";
import { useWallet } from "@/lib/wallet-context";

type MoonPayStatus = { enabled: boolean; configured: boolean; sandbox: boolean };
type RampDirection = "buy" | "sell";

/**
 * Fiat on-ramp/off-ramp entry point, real signed-URL flow (lib/moonpay-
 * server.ts / app/api/moonpay/*). Delivers real USDG directly onto
 * Robinhood Chain -- MoonPay's own confirmed integration, not a guessed
 * pair -- into the SAME connected wallet SwapWidget already trades from
 * (lib/wallet-context.tsx), so "buy with card" and "swap to $PLANK" are two
 * clicks in the same session, not two disconnected products.
 *
 * Same wallet-gate pattern as SwapWidget: explains what connecting unlocks
 * before asking (DESIGN.md, "Wallet gates explain what connection unlocks
 * before asking the user to connect"), and never accepts a destination
 * address other than the caller's own connected wallet.
 */
export default function MoonPayPanel() {
  const { address: account, connect: walletConnect } = useWallet();
  const [status, setStatus] = useState<MoonPayStatus | null>(null);
  const [direction, setDirection] = useState<RampDirection>("buy");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/moonpay/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MoonPayStatus | null) => {
        if (!cancelled) setStatus(d);
      })
      .catch(() => {
        /* panel just stays hidden -- rest of /trade still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Same "clean no-op when off" contract as TradeModeSwitch's cross-chain
  // tab: render nothing at all rather than a dead/disabled card, so an
  // unconfigured server never shows a broken-looking button in production.
  if (!status?.enabled || !status?.configured) return null;

  async function handleOpen() {
    if (!account) {
      await walletConnect();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const endpoint = direction === "buy" ? "/api/moonpay/widget-url" : "/api/moonpay/sell-widget-url";
      const body =
        direction === "buy" ? { walletAddress: account } : { refundWalletAddress: account };
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || data.error || `status ${resp.status}`);
      window.open(data.url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open MoonPay.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-line bg-panel p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.7rem] font-black uppercase tracking-[0.08em] text-cream">
          Fiat {direction === "buy" ? "on-ramp" : "off-ramp"}
        </p>
        {status.sandbox && (
          <span className="rounded-full border border-gold-500/35 bg-gold-500/10 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-gold-300">
            Sandbox
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-lg border border-gold-500/20 bg-wood-900/90 p-1">
        {(
          [
            { id: "buy" as const, label: "Buy with card", icon: CreditCard },
            { id: "sell" as const, label: "Cash out", icon: Landmark },
          ]
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setDirection(tab.id)}
            aria-pressed={direction === tab.id}
            className={`flex min-h-10 items-center justify-center gap-1.5 rounded-md text-xs font-bold uppercase tracking-wide transition-colors sm:text-sm ${
              direction === tab.id ? "bg-gold-500 text-on-gold" : "text-cream-muted hover:text-gold-300"
            }`}
          >
            <tab.icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {tab.label}
          </button>
        ))}
      </div>

      <p className="text-[0.72rem] leading-snug text-cream-muted">
        {direction === "buy"
          ? "Real card, Apple Pay, Google Pay, or bank transfer via MoonPay — delivers USDG directly to your wallet on Robinhood Chain, no bridge. Convert USDG to $PLANK afterward using Swap above (import USDG by address)."
          : "Send USDG from your wallet through MoonPay's real off-ramp and receive fiat in your bank or card. Swap $PLANK to USDG first if you're holding $PLANK."}
      </p>

      {!account ? (
        <p className="rounded-lg border border-line bg-panel-strong px-3 py-2 text-[0.72rem] text-cream-muted">
          Connect your wallet to continue — MoonPay delivers to (or refunds from) that exact address, never anywhere else.
        </p>
      ) : null}

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-[0.72rem] text-red-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleOpen}
        disabled={loading}
        className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-gold-500 px-3 text-xs font-bold uppercase tracking-wide text-on-gold transition-colors hover:bg-gold-400 disabled:opacity-60"
      >
        {loading ? (
          "Opening…"
        ) : !account ? (
          "Connect wallet"
        ) : (
          <>
            {direction === "buy" ? "Open MoonPay checkout" : "Open MoonPay cash-out"}
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </>
        )}
      </button>
    </div>
  );
}
