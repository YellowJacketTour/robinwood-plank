"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import GlobalMarketHub from "@/components/market/GlobalMarketHub";
import ForeignSwapComingSoon from "@/components/market/ForeignSwapComingSoon";
import MarketNav from "@/components/market/MarketNav";
import { MarketTabRail, MarketTabPanel, MarketWalletGate } from "@/components/market/MarketScaffold";
import { MARKET_TABS } from "@/lib/market/navigation";
import { useWallet } from "@/lib/wallet-context";
import { connectWallet } from "@/lib/wallet";
import { swrJson } from "@/lib/market/swr-fetch";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { chainDisplayName } from "@/lib/market/multichain/trading/foreign-chain-registry";
import type { MarketTab } from "@/lib/market/types";

type OwnedItem = { chainSlug: string; contractAddress: string; collectionName: string | null; tokenId: string };
type AccountEvent = {
  type: string;
  timestamp: string;
  transaction: string | null;
  chain: string | null;
  priceWei: string | null;
  priceSymbol: string | null;
  collection: string | null;
  tokenId: string | null;
};
type WalletSummary = {
  distinctCollectionCount: number;
  truncated: boolean;
  myListings: Array<{ chainSlug: string; collectionName: string | null; tokenId: string; priceWei: string }>;
  offers: Array<{ chainSlug: string; collectionName: string | null; priceWei: string; maker: string }>;
};

/**
 * The GLOBAL (all-chains, all-collections) counterpart to MarketView's
 * native tab rail -- same MARKET_TABS, same MarketNav/MarketTabPanel
 * components, so the two surfaces read as one product rather than two.
 *
 * SCOPE, PER THE OWNER'S OWN CALL: global Buy & Sell stays the collection
 * browser (aggregating literal listings across every tracked collection
 * into one feed is a different, much heavier feature nobody asked for
 * yet). Offers/Activity/My NFTs/My Listings are WALLET-SCOPED here --
 * "what's relevant to you across chains" -- rather than an aggregate of
 * every tracked collection's feed, which would mean fanning out to dozens
 * of collections on every page load. Drilling into one collection (via
 * Buy & Sell -> a card) gets the full unscoped per-collection view.
 */
