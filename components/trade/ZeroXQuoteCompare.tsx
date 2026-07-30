"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Info, Zap } from "lucide-react";
import { formatDisplayAmount } from "@/lib/trade";

type Direction = "buy" | "sell";

type ZeroXFeeLine = { amount: string; token: string; type: string } | null;

type ZeroXQuoteBody = {
  provider: "0x";
  liquidityAvailable: boolean;
  buyAmount: string;
  minBuyAmount?: string;
  fees: { integratorFee: ZeroXFeeLine; zeroExFee: ZeroXFeeLine };
  siteFee: { enabled: boolean; label: string };
  zeroExFeeDisclosure?: string;
};

type ErrorBody = { error: string; message: string };

/**
 * Self-contained "price competition" card: quotes 0x in parallel with the
 * caller's already-fetched Uniswap amountOut and shows whichever nets the
 * buyer more of the OUTPUT token — apples-to-apples because both amounts
 * are compared post-fee, for the SAME input amount and slippage.
 *
 * Never shows a misleading "best price" badge: if either side's amount is
 * missing/stale or the two quotes aren't for the same input, it shows both
 * numbers plainly instead of picking a winner.
 *
 * Drop-in: renders nothing when /api/zerox/status reports the feature off
 * or unconfigured, so it's safe to mount unconditionally next to the main
 * swap widget/quote panel.
 */
export default function ZeroXQuoteCompare({
  direction,
  amount,
  swapper,
  counterToken,
  slippageTolerance,
  outputDecimals,
  uniswapAmountOut,
}: {
  direction: Direction;
  /** Base-units decimal string — same EXACT_INPUT amount already sent to Uniswap. */
  amount: string;
  swapper?: string;
  counterToken?: string;
  slippageTolerance?: number;
  /** Decimals of the OUTPUT token, for display formatting. */
  outputDecimals: number;
  /** Uniswap's amountOut for the SAME request, base-units decimal string.
   * Omit to show the 0x quote standalone without a comparison badge. */
  uniswapAmountOut?: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const [checkedStatus, setCheckedStatus] = useState(false);
  const [quote, setQuote] = useState<ZeroXQuoteBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/zerox/status")
      .then((r) => r.json())
      .then((d: { enabled?: boolean; configured?: boolean }) => {
        if (!cancelled) setEnabled(Boolean(d.enabled && d.configured));
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      })
      .finally(() => {
        if (!cancelled) setCheckedStatus(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!enabled || !amount || amount === "0") {
        if (!cancelled) {
          setQuote(null);
          setError(null);
        }
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const r = await fetch("/api/zerox/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ direction, amount, swapper, counterToken, slippageTolerance }),
        });
        const body = (await r.json().catch(() => ({}))) as ZeroXQuoteBody | ErrorBody;
        if (cancelled) return;
        if (!r.ok || "error" in body) {
          setError((body as ErrorBody).message || "0x quote unavailable.");
          setQuote(null);
          return;
        }
        setQuote(body as ZeroXQuoteBody);
      } catch {
        if (!cancelled) setError("Could not reach 0x quoting.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [enabled, direction, amount, swapper, counterToken, slippageTolerance]);

  const comparison = useMemo(() => {
    if (!quote?.liquidityAvailable || !uniswapAmountOut) return null;
    try {
      const zx = BigInt(quote.buyAmount || "0");
      const uni = BigInt(uniswapAmountOut || "0");
      if (zx <= BigInt(0) || uni <= BigInt(0)) return null;
      return zx > uni ? "0x" : zx < uni ? "uniswap" : "tie";
    } catch {
      return null;
    }
  }, [quote, uniswapAmountOut]);

  if (!checkedStatus || !enabled) return null;
  if (loading && !quote) {
    return (
      <div className="rounded-lg border border-gold-500/20 bg-wood-950/40 px-2.5 py-2 text-[0.7rem] text-foreground/50">
        Checking 0x price…
      </div>
    );
  }
  if (error && !quote) {
    return (
      <div className="rounded-lg border border-gold-500/20 bg-wood-950/40 px-2.5 py-2 text-[0.7rem] text-foreground/50">
        0x: {error}
      </div>
    );
  }
  if (!quote?.liquidityAvailable) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-gold-500/20 bg-wood-950/40 px-2.5 py-2 text-[0.7rem] sm:text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-bold uppercase tracking-wide text-foreground/70">
          <Zap size={13} className="shrink-0 text-gold-400" />
          0x quote
        </span>
        {comparison === "0x" && (
          <span className="rounded-full bg-forest-500/20 px-2 py-0.5 text-[0.65rem] font-bold text-forest-300">
            Better on 0x
          </span>
        )}
        {comparison === "uniswap" && (
          <span className="rounded-full bg-wood-800 px-2 py-0.5 text-[0.65rem] font-bold text-foreground/60">
            Uniswap wins
          </span>
        )}
        {comparison === "tie" && (
          <span className="rounded-full bg-wood-800 px-2 py-0.5 text-[0.65rem] font-bold text-foreground/60">
            Same price
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 text-foreground/80">
        <ArrowRight size={12} className="shrink-0 text-gold-400" />
        <span>{formatDisplayAmount(quote.buyAmount, outputDecimals)}</span>
        {quote.siteFee?.enabled && (
          <span className="text-foreground/40">· {quote.siteFee.label} plank.love fee</span>
        )}
      </div>
      {quote.zeroExFeeDisclosure && (
        <div className="flex items-start gap-1 text-[0.65rem] text-gold-300/80">
          <Info size={11} className="mt-0.5 shrink-0" />
          <span>{quote.zeroExFeeDisclosure}</span>
        </div>
      )}
      {!uniswapAmountOut && (
        <div className="text-[0.65rem] text-foreground/40">
          No Uniswap amount supplied — showing 0x standalone, not a comparison.
        </div>
      )}
    </div>
  );
}
