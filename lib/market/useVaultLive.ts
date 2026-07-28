"use client";

import { useEffect, useState } from "react";
import { clearPendingVaultTx } from "@/lib/market/pendingVaultTx";

export type VaultTradeKind = "buy" | "sell" | "deposit" | "redeem";

export type VaultTradeEvent = {
  kind: VaultTradeKind;
  address: string;
  ethWei: string | null;
  sharesWei: string | null;
  tokenId: string | null;
  txHash: string;
  timestamp: string | null;
};

export type VaultStats = {
  poolOpen: boolean;
  ethReserveWei: string;
  shareReserveWei: string;
  heldTokenCount: number;
  heldTokenIds: string[];
  sharePriceWei: string | null;
  mintFeeBps: number;
  redeemFeeBps: number;
  targetPremiumBps: number;
  ethUsd: number | null;
  aprPct: number | null;
  aprBasisHours: number | null;
  depositCount: number;
  redeemCount: number;
  vaultFeeRevenueWei: string;
  marketplaceFeeRevenueEstWei: string;
};

type VaultLiveState = {
  stats: VaultStats | null;
  activity: VaultTradeEvent[];
  connected: boolean;
};

let state: VaultLiveState = { stats: null, activity: [], connected: false };
const listeners = new Set<(s: VaultLiveState) => void>();
let source: EventSource | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** The server ticks every 4s but only actually refreshes chain data every
 * 10s (see app/api/market/vault/stream/route.ts), so most ticks resend the
 * identical payload — comparing the raw text before parsing/emitting skips
 * those, which otherwise re-rendered every subscribed swap-tab component
 * (VaultDashboard, VaultTradeHistory, LivingLiquidityViz) 2-3x more often
 * than the underlying data actually changed. */
let lastRaw: string | null = null;

function emit() {
  listeners.forEach((l) => l(state));
}

function connect() {
  if (source || typeof window === "undefined") return;
  const es = new EventSource("/api/market/vault/stream");
  source = es;

  es.addEventListener("vault", (ev) => {
    const raw = (ev as MessageEvent).data as string;
    if (raw === lastRaw && state.connected) return;
    lastRaw = raw;
    try {
      const data = JSON.parse(raw) as { stats: VaultStats; activity: VaultTradeEvent[] };
      state = { stats: data.stats, activity: data.activity, connected: true };
      // A trade this tab just submitted (see lib/market/pendingVaultTx.ts)
      // graduates out of "pending" the moment it shows up as a real event.
      for (const e of data.activity) clearPendingVaultTx(e.txHash);
      emit();
    } catch {
      // malformed tick — skip it, the next one will self-correct
    }
  });

  es.onerror = () => {
    es.close();
    if (source === es) source = null;
    state = { ...state, connected: false };
    emit();
    if (refCount > 0 && !reconnectTimer) {
      // The connection cycles proactively every ~290s server-side (see
      // app/api/market/vault/stream/route.ts's MAX_STREAM_MS) — that's the
      // routine case, not a network failure, so reconnect fast enough that
      // it reads as a brief blip rather than a visible "reconnecting" state.
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (refCount > 0) connect();
      }, 1_500);
    }
  };
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  source?.close();
  source = null;
}

/**
 * One shared EventSource per tab (refcounted across every consumer —
 * VaultDashboard, VaultTradeHistory, LivingLiquidityViz, the Activity tab's
 * vault section) reading /api/market/vault/stream, so opening more of these
 * components doesn't open more connections. Falls back to a fresh connect
 * attempt on error rather than silently going stale.
 */
export function useVaultLive(): VaultLiveState {
  const [local, setLocal] = useState(state);

  useEffect(() => {
    refCount += 1;
    connect();
    listeners.add(setLocal);
    setLocal(state);
    return () => {
      listeners.delete(setLocal);
      refCount -= 1;
      if (refCount <= 0) {
        refCount = 0;
        disconnect();
      }
    };
  }, []);

  return local;
}
