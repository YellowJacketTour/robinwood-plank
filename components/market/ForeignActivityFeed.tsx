"use client";

import Image from "next/image";
import { ArrowRight } from "lucide-react";
import { shortAddress } from "@/lib/trade";
import { tierAnimationClass, tierCardStyle, tierColor, tierGlow } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { normalizeRarityTier } from "@/lib/rarity";
import ScrollBox from "@/components/market/ScrollBox";
import { withImageWidth } from "@/lib/ipfs";
import { chainDisplayName } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { kindColor, kindLabel, venueLabel } from "@/lib/market/multichain/activity-kind-style";

export type ForeignActivityEvent = {
  type: string;
  timestamp: string;
  transaction: string | null;
  priceWei: string | null;
  priceSymbol: string | null;
  priceDecimals?: number | null;
  priceAmount?: string | null;
  priceUsd?: number | null;
  from: string | null;
  to: string | null;
  tokenId: string | null;
  tokenName: string | null;
  imageUrl?: string | null;
  blockNumber?: string | null;
  logIndex?: number | null;
  evidenceSource?: string | null;
  /** Only present on rows from the unioned first-party ledger
   * (ledger-activity.ts) -- OpenSea/Magic Eden-sourced rows have neither,
   * and the venue/batch chip below simply doesn't render for those. */
  venueId?: string | null;
  batchSize?: number | null;
  /** Real, pre-computed rarity from the SAME token-projection store the
   * collection grid reads (readProjectedTokensByIds) -- a per-row fallback
   * for a token this collection's full-set `rarity` map (fetched once,
   * separately, via /api/market/multichain/rarity) doesn't happen to cover
   * yet. Never fabricated: absent unless that store has really indexed
   * this exact token. */
  rarityRank?: number | null;
  rarityTier?: string | null;
};

