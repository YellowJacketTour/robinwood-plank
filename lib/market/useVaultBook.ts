"use client";

/**
 * Live stats for a *selected* vault book (V1 or V2).
 * Independent of useVaultLive's primary SSE feed so Instant Swap can switch
 * inventory / pool numbers when the user picks a vault. Trade history stays
 * dual-vault via useVaultLive.
 */

import { useEffect, useState } from "react";
import type { VaultStats } from "@/lib/market/useVaultLive";
import { startVisibleInterval } from "@/lib/useVisibleInterval";

export type VaultBookState = {
  stats: VaultStats | null;
  /** True when we have a recent successful fetch for this vault. */
  live: boolean;
  vaultAddress: string | null;
};

const FRESH_MS = 45_000;

export function useVaultBook(
  vaultAddress: string | null | undefined,
  options?: { active?: boolean }
): VaultBookState {
  const active = options?.active ?? true;
  const addr = vaultAddress && /^0x[0-9a-fA-F]{40}$/.test(vaultAddress) ? vaultAddress : null;
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [live, setLive] = useState(false);
  const [tracked, setTracked] = useState<string | null>(null);

  useEffect(() => {
    if (!addr) {
      setStats(null);
      setLive(false);
      setTracked(null);
      return;
    }
    // Clear immediately on switch so we never flash the other vault's numbers.
    setStats(null);
    setLive(false);
    setTracked(addr);

    let cancelled = false;
    let lastOk = 0;

    const load = async () => {
      try {
        const { swrJson } = await import("@/lib/market/swr-fetch");
        const data = await swrJson<VaultStats | null>(
          `/api/market/vault/stats?vault=${encodeURIComponent(addr)}`,
          {
            ttlMs: 8_000,
            swrMs: 60_000,
            session: true,
            isGood: (raw) => {
              const s = raw as VaultStats | null;
              return Boolean(s && typeof s === "object" && "poolOpen" in s && "ethReserveWei" in s);
            },
          }
        );
        if (cancelled) return;
        if (data && typeof data === "object" && "poolOpen" in data) {
          setStats(data as VaultStats);
          lastOk = Date.now();
          setLive(true);
        }
      } catch {
        if (!cancelled && Date.now() - lastOk > FRESH_MS) setLive(false);
      }
    };

    void load();
    // Repeat cadence only while the page is visible and the owning tab is on
    // screen; the initial load above always runs so state is never empty.
    const stop = active ? startVisibleInterval(() => void load(), 12_000) : null;
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [addr, active]);

  return {
    stats: tracked === addr ? stats : null,
    live: tracked === addr ? live : false,
    vaultAddress: addr,
  };
}
