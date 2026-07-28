"use client";

import { useEffect, useState } from "react";

export type PendingVaultTx = {
  txHash: string;
  kind: "buy" | "sell" | "deposit" | "redeem";
  ethWei: string | null;
  tokenId: string | null;
  submittedAt: number;
};

/** A wallet popup can sit unsigned/unmined far longer than any normal
 * confirmation — drop it from the pending list rather than show a "pending"
 * badge forever if it never lands (dropped, replaced, or the user never
 * confirmed the tx-history read that would have cleared it). */
const STALE_MS = 5 * 60_000;

let pending: PendingVaultTx[] = [];
const listeners = new Set<(p: PendingVaultTx[]) => void>();

function emit() {
  listeners.forEach((l) => l(pending));
}

/** Called the instant a vault write returns a hash — see
 * lib/market/vault.ts's onSubmitted callback, which fires right after the
 * wallet returns a hash, well before on-chain confirmation. */
export function addPendingVaultTx(tx: Omit<PendingVaultTx, "submittedAt">) {
  pending = [{ ...tx, submittedAt: Date.now() }, ...pending.filter((p) => p.txHash !== tx.txHash)].slice(0, 20);
  emit();
}

/** Called once the real event for this hash shows up in the live activity
 * feed — see lib/market/useVaultLive.ts. */
export function clearPendingVaultTx(txHash: string) {
  if (!pending.some((p) => p.txHash === txHash)) return;
  pending = pending.filter((p) => p.txHash !== txHash);
  emit();
}

function pruneStale() {
  const cutoff = Date.now() - STALE_MS;
  const next = pending.filter((p) => p.submittedAt >= cutoff);
  if (next.length !== pending.length) {
    pending = next;
    emit();
  }
}

export function usePendingVaultTx(): PendingVaultTx[] {
  const [state, setState] = useState(pending);
  useEffect(() => {
    listeners.add(setState);
    const interval = setInterval(pruneStale, 15_000);
    return () => {
      listeners.delete(setState);
      clearInterval(interval);
    };
  }, []);
  return state;
}
