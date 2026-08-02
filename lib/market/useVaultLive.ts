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
  /** "share" (V1/V2, bps fees) vs "eth" (V3+, flat wei fees) — see
   * lib/market/vault-registry.ts's feeModelForVault. Only the matching field
   * group below is populated; the other is null, never coerced. */
  feeModel: "share" | "eth";
  mintFeeBps: number | null;
  redeemFeeBps: number | null;
  targetPremiumBps: number | null;
  mintFeeWei: string | null;
  redeemFeeWei: string | null;
  targetPremiumWei: string | null;
  swapFeeBps: number | null;
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

/** A snapshot older than this is more likely to mislead than help — past
 * this age just start from empty and wait for a real fetch, same as before
 * this cache existed. */
const SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

/** Resolve any address/undefined/null argument to a stable lowercase key.
 * `undefined`/`null`/an address that isn't a configured vault all fall back
 * to the primary vault — every caller of this hook is displaying exactly
 * one vault's data, and the primary is the only sane default when none is
 * given. */
function normalizeVaultKey(vaultAddress?: string | null): string {
  if (vaultAddress && /^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
    return vaultAddress.toLowerCase();
  }
  return (MARKET_VAULT_ADDRESS ?? "none").toLowerCase();
}

const primaryKey = (MARKET_VAULT_ADDRESS ?? "none").toLowerCase();

function makeState(stats: VaultStats | null, activity: VaultTradeEvent[], connected: boolean, lastUpdateAt: number): VaultLiveState {
  return { stats, activity, connected, live: Date.now() - lastUpdateAt < FRESH_WINDOW_MS };
}

function snapshotKey(vaultKey: string): string {
  return `plank-vault-snapshot:${vaultKey}`;
}

/**
 * One bucket per distinct vault this tab has ever asked to see — each keeps
 * its own last-known state, its own REST fetch loop, and its own listeners,
 * but every bucket is fed by the SAME shared SSE connection (one
 * EventSource per tab, not one per vault): the stream endpoint only ever
 * reports primary-vault stats plus the full merged activity lineage, so a
 * single connection has everything every bucket needs — each tick just gets
 * filtered per bucket instead of opening a redundant connection per vault.
 */
type Bucket = {
  vaultKey: string;
  state: VaultLiveState;
  listeners: Set<(s: VaultLiveState) => void>;
  refCount: number;
  restHydrated: boolean;
  lastUpdateAt: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  freshnessTimer: ReturnType<typeof setInterval> | null;
};

const buckets = new Map<string, Bucket>();

function loadSnapshot(vaultKey: string): { state: VaultLiveState; lastUpdateAt: number } {
  if (typeof window === "undefined") return { state: makeState(null, [], false, 0), lastUpdateAt: 0 };
  try {
    const raw = localStorage.getItem(snapshotKey(vaultKey));
    if (!raw) return { state: makeState(null, [], false, 0), lastUpdateAt: 0 };
    const parsed = JSON.parse(raw) as { stats: VaultStats; activity: VaultTradeEvent[]; at: number };
    if (Date.now() - parsed.at > SNAPSHOT_MAX_AGE_MS) return { state: makeState(null, [], false, 0), lastUpdateAt: 0 };
    // A cached snapshot young enough to still count as "fresh" (well under
    // FRESH_WINDOW_MS) shows as live immediately, no flash of "connecting"
    // on a cold load when the data is genuinely still current.
    return { state: makeState(parsed.stats, parsed.activity, false, parsed.at), lastUpdateAt: parsed.at };
  } catch {
    return { state: makeState(null, [], false, 0), lastUpdateAt: 0 };
  }
}

function saveSnapshot(vaultKey: string, stats: VaultStats | null, activity: VaultTradeEvent[]) {
  if (typeof window === "undefined" || !stats) return;
  try {
    localStorage.setItem(snapshotKey(vaultKey), JSON.stringify({ stats, activity, at: Date.now() }));
  } catch {
    // storage full/unavailable — the live stream still works, it just
    // won't have an instant-hydrate snapshot for the next visit
  }
}

function getBucket(vaultKey: string): Bucket {
  let b = buckets.get(vaultKey);
  if (!b) {
    const { state, lastUpdateAt } = loadSnapshot(vaultKey);
    b = {
      vaultKey,
      state,
      listeners: new Set(),
      refCount: 0,
      restHydrated: false,
      lastUpdateAt,
      pollTimer: null,
      freshnessTimer: null,
    };
    buckets.set(vaultKey, b);
  }
  return b;
}

