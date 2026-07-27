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
import CollectionStats from "@/components/market/CollectionStats";
import BuyConfirm from "@/components/market/BuyConfirm";
import ListingSkeleton from "@/components/market/ListingSkeleton";
import { getOwnedTokenIds } from "@/lib/market/inventory";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { fulfillOrder } from "@/lib/market/seaport";
import { validateListingOrder } from "@/lib/market/order-validation";
import { connectWallet, ensureRobinhoodChain, getConnectedAccounts } from "@/lib/wallet";
import type { Listing, MarketTab } from "@/lib/market/types";

const COLLECTION = MARKET_COLLECTIONS[0];

/** RobinWood's fixed supply — shown as "Items" in the stats strip. */
const TOTAL_SUPPLY = 1542;

type WithOrder<T> = T & { rawOrder: unknown };

type SortKey = "price-asc" | "price-desc" | "recent" | "token-id";

const SORTS: { id: SortKey; label: string }[] = [
  { id: "price-asc", label: "Price: low to high" },
  { id: "price-desc", label: "Price: high to low" },
  { id: "recent", label: "Recently listed" },
  { id: "token-id", label: "Token ID" },
];

function sortListings<T extends Listing>(items: T[], key: SortKey): T[] {
  const out = [...items];
  switch (key) {
    case "price-asc":
      return out.sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? -1 : 1));
    case "price-desc":
      return out.sort((a, b) => (BigInt(a.priceWei) > BigInt(b.priceWei) ? -1 : 1));
    case "token-id":
      return out.sort((a, b) => Number(a.tokenId) - Number(b.tokenId));
    case "recent":
    default:
      // Ids carry their creation timestamp as the trailing segment.
      return out.sort((a, b) => (a.id < b.id ? 1 : -1));
  }
}

export default function MarketView() {
  const [tab, setTab] = useState<MarketTab>("buy-sell");
  const [account, setAccount] = useState<string | null>(null);
  const [listings, setListings] = useState<Array<WithOrder<Listing>>>([]);
  const [offers, setOffers] = useState<Array<WithOrder<Listing>>>([]);
  const [showListForm, setShowListForm] = useState(false);
  const [offerTarget, setOfferTarget] = useState<{ tokenId?: string } | null>(null);
  const [buyTarget, setBuyTarget] = useState<{
    listing: WithOrder<Listing>;
    verifiedPriceWei: string;
  } | null>(null);
  const [sort, setSort] = useState<SortKey>("price-asc");
  const [loading, setLoading] = useState(true);
  const [ownedTokenIds, setOwnedTokenIds] = useState<Set<string> | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!COLLECTION) return;
    try {
      const [listingsRes, offersRes] = await Promise.all([
        fetch(`/api/market/orders?collection=${COLLECTION.slug}&kind=listing`).then((r) =>
          r.json()
        ),
        fetch(`/api/market/orders?collection=${COLLECTION.slug}&kind=offer`).then((r) => r.json()),
      ]);
      setListings(listingsRes.items ?? []);
      setOffers(offersRes.items ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void getConnectedAccounts().then((accounts) => {
      if (accounts[0]) setAccount(accounts[0]);
    });
  }, [refresh]);

  // Which planks this wallet holds — decides which incoming bids it can fill.
  useEffect(() => {
    if (!account || !COLLECTION) {
      setOwnedTokenIds(undefined);
      return;
    }
    let cancelled = false;
    void getOwnedTokenIds(COLLECTION.contractAddress, account).then((ids) => {
      if (!cancelled) setOwnedTokenIds(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [account]);

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

  /** Opens the checkout step. Nothing reaches the wallet from here. */
  const handleBuy = useCallback(
    async (listing: Listing) => {
      setError(null);
      const who = await requireAccount();
      if (!who) return;
      try {
        const full = listings.find((l) => l.id === listing.id);
        if (!full) throw new Error("Listing no longer available.");
        if (!COLLECTION) throw new Error("Unknown collection.");

        // Re-derive the price from the signed order in the buyer's own
        // browser. The API already does this, but repeating it here means
        // even a compromised API or store cannot show one price and have the
        // wallet sign another.
        const derived = validateListingOrder(full.rawOrder, COLLECTION);
        if (derived.tokenId !== full.tokenId) {
          throw new Error("This listing's details don't match its signature.");
        }
        setBuyTarget({ listing: full, verifiedPriceWei: derived.priceWei });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not open this listing.");
      }
    },
    [listings, requireAccount]
  );

  const confirmBuy = useCallback(async () => {
    if (!buyTarget || !account) return;
    setError(null);
    try {
      setStatus("Confirm in wallet…");
      await fulfillOrder(
        buyTarget.listing.rawOrder as Parameters<typeof fulfillOrder>[0],
        account
      );
      setBuyTarget(null);
      setStatus("Purchase confirmed.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Purchase failed.");
    } finally {
      setStatus(null);
    }
  }, [buyTarget, account, refresh]);

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

      {buyTarget && COLLECTION && (
        <BuyConfirm
          listing={buyTarget.listing}
          collection={COLLECTION}
          verifiedPriceWei={buyTarget.verifiedPriceWei}
          busy={status !== null}
          onConfirm={confirmBuy}
          onCancel={() => setBuyTarget(null)}
        />
      )}

      <Reveal delayMs={70}>
        {tab === "buy-sell" && (
          <div className="space-y-3">
            {COLLECTION && (
              <CollectionStats
                collection={COLLECTION}
                listings={listings}
                offers={offers}
                totalSupply={TOTAL_SUPPLY}
              />
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.65rem] text-foreground/45">
                {loading ? "Loading…" : `${listings.length} listed`}
              </span>
              <label className="flex items-center gap-1.5">
                <span className="sr-only">Sort listings</span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="min-h-9 rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground"
                >
                  {SORTS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {loading ? (
              <ListingSkeleton />
            ) : (
              <ListingGrid
                listings={sortListings(listings, sort)}
                collections={MARKET_COLLECTIONS}
                onBuy={handleBuy}
                onOffer={handleOffer}
                emptyMessage="No listings yet — be the first to sell."
              />
            )}
          </div>
        )}
        {tab === "offers" && (
          <div className="space-y-3">
            <p className="rounded-lg border border-dashed border-emerald-500/30 bg-forest-900/50 px-3 py-2 text-center text-[0.7rem] text-foreground/70">
              Bids from buyers. Accepting one sells them your plank.
            </p>
            {loading ? (
              <ListingSkeleton />
            ) : (
              <ListingGrid
                listings={sortListings(offers, sort === "price-asc" ? "price-desc" : sort)}
                collections={MARKET_COLLECTIONS}
                onBuy={handleAcceptOffer}
                buyLabel="Accept"
                variant="offer"
                ownedTokenIds={ownedTokenIds}
                emptyMessage="No offers yet."
              />
            )}
          </div>
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
