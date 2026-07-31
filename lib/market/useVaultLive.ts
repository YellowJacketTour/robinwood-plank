"use client";

import { useEffect, useState } from "react";
import { clearPendingVaultTx } from "@/lib/market/pendingVaultTx";
import { MARKET_VAULT_ADDRESS } from "@/lib/constants";

export type VaultTradeKind =
  | "buy"
  | "sell"
  | "deposit"
  | "redeem"
  | "add_lp"
  | "remove_lp";

export type VaultTradeEvent = {
  kind: VaultTradeKind;
  address: string;
  ethWei: string | null;
  sharesWei: string | null;
  tokenId: string | null;
  txHash: string;
  timestamp: string | null;
  /** Present on server payloads — used for stable client-side dedupe. */
  logIndex?: number;
  blockNumber?: number;
  /** Primary or legacy vault that emitted this row. */
  vaultAddress?: string;
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

const FRESH_WINDOW_MS = 90_000;
let lastUpdateAt = 0;

// Include vault address so a primary switch (V1→V2) does not hydrate stale poolOpen.
const SNAPSHOT_KEY = `plank-vault-snapshot:${(MARKET_VAULT_ADDRESS ?? "none").toLowerCase()}`;
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
/** Start REST trade polling almost immediately — SSE is flaky on CF under RPC pressure. */
const POLL_FALLBACK_AFTER_ERRORS = 1;
/** Must stay above the activity route's cache TTL (20s). At 10s roughly half
 * the polls missed the cache and forced a fresh chain read, so every open tab
 * was paying for a rebuild the SSE stream had already done. */
const POLL_INTERVAL_MS = 30_000;
/** The server ticks every 8s but only actually refreshes chain data every
 * 60s (see app/api/market/vault/stream/route.ts), so most ticks resend the
 * identical payload — comparing the raw text before parsing/emitting skips
 * those, which otherwise re-rendered every subscribed swap-tab component
 * (VaultDashboard, VaultTradeHistory, LivingLiquidityViz) 2-3x more often
 * than the underlying data actually changed. */
let lastRaw: string | null = null;

function emit() {
  listeners.forEach((l) => l(state));
}

/** Never shrink the trade ticker to a partial payload (SSE/REST races were
 * leaving Instant Swap on a single row while the activity API still had 40+). */
function mergeActivity(
  incoming: VaultTradeEvent[] | null | undefined,
  current: VaultTradeEvent[]
): VaultTradeEvent[] {
  if (!incoming?.length) return current;
  if (!current.length) return incoming;
  const map = new Map<string, VaultTradeEvent>();
  for (const e of [...incoming, ...current]) {
    // Prefer logIndex when present so REST (timestamped) and SSE (null ts)
    // of the same log don't double-count. Fall back without timestamp.
    const key = `${e.txHash}|${e.logIndex ?? ""}|${e.kind}|${e.tokenId ?? ""}`;
    const prev = map.get(key);
    // Prefer row with a real timestamp when merging duplicates.
    if (!prev || (!prev.timestamp && e.timestamp)) map.set(key, e);
  }
  return Array.from(map.values())
    .sort((a, b) => {
      const ba = a.blockNumber ?? 0;
      const bb = b.blockNumber ?? 0;
      if (ba !== bb) return bb - ba;
      return (b.logIndex ?? 0) - (a.logIndex ?? 0);
    })
    .slice(0, 100);
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
  // Always pull REST activity once — SSE was wiping trades when it
  // reconnected with empty activity arrays.
  // Prefer shared SWR so Instant Swap panels + this poller de-dupe.
  void Promise.all([
    import("@/lib/market/swr-fetch").then(({ swrJson }) =>
      swrJson<VaultStats | null>("/api/market/vault/stats", {
        ttlMs: 8_000,
        swrMs: 60_000,
        session: true,
      }).catch(() => null)
    ),
    import("@/lib/market/swr-fetch").then(({ swrJson }) =>
      swrJson<{ events?: VaultTradeEvent[] }>("/api/market/vault/activity", {
        ttlMs: 10_000,
        swrMs: 90_000,
        session: true,
      }).catch(() => null)
    ),
  ]).then(([stats, activityRes]) => {
    const restActivity: VaultTradeEvent[] = activityRes?.events ?? [];
    const activity = mergeActivity(restActivity, state.activity);
    const nextStats = (stats && "poolOpen" in (stats as object) ? stats : null) || state.stats;
    if (!nextStats && activity.length === 0) return;
    lastUpdateAt = Date.now();
    state = makeState(nextStats as VaultStats | null, activity, state.connected);
    saveSnapshot(nextStats as VaultStats | null, activity);
    emit();
  });
}

/** REST polling fallback — the same requests hydrateFromRest fires once,
 * repeated, for as long as the SSE connection is unhealthy. Runs alongside
 * connect()'s continuing reconnect attempts, not instead of them. */
function pollOnce() {
  void Promise.all([
    import("@/lib/market/swr-fetch").then(({ swrJson }) =>
      swrJson<VaultStats | null>("/api/market/vault/stats", {
        ttlMs: 8_000,
        swrMs: 60_000,
        session: true,
      }).catch(() => null)
    ),
    import("@/lib/market/swr-fetch").then(({ swrJson }) =>
      swrJson<{ events?: VaultTradeEvent[] }>("/api/market/vault/activity", {
        ttlMs: 10_000,
        swrMs: 90_000,
        session: true,
      }).catch(() => null)
    ),
  ]).then(([stats, activityRes]) => {
    const restActivity: VaultTradeEvent[] = activityRes?.events ?? [];
    const activity = mergeActivity(restActivity, state.activity);
    const nextStats = (stats && "poolOpen" in (stats as object) ? stats : null) || state.stats;
    if (!nextStats && activity.length === 0) return;
    lastUpdateAt = Date.now();
    state = makeState(nextStats as VaultStats | null, activity, state.connected);
    saveSnapshot(nextStats as VaultStats | null, activity);
    emit();
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
  // One REST read for immediate paint. The recurring poll is a *fallback* —
  // starting it unconditionally meant every tab ran a permanent second data
  // feed alongside SSE, duplicating data it already had. The error handlers
  // below start it the moment SSE actually fails.
  hydrateFromRest();
  if (source || typeof window === "undefined") return;
  const es = new EventSource("/api/market/vault/stream");
  source = es;

  es.addEventListener("vault", (ev) => {
    const raw = (ev as MessageEvent).data as string;
    if (raw === lastRaw && state.connected) return;
    lastRaw = raw;
    try {
      const data = JSON.parse(raw) as { stats: VaultStats | null; activity: VaultTradeEvent[] | null };
      // Never wipe a good trade list with an empty/partial SSE payload —
      // merge so a 1-row tick can't replace a 40-row REST history.
      const nextStats = data.stats ?? state.stats;
      const nextActivity = mergeActivity(
        Array.isArray(data.activity) ? data.activity : null,
        state.activity
      );
      if (!nextStats && nextActivity.length === 0) return;
      lastUpdateAt = Date.now();
      state = makeState(nextStats, nextActivity, true);
      saveSnapshot(nextStats, nextActivity);
      consecutiveErrors = 0;
      // SSE is delivering again, so the REST fallback is pure duplicate load.
      // Stopping it is safe now that mergeActivity() never lets a partial
      // payload shrink the ticker — that was the actual cause of the empty
      // tickers this used to guard against.
      stopPollFallback();
      for (const e of nextActivity) clearPendingVaultTx(e.txHash);
      emit();
    } catch {
      // malformed tick — skip it, the next one will self-correct
    }
  });

  // Explicit server error ticks — do NOT tear down the EventSource; the
  // platform already keeps the stream open. Only onerror means a real drop.
  es.addEventListener("error", () => {
    // keep last activity; mark not connected only if we've gone stale
    consecutiveErrors += 1;
    if (consecutiveErrors >= POLL_FALLBACK_AFTER_ERRORS) startPollFallback();
  });

  es.onerror = () => {
    es.close();
    if (source === es) source = null;
    // Preserve trades/stats — only flip connected. `live` stays true while
    // data is fresh so the badge doesn't thrash "Reconnecting…".
    state = makeState(state.stats, state.activity, false);
    emit();
    consecutiveErrors += 1;
    if (consecutiveErrors >= POLL_FALLBACK_AFTER_ERRORS) startPollFallback();
    if (refCount > 0 && !reconnectTimer) {
      // Back off harder so we don't flap Live/Reconnecting every few seconds
      // when the Worker stream dies under RPC pressure.
      const delay = Math.min(
        BASE_RECONNECT_MS * 2 ** Math.min(consecutiveErrors - 1, 4),
        MAX_RECONNECT_MS
      );
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
