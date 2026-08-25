"use client";

import { useEffect, useRef, useState } from "react";
import { useEthUsd } from "@/components/market/EthUsdValue";

/**
 * Real, genuinely instant-tick ETH/USD price via Coinbase's public WebSocket
 * ticker feed (wss://ws-feed.exchange.coinbase.com, ETH-USD product) -- a
 * real, free, no-key, publicly documented market-data feed, not this app's
 * own invented approximation. There is no equivalent exchange order-book
 * feed for $PLANK (it is a brand-new token on a custom chain with no
 * centralized listing -- see useLivePlankUsd.ts's own header for the honest
 * reason that price instead polls this app's own AMM-pool read), so ETH/USD
 * is the one price on this dashboard that is real-time in the fullest
 * sense: pushed, not polled.
 *
 * Falls back to the existing polled useEthUsd() (12s TTL) whenever the
 * socket is closed/reconnecting/blocked (e.g. an extension or network
 * policy that blocks third-party WebSockets) -- the dashboard must never go
 * blank just because the live feed had a hiccup.
 */
export function useLiveEthUsd(): { price: number; live: boolean } {
  const polled = useEthUsd();
  const [live, setLive] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let retryDelayMs = 2_000;

    function connect() {
      if (cancelled) return;
      try {
        ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
      } catch {
        scheduleRetry();
        return;
      }
      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        retryDelayMs = 2_000;
        ws?.send(JSON.stringify({ type: "subscribe", product_ids: ["ETH-USD"], channels: ["ticker"] }));
      };
      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(event.data as string) as { type?: string; price?: string };
          if (msg.type === "ticker" && msg.price) {
            const parsed = Number(msg.price);
            if (Number.isFinite(parsed) && parsed > 0) setLive(parsed);
          }
        } catch {
          // Malformed frame -- ignore, keep the last good value.
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        scheduleRetry();
      };
      ws.onerror = () => {
        ws?.close();
      };
    }

    function scheduleRetry() {
      if (cancelled) return;
      retryRef.current = window.setTimeout(() => {
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        connect();
      }, retryDelayMs);
    }

    connect();
    return () => {
      cancelled = true;
      if (retryRef.current != null) window.clearTimeout(retryRef.current);
      ws?.close();
    };
  }, []);

  const price = live ?? polled;
  return { price, live: connected && live != null };
}
