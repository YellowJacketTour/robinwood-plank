"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { CHAIN } from "@/lib/constants";

/** Mirrors the enum Uniswap's /orders endpoint returns. */
type UniswapXOrderStatus =
  | "open"
  | "Open"
  | "Expired"
  | "Error"
  | "Cancelled"
  | "Filled"
  | "Insufficient-funds"
  | "Unverified";

const TERMINAL: ReadonlySet<string> = new Set([
  "Filled",
  "Expired",
  "Error",
  "Cancelled",
  "Insufficient-funds",
]);

/**
 * Gasless (UniswapX) orders settle asynchronously — a filler broadcasts the
 * actual fill transaction, not the user's wallet. Without this, submitting an
 * order looks exactly like a swap that silently did nothing. This polls
 * GET /api/uniswap/order until the order reaches a terminal state, so the
 * "no gas" experience never gets mistaken for a broken instant swap.
 */
export default function OrderStatus({
  orderHash,
  swapper,
  onFilled,
  onTerminal,
}: {
  orderHash: string;
  swapper?: string;
  onFilled?: (txHash: string | null) => void;
  onTerminal?: (status: string) => void;
}) {
  const [status, setStatus] = useState<UniswapXOrderStatus | string>("open");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const onFilledRef = useRef(onFilled);
  const onTerminalRef = useRef(onTerminal);
  useEffect(() => {
    onFilledRef.current = onFilled;
    onTerminalRef.current = onTerminal;
  }, [onFilled, onTerminal]);

  useEffect(() => {
    let cancelled = false;
    const start = Date.now();
    const poll = async () => {
      try {
        const qs = new URLSearchParams({ orderHash, ...(swapper ? { swapper } : {}) });
        const res = await fetch(`/api/uniswap/order?${qs.toString()}`);
        const data = (await res.json()) as { orderStatus?: string; txHash?: string | null };
        if (cancelled) return;
        if (data.orderStatus) setStatus(data.orderStatus);
        if (data.txHash) setTxHash(data.txHash);
        if (data.orderStatus && TERMINAL.has(data.orderStatus)) {
          if (data.orderStatus === "Filled") onFilledRef.current?.(data.txHash ?? null);
          onTerminalRef.current?.(data.orderStatus);
          return; // stop polling
        }
      } catch {
        /* transient — keep polling until timeout below */
      }
      if (!cancelled && Date.now() - start < 5 * 60_000) {
        setElapsedMs(Date.now() - start);
        setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [orderHash, swapper]);

  const label =
    status === "Filled"
      ? "Filled — no gas paid"
      : status === "Expired"
        ? "Order expired (price moved out of range) — no funds moved, get a fresh quote."
        : status === "Cancelled"
          ? "Order cancelled."
          : status === "Error" || status === "Insufficient-funds"
            ? "Order could not be filled — get a fresh quote."
            : `Waiting for a filler${elapsedMs > 15_000 ? " — still auctioning…" : "…"}`;

  const Icon =
    status === "Filled" ? CheckCircle2 : status === "Expired" || status === "Error" || status === "Cancelled" || status === "Insufficient-funds" ? XCircle : Clock;

  const colorClass =
    status === "Filled"
      ? "text-forest-400 border-forest-500/40 bg-forest-900/30"
      : status === "Expired" || status === "Error" || status === "Cancelled" || status === "Insufficient-funds"
        ? "text-red-300 border-red-500/30 bg-red-950/20"
        : "text-gold-300 border-gold-500/30 bg-wood-950/40";

  return (
    <div className={`flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-[0.7rem] sm:text-xs ${colorClass}`}>
      <span className="flex items-center gap-1.5 font-semibold">
        <Icon size={13} className={status === "open" || status === "Open" ? "animate-pulse" : ""} />
        {label}
      </span>
      {txHash && (
        <a
          href={`${CHAIN.blockExplorers.default.url}/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all underline underline-offset-2"
        >
          {txHash.slice(0, 10)}…{txHash.slice(-6)}
        </a>
      )}
    </div>
  );
}