function ago(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

type Props = {
  events: ForeignActivityEvent[];
  loading: boolean;
  chainSlug: string;
  rarity: Map<string, RarityLookup>;
  onSelectToken?: (tokenId: string) => void;
};

/**
 * Row-for-row visual match of ActivityFeed.tsx (dense-card grid, KIND_STYLE
 * color coding, tier-glow thumbnails, rarity badges, from->to arrow) --
 * deliberately a SEPARATE component rather than making the native
 * ActivityFeed itself chain-generic: that component is hard-wired to
 * Robinhood Chain's own /api/market/activity, Blockscout explorer links,
 * and marketplank/seaport/vault venue classification that has no meaning
 * for a foreign chain. Refactoring it in place would risk the native,
 * already-in-production page for a shared abstraction that saves little --
 * this mirrors its exact styling instead, safely, from foreign data.
 *
 * Tx hash is plain text, not an explorer link: unlike Robinhood Chain's
 * single Blockscout instance, linking out here would need a verified
 * explorer URL per one of 7 foreign chains -- left honest/unlinked rather
 * than guessed.
 */
export default function ForeignActivityFeed({ events, loading, chainSlug, rarity, onSelectToken }: Props) {
  if (loading) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg border border-line bg-panel-strong" />
        ))}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-panel-strong px-4 py-8 text-center">
        <p className="text-sm font-bold text-foreground/65">No activity yet.</p>
      </div>
    );
  }

  return (
    <>
      <div
        className="hidden grid-cols-[3.5rem_minmax(10rem,1fr)_6.5rem_10rem_2.5rem] gap-3 rounded-lg bg-[rgba(219,165,63,0.07)] px-2 py-1.5 text-[0.58rem] font-black uppercase tracking-wider text-foreground/45 xl:grid"
        aria-hidden="true"
      >
        <span>Art</span>
        <span>Event / item</span>
        <span>Price</span>
        <span>From / to</span>
        <span>When</span>
      </div>
      <ScrollBox storageKey={`foreign-activity-${chainSlug}`} defaultHeight={420} maxHeight={1000}>
        <ul className="space-y-1.5">
          {events.map((event, i) => {
            // Prefer the full-collection rarity map (has percentile + the
            // real plank-style display name); fall back to this row's own
            // rarityRank/rarityTier from the token-projection store when
            // the map hasn't resolved this token -- both are real,
            // pre-computed sources, never a guess.
            const mapRarity = event.tokenId ? rarity.get(event.tokenId) : undefined;
            const eventRarity: RarityLookup | undefined =
              mapRarity ??
              (event.rarityRank != null && event.rarityTier
                ? {
                    name: event.tokenName ?? (event.tokenId ? `#${event.tokenId}` : ""),
                    tier: normalizeRarityTier(event.rarityTier),
                    rank: event.rarityRank,
                    percentile: 0,
                  }
                : undefined);
            const selectable = Boolean(onSelectToken && event.tokenId);
            return (
              <li
                key={`${event.transaction ?? i}-${event.tokenId ?? i}-${event.type}-${i}`}
                className={`dense-card grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 p-2 xl:grid-cols-[3.5rem_minmax(10rem,1fr)_6.5rem_10rem_2.5rem] ${
                  selectable ? "cursor-pointer" : ""
                } ${eventRarity ? tierAnimationClass(eventRarity.tier) : ""}`}
                style={eventRarity ? tierCardStyle(eventRarity.tier) : undefined}
                role={selectable ? "button" : undefined}
                tabIndex={selectable ? 0 : undefined}
                onClick={selectable ? () => onSelectToken!(event.tokenId!) : undefined}
              >
                <div
                  className={`relative row-span-2 h-14 w-14 overflow-hidden rounded-lg bg-wood-900 xl:row-span-1 ${eventRarity ? "holo-card" : ""}`}
                  style={eventRarity ? { boxShadow: tierGlow(eventRarity.tier) } : undefined}
                >
                  {event.imageUrl ? (
                    <Image src={withImageWidth(event.imageUrl, 256)} alt={event.tokenId ? `#${event.tokenId}` : "item"} fill sizes="56px" className="object-cover" unoptimized />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[0.6rem] text-foreground/30">
                      {event.tokenId ? `#${event.tokenId}` : "?"}
                    </div>
                  )}
                </div>

                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={`shrink-0 text-xs font-bold ${kindColor(event.type)}`}>{kindLabel(event.type)}</span>
                    <span className="truncate text-xs font-bold text-foreground">
                      {eventRarity?.name ?? event.tokenName ?? (event.tokenId ? `#${event.tokenId}` : "")}
                    </span>
                    {eventRarity && (
                      <span className="tier-badge hidden rounded-full px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide sm:inline" style={{ color: tierColor(eventRarity.tier) }}>
                        {eventRarity.tier}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[0.6rem] text-foreground/40">
                    {event.tokenId ? `#${event.tokenId}` : ""}
                    {eventRarity ? ` · R${eventRarity.rank} · ${eventRarity.tier}` : ""}
                    {event.venueId ? ` · ${venueLabel(event.venueId)}` : ""}
                    {event.batchSize && event.batchSize > 1 ? ` · +${event.batchSize - 1} more` : ""}
                  </span>
                </div>

                <strong className="whitespace-nowrap text-right text-xs text-gold-300 xl:text-left">
                  {event.priceWei ? (
                    <>
                      <span className="block">
                        {event.priceAmount ?? "?"} {event.priceSymbol ?? "unknown"}
                      </span>
                      {event.priceUsd != null && (
                        <span className="block text-[0.6rem] font-normal text-foreground/50">
                          ≈ ${event.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </strong>

                <span className="hidden items-center gap-1 whitespace-nowrap font-mono text-[0.6rem] text-foreground/40 xl:inline-flex">
                  {event.from ? shortAddress(event.from) : "?"}
                  <ArrowRight size={12} strokeWidth={2.5} className="shrink-0" />
                  {event.to ? shortAddress(event.to) : "?"}
                </span>

                <span className="whitespace-nowrap text-right text-[0.65rem] text-foreground/40 xl:text-left">{ago(event.timestamp)}</span>
              </li>
            );
          })}
        </ul>
      </ScrollBox>
      <p className="mt-1 text-[0.6rem] text-foreground/35">On {chainDisplayName(chainSlug)}</p>
    </>
  );
}
