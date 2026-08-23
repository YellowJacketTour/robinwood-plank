/**
 * Shared color-coding + human labels for real multi-venue ledger activity
 * (see lib/market/multichain/ledger-activity.ts). One source of truth so
 * ForeignActivityFeed.tsx (and any future consumer of the same
 * /api/market/multichain/activity union branch) render identical colors
 * for identical event kinds instead of drifting per-component copies.
 *
 * Palette intentionally distinguishes real economic direction, not just
 * "sale vs not": a pool-buy (user buys from an AMM pool, real demand) and
 * a pool-sell (user sells into a pool, real supply) are colored opposite
 * warm/cool tones the same way a sale (gold) and a wallet transfer (dim)
 * already are elsewhere in this app -- never collapsed into one generic
 * "sale" bucket, since Sudoswap's own direction column (053_sudoswap_fill_
 * index.sql) is real, first-party data, not a guess.
 */
import type { LedgerActivityKind, LedgerVenueId } from "@/lib/market/multichain/ledger-activity";

export const KIND_COLOR: Record<LedgerActivityKind, string> = {
  sale: "text-gold-300",
  transfer: "text-foreground/50",
  mint: "text-emerald-300",
  burn: "text-red-300",
  "listing-created": "text-sky-300",
  "listing-cancelled": "text-foreground/40",
  "bid-created": "text-violet-300",
  "bid-cancelled": "text-foreground/40",
  "pool-buy": "text-amber-300",
  "pool-sell": "text-cyan-300",
  siring: "text-pink-300",
};

export const KIND_LABEL: Record<LedgerActivityKind, string> = {
  sale: "Sale",
  transfer: "Transfer",
  mint: "Mint",
  burn: "Burn",
  "listing-created": "Listed",
  "listing-cancelled": "Delisted",
  "bid-created": "Bid",
  "bid-cancelled": "Bid cancelled",
  "pool-buy": "Bought from pool",
  "pool-sell": "Sold to pool",
  siring: "Siring rights",
};

export const VENUE_LABEL: Record<LedgerVenueId, string> = {
  "wallet-transfer": "Wallet transfer",
  seaport: "Seaport",
  wyvern: "OpenSea (Wyvern, legacy)",
  looksrare: "LooksRare",
  blur: "Blur",
  x2y2: "X2Y2",
  foundation: "Foundation",
  sudoswap: "Sudoswap (AMM pool)",
  rarible: "Rarible",
  "cryptokitties-auction": "CryptoKitties",
};

export function kindColor(kind: string): string {
  return KIND_COLOR[kind as LedgerActivityKind] ?? "text-foreground/60";
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as LedgerActivityKind] ?? kind;
}

export function venueLabel(venueId: string | null | undefined): string | null {
  if (!venueId) return null;
  return VENUE_LABEL[venueId as LedgerVenueId] ?? venueId;
}
