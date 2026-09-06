"use client";

import { useEffect, useRef } from "react";

/**
 * Viewport-aware continuous hydration -- docs/marketplank/GROK-FINDINGS-
 * viewport-predictive-hydration-2026-08-25.md. Watches every element in the
 * document carrying `data-collection-key="chainSlug:collectionKey"`, and
 * flushes a small debounced batch POST to /api/market/multichain/
 * visibility-demand naming whichever of those are actually intersecting the
 * viewport. That route only nudges mesh-queue priority (see
 * prioritizeVisibleCollections in lib/market/multichain/collection-demand.ts)
 * -- it never bypasses this app's singleflight-cache/freshness-budget live-
 * read paths and never calls a third-party provider directly.
 *
 * Composite key format `${chainSlug}:${collectionKey}` (matching the
 * `key(c)` helper already used by GlobalMarketHub.tsx) is REQUIRED, not
 * `collectionKey` alone -- GlobalMarketHub renders rows spanning multiple
 * chains at once, so this hook groups pending keys by chain and sends one
 * POST per chain group per flush (each still capped at 40 keys and subject
 * to the server's own IP rate limit). A single-chain page (e.g.
 * MultichainCollectionView) just ends up with one group.
 *
 * Batching contract (design doc section 1, followed exactly):
 * - IntersectionObserver threshold 0.25, rootMargin "100px 0px".
 * - Accumulate intersecting keys in a Set; flush every 2.5s OR on
 *   visibilitychange -> "hidden" (final flush, via sendBeacon so it survives
 *   the tab actually closing).
 * - Max 40 keys per chain group per flush.
 * - Skips entirely (never observes, never flushes) when
 *   navigator.connection?.saveData or effectiveType is "2g"/"slow-2g"
 *   (Quicklink-style data-saver/slow-connection check).
 *
 * Does NOT fire one request per row or per scroll frame -- only ever the
 * batched flush above.
 */

export type VisibilityContext = "rankings" | "detail" | "rail" | "movers";

export type UseVisibleCollectionDemandOptions = {
  context: VisibilityContext;
  /**
   * Full current on-page order of `${chainSlug}:${collectionKey}` composite
   * keys (e.g. the rankings table's current sort order) -- enables the
   * server's cheap same-chain rank-adjacency "predict next" expansion
   * (design doc section 7). Optional; omit to skip expansion.
   */
  pageOrder?: string[];
  /** Server-known page set (e.g. the rankings API's own current page of results) sent once alongside the viewport subset, per section 1's "even with JS disabled" note. Optional. */
  pageKeys?: string[];
  enabled?: boolean;
};

const FLUSH_MS = 2_500;
const MAX_KEYS_PER_FLUSH = 40;
const VISIBILITY_DEMAND_URL = "/api/market/multichain/visibility-demand";

function isSlowConnection(): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as unknown as {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (!conn) return false;
  if (conn.saveData) return true;
  return conn.effectiveType === "2g" || conn.effectiveType === "slow-2g";
}

/** Splits `${chainSlug}:${collectionKey}` composites into one array of collectionKeys per chainSlug. */
function groupByChain(composites: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const composite of composites) {
    const idx = composite.indexOf(":");
    if (idx <= 0 || idx === composite.length - 1) continue;
    const chainSlug = composite.slice(0, idx);
    const collectionKey = composite.slice(idx + 1);
    const arr = groups.get(chainSlug);
    if (arr) arr.push(collectionKey);
    else groups.set(chainSlug, [collectionKey]);
  }
  return groups;
}

/**
 * One in-flight POST per chain at a time. Real bug found live 2026-09-06:
 * with a slow server the 2.5 s flush cadence stacked a dozen pending POSTs,
 * saturating the browser's per-host connection pool and starving page
 * navigation. A batch that arrives while one is pending is folded into the
 * next flush (the pending Set keeps accumulating), never sent in parallel.
 */
const inFlightByChain = new Set<string>();

function sendVisibilityBatch(
  chainSlug: string,
  keys: string[],
  pageOrderKeys: string[] | undefined,
  pageKeys: string[] | undefined,
  context: VisibilityContext,
  useBeacon: boolean
): boolean {
  if (keys.length === 0 && (!pageKeys || pageKeys.length === 0)) return true;
  if (!useBeacon && inFlightByChain.has(chainSlug)) return false;
  const payload = JSON.stringify({
    chainSlug,
    keys: keys.slice(0, MAX_KEYS_PER_FLUSH),
    pageKeys,
    pageOrder: pageOrderKeys,
    context,
  });
  if (useBeacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const ok = navigator.sendBeacon(VISIBILITY_DEMAND_URL, new Blob([payload], { type: "application/json" }));
    if (ok) return true;
  }
  inFlightByChain.add(chainSlug);
  void fetch(VISIBILITY_DEMAND_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: useBeacon,
    // Navigation must always win over a demand ping.
    priority: "low",
  } as RequestInit)
    .catch(() => {
      // Best-effort demand signal -- a dropped POST never affects rendering,
      // it just means this batch didn't get to nudge mesh priority this time.
    })
    .finally(() => inFlightByChain.delete(chainSlug));
  return true;
}

export function useVisibleCollectionDemand(opts: UseVisibleCollectionDemandOptions): void {
  const { context, enabled = true } = opts;
  const pendingRef = useRef<Set<string>>(new Set());
  const pageOrderRef = useRef<string[] | undefined>(opts.pageOrder);
  const pageKeysRef = useRef<string[] | undefined>(opts.pageKeys);
  pageOrderRef.current = opts.pageOrder;
  pageKeysRef.current = opts.pageKeys;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;
    if (isSlowConnection()) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = entry.target.getAttribute("data-collection-key");
          if (key) pendingRef.current.add(key);
        }
      },
      { threshold: 0.25, rootMargin: "100px 0px" }
    );

    const observed = new WeakSet<Element>();
    const scan = () => {
      document.querySelectorAll("[data-collection-key]").forEach((el) => {
        if (observed.has(el)) return;
        observed.add(el);
        observer.observe(el);
      });
    };
    scan();
    // Rows/cards mount asynchronously (fetch-then-render) -- a MutationObserver
    // picks up newly rendered nodes without this hook needing every call site
    // to manually re-trigger a rescan on each data update.
    const mutationObserver = new MutationObserver(scan);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    const flushGroups = (useBeacon: boolean) => {
      if (pendingRef.current.size === 0) return;
      const composites = [...pendingRef.current];
      pendingRef.current.clear();
      const groups = groupByChain(composites);
      const orderGroups = pageOrderRef.current ? groupByChain(pageOrderRef.current) : undefined;
      const pageKeyGroups = pageKeysRef.current ? groupByChain(pageKeysRef.current) : undefined;
      for (const [chainSlug, keys] of groups) {
        const sent = sendVisibilityBatch(
          chainSlug,
          keys,
          orderGroups?.get(chainSlug),
          pageKeyGroups?.get(chainSlug),
          context,
          useBeacon
        );
        // Folded into the next flush rather than dropped.
        if (!sent) for (const k of keys) pendingRef.current.add(`${chainSlug}:${k}`);
      }
    };

    const interval = setInterval(() => flushGroups(false), FLUSH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushGroups(true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flushGroups(true);
    };
  }, [context, enabled]);
}
