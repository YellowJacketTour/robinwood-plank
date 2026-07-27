"use client";

import { useCallback, useEffect, useState } from "react";
import Reveal from "@/components/Reveal";
import SectionHead from "@/components/SectionHead";
import MarketNav from "@/components/market/MarketNav";
import ListingGrid from "@/components/market/ListingGrid";
import ListForm from "@/components/market/ListForm";
import OfferForm from "@/components/market/OfferForm";
import SwapPanel from "@/components/market/SwapPanel";
import MyPositions from "@/components/market/MyPositions";
import TreasuryDashboard from "@/components/market/TreasuryDashboard";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { fulfillOrder } from "@/lib/market/seaport";
import { connectWallet, ensureRobinhoodChain, getConnectedAccounts } from "@/lib/wallet";
import type { Listing, MarketTab } from "@/lib/market/types";

const COLLECTION = MARKET_COLLECTIONS[0];

type WithOrder<T> = T & { rawOrder: unknown };

export default function MarketView() {
  const [tab, setTab] = useState<MarketTab>("buy-sell");
  const [account, setAccount] = useState<string | null>(null);
  const [listings, setListings] = useState<Array<WithOrder<Listing>>>([]);
  const [offers, setOffers] = useState<Array<WithOrder<Listing>>>([]);
  const [showListForm, setShowListForm] = useState(false);
  const [offerTarget, setOfferTarget] = useState<{ tokenId?: string } | null>(null);
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

  const requireAccount = useCallback(async () => {
    if (account) return account;
    await handleConnect();
    return null;
  }, [account, handleConnect]);

  const handleBuy = useCallback(
    async (listing: Listing) => {
      setError(null);
      const who = await requireAccount();
      if (!who) return;
      try {
        setStatus(`Buying #${listing.tokenId}…`);
        const full = listings.find((l) => l.id === listing.id);
        if (!full) throw new Error("Listing no longer available.");
        await fulfillOrder(full.rawOrder as Parameters<typeof fulfillOrder>[0], who);
        setStatus("Purchase confirmed.");
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Purchase failed.");
      } finally {
        setStatus(null);
      }
    },
    [listings, refresh, requireAccount]
  );

  const handleOffer = useCallback(
    async (listing: Listing) => {
      const who = await requireAccount();
      if (!who) return;
      setOfferTarget({ tokenId: listing.tokenId });
    },
    [requireAccount]
  );

  const handleAcceptOffer = useCallback(
    async (offer: Listing) => {
      setError(null);
      const who = await requireAccount();
      if (!who) return;
      try {
        setStatus(`Accepting offer on #${offer.tokenId}…`);
        const full = offers.find((o) => o.id === offer.id);
        if (!full) throw new Error("Offer no longer available.");
        await fulfillOrder(full.rawOrder as Parameters<typeof fulfillOrder>[0], who);
        setStatus("Offer accepted.");
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not accept offer.");
      } finally {
        setStatus(null);
      }
    },
    [offers, refresh, requireAccount]
  );

  return (
    <div className="space-y-5">
      <Reveal>
        <SectionHead eyebrow="Robinhood Chain" title="Marketplank" />
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
                {showListForm ? "Cancel" : "Sell"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                className="min-h-10 shrink-0 rounded-lg bg-gold-500 px-3.5 text-xs font-bold text-wood-950 transition hover:bg-gold-400 sm:text-sm"
              >
                Connect
              </button>
            ))}
          {tab === "offers" && account && (
            <button
              type="button"
              onClick={() => setOfferTarget({})}
              className="min-h-10 shrink-0 rounded-lg border border-gold-500/40 px-3.5 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
            >
              Offer any
            </button>
          )}
        </div>
      </Reveal>

      {(status || error) && (
        <p
          className={`text-center text-xs ${error ? "text-red-300" : "text-forest-600"}`}
          role={error ? "alert" : "status"}
        >
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

      {offerTarget && account && COLLECTION && (
        <OfferForm
          account={account}
          collection={COLLECTION}
          tokenId={offerTarget.tokenId}
          onClose={() => setOfferTarget(null)}
          onSubmitted={() => {
            setOfferTarget(null);
            void refresh();
          }}
        />
      )}

      <Reveal delayMs={70}>
        {tab === "buy-sell" && (
          <ListingGrid
            listings={listings}
            collections={MARKET_COLLECTIONS}
            onBuy={handleBuy}
            onOffer={handleOffer}
            emptyMessage="No listings yet — be the first to sell."
          />
        )}
        {tab === "offers" && (
          <ListingGrid
            listings={offers}
            collections={MARKET_COLLECTIONS}
            onBuy={handleAcceptOffer}
            buyLabel="Accept"
            emptyMessage="No offers yet."
          />
        )}
        {tab === "swap" && (
          <div className="space-y-3">
            <TreasuryDashboard />
            <SwapPanel />
          </div>
        )}
        {tab === "positions" && account && (
          <MyPositions account={account} listings={listings} offers={offers} onChanged={refresh} />
        )}
        {tab === "positions" && !account && (
          <button
            type="button"
            onClick={handleConnect}
            className="mx-auto flex min-h-11 items-center justify-center rounded-lg bg-gold-500 px-5 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
          >
            Connect wallet
          </button>
        )}
      </Reveal>
    </div>
  );
}
