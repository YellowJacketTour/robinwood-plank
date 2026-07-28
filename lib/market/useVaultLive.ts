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

const SNAPSHOT_KEY = "plank-vault-snapshot";
/** A snapshot older than this is more likely to mislead than help — past
 * this age just start from empty and wait for a real fetch, same as before
 * this cache existed. */
const SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

function loadSnapshot(): VaultLiveState {
  if (typeof window === "undefined") return { stats: null, activity: [], connected: false };
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return { stats: null, activity: [], connected: false };
    const parsed = JSON.parse(raw) as { stats: VaultStats; activity: VaultTradeEvent[]; at: number };
    if (Date.now() - parsed.at > SNAPSHOT_MAX_AGE_MS) return { stats: null, activity: [], connected: false };
    // connected: false is deliberate — this is last-known data from a prior
    // visit or a page refresh, not a live read, and the UI should say so
    // (a "Reconnecting…"/"Live" badge) rather than imply it's current.
    return { stats: parsed.stats, activity: parsed.activity, connected: false };
  } catch {
    return { stats: null, activity: [], connected: false };
  }
}

function saveSnapshot(stats: VaultStats | null, activity: VaultTradeEvent[]) {
  if (typeof window === "undefined" || !stats) return;
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ stats, activity, at: Date.now() }));
  } catch {
    // storage full/unavailable — the live stream still works, it just
    // won't have an instant-hydrate snapshot for the next visit
  }
}

/**
 * Seeded from the last snapshot this browser saw (see loadSnapshot), so a
 * hard refresh or a fresh server instance shows last-known data instantly
 * instead of every panel rebuilding from a blank "loading…" state — the
 * reported "refreshing Instant Swap builds the whole page from scratch"
 * and "server reboots don't carry any cache" complaints. The server-side
 * caches (app/api/market/vault/stream's module cache) don't survive a
 * Vercel serverless cold start reliably; this client-side one survives
 * everything except the browser's own storage being cleared.
 */
let state: VaultLiveState = loadSnapshot();
const listeners = new Set<(s: VaultLiveState) => void>();
let source: EventSource | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let restHydrated = false;
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

/**
 * One-time REST fallback, fired alongside the SSE connection attempt (not
 * instead of it) — the stream and the plain GET routes hit the same
 * underlying data but have separate server-side caches, so whichever
 * happens to be warm answers first. Only applied if nothing newer has
 * landed by the time it resolves (the SSE tick and this race freely; last
 * writer checks `restHydrated` so this never clobbers a live tick that
 * already arrived).
 */
function hydrateFromRest() {
  if (restHydrated || typeof window === "undefined") return;
  restHydrated = true;
  Promise.all([
    fetch("/api/market/vault/stats").then((r) => (r.ok ? r.json() : null)),
    fetch("/api/market/vault/activity").then((r) => (r.ok ? r.json() : null)),
  ])
    .then(([stats, activityRes]) => {
      if (state.connected) return; // a live SSE tick already beat us to it
      const activity = activityRes?.events ?? state.activity;
      if (stats) {
        state = { stats, activity, connected: false };
        saveSnapshot(stats, activity);
        emit();
      }
    })
    .catch(() => {
      // stream connection is still the primary path — nothing to do here
    });
}

function connect() {
  hydrateFromRest();
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
      saveSnapshot(data.stats, data.activity);
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
    // Keep whatever data is already showing (live or last-known-snapshot)
    // — only the connection badge flips, never the content itself.
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
