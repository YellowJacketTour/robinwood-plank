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
  type VaultRole,
} from "@/lib/market/vault-registry";
import { getVaultOnChainSnapshot } from "@/lib/market/vault";
import { formatTokenAmount } from "@/lib/trade";
import { CHAIN } from "@/lib/constants";

type Props = {
  role: VaultRole;
  onChange: (role: VaultRole) => void;
};

export default function InstantVaultSwitcher({ role, onChange }: Props) {
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
    const t = setInterval(() => {
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
    }, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [vaults.length]);

  if (!dualVaultMode() || vaults.length < 2) {
    const only = vaults[0];
    if (!only) return null;
    return (
      <div className="rounded-xl border border-gold-500/25 bg-black/25 px-3 py-2 text-sm text-foreground/70">
        Active vault: <span className="font-mono text-gold-200">{shortVault(only.address)}</span>
      </div>
    );
  }

  return (
    <div className="wood-frame space-y-3 rounded-2xl border-2 border-gold-400/40 bg-wood-900/95 p-4">
      <div>
        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.16em] text-gold-300">
          Choose vault
        </p>
        <h3 className="mt-0.5 font-display text-lg text-gold-200">V1 legacy · V2 new book</h3>
        <p className="mt-1 text-xs text-foreground/60">
          Use <strong className="text-foreground/85">V1</strong> for deposits already on the original
          vault (redeem / sell / buy there). Use <strong className="text-foreground/85">V2</strong> for
          the new pool (deposit, LP add/remove when open, Instant Swap).
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {vaults.map((v) => {
          const active = role === v.role;
          const s = snap[v.role];
          const title =
            v.role === "primary"
              ? v.isV1
                ? "Primary vault"
                : "V2 — new Instant Swap"
              : "V1 — legacy deposits";
          const blurb =
            v.role === "primary"
              ? "New book · Add/Remove LP when open · seed/bootstrap if closed"
              : "Original vault · redeem holdings · existing 57+ inventory path";
          return (
            <button
              key={v.role}
              type="button"
              onClick={() => onChange(v.role)}
              className={`rounded-xl border px-3 py-3 text-left transition ${
                active
                  ? "border-gold-400 bg-gold-500/15 ring-2 ring-gold-400/40"
                  : "border-gold-500/20 bg-black/20 hover:border-gold-500/40"
              }`}
            >
              <p className="text-sm font-bold text-gold-200">
                {title}
                {active ? " · active" : ""}
              </p>
              <p className="mt-0.5 font-mono text-[0.65rem] text-foreground/50">
                <a
                  href={`${CHAIN.blockExplorers.default.url}/address/${v.address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {shortVault(v.address)}
                </a>
              </p>
              <p className="mt-1 text-[0.7rem] text-foreground/55">{blurb}</p>
              {s && (
                <p className="mt-2 font-mono text-[0.65rem] text-gold-300/80">
                  held {s.held} · pool {s.pool} sh · {s.eth} Ξ ·{" "}
                  {s.open ? "open" : "closed"}
                </p>
              )}
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
