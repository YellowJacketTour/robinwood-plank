"use client";

/**
 * Desktop: table (item, type, price, expiry, action).
 * Mobile: same data as stacked cards — see docs/marketplank/SPEC.md §4.
 * Empty until wallet connection + order-relay API exist.
 */
export default function MyPositions() {
  return (
    <div className="wood-ledger p-3">
      <p className="rounded-lg border border-dashed border-gold-500/30 bg-wood-900/40 px-4 py-8 text-center text-sm text-foreground/60">
        Connect your wallet to see your listings, offers, and vault positions.
      </p>
    </div>
  );
}
