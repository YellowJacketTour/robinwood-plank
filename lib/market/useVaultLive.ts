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

function emit() {
  listeners.forEach((l) => l(state));
}

function connect() {
  if (source || typeof window === "undefined") return;
  const es = new EventSource("/api/market/vault/stream");
  source = es;

  es.addEventListener("vault", (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { stats: VaultStats; activity: VaultTradeEvent[] };
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
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (refCount > 0) connect();
      }, 4_000);
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
