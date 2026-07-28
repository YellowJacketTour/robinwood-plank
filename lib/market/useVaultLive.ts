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
  /** True only while the literal SSE connection is open right now. Not what
   * the UI should badge as "Live" — see `live` below. */
  connected: boolean;
  /** Data-freshness based, not connection-based: true whenever the data on
   * screen is recent, whether it arrived via the live stream, the REST
   * fallback, or a poll. A routine ~1.5s reconnect (the server proactively
   * recycles the stream every ~290s) used to flash "Reconnecting…" even
   * though the data was still perfectly current — a real, reported "why
   * does this look broken when nothing is actually wrong" bug. `live` only
   * goes false once nothing has actually arrived in a while. */
  live: boolean;
};

const FRESH_WINDOW_MS = 45_000;
let lastUpdateAt = 0;

const SNAPSHOT_KEY = "plank-vault-snapshot";
/** A snapshot older than this is more likely to mislead than help — past
 * this age just start from empty and wait for a real fetch, same as before
 * this cache existed. */
const SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

function makeState(stats: VaultStats | null, activity: VaultTradeEvent[], connected: boolean): VaultLiveState {
  return { stats, activity, connected, live: Date.now() - lastUpdateAt < FRESH_WINDOW_MS };
}

function loadSnapshot(): VaultLiveState {
  if (typeof window === "undefined") return makeState(null, [], false);
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return makeState(null, [], false);
    const parsed = JSON.parse(raw) as { stats: VaultStats; activity: VaultTradeEvent[]; at: number };
    if (Date.now() - parsed.at > SNAPSHOT_MAX_AGE_MS) return makeState(null, [], false);
    // A cached snapshot young enough to still count as "fresh" (well under
    // FRESH_WINDOW_MS) shows as live immediately, no flash of "connecting"
    // on a cold load when the data is genuinely still current.
    lastUpdateAt = parsed.at;
    return makeState(parsed.stats, parsed.activity, false);
  } catch {
    return makeState(null, [], false);
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
let consecutiveErrors = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Fixed 1.5s retries forever is exactly how a real outage turns into a
 * connection that never recovers and never falls back to anything —
 * confirmed as the reported "data feed failing connection live." Backs off
 * on repeated failures, and once it's failed enough in a row to look like a
 * real outage rather than the routine ~290s recycle, switches to plain
 * REST polling as the primary data source (SSE keeps retrying in the
 * background so it can take back over once healthy). */
const BASE_RECONNECT_MS = 1_500;
const MAX_RECONNECT_MS = 20_000;
const POLL_FALLBACK_AFTER_ERRORS = 4;
const POLL_INTERVAL_MS = 12_000;
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
        lastUpdateAt = Date.now();
        state = makeState(stats, activity, false);
        saveSnapshot(stats, activity);
        emit();
      }
    })
    .catch(() => {
      // stream connection is still the primary path — nothing to do here
    });
}

/** REST polling fallback — the same requests hydrateFromRest fires once,
 * repeated, for as long as the SSE connection is unhealthy. Runs alongside
 * connect()'s continuing reconnect attempts, not instead of them. */
function pollOnce() {
  Promise.all([
    fetch("/api/market/vault/stats").then((r) => (r.ok ? r.json() : null)),
    fetch("/api/market/vault/activity").then((r) => (r.ok ? r.json() : null)),
  ])
    .then(([stats, activityRes]) => {
      if (!stats || state.connected) return;
      const activity = activityRes?.events ?? state.activity;
      lastUpdateAt = Date.now();
      state = makeState(stats, activity, false);
      saveSnapshot(stats, activity);
      emit();
    })
    .catch(() => {
      // next poll tick tries again
    });
}

function startPollFallback() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPollFallback() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
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
      lastUpdateAt = Date.now();
      state = makeState(data.stats, data.activity, true);
      saveSnapshot(data.stats, data.activity);
      // A real tick landed — the connection is healthy again, so drop the
      // backoff and stand down the polling fallback (SSE is back in charge).
      consecutiveErrors = 0;
      stopPollFallback();
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
    // — connected flips false, but `live` stays true as long as that data
    // is still within FRESH_WINDOW_MS, so a routine reconnect doesn't flash
    // "Reconnecting" over data that's still perfectly current.
    state = makeState(state.stats, state.activity, false);
    emit();
    consecutiveErrors += 1;
    if (consecutiveErrors >= POLL_FALLBACK_AFTER_ERRORS) startPollFallback();
    if (refCount > 0 && !reconnectTimer) {
      // The connection cycles proactively every ~290s server-side (see
      // app/api/market/vault/stream/route.ts's MAX_STREAM_MS) — the FIRST
      // retry after that routine recycle should be fast so it reads as a
      // blip, not a visible "reconnecting" state. Repeated failures back
      // off instead of hammering an endpoint that's actually down.
      const delay = Math.min(BASE_RECONNECT_MS * 2 ** (consecutiveErrors - 1), MAX_RECONNECT_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (refCount > 0) connect();
      }, delay);
    }
  };
}

/** `live` is time-based, not event-based — without this, it would only
 * ever get re-evaluated when a new tick/poll/error happens to call
 * makeState(). If nothing happens for FRESH_WINDOW_MS (a genuinely dead
 * connection with no retries succeeding), nothing would ever flip `live`
 * back to false on its own. Ticks slowly since it only matters for the
 * boundary case, not routine updates. */
let freshnessTimer: ReturnType<typeof setInterval> | null = null;

function startFreshnessTimer() {
  if (freshnessTimer) return;
  freshnessTimer = setInterval(() => {
    const nowLive = Date.now() - lastUpdateAt < FRESH_WINDOW_MS;
    if (nowLive !== state.live) {
      state = { ...state, live: nowLive };
      emit();
    }
  }, 5_000);
}

function stopFreshnessTimer() {
  if (freshnessTimer) {
    clearInterval(freshnessTimer);
    freshnessTimer = null;
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopPollFallback();
  stopFreshnessTimer();
  consecutiveErrors = 0;
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
    startFreshnessTimer();
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
