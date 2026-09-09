"use client";

import { useEffect, useRef } from "react";
import { coalesceChanges, parseChange, type MarketChange, type MarketScope } from "@/lib/market/multichain/edge/change-protocol";

/** One scoped channel per mounted surface. Commit bursts coalesce; hidden
 * tabs disconnect and resnapshot on return. SSE covers hosts without upgrade. */
export function useMarketRealtime(scopes: MarketScope[], refresh: (change: MarketChange) => Promise<unknown> | void, debounceMs = 1_000) {
  const callback = useRef(refresh);
  useEffect(() => { callback.current = refresh; });
  const key = JSON.stringify(scopes);
  useEffect(() => {
    let socket: WebSocket | null = null;
    let events: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: MarketChange | null = null;
    let busy = false;
    let disposed = false;
    const drain = async () => {
      timer = undefined;
      if (busy || disposed || document.hidden || !pending) return;
      const change = pending;
      pending = null;
      busy = true;
      try { await callback.current(change); }
      catch { /* The surface retains its last good snapshot; recovery polling retries. */ }
      finally {
        busy = false;
        if (pending && !disposed) timer = setTimeout(() => void drain(), debounceMs);
      }
    };
    const receive = (raw: string) => {
      const change = parseChange(raw);
      if (!change) return;
      // Mixed families require a complete scoped refresh; nothing is dropped.
      pending = pending ? coalesceChanges(pending, change) : change;
      if (!timer && !busy) timer = setTimeout(() => void drain(), debounceMs);
    };
    const fallback = () => {
      if (disposed || document.hidden || events) return;
      clearTimeout(connectionTimer);
      if (socket) { socket.onclose = null; socket.close(); socket = null; }
      events = new EventSource(`/api/market/multichain/changes?scopes=${encodeURIComponent(key)}`);
      events.onmessage = (event) => receive(event.data);
    };
    const close = () => {
      clearTimeout(connectionTimer);
      clearTimeout(timer);
      timer = undefined;
      if (socket) { socket.onclose = null; socket.close(); socket = null; }
      events?.close(); events = null;
    };
    const connect = () => {
      if (disposed || document.hidden) return;
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/market/multichain/socket`);
      socket.onopen = () => { clearTimeout(connectionTimer); socket?.send(JSON.stringify({ scopes: JSON.parse(key) })); };
      socket.onmessage = (event) => receive(event.data);
      socket.onclose = fallback;
      connectionTimer = setTimeout(fallback, 4_000);
    };
    const visibility = () => { close(); if (!document.hidden) connect(); };
    document.addEventListener("visibilitychange", visibility);
    connect();
    return () => { disposed = true; close(); document.removeEventListener("visibilitychange", visibility); };
  }, [key, debounceMs]);
}
