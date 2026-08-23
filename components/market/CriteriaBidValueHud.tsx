"use client";

import { formatEther } from "ethers";
import EthUsdValue from "@/components/market/EthUsdValue";

type ListingLike = { tokenId: string; priceWei: string };

function compactEth(value: bigint | null): string {
  if (value === null) return "—";
  const number = Number(formatEther(value));
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—";
}

/** Wallet-independent economics for a staged criteria bid. */
export default function CriteriaBidValueHud({ offerWei, qualifyingIds, listings = [], currencySymbol, totalFeeBps }: {
  offerWei: bigint | null;
  qualifyingIds: string[];
  listings?: ListingLike[];
  currencySymbol: string;
  totalFeeBps: number;
}) {
  const ids = new Set(qualifyingIds);
  const floorWei = listings.reduce<bigint | null>((floor, listing) => {
    if (!ids.has(listing.tokenId)) return floor;
    try {
      const price = BigInt(listing.priceWei);
      return price > 0n && (floor === null || price < floor) ? price : floor;
    } catch { return floor; }
  }, null);
  const sellerNetWei = offerWei === null ? null : offerWei * BigInt(Math.max(0, 10_000 - totalFeeBps)) / 10_000n;
  const floorDelta = offerWei !== null && floorWei !== null && floorWei > 0n
    ? Number((offerWei - floorWei) * 10_000n / floorWei) / 100
    : null;

  return (
    <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-line bg-wood-950 p-1.5 sm:grid-cols-4" aria-label="Criteria bid value summary">
      <div className="rounded-md bg-panel px-2 py-2"><p className="text-[0.55rem] font-black uppercase tracking-wide text-cream-muted">Eligible</p><p className="mt-0.5 text-sm font-bold tabular-nums text-foreground">{qualifyingIds.length}</p></div>
      <div className="rounded-md bg-panel px-2 py-2"><p className="text-[0.55rem] font-black uppercase tracking-wide text-cream-muted">Criteria floor</p><p className="mt-0.5 text-sm font-bold tabular-nums text-foreground">{compactEth(floorWei)} {currencySymbol}</p></div>
      <div className="rounded-md bg-panel px-2 py-2"><p className="text-[0.55rem] font-black uppercase tracking-wide text-cream-muted">Bid vs floor</p><p className={`mt-0.5 text-sm font-bold tabular-nums ${floorDelta !== null && floorDelta >= 0 ? "text-emerald-300" : "text-foreground"}`}>{floorDelta === null ? "—" : `${floorDelta >= 0 ? "+" : ""}${floorDelta.toFixed(1)}%`}</p></div>
      <div className="rounded-md bg-panel px-2 py-2"><p className="text-[0.55rem] font-black uppercase tracking-wide text-cream-muted">Est. seller net</p><p className="mt-0.5 text-sm font-bold tabular-nums text-foreground">{compactEth(sellerNetWei)} {currencySymbol}</p><EthUsdValue wei={sellerNetWei} className="block text-[0.58rem] text-cream-muted" /></div>
      <p className="col-span-2 px-1 text-[0.58rem] text-cream-muted sm:col-span-4">One qualifying item can fill this bid. Balance, allowance, chain and final signed values are checked only when you continue to the wallet.</p>
    </div>
  );
}