function emit(b: Bucket) {
  b.listeners.forEach((l) => l(b.state));
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

function applyFetchResult(b: Bucket, stats: VaultStats | null | undefined, activity: VaultTradeEvent[]) {
  const merged = mergeActivity(activity, b.state.activity);
  const nextStats = stats ?? b.state.stats;
  if (!nextStats && merged.length === 0) return;
  b.lastUpdateAt = Date.now();
  b.state = makeState(nextStats, merged, b.state.connected, b.lastUpdateAt);
  saveSnapshot(b.vaultKey, nextStats, merged);
  emit(b);
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
function hydrateFromRest(b: Bucket) {
  if (b.restHydrated || typeof window === "undefined") return;
  b.restHydrated = true;
  fetchOnce(b);
}

/** Both the stats and activity REST reads are explicitly scoped to this
 * bucket's vault (`?vault=`) — the activity endpoint used to accept and
 * silently ignore that param, so every bucket, primary or legacy, got the
 * entire merged lineage. Prefer shared SWR so Instant Swap panels + this
 * poller de-dupe. */
function fetchOnce(b: Bucket) {
  const qs = `?vault=${encodeURIComponent(b.vaultKey)}`;
  void Promise.all([
    import("@/lib/market/swr-fetch").then(({ swrJson }) =>
      swrJson<VaultStats | null>(`/api/market/vault/stats${qs}`, {
        ttlMs: 8_000,
        swrMs: 60_000,
        session: true,
      }).catch(() => null)
    ),
    import("@/lib/market/swr-fetch").then(({ swrJson }) =>
      swrJson<{ events?: VaultTradeEvent[] }>(`/api/market/vault/activity${qs}`, {
        ttlMs: 10_000,
        swrMs: 90_000,
        session: true,
      }).catch(() => null)
    ),
  ]).then(([stats, activityRes]) => {
    const restActivity: VaultTradeEvent[] = activityRes?.events ?? [];
    const nextStats = stats && "poolOpen" in (stats as object) ? stats : null;
    applyFetchResult(b, nextStats, restActivity);
  });
}

function startPollFallback(b: Bucket) {
  if (b.pollTimer) return;
  fetchOnce(b);
  b.pollTimer = setInterval(() => fetchOnce(b), POLL_INTERVAL_MS);
}

function stopPollFallback(b: Bucket) {
  if (b.pollTimer) {
    clearInterval(b.pollTimer);
    b.pollTimer = null;
  }
}

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
let source: EventSource | null = null;
let sourceRefCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveErrors = 0;

/**
 * The stream (app/api/market/vault/stream/route.ts) is a single shared feed
 * — it always reports PRIMARY-vault stats plus the FULL merged activity
 * lineage across every vault, unfiltered (it has no `?vault=` support and
 * caches server-side across all clients). One SSE tick is therefore fanned
 * out to every open bucket: stats only apply to the primary bucket (that's
 * the only vault the stream actually reports on); activity is filtered per
 * bucket to that bucket's own vault before merging, so a legacy bucket
 * never picks up primary trades and vice versa.
 */
function handleTick(data: { stats: VaultStats | null; activity: VaultTradeEvent[] | null }) {
  const rawActivity = Array.isArray(data.activity) ? data.activity : [];
  for (const b of buckets.values()) {
    if (b.refCount <= 0) continue;
    const filteredActivity = rawActivity.filter(
      (e) => (e.vaultAddress || "").toLowerCase() === b.vaultKey
    );
    const nextActivity = mergeActivity(filteredActivity, b.state.activity);
    const nextStats = b.vaultKey === primaryKey ? data.stats ?? b.state.stats : b.state.stats;
    if (!nextStats && nextActivity.length === 0) continue;
    b.lastUpdateAt = Date.now();
    b.state = makeState(nextStats, nextActivity, true, b.lastUpdateAt);
    saveSnapshot(b.vaultKey, nextStats, nextActivity);
    // SSE is delivering again, so the REST fallback is pure duplicate load.
    // Stopping it is safe now that mergeActivity() never lets a partial
    // payload shrink the ticker — that was the actual cause of the empty
    // tickers this used to guard against.
    stopPollFallback(b);
    for (const e of nextActivity) clearPendingVaultTx(e.txHash);
    emit(b);
  }
}

function markAllDisconnected() {
  for (const b of buckets.values()) {
    if (b.refCount <= 0) continue;
    b.state = makeState(b.state.stats, b.state.activity, false, b.lastUpdateAt);
    emit(b);
  }
}

function startPollFallbackForAll() {
  for (const b of buckets.values()) {
    if (b.refCount > 0) startPollFallback(b);
  }
}

function connectShared() {
  if (source || typeof window === "undefined") return;
  const es = new EventSource("/api/market/vault/stream");
  source = es;

  es.addEventListener("vault", (ev) => {
    const raw = (ev as MessageEvent).data as string;
    // Skip an identical repeat tick UNLESS some bucket is currently marked
    // disconnected — otherwise a reconnect whose first tick happens to
    // match the last payload text would never flip that bucket's
    // `connected` back to true.
    const anyDisconnected = Array.from(buckets.values()).some(
      (b) => b.refCount > 0 && !b.state.connected
    );
    if (raw === lastRaw && !anyDisconnected) return;
    lastRaw = raw;
    try {
      const data = JSON.parse(raw) as { stats: VaultStats | null; activity: VaultTradeEvent[] | null };
      consecutiveErrors = 0;
      handleTick(data);
    } catch {
      // malformed tick — skip it, the next one will self-correct
    }
  });

  // Explicit server error ticks — do NOT tear down the EventSource; the
  // platform already keeps the stream open. Only onerror means a real drop.
  es.addEventListener("error", () => {
    consecutiveErrors += 1;
    if (consecutiveErrors >= POLL_FALLBACK_AFTER_ERRORS) startPollFallbackForAll();
  });

  es.onerror = () => {
    es.close();
    if (source === es) source = null;
    // Preserve trades/stats — only flip connected. `live` stays true while
    // data is fresh so the badge doesn't thrash "Reconnecting…".
    markAllDisconnected();
    consecutiveErrors += 1;
    if (consecutiveErrors >= POLL_FALLBACK_AFTER_ERRORS) startPollFallbackForAll();
    if (sourceRefCount > 0 && !reconnectTimer) {
      // Back off harder so we don't flap Live/Reconnecting every few seconds
      // when the Worker stream dies under RPC pressure.
      const delay = Math.min(
        BASE_RECONNECT_MS * 2 ** Math.min(consecutiveErrors - 1, 4),
        MAX_RECONNECT_MS
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (sourceRefCount > 0) connectShared();
      }, delay);
    }
  };
}

function disconnectShared() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  consecutiveErrors = 0;
  source?.close();
  source = null;
}

