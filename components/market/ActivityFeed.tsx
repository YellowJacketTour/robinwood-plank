"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ArrowRight } from "lucide-react";
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
import ScrollBox from "@/components/market/ScrollBox";
import type { Listing, MarketCollection } from "@/lib/market/types";
import { invalidateSwr, swrJson } from "@/lib/market/swr-fetch";
import { withImageWidth } from "@/lib/ipfs";
import { SkeletonBlock, SkeletonStatus } from "@/components/Skeleton";

type Venue = { kind: "marketplank" | "seaport" | "vault" | "other"; contract: string } | null;

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

/** True for a real 0x-prefixed 20-byte contract address, false for the
 * occasional bare method name ("multicall", "transferfrom") a venue's
 * `contract` field can carry when the Blockscout feed had no cleaner
 * signal — those must never be treated as a linkable address or a dropdown
 * option, or the "All platforms" filter fills up with raw method fragments. */
function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Human label for a venue. "Marketplank" is only ever shown when the fill's
 * on-chain orderHash positively matched an order this relay actually served
 * — never just because the transaction touched our Seaport instance, which
 * is shared protocol infrastructure anyone can fulfill through. "Seaport"
 * means the trade went through that protocol but wasn't one of ours (most
 * likely a pre-launch fill, another Seaport-based frontend, or a script) —
 * deliberately not a guessed brand name we have no evidence for. "vault"
 * means it moved through our own MarketplankVault (a deposit or redeem, not
 * a sale — priced separately in VaultTradeHistory, never here).
 */
