"use client";

import { useCallback, useState } from "react";
import { getSeaport } from "@/lib/market/seaport";
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

/** Desktop: table. Mobile: the same rows stacked as cards — SPEC.md §4. */
export default function MyPositions({ account, listings, offers, onChanged }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const cancel = useCallback(
    async (row: Row) => {
      setError(null);
      try {
        setBusyId(row.id);
        const seaport = await getSeaport();
        const raw = row.rawOrder as { parameters: Parameters<typeof seaport.cancelOrders>[0][number] };
        const tx = seaport.cancelOrders([raw.parameters], account);
        await tx.transact();

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

  if (mine.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/30 bg-wood-900/40 px-4 py-8 text-center text-sm text-foreground/60">
        Nothing active.
      </p>
    );
  }

  return (
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
  );
}
