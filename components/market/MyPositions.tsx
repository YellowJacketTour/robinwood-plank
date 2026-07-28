"use client";

import { useCallback, useEffect, useState } from "react";
import {
  cancelOrder,
  getMarketApprovals,
  revokeCollectionApproval,
  revokeWethApproval,
  type MarketApprovals,
} from "@/lib/market/seaport";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { formatTokenAmount } from "@/lib/trade";
import type { Listing } from "@/lib/market/types";

type Props = {
  account: string;
  listings: Array<Listing & { rawOrder: unknown }>;
  offers: Array<Listing & { rawOrder: unknown }>;
  onChanged: () => void;
};

type Row = {
  id: string;
  kind: "Listing" | "Offer";
  tokenId?: string;
  priceWei: string;
  expiresAt: string;
  rawOrder: unknown;
};

const COLLECTION = MARKET_COLLECTIONS[0];

/** Desktop: table. Mobile: the same rows stacked as cards — SPEC.md §4. */
export default function MyPositions({ account, listings, offers, onChanged }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<MarketApprovals | null>(null);
  const [revoking, setRevoking] = useState<"nft" | "weth" | null>(null);

  const mine: Row[] = [
    ...listings
      .filter((l) => l.maker.toLowerCase() === account.toLowerCase())
      .map((l) => ({
        id: l.id,
        kind: "Listing" as const,
        tokenId: l.tokenId,
        priceWei: l.priceWei,
        expiresAt: l.expiresAt,
        rawOrder: l.rawOrder,
      })),
    ...offers
      .filter((o) => o.maker?.toLowerCase() === account.toLowerCase())
      .map((o) => ({
        id: o.id,
        kind: "Offer" as const,
        tokenId: o.tokenId,
        priceWei: o.priceWei,
        expiresAt: o.expiresAt,
        rawOrder: o.rawOrder,
      })),
  ];

  const refreshApprovals = useCallback(async () => {
    if (!COLLECTION) return;
    try {
      setApprovals(await getMarketApprovals(account, COLLECTION.contractAddress));
    } catch {
      // Read-only nicety; a failed read just hides the panel.
      setApprovals(null);
    }
  }, [account]);

  useEffect(() => {
    void refreshApprovals();
  }, [refreshApprovals]);

  const cancel = useCallback(
    async (row: Row) => {
      setError(null);
      try {
        setBusyId(row.id);
        // Routed through lib/wallet.ts (chain re-check + destination
        // allowlist + pre-flight simulation), not a raw ethers signer.
        const raw = row.rawOrder as {
          parameters: Parameters<typeof cancelOrder>[0];
        };
        await cancelOrder(raw.parameters, account);

        // Cancelling on-chain doesn't remove the order from the relay, so
        // without this the dead listing keeps showing and buyers waste gas
        // reverting on it. The endpoint re-checks Seaport itself before
        // removing anything, so this is a hint, not an authorization.
        await fetch(`/api/market/orders?id=${encodeURIComponent(row.id)}`, {
          method: "DELETE",
        }).catch(() => {});

        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not cancel.");
      } finally {
        setBusyId(null);
      }
    },
    [account, onChanged]
  );

  const revoke = useCallback(
    async (which: "nft" | "weth") => {
      if (!COLLECTION || revoking) return;
      setError(null);
      try {
        setRevoking(which);
        if (which === "nft") {
          await revokeCollectionApproval(account, COLLECTION.contractAddress);
        } else {
          await revokeWethApproval(account);
        }
        await refreshApprovals();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not revoke.");
      } finally {
        setRevoking(null);
      }
    },
    [account, revoking, refreshApprovals]
  );

  const hasLiveApproval =
    approvals !== null &&
    (approvals.collectionApprovedForAll || approvals.wethAllowance > BigInt(0));

  return (
    <div className="space-y-3">
      {mine.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gold-500/30 bg-wood-900/40 px-4 py-8 text-center text-sm text-foreground/60">
          Nothing active.
        </p>
      ) : (
        <div className="wood-ledger overflow-hidden">
          {error && (
            <p className="px-3 pt-2 text-center text-xs text-red-300" role="alert">
              {error}
            </p>
          )}
          <ul>
            {mine.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 border-t border-gold-500/15 px-3 py-2.5 first:border-t-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-foreground">
                    {row.kind} · {row.tokenId ? `#${row.tokenId}` : "any"}
                  </p>
                  <p className="text-[0.65rem] text-foreground/50">
                    {/* Listings settle in native ETH; bids are WETH-denominated
                        because Seaport cannot pull ETH from an offerer. Labelling
                        both "Ξ" would misstate what actually moves. */}
                    {formatTokenAmount(row.priceWei, 18, 4)}{" "}
                    {row.kind === "Offer" ? "WETH" : "Ξ"} · expires{" "}
                    {new Date(row.expiresAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busyId === row.id}
                  onClick={() => cancel(row)}
                  className="min-h-9 shrink-0 rounded-md border border-red-500/30 px-3 text-xs font-bold text-red-300 transition hover:border-red-400 disabled:opacity-50"
                >
                  {busyId === row.id ? "…" : "Cancel"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Live marketplace approvals — cancelling an order does NOT undo the
          approval that was granted while creating it, so surface + revoke
          them here (audit 2026-07-27). */}
      {hasLiveApproval && approvals && COLLECTION && (
        <div className="wood-ledger space-y-2 p-3">
          <p className="text-xs font-bold text-foreground">Marketplace approvals</p>
          {mine.length === 0 && (
            <p className="text-[0.65rem] text-foreground/50">
              You have no active orders, but the marketplace still holds these
              permissions from earlier ones. Revoking them costs a little gas
              and takes nothing else.
            </p>
          )}
          {approvals.collectionApprovedForAll && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[0.7rem] text-foreground/70">
                {COLLECTION.name}: transfer approval for the whole collection
              </p>
              <button
                type="button"
                disabled={revoking !== null}
                onClick={() => revoke("nft")}
                className="min-h-9 shrink-0 rounded-md border border-red-500/30 px-3 text-xs font-bold text-red-300 transition hover:border-red-400 disabled:opacity-50"
              >
                {revoking === "nft" ? "…" : "Revoke"}
              </button>
            </div>
          )}
          {approvals.wethAllowance > BigInt(0) && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[0.7rem] text-foreground/70">
                WETH allowance: {formatTokenAmount(approvals.wethAllowance.toString(), 18, 4)}
              </p>
              <button
                type="button"
                disabled={revoking !== null}
                onClick={() => revoke("weth")}
                className="min-h-9 shrink-0 rounded-md border border-red-500/30 px-3 text-xs font-bold text-red-300 transition hover:border-red-400 disabled:opacity-50"
              >
                {revoking === "weth" ? "…" : "Revoke"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
