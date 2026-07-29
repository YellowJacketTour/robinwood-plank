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
  VAULT_LABEL_CLASS,
  VAULT_TEXT_CLASS,
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
        <h3 className="mt-0.5 font-display text-lg text-gold-200">
          <span className={VAULT_TEXT_CLASS.v1}>V1</span>
          <span className="text-foreground/40"> legacy · </span>
          <span className={VAULT_TEXT_CLASS.v2}>V2</span>
          <span className="text-foreground/40"> new book</span>
        </h3>
        <p className="mt-1 text-xs text-foreground/60">
          Use{" "}
          <strong className={VAULT_TEXT_CLASS.v1}>V1 (orange)</strong> for deposits already on the
          original vault. Use{" "}
          <strong className={VAULT_TEXT_CLASS.v2}>V2 (green)</strong> for the new pool (deposit, LP,
          Instant Swap).
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {vaults.map((v) => {
          const active = role === v.role;
          const s = snap[v.role];
          const kind = vaultColorKind(v.role === "legacy" ? "legacy" : "primary");
          const isV1Card = kind === "v1";
          const title = isV1Card ? "V1 — legacy deposits" : "V2 — new Instant Swap";
          const blurb = isV1Card
            ? "Original vault · redeem holdings · existing inventory path"
            : "New book · Add/Remove LP when open · seed/bootstrap if closed";
          const badgeClass = VAULT_LABEL_CLASS[kind];
          const activeRing = isV1Card
            ? "border-orange-400 bg-orange-500/15 ring-2 ring-orange-400/40"
            : "border-emerald-400 bg-emerald-500/15 ring-2 ring-emerald-400/40";
          const idleBorder = isV1Card
            ? "border-orange-500/25 bg-black/20 hover:border-orange-400/50"
            : "border-emerald-500/25 bg-black/20 hover:border-emerald-400/50";
          return (
            <button
              key={v.role}
              type="button"
              onClick={() => onChange(v.role)}
              className={`rounded-xl border px-3 py-3 text-left transition ${
                active ? activeRing : idleBorder
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-md border px-1.5 py-0.5 text-[0.65rem] font-extrabold uppercase tracking-wide ${badgeClass}`}
                >
                  {isV1Card ? "V1" : "V2"}
                </span>
                <p className={`text-sm font-bold ${VAULT_TEXT_CLASS[kind]}`}>
                  {title}
                  {active ? " · active" : ""}
                </p>
              </div>
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
                <p
                  className={`mt-2 font-mono text-[0.65rem] ${
                    isV1Card ? "text-orange-300/80" : "text-emerald-300/80"
                  }`}
                >
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