export default function GlobalMultichainMarketView() {
  const { address: account, adoptAccount } = useWallet();
  const [tab, setTab] = useState<MarketTab>("buy-sell");

  const [owned, setOwned] = useState<OwnedItem[]>([]);
  const [ownedLoading, setOwnedLoading] = useState(false);

  const [activity, setActivity] = useState<AccountEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const loadOwned = useCallback(async () => {
    if (!account) {
      setOwned([]);
      return;
    }
    setOwnedLoading(true);
    try {
      const data = await swrJson<{ items: OwnedItem[] }>(`/api/market/multichain/owned-all?owner=${account}`, {
        ttlMs: 30_000,
        swrMs: 180_000,
        session: true,
      });
      setOwned(data.items ?? []);
    } catch {
      setOwned([]);
    } finally {
      setOwnedLoading(false);
    }
  }, [account]);

  const loadActivity = useCallback(async () => {
    if (!account) {
      setActivity([]);
      return;
    }
    setActivityLoading(true);
    try {
      const data = await swrJson<{ events: AccountEvent[] }>(
        `/api/market/multichain/account-activity?owner=${account}&limit=25`,
        { ttlMs: 30_000, swrMs: 180_000, session: true }
      );
      setActivity(data.events ?? []);
    } catch {
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, [account]);

  const loadSummary = useCallback(async () => {
    if (!account) {
      setSummary(null);
      return;
    }
    setSummaryLoading(true);
    try {
      // Heavier than owned-all (fans out per distinct collection to resolve
      // your listings + collection offers) -- loaded on demand for the
      // Offers/My Listings tabs, not on every page mount.
      const data = await swrJson<WalletSummary>(`/api/market/multichain/wallet-summary?owner=${account}`, {
        ttlMs: 30_000,
        swrMs: 180_000,
        session: true,
      });
      setSummary(data);
    } catch {
      setSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, [account]);

  useEffect(() => {
    void loadOwned();
  }, [loadOwned]);

  useEffect(() => {
    if (tab === "activity") void loadActivity();
    if (tab === "offers" || tab === "positions") void loadSummary();
  }, [tab, loadActivity, loadSummary]);

  const requireAccount = useCallback(async () => {
    if (account) return account;
    try {
      const addr = await connectWallet();
      adoptAccount(addr);
      return addr;
    } catch {
      return null;
    }
  }, [account, adoptAccount]);

  const ownedByCollection = new Map<string, { chainSlug: string; contractAddress: string; collectionName: string | null; count: number }>();
  for (const item of owned) {
    const key = `${item.chainSlug}:${item.contractAddress.toLowerCase()}`;
    const existing = ownedByCollection.get(key);
    if (existing) existing.count += 1;
    else ownedByCollection.set(key, { chainSlug: item.chainSlug, contractAddress: item.contractAddress, collectionName: item.collectionName, count: 1 });
  }
  const ownedCollections = [...ownedByCollection.values()];

  return (
    <div className="space-y-4">
      <MarketTabRail navigation={<MarketNav active={tab} onChange={setTab} tabs={MARKET_TABS} />} />

      <MarketTabPanel id="buy-sell" active={tab === "buy-sell"}>
        <GlobalMarketHub />
      </MarketTabPanel>

      <MarketTabPanel id="swap" active={tab === "swap"}>
        <ForeignSwapComingSoon />
      </MarketTabPanel>

      <MarketTabPanel id="offers" active={tab === "offers"}>
        {!account ? (
          <MarketWalletGate
            title="See offers on what you own"
            description="Connect your wallet to see active bids on collections you hold tokens in, across every chain."
            onConnect={() => void requireAccount()}
          />
        ) : (
          <div className="space-y-2 rounded-lg border border-line bg-panel p-3">
            <h3 className="text-xs font-black uppercase tracking-wide text-foreground/60">
              Offers on your collections {summary && summary.offers.length > 0 ? `(${summary.offers.length})` : ""}
            </h3>
            {summary?.truncated && (
              <p className="text-[0.6rem] text-foreground/40">
                Showing your first {summary.distinctCollectionCount > 10 ? 10 : summary.distinctCollectionCount} collections — you hold tokens in {summary.distinctCollectionCount}.
              </p>
            )}
            {summaryLoading ? (
              <p className="text-xs text-foreground/45">Loading offers…</p>
            ) : !summary || summary.offers.length === 0 ? (
              <p className="text-xs text-foreground/45">No active offers on collections you own into right now.</p>
            ) : (
              <ul className="space-y-1.5">
                {summary.offers.map((o, i) => (
                  <li key={`${o.maker}-${i}`} className="flex items-center justify-between text-xs">
                    <span className="text-foreground">
                      <span className="font-bold">{formatTokenAmount(o.priceWei, 18, 4)} Ξ</span>{" "}
                      <span className="text-foreground/45">on {o.collectionName ?? "collection"} ({chainDisplayName(o.chainSlug)})</span>
                    </span>
                    <span className="text-foreground/45">by {shortAddress(o.maker)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </MarketTabPanel>

      <MarketTabPanel id="activity" active={tab === "activity"}>
        {!account ? (
          <MarketWalletGate
            title="See your activity"
            description="Connect your wallet to see your recent sales and transfers across every chain."
            onConnect={() => void requireAccount()}
          />
        ) : (
          <div className="space-y-2 rounded-lg border border-line bg-panel p-3">
            <h3 className="text-xs font-black uppercase tracking-wide text-foreground/60">Your activity</h3>
            {activityLoading ? (
              <p className="text-xs text-foreground/45">Loading activity…</p>
            ) : activity.length === 0 ? (
              <p className="text-xs text-foreground/45">No recent activity.</p>
            ) : (
              <ul className="space-y-1.5">
                {activity.map((e, i) => (
                  <li key={`${e.transaction ?? i}-${i}`} className="flex flex-wrap items-center justify-between gap-x-2 text-xs">
                    <span className="text-foreground">
                      <span className="font-bold capitalize">{e.type}</span> {e.collection ?? ""}
                      {e.tokenId ? ` #${e.tokenId}` : ""}
                      {e.priceWei ? ` — ${formatTokenAmount(e.priceWei, 18, 4)} ${e.priceSymbol ?? "ETH"}` : ""}
                    </span>
                    <span className="text-foreground/40">{e.chain ? chainDisplayName(e.chain) : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </MarketTabPanel>

      <MarketTabPanel id="my-nfts" active={tab === "my-nfts"}>
        {!account ? (
          <MarketWalletGate
            title="See what you own"
            description="Connect your wallet to see everything you hold across every chain this app tracks."
            onConnect={() => void requireAccount()}
          />
        ) : (
          <div className="space-y-2 rounded-lg border border-line bg-panel p-3">
            <h3 className="text-xs font-black uppercase tracking-wide text-foreground/60">
              Your collections {ownedCollections.length > 0 ? `(${ownedCollections.length})` : ""}
            </h3>
            {ownedLoading ? (
              <p className="text-xs text-foreground/45">Checking your wallet across every chain…</p>
            ) : ownedCollections.length === 0 ? (
              <p className="text-xs text-foreground/45">You don't own anything in a tracked collection yet.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ownedCollections.map((c) => (
                  <li key={`${c.chainSlug}:${c.contractAddress}`}>
                    <Link
                      href={`/market/multichain/${c.chainSlug}/${encodeURIComponent(c.contractAddress)}`}
                      className="flex items-center justify-between rounded-md border border-line-strong bg-background px-3 py-2 text-xs hover:border-gold-400"
                    >
                      <span className="font-bold text-foreground">{c.collectionName ?? c.contractAddress}</span>
                      <span className="text-foreground/45">
                        {c.count} on {chainDisplayName(c.chainSlug)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </MarketTabPanel>

      <MarketTabPanel id="positions" active={tab === "positions"}>
        {!account ? (
          <MarketWalletGate
            title="See your listings"
            description="Connect your wallet to see your active listings across every chain."
            onConnect={() => void requireAccount()}
          />
        ) : (
          <div className="space-y-2 rounded-lg border border-line bg-panel p-3">
            <h3 className="text-xs font-black uppercase tracking-wide text-foreground/60">
              My listings {summary && summary.myListings.length > 0 ? `(${summary.myListings.length})` : ""}
            </h3>
            {summaryLoading ? (
              <p className="text-xs text-foreground/45">Loading your listings…</p>
            ) : !summary || summary.myListings.length === 0 ? (
              <p className="text-xs text-foreground/45">You have no active listings in a tracked collection.</p>
            ) : (
              <ul className="space-y-1.5">
                {summary.myListings.map((l, i) => (
                  <li key={`${l.tokenId}-${i}`} className="flex items-center justify-between text-xs">
                    <span className="text-foreground">
                      {l.collectionName ?? "Collection"} #{l.tokenId} <span className="text-foreground/45">({chainDisplayName(l.chainSlug)})</span>
                    </span>
                    <span className="font-bold text-foreground tabular-nums">{formatTokenAmount(l.priceWei, 18, 4)} Ξ</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </MarketTabPanel>
    </div>
  );
}
