"use client";

/**
 * One shared scan of the connected wallet's position across every legacy vault,
 * driving both the site-wide migration banner and the /migrate page. Reads
 * shares + LP credit + owned planks + the vault-wide redeem-slot state, polls on
 * a single 20s visible interval, and exposes an imperative refresh().
 */

import { useCallback, useEffect, useState } from "react";
import {
  listVaults,
  type VaultDescriptor,
} from "@/lib/market/vault-registry";
import {
  getVaultOnChainSnapshot,
  getLpCredit,
  getPendingRequester,
  getPendingRound,
} from "@/lib/market/vault";
import { getOwnedInventory } from "@/lib/market/inventory";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  buildMigrationPlan,
  redeemCostShares,
  type MigrationPlan,
  type VaultPosition,
} from "@/lib/market/migration";
import { startVisibleInterval } from "@/lib/useVisibleInterval";

export type OwnedPlank = { tokenId: string; image?: string; name?: string };

export type SlotState = {
  /** Zero address when idle. */
  requester: string;
  round: bigint;
  available: boolean;
  /** True when the connected wallet is the one with the pending request. */
  mine: boolean;
  busy: boolean;
};

export type LegacyPosition = {
  plan: MigrationPlan | null;
  owned: OwnedPlank[];
  /** Redeem-slot state keyed by lowercased vault address. */
  slots: Record<string, SlotState>;
  /** True when this wallet has any legacy shares, LP, owned planks, or a slot. */
  hasValue: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Optimistically drop a plank from `owned` the instant its deposit confirms,
   *  so the count updates without waiting on the slow authoritative rescan. */
  markDeposited: (tokenId: string) => void;
};

const ZERO = "0x0000000000000000000000000000000000000000";

export function useLegacyPosition(
  address: string | null,
  active = true
): LegacyPosition {
  const legacies: VaultDescriptor[] = listVaults().filter((v) => v.role === "legacy");
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [owned, setOwned] = useState<OwnedPlank[]>([]);
  const [slots, setSlots] = useState<Record<string, SlotState>>({});
  const [loading, setLoading] = useState(false);
  const legacyKey = legacies.map((v) => v.address).join(",");

  const scan = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const positions: VaultPosition[] = [];
      const nextSlots: Record<string, SlotState> = {};
      for (const v of legacies) {
        try {
          // A single unreadable vault (no code at that address on the current
          // chain, a node hiccup, a wrong-network read) must not crash the whole
          // page — skip it and surface whatever else we could read.
          const [snap, lp, requester, round] = await Promise.all([
            getVaultOnChainSnapshot(v.address, address),
            getLpCredit(address, v.address).catch(() => ({
              shareCredit: BigInt(0),
              ethCredit: BigInt(0),
            })),
            getPendingRequester(v.address).catch(() => ZERO),
            getPendingRound(v.address).catch(() => ({ round: BigInt(0), available: false })),
          ]);
          positions.push({
            address: v.address,
            generation: v.generation,
            version: v.version,
            walletShares: snap.shareBalance,
            lpShareCredit: lp.shareCredit,
            lpEthCredit: lp.ethCredit,
            redeemCostShares: redeemCostShares(snap.redeemFeeBps),
            poolShareReserve: snap.shareReserve,
            poolEthReserve: snap.ethReserve,
          });
          const busy = requester !== ZERO;
          nextSlots[v.address.toLowerCase()] = {
            requester,
            round: round.round,
            available: round.available,
            mine: busy && requester.toLowerCase() === address.toLowerCase(),
            busy,
          };
        } catch {
          /* vault unreadable this tick — skip it, keep the others */
        }
      }
      setPlan(buildMigrationPlan(positions));
      setSlots(nextSlots);

      const inv = await getOwnedInventory(MARKET_COLLECTIONS, address).catch(() => []);
      const planks: OwnedPlank[] = inv.flatMap((c: { items?: OwnedPlank[] }) =>
        (c.items ?? []).map((it) => ({
          tokenId: String(it.tokenId),
          image: it.image,
          name: it.name,
        }))
      );
      setOwned(planks);
    } catch (e) {
      // Every await inside is individually guarded, so this is a backstop: if a
      // future edit adds an unguarded await, make the failure visible (a
      // fire-and-forget scan() would otherwise become a silent rejection).
      console.error("legacy position scan failed", e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, legacyKey]);

  const refresh = useCallback(async () => {
    await scan();
  }, [scan]);

  const markDeposited = useCallback((tokenId: string) => {
    setOwned((prev) => prev.filter((p) => p.tokenId !== tokenId));
  }, []);

  useEffect(() => {
    if (!address) {
      setPlan(null);
      setOwned([]);
      setSlots({});
      return;
    }
    void scan();
    const stop = active ? startVisibleInterval(() => void scan(), 20_000) : null;
    return () => stop?.();
  }, [address, active, scan]);

  const anySlotMine = Object.values(slots).some((s) => s.mine);
  const hasValue = Boolean(plan?.hasValue) || owned.length > 0 || anySlotMine;

  return { plan, owned, slots, hasValue, loading, refresh, markDeposited };
}