function venueLabel(venue: Venue): string {
  if (!venue) return "—";
  if (venue.kind === "marketplank") return "Marketplank";
  if (venue.kind === "seaport") return "Seaport (other)";
  if (venue.kind === "vault") return "Vault";
  return isAddress(venue.contract) ? shortAddress(venue.contract) : "Other contract";
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

const VENUE_KIND_LABELS: Record<"marketplank" | "seaport" | "vault" | "other", string> = {
  marketplank: "Marketplank",
  seaport: "Seaport (other)",
  vault: "Vault",
  other: "Other contracts",
};

function VenueValue({ venue }: { venue: Venue }) {
  if (!venue) return <>wallet-to-wallet</>;
  if (venue.kind === "marketplank") {
    return (
      <span
        className="text-emerald-300"
        title="This fill's on-chain order hash matched an order we actually served — not just a guess from the contract address."
      >
        Marketplank
      </span>
    );
  }
  if (venue.kind === "vault") {
    return (
      <span
        className="text-sky-300"
        title="Moved through the liquidity vault — a deposit or redeem, not a marketplace sale. See the Liquidity pool trades table below for its real numbers."
      >
        Vault
      </span>
    );
  }
  const title =
    venue.kind === "seaport"
      ? "Went through the Seaport protocol, but not an order we served — likely another Seaport-based frontend, a pre-launch fill, or a script. Not attributed to any specific brand without evidence."
      : "Executed via a contract we don't recognize — some other marketplace, router, or script on this chain.";

  // Only link out when the venue actually carries a real contract address —
  // some "other" fills only ever resolved a bare method name, and linking
  // that to the block explorer would 404.
  if (!isAddress(venue.contract)) {
    return <span title={title}>{venueLabel(venue)}</span>;
  }

  return (
    <a
      href={`${EXPLORER_ADDRESS}${venue.contract}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="hover:underline"
      title={title}
    >
      {venueLabel(venue)}
    </a>
  );
}

function FeedSkeleton() {
  return (
    <>
      <SkeletonStatus>Loading market activity</SkeletonStatus>
      <div className="space-y-1.5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="grid grid-cols-[3.5rem_minmax(0,1fr)_3rem] items-center gap-3 rounded-lg border border-line bg-panel-strong p-2"
          >
            <SkeletonBlock className="h-14 w-14" />
            <div className="space-y-2">
              <SkeletonBlock className="h-3 w-2/3" />
              <SkeletonBlock className="h-2.5 w-1/2" />
            </div>
            <SkeletonBlock className="h-3" />
          </div>
        ))}
      </div>
    </>
  );
}

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

// Module snapshot for instant first paint before SWR resolves — shared with
// MarketView's mount prefetch via swrJson (same URLs).
let cachedEvents: ActivityEvent[] | null = null;
let cachedFullEvents: ActivityEvent[] | null = null;

export default function ActivityFeed({
  onSelectToken,
  collection,
  listings,
  offers,
  totalSupply,
}: Props) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(cachedEvents);
  const [fullEvents, setFullEvents] = useState<ActivityEvent[] | null>(cachedFullEvents);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [venueFilter, setVenueFilter] = useState<string>("all");
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());

  useEffect(() => {
    let cancelled = false;
    // Shared SWR: hits memory/session filled by MarketView prefetch, then
    // edge/server cache. Soft-stale still paints instantly + revalidates.
    swrJson<{ events?: ActivityEvent[] }>("/api/market/activity", {
      ttlMs: 20_000,
      swrMs: 120_000,
      session: true,
    })
      .then((data) => {
        const next = data.events ?? [];
        cachedEvents = next;
        if (!cancelled) {
          setEvents(next);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled && (!cachedEvents || cachedEvents.length === 0)) {
          setFailed(true);
        }
      });
    void getRarityMap().then((map) => {
      if (!cancelled) setRarity(map);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    swrJson<{ events?: ActivityEvent[] }>("/api/market/activity?full=1", {
      ttlMs: 45_000,
      swrMs: 180_000,
      session: true,
    })
      .then((data) => {
        const next = data.events ?? [];
        cachedFullEvents = next;
        if (!cancelled) setFullEvents(next);
      })
      .catch(() => {
        // Stats sidebar falls back to the capped recent list.
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const retry = () => {
    invalidateSwr("/api/market/activity");
    invalidateSwr("/api/market/sales-history");
    invalidateSwr("/api/market/sales-stats");
    setFailed(false);
    setReloadKey((value) => value + 1);
  };

  const clearFilters = () => {
    setKindFilter("all");
    setVenueFilter("all");
  };

  // Named venues only, never raw contract addresses or method fragments —
  // one collapsed "Other contracts" option covers every venue.kind === "other"
  // event instead of listing each distinct address/method it happened to
  // carry. Options are still derived from what's actually IN the feed, just
  // grouped by kind rather than by raw contract text.
  const venueOptions = useMemo(() => {
    if (!events) return [];
    const present = new Set<string>();
    for (const e of events) {
      if (e.venue) present.add(e.venue.kind);
    }
    return (["marketplank", "seaport", "vault", "other"] as const)
      .filter((kind) => present.has(kind))
      .map((kind) => [kind, VENUE_KIND_LABELS[kind]] as const);
  }, [events]);

  const filtered = useMemo(() => {
    if (!events) return [];
    return events.filter((e) => {
      if (kindFilter !== "all" && e.kind !== kindFilter) return false;
      if (venueFilter !== "all") {
        const key = e.venue ? e.venue.kind : "none";
        if (key !== venueFilter) return false;
      }
      return true;
    });
  }, [events, kindFilter, venueFilter]);

  // Stats prefer the deeper full=1 lineage (300 events, same source
  // EventCountdown's "highest sale ever" uses) over the capped 40-row recent
  // feed — the 40-cap mixes in mints/transfers/vault moves alongside sales,
  // so real sales fall out of that window fast and volume/avg/history
  // undercounted. Falls back to the recent feed's own sales until the
  // full-lineage fetch resolves, rather than showing nothing.
  const sales = (fullEvents ?? events ?? []).filter((e) => e.kind === "sale");

  const loading = events === null && !failed;
  const hasFilters = kindFilter !== "all" || venueFilter !== "all";

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
              disabled={loading || failed || (events?.length ?? 0) === 0}
              onChange={(event) => setKindFilter(event.target.value as KindFilter)}
              className="min-h-9 rounded-md border border-line bg-wood-950 px-2 text-xs text-foreground disabled:opacity-50"
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
                onChange={(event) => setVenueFilter(event.target.value)}
                className="min-h-9 rounded-md border border-line bg-wood-950 px-2 text-xs text-foreground"
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
            {loading
              ? "Loading events…"
              : failed
                ? "Feed unavailable"
                : `${filtered.length} of ${events?.length ?? 0}`}
          </span>
        </div>

        <div
          className="hidden grid-cols-[3.5rem_minmax(10rem,1fr)_6.5rem_8rem_10rem_2.5rem] gap-3 rounded-lg bg-[rgba(219,165,63,0.07)] px-2 py-1.5 text-[0.58rem] font-black uppercase tracking-wider text-foreground/45 xl:grid"
          aria-hidden="true"
        >
          <span>Art</span>
          <span>Event / item</span>
          <span>Price</span>
          <span>Platform</span>
          <span>From / to</span>
          <span>When</span>
        </div>

        {loading ? (
          <FeedSkeleton />
        ) : failed ? (
          <div className="rounded-lg border border-red-500/25 bg-red-950/15 px-4 py-8 text-center">
            <p className="text-sm font-bold text-red-200">Activity unavailable.</p>
            <p className="mt-1 text-xs text-foreground/50">
              The last good market statistics stay visible while the feed reconnects.
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-4 min-h-11 rounded-md border border-line-strong px-4 text-xs font-bold text-gold-300 transition hover:border-gold-400"
            >
              Retry activity
            </button>
          </div>
        ) : (events?.length ?? 0) === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-panel-strong px-4 py-8 text-center">
            <p className="text-sm font-bold text-foreground/65">No activity yet.</p>
            <button
              type="button"
              onClick={retry}
              className="mt-4 min-h-11 rounded-md border border-line-strong px-4 text-xs font-bold text-gold-300 transition hover:border-gold-400"
            >
              Reload activity
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-panel-strong px-4 py-8 text-center">
            <p className="text-sm font-bold text-foreground/65">
              No activity matches these filters.
            </p>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="mt-4 min-h-11 rounded-md bg-gold-500 px-4 text-xs font-bold text-wood-950 transition hover:bg-gold-400"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <ScrollBox storageKey="activity-feed" defaultHeight={420} maxHeight={1000}>
            <ul className="space-y-1.5">
              {filtered.map((event) => {
                const eventRarity = rarity.get(event.tokenId);
                const selectable = Boolean(onSelectToken);
                return (
                  <li
                    key={`${event.txHash}-${event.tokenId}`}
                    className={`dense-card grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 p-2 xl:grid-cols-[3.5rem_minmax(10rem,1fr)_6.5rem_8rem_10rem_2.5rem] ${
                      selectable ? "cursor-pointer" : ""
                    } ${eventRarity ? tierAnimationClass(eventRarity.tier) : ""}`}
                    style={eventRarity ? tierCardStyle(eventRarity.tier) : undefined}
                    role={selectable ? "button" : undefined}
                    tabIndex={selectable ? 0 : undefined}
                    aria-label={selectable ? `View #${event.tokenId}` : undefined}
                    onClick={selectable ? () => onSelectToken!(event.tokenId) : undefined}
                    onKeyDown={
                      selectable
                        ? (keyboardEvent) => {
                            if (
                              keyboardEvent.key === "Enter" ||
                              keyboardEvent.key === " "
                            ) {
                              keyboardEvent.preventDefault();
                              onSelectToken!(event.tokenId);
                            }
                          }
                        : undefined
                    }
                  >
                    <div
                      className={`relative row-span-2 h-14 w-14 overflow-hidden rounded-lg bg-wood-900 xl:row-span-1 ${
                        eventRarity ? "holo-card" : ""
                      }`}
                      style={
                        eventRarity
                          ? { boxShadow: tierGlow(eventRarity.tier) }
                          : undefined
                      }
                    >
                      {event.imageUrl ? (
                        <Image
                          src={withImageWidth(event.imageUrl, 256)}
                          alt={`#${event.tokenId}`}
                          fill
                          sizes="56px"
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[0.6rem] text-foreground/30">
                          #{event.tokenId}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <a
                          href={`${EXPLORER_TX}${event.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(clickEvent) => clickEvent.stopPropagation()}
                          className={`shrink-0 text-xs font-bold capitalize hover:underline ${KIND_STYLE[event.kind]}`}
                        >
                          {event.kind}
                        </a>
                        <span className="truncate text-xs font-bold text-foreground">
                          {eventRarity?.name ?? `#${event.tokenId}`}
                        </span>
                        {eventRarity && (
                          <span
                            className="tier-badge hidden rounded-full px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide sm:inline"
                            style={{ color: tierColor(eventRarity.tier) }}
                          >
                            {eventRarity.tier}
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[0.6rem] text-foreground/40">
                        #{event.tokenId}
                        {eventRarity
                          ? ` · R${eventRarity.rank} · ${eventRarity.tier}`
                          : ""}
                      </span>
                    </div>

                    <strong className="whitespace-nowrap text-right text-xs text-gold-300 xl:text-left">
                      {event.priceEth
                        ? `${Number(event.priceEth).toFixed(4)} Ξ`
                        : event.kind === "sale"
                          ? "Unavailable"
                          : "—"}
                    </strong>

                    <span className="min-w-0 truncate text-[0.65rem] text-foreground/50">
                      <VenueValue venue={event.venue} />
                    </span>

                    <span className="hidden items-center gap-1 whitespace-nowrap font-mono text-[0.6rem] text-foreground/40 xl:inline-flex">
                      {shortAddress(event.from)}
                      <ArrowRight size={12} strokeWidth={2.5} className="shrink-0" />
                      {shortAddress(event.to)}
                    </span>

                    <span className="whitespace-nowrap text-right text-[0.65rem] text-foreground/40 xl:text-left">
                      {ago(event.timestamp)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </ScrollBox>
        )}
      </div>

      <div className="lg:sticky lg:top-4">
        <ActivityStats
          sales={sales}
          loading={loading}
          unavailable={failed}
          reloadKey={reloadKey}
        />
      </div>
    </div>
  );
}
