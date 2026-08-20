"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import type { Listing } from "@/lib/market/types";
import { withImageWidth } from "@/lib/ipfs";
import { formatTokenAmount } from "@/lib/trade";
import type { SolanaListingVerification } from "@/app/api/market/multichain/solana-verify-listing/route";
import ChainIcon from "@/components/market/ChainIcon";
import { formatRank } from "@/lib/rarity";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";

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
  /** Real per-chain native currency this listing's priceWei is denominated in (see nativeCurrencySymbol in foreign-chain-registry.ts). Defaults to "ETH" only as a last resort -- callers should always pass the real value. */
  currencySymbol?: string;
  /** Real chain slug for ChainIcon's own recognizable per-chain mark instead of a plain-text ticker abbreviation. Defaults to "robinhood" to match currencySymbol's own "ETH" default. */
  chainSlug?: string;
  /** Same information-content rank/percentile as RobinWood ItemDetail when indexed. */
  rarity?: RarityLookup | null;
};

/**
 * Real per-token traits with a real "N% of the collection has this" signal
 * per trait -- see traits/route.ts's header on why this is NOT a numeric
 * rank (that needs a full-collection indexing pass this app doesn't run
 * yet). totalForCategory sums one trait_type's own counts, which is a
 * real total-supply proxy (every token has exactly one value per
 * category) -- confirmed by the shape OpenSea's /traits response returns.
 */
export function lookupTraitCategory(
  counts: Record<string, Record<string, number>> | null,
  traitType: string
): Record<string, number> | undefined {
  if (!counts) return undefined;
  if (counts[traitType]) return counts[traitType];
  const needle = traitType.toLowerCase();
  const hit = Object.entries(counts).find(([k]) => k.toLowerCase() === needle);
  return hit?.[1];
}

export function lookupTraitCount(category: Record<string, number>, value: string): number | undefined {
  if (category[value] != null) return category[value];
  const needle = value.toLowerCase();
  const hit = Object.entries(category).find(([k]) => k.toLowerCase() === needle);
  return hit?.[1];
}

export default function ForeignDetailsModal({ listing, collectionName, traitCounts, isSolana, onClose, currencySymbol = "ETH", chainSlug = "robinhood", rarity = null }: Props) {
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

  const shortId =
    listing.tokenId.length > 12 ? `${listing.tokenId.slice(0, 4)}…${listing.tokenId.slice(-4)}` : listing.tokenId;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" role="dialog" aria-modal="true">
      <div className="wood-ledger max-h-[92vh] w-full max-w-md space-y-3 overflow-y-auto p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 font-display text-lg leading-tight text-gold-300">
            <span className="block truncate">{collectionName}</span>
            <span className="mt-0.5 block break-all font-sans text-[0.7rem] font-semibold tracking-normal text-gold-300/80" title={listing.tokenId}>
              #{shortId}
            </span>
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300">
            ✕
          </button>
        </div>

        <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-wood-900">
          <Image src={withImageWidth(listing.imageUrl, 400) || ""} alt={`${collectionName} #${listing.tokenId}`} fill sizes="400px" className="object-cover" unoptimized />
        </div>

        {rarity && (
          <dl className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
              <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Rank</dt>
              <dd className="mt-1 text-xs font-bold" style={{ color: tierColor(rarity.tier) }}>
                {formatRank(rarity.rank)} · {rarity.tier}
              </dd>
            </div>
            <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
              <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Exclusivity</dt>
              <dd className="mt-1 text-xs font-bold text-foreground">
                {rarity.percentile.toFixed(1)}
                <span className="text-foreground/45"> · rarer than this % of the indexed collection</span>
              </dd>
            </div>
          </dl>
        )}

        <div className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2">
          <span className="text-xs text-foreground/60">Price</span>
          <span
            className="flex items-center gap-1.5 text-[clamp(0.8rem,3.5vw,1rem)] font-bold text-gold-300 tabular-nums"
            aria-label={`${formatTokenAmount(listing.priceWei, 18, 4)} ${currencySymbol}`}
          >
            {formatTokenAmount(listing.priceWei, 18, 4)}
            <ChainIcon chainSlug={chainSlug} size={18} className="shrink-0" />
          </span>
        </div>

        {/* ON-CHAIN VERIFICATION -- Solana only, this one token only. Real
            getAccountInfo confirmation (magiceden-m2-onchain.ts), not just
            re-displaying Magic Eden's own API. See ForeignDetailsModal's
            isSolana prop comment for why this doesn't appear for other
            chains. */}
        {isSolana && verification !== "idle" && (
          <div className="rounded-lg border border-line bg-panel px-3 py-2">
            {verification === "loading" ? (
              <p className="flex items-center gap-1.5 text-xs text-foreground/45">
                <Loader2 size={13} strokeWidth={2.5} className="animate-spin motion-reduce:animate-none" aria-hidden />
                Checking on-chain…
              </p>
            ) : verification.verified ? (
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs text-foreground/60">
                  {verification.priceMatches ? (
                    <ShieldCheck size={14} strokeWidth={2.5} className="success-pop text-emerald-300" aria-hidden />
                  ) : (
                    <ShieldAlert size={14} strokeWidth={2.5} className="text-red-300" aria-hidden />
                  )}
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
              <p className="flex items-center gap-1.5 text-xs text-foreground/45">
                <ShieldAlert size={13} strokeWidth={2.5} className="shrink-0 text-foreground/35" aria-hidden />
                {verification.reason || "Could not verify this listing on-chain."}
              </p>
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
                const categoryCounts = lookupTraitCategory(traitCounts, t.traitType);
                const total = categoryCounts ? Object.values(categoryCounts).reduce((s, n) => s + n, 0) : null;
                const count = categoryCounts ? lookupTraitCount(categoryCounts, t.value) : undefined;
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