/** `live` is time-based, not event-based — without this, it would only
 * ever get re-evaluated when a new tick/poll/error happens to call
 * makeState(). If nothing happens for FRESH_WINDOW_MS (a genuinely dead
 * connection with no retries succeeding), nothing would ever flip `live`
 * back to false on its own. Ticks slowly since it only matters for the
 * boundary case, not routine updates. */
function startFreshnessTimer(b: Bucket) {
  if (b.freshnessTimer) return;
  b.freshnessTimer = setInterval(() => {
    const nowLive = Date.now() - b.lastUpdateAt < FRESH_WINDOW_MS;
    if (nowLive !== b.state.live) {
      b.state = { ...b.state, live: nowLive };
      emit(b);
    }
  }, 5_000);
}

function stopFreshnessTimer(b: Bucket) {
  if (b.freshnessTimer) {
    clearInterval(b.freshnessTimer);
    b.freshnessTimer = null;
  }
}

/**
 * One shared EventSource per tab (refcounted across every vault any
 * consumer is currently displaying — VaultDashboard, VaultTradeHistory,
 * LivingLiquidityViz, the Activity tab's vault section) reading
 * /api/market/vault/stream, so opening more of these components doesn't
 * open more connections. Each caller gets state scoped to exactly the
 * vault it asked for (defaulting to the primary vault when omitted) — see
 * the module doc above `handleTick` for how one shared tick is fanned out
 * per-vault. Falls back to a fresh connect attempt on error rather than
 * silently going stale.
 */
export function useVaultLive(vaultAddress?: string | null): VaultLiveState {
  const vaultKey = normalizeVaultKey(vaultAddress);
  const [local, setLocal] = useState(() => getBucket(vaultKey).state);

  useEffect(() => {
    const b = getBucket(vaultKey);
    b.refCount += 1;
    sourceRefCount += 1;
    hydrateFromRest(b);
    connectShared();
    startFreshnessTimer(b);
    b.listeners.add(setLocal);
    setLocal(b.state);
    return () => {
      b.listeners.delete(setLocal);
      b.refCount -= 1;
      sourceRefCount -= 1;
      if (b.refCount <= 0) {
        b.refCount = 0;
        stopPollFallback(b);
        stopFreshnessTimer(b);
        b.restHydrated = false;
      }
      if (sourceRefCount <= 0) {
        sourceRefCount = 0;
        disconnectShared();
      }
    };
  }, [vaultKey]);

  return local;
}
