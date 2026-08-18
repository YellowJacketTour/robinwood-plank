"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import type { Listing } from "@/lib/market/types";
import { withImageWidth } from "@/lib/ipfs";
import { formatTokenAmount } from "@/lib/trade";
import type { SolanaListingVerification } from "@/app/api/market/multichain/solana-verify-listing/route";

type Props = {
  listing: Listing;
  collectionName: string;
  /** trait_type -> value -> count, from /api/market/multichain/traits. Null while loading. */
  traitCounts: Record<string, Record<string, number>> | null;
  /**
   * Only Solana listings get the real on-chain check below -- for Solana,
   * listing.tokenId IS the token mint (see listings/route.ts's "solana"
   * branch), the exact single-token lead solana-verify-listing/route.ts
   * needs. No EVM/Bitcoin equivalent is wired here: this stays scoped to
   * the ONE venue where this session built and verified a real, keyless
   * on-chain reader (magiceden-m2-onchain.ts) -- not a generic "verify any
   * chain" claim.
   */
  isSolana?: boolean;
  onClose: () => void;
};

/**
 * Real per-token traits with a real "N% of the collection has this" signal
 * per trait -- see traits/route.ts's header on why this is NOT a numeric
 * rank (that needs a full-collection indexing pass this app doesn't run
 * yet). totalForCategory sums one trait_type's own counts, which is a
 * real total-supply proxy (every token has exactly one value per
 * category) -- confirmed by the shape OpenSea's /traits response returns.
 */
export default function ForeignDetailsModal({ listing, collectionName, traitCounts, isSolana, onClose }: Props) {
  // ON-CHAIN VERIFICATION -- fires once per modal open, for this ONE token
  // only (a bounded, single-item action, never a scan). "idle" covers both
  // "not Solana" and "haven't started yet" so the section below can render
  // nothing until there's something real to say.
  const [verification, setVerification] = useState<SolanaListingVerification | "loading" | "idle">("idle");

  useEffect(() => {
    if (!isSolana) {
      setVerification("idle");
      return;
    }
    let cancelled = false;
    setVerification("loading");
    (async () => {
      try {
        const res = await fetch(`/api/market/multichain/solana-verify-listing?tokenMint=${encodeURIComponent(listing.tokenId)}`);
        const data = (await res.json()) as SolanaListingVerification;
        if (!cancelled) setVerification(data);
      } catch {
        if (!cancelled) setVerification({ verified: false, reason: "Could not reach the verification service." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSolana, listing.tokenId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" role="dialog" aria-modal="true">
      <div className="wood-ledger w-full max-w-md space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">
            {collectionName} #{listing.tokenId}
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300">
            ✕
          </button>
        </div>

        <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-wood-900">
          <Image src={withImageWidth(listing.imageUrl, 400) || ""} alt={`${collectionName} #${listing.tokenId}`} fill sizes="400px" className="object-cover" unoptimized />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2">
          <span className="text-xs text-foreground/60">Price</span>
          <span className="text-sm font-bold text-gold-300 tabular-nums">{formatTokenAmount(listing.priceWei, 18, 4)} Ξ</span>
        </div>

        {/* ON-CHAIN VERIFICATION -- Solana only, this one token only. Real
            getAccountInfo confirmation (magiceden-m2-onchain.ts), not just
            re-displaying Magic Eden's own API. See ForeignDetailsModal's
            isSolana prop comment for why this doesn't appear for other
            chains. */}
        {isSolana && verification !== "idle" && (
          <div className="rounded-lg border border-line bg-panel px-3 py-2">
            {verification === "loading" ? (
              <p className="text-xs text-foreground/45">Checking on-chain…</p>
            ) : verification.verified ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-foreground/60">
                  {verification.priceMatches ? "On-chain verified" : "On-chain price mismatch"}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide ${
                    verification.priceMatches ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
                  }`}
                  title={`Solana account ${verification.onchain.pda}`}
                >
                  {verification.priceMatches ? "Matches" : "Mismatch"}
                </span>
              </div>
            ) : (
              <p className="text-xs text-foreground/45">{verification.reason}</p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <h4 className="text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">Traits</h4>
          {!listing.traits || listing.traits.length === 0 ? (
            <p className="text-xs text-foreground/45">No trait data.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-1.5">
              {listing.traits.map((t) => {
                const categoryCounts = traitCounts?.[t.traitType];
                const total = categoryCounts ? Object.values(categoryCounts).reduce((s, n) => s + n, 0) : null;
                const count = categoryCounts?.[t.value];
                const pct = total && count ? ((count / total) * 100) : null;
                return (
                  <li key={t.traitType} className="rounded-md border border-line-strong bg-background px-2 py-1.5">
                    <p className="text-[0.55rem] uppercase tracking-wide text-foreground/40">{t.traitType}</p>
                    <p className="truncate text-xs font-bold text-foreground">{t.value}</p>
                    <p className="text-[0.6rem] text-foreground/45 tabular-nums">
                      {pct !== null ? `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}% have this` : "—"}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
