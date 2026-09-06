"use client";

import { useCallback, useRef } from "react";

/**
 * Client side of the demand bus (lib/market/multichain/edge/demand-bus.ts).
 * One tiny helper every surface uses to say what the user is about to need
 * -- a sweep being previewed (with the money on the table), a trait facet
 * just opened, a search that matched collections, a wallet just connected.
 * Best-effort, debounced per (kind, chain, subject) so a hover storm or a
 * keystroke burst never becomes a request storm; never affects rendering.
 */

export type ClientIntentKind = "hover" | "click" | "search" | "wallet-connect" | "sweep" | "facet";

export type ClientIntent = {
  kind: ClientIntentKind;
  chainSlug: string;
  subjects: string[];
  moneyAtStakeUsd?: number;
  tokenIds?: string[];
  context?: string;
};

const DEMAND_URL = "/api/market/multichain/demand";
const DEDUPE_MS = 4_000;

export function publishDemandIntent(intent: ClientIntent, opts?: { keepalive?: boolean }): void {
  if (typeof window === "undefined" || !intent.chainSlug || intent.subjects.length === 0) return;
  void fetch(DEMAND_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(intent),
    keepalive: opts?.keepalive ?? false,
    priority: "low",
  } as RequestInit).catch(() => {
    // A dropped intent only means the mesh did not get this nudge.
  });
}

export function useDemandIntent() {
  const lastSent = useRef<Map<string, number>>(new Map());
  return useCallback((intent: ClientIntent) => {
    const now = Date.now();
    const key = `${intent.kind}|${intent.chainSlug}|${intent.subjects.slice(0, 5).join(",")}|${Math.round(intent.moneyAtStakeUsd ?? 0)}`;
    const prev = lastSent.current.get(key) ?? 0;
    if (now - prev < DEDUPE_MS) return;
    lastSent.current.set(key, now);
    if (lastSent.current.size > 200) {
      for (const [k, t] of lastSent.current) if (now - t > 60_000) lastSent.current.delete(k);
    }
    publishDemandIntent(intent);
  }, []);
}
