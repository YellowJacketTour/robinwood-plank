"use client";

import { useCallback, useEffect, useState } from "react";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import MarketNav from "@/components/market/MarketNav";
import ListingGrid from "@/components/market/ListingGrid";
import ListForm from "@/components/market/ListForm";
import SwapPanel from "@/components/market/SwapPanel";
import MyPositions from "@/components/market/MyPositions";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { fulfillOrder } from "@/lib/market/seaport";
import { connectWallet, ensureRobinhoodChain, getConnectedAccounts } from "@/lib/wallet";
import type { Listing, MarketTab } from "@/lib/market/types";

const COLLECTION = MARKET_COLLECTIONS[0];

export default function MarketView() {
  const [tab, setTab] = useState<MarketTab>("buy-sell");
  const [account, setAccount] = useState<string | null>(null);
  const [listings, setListings] = useState<Array<Listing & { rawOrder: unknown }>>([]);
  const [offers, setOffers] = useState<Array<Listing & { rawOrder: unknown }>>([]);
  const [showListForm, setShowListForm] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!COLLECTION) return;
    const [listingsRes, offersRes] = await Promise.all([
      fetch(`/api/market/orders?collection=${COLLECTION.slug}&kind=listing`).then((r) => r.json()),
      fetch(`/api/market/orders?collection=${COLLECTION.slug}&kind=offer`).then((r) => r.json()),
    ]);
    setListings(listingsRes.items ?? []);
    setOffers(offersRes.items ?? []);
  }, []);

  useEffect(() => {
    void refresh();
    void getConnectedAccounts().then((accounts) => {
      if (accounts[0]) setAccount(accounts[0]);
    });
  }, [refresh]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      const addr = await connectWallet();
      await ensureRobinhoodChain();
      setAccount(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
    }
  }, []);

  const handleBuy = useCallback(
    async (listing: Listing) => {
      setError(null);
      if (!account) {
        await handleConnect();
        return;
      }
      try {
        setStatus(`Buying ${COLLECTION?.name} #${listing.tokenId}…`);
        const full = listings.find((l) => l.id === listing.id);
        if (!full) throw new Error("Listing no longer available.");
        await fulfillOrder(
          full.rawOrder as Parameters<typeof fulfillOrder>[0],
          account
        );
        setStatus("Purchase confirmed.");
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Purchase failed.");
      } finally {
        setStatus(null);
      }
    },
    [account, handleConnect, listings, refresh]
  );

  return (
    <div className="space-y-5">
      <Reveal>
        <SectionHead
          eyebrow="RobinWood Chain · Marketplank"
          title="Marketplank"
          lede="List, buy, sell, and make offers on RobinWood."
        />
      </Reveal>

      <Reveal delayMs={40}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MarketNav active={tab} onChange={setTab} />
          {tab === "buy-sell" &&
            (account ? (
              <button
                type="button"
                onClick={() => setShowListForm((v) => !v)}
                className="min-h-10 shrink-0 rounded-lg border border-gold-500/40 px-3.5 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
              >
                {showListForm ? "Cancel" : "List a plank"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                className="min-h-10 shrink-0 rounded-lg bg-gold-500 px-3.5 text-xs font-bold text-wood-950 transition hover:bg-gold-400 sm:text-sm"
              >
                Connect wallet
              </button>
            ))}
        </div>
      </Reveal>

      {(status || error) && (
        <p className={`text-center text-xs ${error ? "text-red-300" : "text-forest-600"}`} role={error ? "alert" : "status"}>
          {error ?? status}
        </p>
      )}

      {tab === "buy-sell" && showListForm && account && COLLECTION && (
        <Reveal>
          <ListForm
            account={account}
            collection={COLLECTION}
            onListed={() => {
              setShowListForm(false);
              void refresh();
            }}
          />
        </Reveal>
      )}

      <Reveal delayMs={70}>
        {tab === "buy-sell" && (
          <ListingGrid
            listings={listings}
            collections={MARKET_COLLECTIONS}
            onBuy={handleBuy}
            emptyMessage="No active listings yet — be the first to list a plank."
          />
        )}
        {tab === "offers" && (
          <ListingGrid
            listings={offers}
            collections={MARKET_COLLECTIONS}
            emptyMessage="No open offers yet."
          />
        )}
        {tab === "swap" && <SwapPanel />}
        {tab === "positions" && <MyPositions />}
      </Reveal>
    </div>
  );
}
