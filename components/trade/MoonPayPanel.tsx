"use client";

import { useEffect, useState } from "react";
import { CreditCard, ExternalLink, Landmark } from "lucide-react";
import { useWallet } from "@/lib/wallet-context";
import { getErc20Balance } from "@/lib/wallet";
import { USDG_TOKEN } from "@/lib/constants";

type MoonPayStatus = { enabled: boolean; configured: boolean; sandbox: boolean };
type RampDirection = "buy" | "sell";

type MoonPayOrder = {
  orderId: string;
  direction: string;
  status: string;
  baseCurrencyCode: string | null;
  baseCurrencyAmount: number | null;
  lastEventAt: string;
};

/**
 * MoonPay's transaction statuses, mapped to the only three things a buyer
 * needs to know: it worked, it is still going, or it did not. Anything
 * unrecognised is shown as in-progress rather than hidden -- an order we
 * cannot classify is exactly the one someone needs to see.
 */
type OrderTone = "done" | "pending" | "failed";

const ORDER_TONE: Record<OrderTone, string> = {
  done: "border-emerald-500/30 bg-emerald-950/20 text-emerald-300",
  pending: "border-gold-500/30 bg-gold-500/10 text-gold-300",
  failed: "border-red-500/30 bg-red-950/20 text-red-300",
};

function orderTone(status: string): OrderTone {
  const s = status.toLowerCase();
  if (s === "completed") return "done";
  if (s === "failed" || s === "cancelled" || s === "canceled") return "failed";
  return "pending";
}

function describeOrder(order: MoonPayOrder): string {
  const amount =
    order.baseCurrencyAmount !== null && order.baseCurrencyCode
      ? ` (${order.baseCurrencyAmount} ${order.baseCurrencyCode.toUpperCase()})`
      : "";
  const verb = order.direction === "sell" ? "Cash-out" : "Purchase";
  switch (orderTone(order.status)) {
    case "done":
      return `${verb} completed${amount}. Funds have been delivered.`;
    case "failed":
      return `${verb}${amount} did not go through (${order.status}). Nothing was delivered — contact MoonPay support if you were charged.`;
    default:
      return `${verb}${amount} in progress (${order.status}). MoonPay is still working on it; this updates automatically.`;
  }
}

// One definition, in lib/constants.ts, shared with the swap selector's core
// counter tokens (USDG is a routing hop in live quotes, so it is already in
// the token list the buyer returns to). Decimals are 6, NOT the 18 most
// ERC-20s use -- which is why formatUsdg exists rather than a default
// 18-decimal formatter.
const { address: USDG_ADDRESS, decimals: USDG_DECIMALS } = USDG_TOKEN;

