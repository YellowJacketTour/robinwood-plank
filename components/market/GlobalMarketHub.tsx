"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { chainDisplayName } from "@/lib/market/multichain/trading/foreign-chain-registry";

/**
 * Some collection images (any sourced from lib/market/multichain/adapters/
 * defillama-nft.ts) are cached URLs on img.reservoir.tools -- confirmed
 * live 2026-08-18 in a real browser: that domain no longer resolves at all
 * (ERR_NAME_NOT_RESOLVED), since Reservoir shut down its public
 * infrastructure in 2025 (see defillama-nft.ts's own header). A plain
 * <Image> with a dead src throws a real console error and shows a broken
 * image; this swaps to the same "?" placeholder used for a genuinely
 * absent imageUrl, so a real user never sees breakage from third-party
 * infrastructure this app doesn't control.
 */
function CollectionThumb({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <div className="flex h-full w-full items-center justify-center text-foreground/30">?</div>;
  }
  return <Image src={src} alt={alt} fill sizes="20vw" className="object-cover" unoptimized onError={() => setFailed(true)} />;
}

type TrackedCollection = {
  chainSlug: string;
  chainId: number | null;
  contractAddress: string;
  name: string | null;
  imageUrl: string | null;
  isVaultBacked: boolean;
  floorPriceWei: string | null;
  floorPriceCurrency: string | null;
  syncedAt: string | null;
};

/**
 * The "global market world" hub -- every collection this app tracks
 * outside Marketplank's own single RobinWood plank collection, browsable
 * by chain, one click into each collection's real buy/sweep/send surface
 * (MultichainCollectionView). Deliberately simple: this is the map, not
 * another place to shop from directly.
 *
 * NO "AFFILIATE COLLECTIONS FROM OUR OWN MINTING STUDIOS" SECTION YET --
 * HONEST GAP, NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 * plank_multichain_collections (migration 013) has no field distinguishing
 * a collection minted by this app's own studio tooling from any other
 * third-party collection someone tracked -- isVaultBacked is a DIFFERENT,
 * Robinhood-Chain-specific concept (whether MarketplankVaultV3 mechanics
 * apply), not "did we mint this." Building that distinction honestly needs
 * a real schema field (e.g. a `minted_by_us` column) set at seed/discover
 * time from actual knowledge of which collections came from this studio's
 * own minting flow, not a UI-side guess. Every collection here is grouped
 * only by chain until that field exists.
 */
export default function GlobalMarketHub() {
  const [collections, setCollections] = useState<TrackedCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chainFilter, setChainFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/market/multichain");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { collections: TrackedCollection[] };
        if (!cancelled) setCollections(data.collections ?? []);
      } catch {
        if (!cancelled) setLoadError("Could not load the global market index right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const chains = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of collections) seen.set(c.chainSlug, (seen.get(c.chainSlug) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [collections]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return collections.filter((c) => {
      if (chainFilter !== "all" && c.chainSlug !== chainFilter) return false;
      if (q && !(c.name ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [collections, chainFilter, search]);

  if (loading) {
    return <p className="p-6 text-center text-foreground/50">Loading the global market…</p>;
  }
  if (loadError) {
    return <p className="p-6 text-center text-red-300">{loadError}</p>;
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">Global Market</h2>
          <p className="text-xs text-foreground/50">
            {collections.length} collection{collections.length === 1 ? "" : "s"} tracked across{" "}
            {chains.length} chain{chains.length === 1 ? "" : "s"} — real listings, buy, sweep, and send on every one.
          </p>
        </div>
        <Link
          href="/market"
          className="min-h-11 flex items-center rounded-md border border-gold-400/50 px-3 text-sm font-bold text-gold-300 hover:border-gold-400"
        >
          ← Home: RobinWood Planks
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-2.5">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search collection name…"
          className="min-h-10 flex-1 min-w-[10rem] rounded-md border border-line bg-background px-3 text-sm text-foreground placeholder:text-foreground/30"
        />
        <select
          value={chainFilter}
          onChange={(e) => setChainFilter(e.target.value)}
          className="min-h-10 rounded-md border border-line bg-background px-2 text-sm text-foreground"
          aria-label="Filter by chain"
        >
          <option value="all">All chains</option>
          {chains.map(([slug, count]) => (
            <option key={slug} value={slug}>
              {chainDisplayName(slug)} ({count})
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="p-6 text-center text-foreground/45">No collections match.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {filtered.map((c) => (
            <li key={`${c.chainSlug}:${c.contractAddress}`}>
              <Link
                href={`/market/multichain/${c.chainSlug}/${encodeURIComponent(c.contractAddress)}`}
                className="dense-card flex flex-col overflow-hidden p-0 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong"
              >
                <div className="relative aspect-square w-full bg-wood-900">
                  <CollectionThumb src={c.imageUrl} alt={c.name ?? c.contractAddress} />
                </div>
                <div className="space-y-1 p-2.5">
                  <p className="truncate text-sm font-bold text-foreground">{c.name ?? c.contractAddress}</p>
                  <span className="inline-flex w-fit items-center rounded-full bg-[#58BDF0]/15 px-2 py-0.5 text-[0.55rem] font-black uppercase tracking-wider text-[#58BDF0]">
                    {chainDisplayName(c.chainSlug)}
                  </span>
                  {c.floorPriceWei && (
                    <p className="text-xs text-foreground/50">
                      Floor {(Number(c.floorPriceWei) / 1e18).toFixed(4)} {c.floorPriceCurrency ?? "ETH"}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
