"use client";

/**
 * Intuitive dual-vault control for Instant Swap.
 * V2 (primary) = new book + LP · V1 (legacy) = existing deposits / redeem.
 */

import { useEffect, useState } from "react";
import {
  dualVaultMode,
  listVaults,
  shortVault,
  vaultColorKind,
  VAULT_TEXT_CLASS,
  type VaultRole,
} from "@/lib/market/vault-registry";
import { getVaultOnChainSnapshot } from "@/lib/market/vault";
import { formatTokenAmount } from "@/lib/trade";
import { CHAIN } from "@/lib/constants";
import { startVisibleInterval } from "@/lib/useVisibleInterval";

type Props = {
  role: VaultRole;
  onChange: (role: VaultRole) => void;
  /** False while the owning tab is mounted but off screen — pauses polling. */
  active?: boolean;
};

export default function InstantVaultSwitcher({ role, onChange, active = true }: Props) {
  const vaults = listVaults();
  const [snap, setSnap] = useState<
    Record<string, { held: number; pool: string; eth: string; open: boolean }>
  >({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: typeof snap = {};
      for (const v of vaults) {
        try {
          const s = await getVaultOnChainSnapshot(v.address);
          next[v.role] = {
            held: s.held,
            pool: formatTokenAmount(s.shareReserve, 18, 2),
            eth: formatTokenAmount(s.ethReserve, 18, 4),
            open: s.poolOpen,
          };
        } catch {
          next[v.role] = { held: 0, pool: "—", eth: "—", open: false };
        }
      }
      if (!cancelled) setSnap(next);
    })();
    const tick = () => {
      void (async () => {
        const next: typeof snap = {};
        for (const v of vaults) {
          try {
            const s = await getVaultOnChainSnapshot(v.address);
            next[v.role] = {
              held: s.held,
              pool: formatTokenAmount(s.shareReserve, 18, 2),
              eth: formatTokenAmount(s.ethReserve, 18, 4),
              open: s.poolOpen,
            };
          } catch {
            /* keep */
          }
        }
        if (!cancelled) setSnap((prev) => ({ ...prev, ...next }));
      })();
    };
    const stop = active ? startVisibleInterval(tick, 20_000) : null;
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [vaults.length, active]);

  if (!dualVaultMode() || vaults.length < 2) {
    const only = vaults[0];
    if (!only) return null;
    return (
      <div className="rounded-xl border border-gold-500/25 bg-wood-950/90 px-3 py-2 text-sm text-foreground/70">
        Active vault: <span className="font-mono text-gold-200">{shortVault(only.address)}</span>
      </div>
    );
  }

  // Finalized mockup: two compact vault cards, primary (V2) first, no
  // instructional panel around them — each card carries its own identity,
  // explorer link, and live meta line. Active card gets the emerald frame.
  const ordered = [...vaults].sort((a) => (a.role === "primary" ? -1 : 1));

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {ordered.map((v) => {
          const active = role === v.role;
          const s = snap[v.role];
          const kind = vaultColorKind(v.role === "legacy" ? "legacy" : "primary");
          const isV1Card = kind === "v1";
          const title = isV1Card ? "V1 — Legacy vault" : "V2 — Primary vault";
          const blurb = isV1Card
            ? "Original vault · deposit & redeem · limited LP controls"
            : "New book · deposit, redeem, Add & Remove LP · Instant Swap";
          return (
            <button
              key={v.role}
              type="button"
              onClick={() => onChange(v.role)}
              aria-pressed={active}
              className={`rounded-xl border px-3.5 py-3 text-left transition ${
                active
                  ? "border-emerald-400/70 bg-emerald-950/20"
                  : "border-gold-500/20 bg-wood-950/90 hover:border-gold-500/45"
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <p className={`text-sm font-extrabold ${VAULT_TEXT_CLASS[kind]}`}>{title}</p>
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
              <p className="mt-1 text-[0.7rem] text-foreground/55">
                {s
                  ? `${s.open ? "Open" : "Closed"} · ${s.held} held · ${s.pool} shares · ${s.eth} Ξ liquidity`
                  : blurb}
              </p>
              {s && <p className="mt-0.5 text-[0.62rem] text-foreground/40">{blurb}</p>}
            </button>
          );
        })}
      </div>
      <p className="text-[0.65rem] text-foreground/40">
        Switching vault only changes Instant Swap targets below. Listings/offers stay collection-wide.
      </p>
    </div>
  );
}
