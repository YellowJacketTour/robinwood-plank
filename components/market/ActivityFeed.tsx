"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { shortAddress } from "@/lib/trade";
import {
  getRarityMap,
  tierAnimationClass,
  tierCardStyle,
  tierColor,
  tierGlow,
} from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import CollectionStats from "@/components/market/CollectionStats";
import ActivityStats from "@/components/market/ActivityStats";
import type { Listing, MarketCollection } from "@/lib/market/types";

type Venue = { kind: "marketplank" | "seaport" | "other"; contract: string } | null;

type ActivityEvent = {
  kind: "mint" | "sale" | "transfer";
  tokenId: string;
  from: string;
  to: string;
  priceWei: string | null;
  priceEth: string | null;
  txHash: string;
  timestamp: string | null;
  venue: Venue;
  imageUrl: string | null;
};

const KIND_STYLE: Record<ActivityEvent["kind"], string> = {
  sale: "text-gold-300",
  mint: "text-emerald-300",
  transfer: "text-foreground/50",
};

/**
 * Human label for a venue. "Marketplank" is only ever shown when the fill's
 * on-chain orderHash positively matched an order this relay actually served
 * — never just because the transaction touched our Seaport instance, which
 * is shared protocol infrastructure anyone can fulfill through. "Seaport"
 * means the trade went through that protocol but wasn't one of ours (most
 * likely a pre-launch fill, another Seaport-based frontend, or a script) —
 * deliberately not a guessed brand name we have no evidence for.
 */
