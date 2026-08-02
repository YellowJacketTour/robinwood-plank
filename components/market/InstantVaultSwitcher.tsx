"use client";

/**
 * N-vault control for Instant Swap. One card per configured vault — the current
 * vault first, then legacies newest-first — each carrying its own identity,
 * explorer link, and live meta line. Selection is by address.
 */

import { useEffect, useState } from "react";
import {
  dualVaultMode,
  listVaultsForDisplay,
  shortVault,
  vaultColorKind,
  VAULT_LABEL_CLASS,
} from "@/lib/market/vault-registry";
import { getVaultOnChainSnapshot } from "@/lib/market/vault";
import { formatTokenAmount } from "@/lib/trade";
import { CHAIN } from "@/lib/constants";
import { startVisibleInterval } from "@/lib/useVisibleInterval";

type Snap = { held: number; pool: string; eth: string; open: boolean };

type Props = {
  /** Selected vault address. */
  selected: string | null;
  onSelect: (address: string) => void;
  /** False while the owning tab is mounted but off screen — pauses polling. */
  active?: boolean;
};

export default function InstantVaultSwitcher({ selected, onSelect, active = true }: Props) {
  const vaults = listVaultsForDisplay();
  const [snap, setSnap] = useState<Record<string, Snap>>({});

  const addrKey = vaults.map((v) => v.address).join(",");

  useEffect(() => {
    let cancelled = false;
    const read = async (merge: boolean) => {
      const next: Record<string, Snap> = {};
      for (const v of vaults) {
        try {
          const s = await getVaultOnChainSnapshot(v.address);
          next[v.address.toLowerCase()] = {
            held: s.held,
            pool: formatTokenAmount(s.shareReserve, 18, 2),
            eth: formatTokenAmount(s.ethReserve, 18, 4),
            open: s.poolOpen,
          };
        } catch {
          if (!merge) next[v.address.toLowerCase()] = { held: 0, pool: "—", eth: "—", open: false };
        }
      }
      if (!cancelled) setSnap((prev) => (merge ? { ...prev, ...next } : next));
    };
    void read(false);
    const stop = active ? startVisibleInterval(() => void read(true), 20_000) : null;
    return () => {
      cancelled = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrKey, active]);

  if (!dualVaultMode() || vaults.length < 2) {
    const only = vaults[0];
    if (!only) return null;
    return (
      <div className="rounded-[10px] border border-line bg-wood-950 px-3 py-2 text-sm text-foreground/70">
        Active vault: <span className="font-mono text-gold-200">{shortVault(only.address)}</span>
      </div>
    );
  }

  const selectedLc = selected?.toLowerCase() ?? null;

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {vaults.map((v) => {
          const isActive = v.address.toLowerCase() === selectedLc;
          const s = snap[v.address.toLowerCase()];
          const kind = vaultColorKind(v.address);
          return (
            <button
              key={v.address}
              type="button"
              onClick={() => onSelect(v.address)}
              aria-pressed={isActive}
              className={`rounded-[10px] border px-3.5 py-3 text-left transition ${
                isActive
                  ? "border-[#60d890] bg-[rgba(18,49,33,0.54)]"
                  : "border-line bg-wood-950 hover:border-line-strong"
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span
                  className={`rounded border px-1.5 py-0.5 text-[0.6rem] font-extrabold uppercase tracking-wide ${VAULT_LABEL_CLASS[kind]}`}
                >
                  {v.role === "primary" ? "Current" : "Older pool"}
                </span>
                <p className="text-sm font-extrabold text-foreground">{v.label}</p>
                <a
                  href={`${CHAIN.blockExplorers.default.url}/address/${v.address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[0.65rem] text-foreground/45 underline hover:text-gold-300"
                  onClick={(e) => e.stopPropagation()}
                  title={v.address}
                >
                  {shortVault(v.address)} ↗
                </a>
              </div>
              <p className="mt-1 text-[0.62rem] text-foreground/55">
                {s
                  ? `${s.open ? "Open" : "Closed"} · ${s.held} held · ${s.pool} shares · ${s.eth} Ξ liquidity`
                  : v.purpose}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