function formatUsdg(raw: bigint): string {
  const divisor = BigInt(10) ** BigInt(USDG_DECIMALS);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === BigInt(0)) return whole.toString();
  const fracStr = frac.toString().padStart(USDG_DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

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
 * before asking the user to connect"). The destination is always the
 * address this panel currently has connected -- see lib/moonpay-server.ts
 * for why the SERVER deliberately does not try to enforce that, and why it
 * does not need to.
 *
 * Off-ramp automation: once connected, this reads the real USDG balance
 * (lib/wallet.ts's own getErc20Balance -- the same helper SwapWidget uses
 * for post-swap delivery checks) and pre-fills the cash-out amount with it,
 * so the MoonPay widget opens ready to sell the full real balance instead
 * of asking the visitor to look up and type their own balance. If there's
 * nothing to sell, the cash-out button is disabled with an honest reason
 * instead of opening a checkout with nothing in it.
 */
export default function MoonPayPanel() {
  const { address: account, connect: walletConnect } = useWallet();
  const [status, setStatus] = useState<MoonPayStatus | null>(null);
  const [direction, setDirection] = useState<RampDirection>("buy");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usdgBalance, setUsdgBalance] = useState<bigint | null>(null);
  const [latestOrder, setLatestOrder] = useState<MoonPayOrder | null>(null);

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

  useEffect(() => {
    if (!account) {
      // Resetting to "unknown" on disconnect/account-switch is
      // synchronizing with the external wallet, not derived render state --
      // same justification as the reset pattern in lib/wallet-context.tsx.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUsdgBalance(null);
      return;
    }
    let cancelled = false;
    getErc20Balance(USDG_ADDRESS, account).then((bal) => {
      if (!cancelled) setUsdgBalance(bal);
    });
    return () => {
      cancelled = true;
    };
  }, [account]);

  // Order status for the connected wallet, from the webhook-fed store
  // (app/api/moonpay/orders). Polled rather than pushed: a buyer completes
  // the checkout in ANOTHER tab or on their phone, so there is no event in
  // this tab to react to, and the settle time is minutes. Polling stops as
  // soon as the newest order reaches a terminal state, so an idle panel is
  // not a permanent timer.
  useEffect(() => {
    if (!account) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLatestOrder(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const resp = await fetch(`/api/moonpay/orders?wallet=${account}`);
        const data = await resp.json();
        if (cancelled) return;
        const newest: MoonPayOrder | undefined = data?.orders?.[0];
        setLatestOrder(newest ?? null);
        if (newest && orderTone(newest.status) !== "pending") return;
      } catch {
        /* a failed status read must never break the ramp itself */
        if (cancelled) return;
      }
      timer = setTimeout(poll, 15_000);
    };
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [account]);

  // Same "clean no-op when off" contract as TradeModeSwitch's cross-chain
  // tab: render nothing at all rather than a dead/disabled card, so an
  // unconfigured server never shows a broken-looking button in production.
  if (!status?.enabled || !status?.configured) return null;

  const hasUsdgToSell = usdgBalance !== null && usdgBalance > BigInt(0);
  const sellBlocked = direction === "sell" && account !== null && usdgBalance !== null && !hasUsdgToSell;

  async function handleOpen() {
    setLoading(true);
    setError(null);
    try {
      // One click end to end: if there's no wallet yet, connect() first and
      // use the address it resolves to directly, rather than stopping and
      // making the visitor click a second time once `account` re-renders.
      // connect() throws if the visitor closes the modal or rejects the
      // request (lib/wallet-context.tsx) -- that propagates to the catch
      // below and shows a real error, not a silent no-op.
      const walletAddress = account ?? (await walletConnect());

      if (direction === "sell") {
        const resp = await fetch("/api/moonpay/sell-widget-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refundWalletAddress: walletAddress,
            // Pre-fill with the real, just-read balance -- skips the visitor
            // having to look up and type their own USDG amount. Only sent
            // when we actually have a fresh balance for THIS wallet (never
            // carries over a stale read from a previously-connected one).
            ...(walletAddress === account && usdgBalance && usdgBalance > BigInt(0)
              ? { baseCurrencyAmount: formatUsdg(usdgBalance) }
              : {}),
          }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.message || data.error || `status ${resp.status}`);
        window.open(data.url, "_blank", "noopener");
        return;
      }

      const resp = await fetch("/api/moonpay/widget-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
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
          ? "Real card, Apple Pay, Google Pay, or bank transfer via MoonPay — delivers USDG directly to your wallet on Robinhood Chain, no bridge. Convert USDG to $PLANK afterward using Swap above — USDG is already in the token list."
          : "Send USDG from your wallet through MoonPay's real off-ramp and receive fiat in your bank or card."}
      </p>

      {latestOrder && (
        <p
          className={`rounded-lg border px-3 py-2 text-[0.72rem] ${
            ORDER_TONE[orderTone(latestOrder.status)]
          }`}
        >
          {describeOrder(latestOrder)}
        </p>
      )}

      {!account ? (
        <p className="rounded-lg border border-line bg-panel-strong px-3 py-2 text-[0.72rem] text-cream-muted">
          One click connects your wallet and opens MoonPay — it always delivers to (or refunds from) that exact address, never anywhere else.
        </p>
      ) : direction === "sell" ? (
        <p className="rounded-lg border border-line bg-panel-strong px-3 py-2 text-[0.72rem] text-cream-muted">
          {usdgBalance === null
            ? "Checking your real USDG balance…"
            : hasUsdgToSell
              ? `${formatUsdg(usdgBalance)} USDG ready to cash out — pre-filled automatically, editable in the MoonPay checkout.`
              : "You don't hold any USDG yet. Swap $PLANK to USDG above, or buy USDG with a card on the other tab, then come back here."}
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
        disabled={loading || sellBlocked}
        className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-gold-500 px-3 text-xs font-bold uppercase tracking-wide text-on-gold transition-colors hover:bg-gold-400 disabled:opacity-60"
      >
        {loading ? (
          account ? "Opening…" : "Connecting…"
        ) : sellBlocked ? (
          "Nothing to cash out yet"
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