function venueLabel(venue: Venue): string {
  if (!venue) return "—";
  if (venue.kind === "marketplank") return "Marketplank";
  if (venue.kind === "seaport") return "Seaport (other)";
  return shortAddress(venue.contract);
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** Explorer confirmed reachable during the audit. */
const EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";
const EXPLORER_ADDRESS = "https://robinhoodchain.blockscout.com/address/";

type KindFilter = "all" | ActivityEvent["kind"];

type Props = {
  /** Opens the shared item detail modal — same one the marketplace grid uses. */
  onSelectToken?: (tokenId: string) => void;
  /** Optional — when present, renders the same Floor/Listed/Items/Best-offer
   * strip Buy&Sell uses, plus a computed volume/sales sidebar, so the
   * Activity tab isn't just a bare list on a wide desktop screen. */
  collection?: MarketCollection;
  listings?: Listing[];
  offers?: Listing[];
  totalSupply?: number;
};

export default function ActivityFeed({
  onSelectToken,
  collection,
  listings,
  offers,
  totalSupply,
}: Props) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [venueFilter, setVenueFilter] = useState<string>("all");
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/market/activity")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data) => {
        if (!cancelled) setEvents(data.events ?? []);
      })
      .catch(() => {
        // Distinguish "nothing traded" from "we could not look" — showing an
        // empty feed for an RPC failure would misrepresent the collection.
        if (!cancelled) setFailed(true);
      });
    void getRarityMap().then((map) => {
      if (!cancelled) setRarity(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Options are derived from what's actually IN the feed — never a
  // hardcoded guess at which venues might show up.
  const venueOptions = useMemo(() => {
    if (!events) return [];
    const seen = new Map<string, string>();
    for (const e of events) {
      if (!e.venue) continue;
      const key = e.venue.kind === "marketplank" ? "marketplank" : e.venue.contract.toLowerCase();
      if (!seen.has(key)) seen.set(key, venueLabel(e.venue));
    }
    return [...seen.entries()];
  }, [events]);

  const filtered = useMemo(() => {
    if (!events) return [];
    return events.filter((e) => {
      if (kindFilter !== "all" && e.kind !== kindFilter) return false;
      if (venueFilter !== "all") {
        const key = e.venue ? (e.venue.kind === "marketplank" ? "marketplank" : e.venue.contract.toLowerCase()) : "none";
        if (key !== venueFilter) return false;
      }
      return true;
    });
  }, [events, kindFilter, venueFilter]);

  if (failed) {
    return <p className="py-6 text-center text-xs text-foreground/45">Activity unavailable.</p>;
  }
  if (events === null) {
    return <p className="py-6 text-center text-xs text-foreground/45">Loading…</p>;
  }
  if (events.length === 0) {
    return <p className="py-6 text-center text-xs text-foreground/45">No activity yet.</p>;
  }

  // Stats are computed from the FULL unfiltered feed (not `filtered`) — the
  // sidebar should always answer "what's this collection actually doing,"
  // not shift every time someone narrows the list below it.
  const sales = events.filter((e) => e.kind === "sale");

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start xl:grid-cols-[minmax(0,1fr)_320px]">
    <div className="min-w-0 space-y-2">
      {collection && (
        <CollectionStats
          collection={collection}
          listings={listings ?? []}
          offers={offers ?? []}
          totalSupply={totalSupply}
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1.5">
          <span className="sr-only">Filter by event type</span>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as KindFilter)}
            className="min-h-9 rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground"
          >
            <option value="all">All events</option>
            <option value="sale">Sales</option>
            <option value="mint">Mints</option>
            <option value="transfer">Transfers</option>
          </select>
        </label>
        {venueOptions.length > 0 && (
          <label className="flex items-center gap-1.5">
            <span className="sr-only">Filter by platform</span>
            <select
              value={venueFilter}
              onChange={(e) => setVenueFilter(e.target.value)}
              className="min-h-9 rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground"
            >
              <option value="all">All platforms</option>
              {venueOptions.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="ml-auto whitespace-nowrap text-[0.65rem] text-foreground/45">
          {filtered.length} of {events.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="py-6 text-center text-xs text-foreground/45">No matches.</p>
      ) : (
        <ul className="space-y-1.5">
          {filtered.map((e) => {
            const r = rarity.get(e.tokenId);
            const selectable = Boolean(onSelectToken);
            return (
              <li
                key={`${e.txHash}-${e.tokenId}`}
                className={`dense-card flex items-center gap-3 p-2 ${selectable ? "cursor-pointer" : ""} ${
                  r ? `${tierAnimationClass(r.tier)} holo-card` : ""
                }`}
                style={r ? tierCardStyle(r.tier) : undefined}
                role={selectable ? "button" : undefined}
                tabIndex={selectable ? 0 : undefined}
                aria-label={selectable ? `View #${e.tokenId}` : undefined}
                onClick={selectable ? () => onSelectToken!(e.tokenId) : undefined}
                onKeyDown={
                  selectable
                    ? (ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          onSelectToken!(e.tokenId);
                        }
                      }
                    : undefined
                }
              >
                {/* Artwork leads every row — the site's own "visually
                    dominant, text supplemental" rule applied to the feed. A
                    tier-colored ring reuses the exact same rarity math and
                    palette as the Gallery page, never a second color system. */}
                <div
                  className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-wood-900 ${
                    r ? tierAnimationClass(r.tier) : ""
                  }`}
                  style={r ? { boxShadow: tierGlow(r.tier) } : undefined}
                >
                  {e.imageUrl ? (
                    <Image
                      src={e.imageUrl}
                      alt={`#${e.tokenId}`}
                      fill
                      sizes="56px"
                      className="object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[0.6rem] text-foreground/30">
                      #{e.tokenId}
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a
                      href={`${EXPLORER_TX}${e.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(ev) => ev.stopPropagation()}
                      className={`text-xs font-bold capitalize hover:underline ${KIND_STYLE[e.kind]}`}
                    >
                      {e.kind}
                    </a>
                    <span className="text-xs font-bold text-foreground">#{e.tokenId}</span>
                    {r && (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide text-wood-950 shadow-[0_1px_3px_rgba(0,0,0,0.6)]"
                        style={{ backgroundColor: tierColor(r.tier) }}
                      >
                        {r.tier}
                      </span>
                    )}
                    <span className="whitespace-nowrap text-xs font-bold text-gold-300">
                      {e.priceEth
                        ? `${Number(e.priceEth).toFixed(4)} Ξ`
                        : e.kind === "sale"
                          ? "price unavailable"
                          : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.65rem] text-foreground/50">
                    <span>
                      {e.venue ? (
                        e.venue.kind === "marketplank" ? (
                          <span className="text-emerald-300" title="This fill's on-chain order hash matched an order we actually served — not just a guess from the contract address.">
                            Marketplank
                          </span>
                        ) : (
                          <a
                            href={`${EXPLORER_ADDRESS}${e.venue.contract}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(ev) => ev.stopPropagation()}
                            className="hover:underline"
                            title={
                              e.venue.kind === "seaport"
                                ? "Went through the Seaport protocol, but not an order we served — likely another Seaport-based frontend, a pre-launch fill, or a script. Not attributed to any specific brand without evidence."
                                : "Executed via a contract we don't recognize — some other marketplace, router, or script on this chain."
                            }
                          >
                            {venueLabel(e.venue)}
                          </a>
                        )
                      ) : (
                        "wallet-to-wallet"
                      )}
                    </span>
                    <span className="hidden sm:inline">
                      {shortAddress(e.from)} → {shortAddress(e.to)}
                    </span>
                  </div>
                </div>

                <span className="shrink-0 whitespace-nowrap text-[0.65rem] text-foreground/40">
                  {ago(e.timestamp)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>

      {/* Desktop-only sidebar — on a phone this content would just push the
          list below the fold, so it only renders at lg+ where there's
          otherwise dead space next to a comfortably-narrow activity list. */}
      <div className="hidden lg:block lg:sticky lg:top-4">
        <ActivityStats sales={sales} rarity={rarity} onSelectToken={onSelectToken} />
      </div>
    </div>
  );
}
