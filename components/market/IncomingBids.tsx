"use client";

import { useMemo } from "react";
import { formatTokenAmount } from "@/lib/trade";
import type { Offer } from "@/lib/market/types";

export type IncomingBidRow = Offer & { rawOrder?: unknown };

type Props = {
  /** All live offers (token + criteria). */
  offers: IncomingBidRow[];
  /** Wallet-owned token ids (decimal strings). Undefined = not connected / loading. */
  ownedTokenIds?: Set<string>;
  /** Accept a single-token bid. */
  onAcceptToken: (offer: IncomingBidRow) => void;
  /** Accept a criteria / trait / rarity bid. */
  onAcceptCriteria: (offer: IncomingBidRow) => void;
  /** Compact strip vs full panel. */
  dense?: boolean;
  className?: string;
};

function labelFor(o: IncomingBidRow): string {
  if (o.tokenId) return `#${o.tokenId}`;
  if (o.traits?.length) {
    return o.traits.map((t) => `${t.traitType}: ${t.value}`).join(" · ");
  }
  return "Collection-wide";
}

/**
 * Bids the connected wallet can actually fill — token bids on owned planks
 * and criteria bids whose snapshot intersects holdings. Shared on Buy & Sell,
 * Offers, and My Listings so accept UX is one place.
 */
export default function IncomingBids({
  offers,
  ownedTokenIds,
  onAcceptToken,
  onAcceptCriteria,
  dense,
  className,
}: Props) {
  const actionable = useMemo(() => {
    if (!ownedTokenIds || ownedTokenIds.size === 0) return [];
    const owned = new Set([...ownedTokenIds].map((id) => BigInt(id).toString()));
    const rows: Array<{
      offer: IncomingBidRow;
      kind: "token" | "criteria";
      matchCount: number;
    }> = [];

    for (const o of offers) {
      if (o.tokenId) {
        if (owned.has(BigInt(o.tokenId).toString())) {
          rows.push({ offer: o, kind: "token", matchCount: 1 });
        }
        continue;
      }
      if (o.criteriaTokenIds?.length) {
        const n = o.criteriaTokenIds.filter((id) => owned.has(BigInt(id).toString())).length;
        if (n > 0) rows.push({ offer: o, kind: "criteria", matchCount: n });
      }
    }

    // Highest bid first
    rows.sort((a, b) => {
      const aw = BigInt(a.offer.priceWei);
      const bw = BigInt(b.offer.priceWei);
      return aw === bw ? 0 : aw > bw ? -1 : 1;
    });
    return rows;
  }, [offers, ownedTokenIds]);

  if (!ownedTokenIds) {
    return (
      <div
        className={`rounded-lg border border-dashed border-line bg-panel-strong px-3 py-2 ${className ?? ""}`}
      >
        <p className="text-[0.65rem] text-foreground/45">
          Connect a wallet to see bids on your planks.
        </p>
      </div>
    );
  }

  if (ownedTokenIds.size === 0) {
    return (
      <div
        className={`rounded-lg border border-dashed border-line bg-panel-strong px-3 py-2 ${className ?? ""}`}
      >
        <p className="text-[0.65rem] text-foreground/45">
          No planks in this wallet — bids you can accept will show here.
        </p>
      </div>
    );
  }

  if (actionable.length === 0) {
    return (
      <div
        className={`rounded-lg border border-dashed border-line bg-panel-strong px-3 py-2 ${className ?? ""}`}
      >
        <p className="text-[0.7rem] font-bold text-foreground/55">Bids on your planks</p>
        <p className="text-[0.65rem] text-foreground/40">
          None of the open offers match your holdings right now (token, trait, rarity, or combo).
        </p>
      </div>
    );
  }

  return (
    <div
      className={`space-y-1.5 rounded-lg border border-emerald-500/30 bg-forest-900/40 ${dense ? "p-2" : "p-3"} ${className ?? ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[0.76rem] font-black uppercase tracking-[0.06em] text-emerald-300/90">
          Bids you can accept
        </p>
        <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-wood-950 px-2 py-0.5 text-[0.6rem] font-bold text-emerald-300">
          {actionable.length} matching
        </span>
      </div>
      <ul className="space-y-1.5">
        {actionable.map(({ offer, kind, matchCount }) => (
          <li
            key={offer.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-panel-strong px-2.5 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-foreground">
                {formatTokenAmount(offer.priceWei, 18, 5)} WETH
                <span className="ml-1.5 text-[0.65rem] font-normal text-foreground/55">
                  · {labelFor(offer)}
                </span>
              </p>
              <p className="text-[0.6rem] text-foreground/45">
                {kind === "token"
                  ? "Item bid on a plank you own"
                  : `Criteria bid · ${matchCount} of your planks qualify`}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                kind === "token" ? onAcceptToken(offer) : onAcceptCriteria(offer)
              }
              className="min-h-9 shrink-0 rounded-md bg-gold-500 px-3 text-xs font-bold text-wood-950 transition hover:bg-gold-400"
            >
              Accept
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Best open bid amount for a specific token id (item + criteria that include it). */
export function bestBidForToken(
  offers: IncomingBidRow[],
  tokenId: string
): IncomingBidRow | null {
  const id = BigInt(tokenId).toString();
  let best: IncomingBidRow | null = null;
  for (const o of offers) {
    let matches = false;
    if (o.tokenId && BigInt(o.tokenId).toString() === id) matches = true;
    else if (o.criteriaTokenIds?.some((x) => BigInt(x).toString() === id)) matches = true;
    if (!matches) continue;
    if (!best || BigInt(o.priceWei) > BigInt(best.priceWei)) best = o;
  }
  return best;
}
