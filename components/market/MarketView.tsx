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
import MyInventory from "@/components/market/MyInventory";
import TreasuryDashboard from "@/components/market/TreasuryDashboard";
import CollectionStats from "@/components/market/CollectionStats";
import BuyConfirm from "@/components/market/BuyConfirm";
import SweepConfirm from "@/components/market/SweepConfirm";
import SweepFloorboards from "@/components/market/SweepFloorboards";
import ListingSkeleton from "@/components/market/ListingSkeleton";
import ActivityFeed from "@/components/market/ActivityFeed";
import ItemDetail from "@/components/market/ItemDetail";
import WalletChip from "@/components/market/WalletChip";
import FilterBar, { applyFilters, EMPTY_FILTERS } from "@/components/market/FilterBar";
import type { MarketFilters } from "@/components/market/FilterBar";
import { getRarityMap } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { getOwnedTokenIds } from "@/lib/market/inventory";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  assertAcceptableOffer,
  assertAcceptableTraitOffer,
  fulfillOrder,
  sweepFloor,
} from "@/lib/market/seaport";
import type { SweepPlan } from "@/lib/market/sweep";
import { validateListingOrder, validateOfferOrder } from "@/lib/market/order-validation";
import { connectWallet, ensureRobinhoodChain, getConnectedAccounts } from "@/lib/wallet";
import { MARKET_OFFER_CURRENCY } from "@/lib/constants";
import { formatTokenAmount } from "@/lib/trade";
import type { Listing, MarketTab, Offer } from "@/lib/market/types";

const COLLECTION = MARKET_COLLECTIONS[0];

const VALID_TABS: MarketTab[] = ["buy-sell", "offers", "activity", "swap", "positions"];

function isTab(value: string | null): value is MarketTab {
  return value !== null && (VALID_TABS as string[]).includes(value);
}

/**
 * Mirror the view into the URL so a tab or an item can be linked and shared.
 * Read in an effect rather than during render: the server has no location, and
 * seeding state from it directly would hydrate mismatched markup.
 */
function readUrlState(): { tab: MarketTab | null; item: string | null } {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  const item = params.get("item");
  return {
    tab: isTab(tab) ? tab : null,
    item: item && /^\d{1,5}$/.test(item) ? item : null,
  };
}

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
  const [filters, setFilters] = useState<MarketFilters>(EMPTY_FILTERS);
  const [rarityMap, setRarityMap] = useState<Map<string, RarityLookup>>(new Map());
  const [detailTokenId, setDetailTokenId] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [listings, setListings] = useState<Array<WithOrder<Listing>>>([]);
  const [offers, setOffers] = useState<Array<WithOrder<Listing>>>([]);
  const [showListForm, setShowListForm] = useState(false);
  const [offerTarget, setOfferTarget] = useState<{ tokenId?: string; trait?: boolean } | null>(
    null
  );
  const [acceptTraitTarget, setAcceptTraitTarget] = useState<{
    offer: WithOrder<Offer>;
    /** Seller NET proceeds in WETH wei, re-derived from the signed order. */
    verifiedNetWei: string;
    /** Wallet-owned token ids inside the bid's committed snapshot. */
    qualifyingOwned: string[];
    chosenTokenId: string;
  } | null>(null);
  const [buyTarget, setBuyTarget] = useState<{
    listing: WithOrder<Listing>;
    verifiedPriceWei: string;
  } | null>(null);
  const [acceptTarget, setAcceptTarget] = useState<{
    offer: WithOrder<Listing>;
    /** Seller NET proceeds in WETH wei, re-derived from the signed order. */
    verifiedNetWei: string;
    tokenId: string;
  } | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [showInventory, setShowInventory] = useState(false);
  const [sweepTarget, setSweepTarget] = useState<SweepPlan | null>(null);
  const [sweeping, setSweeping] = useState(false);
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

  // Same shared, module-cached fetch every rarity-aware grid on the page
  // uses — the tier filter reads the identical map the card badges do.
  useEffect(() => {
    let cancelled = false;
    void getRarityMap().then((map) => {
      if (!cancelled) setRarityMap(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Adopt the URL on load, and keep following it through Back/Forward.
  useEffect(() => {
    const sync = () => {
      const { tab: urlTab, item } = readUrlState();
      setTab(urlTab ?? "buy-sell");
      setDetailTokenId(item);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  /** Single writer for the URL, so tab and item can never disagree with it. */
  const writeUrl = useCallback((nextTab: MarketTab, nextItem: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (nextTab === "buy-sell") params.delete("tab");
    else params.set("tab", nextTab);
    if (nextItem) params.set("item", nextItem);
    else params.delete("item");
    const query = params.toString();
    window.history.pushState(null, "", query ? `?${query}` : window.location.pathname);
  }, []);

  const selectTab = useCallback(
    (next: MarketTab) => {
      setTab(next);
      setDetailTokenId(null);
      writeUrl(next, null);
    },
    [writeUrl]
  );

  const openDetail = useCallback(
    (tokenId: string) => {
      setDetailTokenId(tokenId);
      writeUrl(tab, tokenId);
    },
    [tab, writeUrl]
  );

  const closeDetail = useCallback(() => {
    setDetailTokenId(null);
    writeUrl(tab, null);
  }, [tab, writeUrl]);

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

  /**
   * Opens the sweep checkout. The plan arrives already validated (planSweep
   * re-derived every order in this browser); the same derivation runs once
   * more inside sweepFloor at send time. Nothing reaches the wallet from here.
   */
  const handleSweep = useCallback(
    async (plan: SweepPlan) => {
      setError(null);
      const who = await requireAccount();
      if (!who) return;
      if (plan.items.length === 0) return;
      setSweepTarget(plan);
    },
    [requireAccount]
  );

  const confirmSweep = useCallback(async () => {
    if (!sweepTarget || !account || sweeping || !COLLECTION) return; // busy lock
    setError(null);
    try {
      setSweeping(true);
      setStatus("Confirm in wallet…");
      await sweepFloor(sweepTarget.items, account, COLLECTION, sweepTarget.totalWei);
      setSweepTarget(null);
      setStatus("Sweep confirmed.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sweep failed.");
    } finally {
      setSweeping(false);
      setStatus(null);
    }
  }, [sweepTarget, account, sweeping, refresh]);

  const handleOffer = useCallback(
    async (listing: Listing) => {
      const who = await requireAccount();
      if (!who) return;
      setOfferTarget({ tokenId: listing.tokenId });
    },
    [requireAccount]
  );

  /**
   * Opens the accept-offer checkout. Mirrors handleBuy exactly: the order is
   * re-derived and validated in THIS browser (validateOfferOrder), and the
   * relay's claimed tokenId/price must match the signature-covered values —
   * a compromised relay cannot show one offer and have the wallet approve /
   * transfer against another. Nothing reaches the wallet from here.
   */
  const handleAcceptOffer = useCallback(
    async (offer: Listing) => {
      setError(null);
      const who = await requireAccount();
      if (!who) return;
      try {
        const full = offers.find((o) => o.id === offer.id);
        if (!full) throw new Error("Offer no longer available.");
        if (!COLLECTION) throw new Error("Unknown collection.");

        const derived = validateOfferOrder(full.rawOrder, COLLECTION, MARKET_OFFER_CURRENCY);
        assertAcceptableOffer(full, derived);
        // derived.priceWei is the seller's NET proceeds (order-validation
        // OFFER semantics) — the number the seller must see before signing.
        setAcceptTarget({
          offer: full,
          verifiedNetWei: derived.priceWei,
          tokenId: derived.tokenId as string,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not open this offer.");
      }
    },
    [offers, requireAccount]
  );

  /**
   * TRAIT-bid accept flow. Same trust model as handleAcceptOffer, plus the
   * criteria layer: the snapshot stored with the offer must reproduce the
   * signed order's Merkle root, and the token the seller picks must be inside
   * it (assertAcceptableTraitOffer re-checks all of this at send time too).
   * The fulfillability of this exact shape is proven against the real Seaport
   * 1.6 bytecode in test/contracts/SeaportCriteriaFulfill.test.ts.
   */
  const handleAcceptTraitOffer = useCallback(
    async (offer: WithOrder<Offer>) => {
      setError(null);
      const who = await requireAccount();
      if (!who) return;
      try {
        if (!COLLECTION) throw new Error("Unknown collection.");
        if (!offer.criteriaTokenIds?.length) throw new Error("Offer snapshot missing.");
        const derived = validateOfferOrder(offer.rawOrder, COLLECTION, MARKET_OFFER_CURRENCY, {
          criteriaTokenIds: offer.criteriaTokenIds,
        });
        const owned = ownedTokenIds ?? new Set<string>();
        const snapshot = new Set(offer.criteriaTokenIds.map((id) => BigInt(id).toString()));
        const qualifyingOwned = Array.from(owned)
          .map((id) => BigInt(id).toString())
          .filter((id) => snapshot.has(id))
          .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        if (qualifyingOwned.length === 0) {
          throw new Error("None of your planks qualify for this trait offer.");
        }
        // Dry-run the full cross-check now so a broken offer never reaches
        // the confirm modal; it runs again at send time.
        assertAcceptableTraitOffer(offer, derived, qualifyingOwned[0]);
        setAcceptTraitTarget({
          offer,
          verifiedNetWei: derived.priceWei,
          qualifyingOwned,
          chosenTokenId: qualifyingOwned[0],
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not open this offer.");
      }
    },
    [requireAccount, ownedTokenIds]
  );

  const confirmAcceptTraitOffer = useCallback(async () => {
    if (!acceptTraitTarget || !account || accepting || !COLLECTION) return; // busy lock
    setError(null);
    try {
      setAccepting(true);
      const { offer, chosenTokenId } = acceptTraitTarget;
      // Re-derive EVERYTHING from the signed order at send time; the proof
      // handed to the wallet comes from the same verified snapshot.
      const derived = validateOfferOrder(offer.rawOrder, COLLECTION, MARKET_OFFER_CURRENCY, {
        criteriaTokenIds: offer.criteriaTokenIds ?? [],
      });
      const criteria = assertAcceptableTraitOffer(
        { priceWei: acceptTraitTarget.verifiedNetWei, criteriaTokenIds: offer.criteriaTokenIds },
        derived,
        chosenTokenId
      );
      setStatus(`Accepting trait offer with #${chosenTokenId}…`);
      await fulfillOrder(
        offer.rawOrder as Parameters<typeof fulfillOrder>[0],
        account,
        [criteria]
      );
      setAcceptTraitTarget(null);
      setStatus("Offer accepted.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept offer.");
    } finally {
      setAccepting(false);
      setStatus(null);
    }
  }, [acceptTraitTarget, account, accepting, refresh]);

  const confirmAcceptOffer = useCallback(async () => {
    if (!acceptTarget || !account || accepting) return; // busy lock
    setError(null);
    try {
      setAccepting(true);
      setStatus(`Accepting offer on #${acceptTarget.tokenId}…`);
      await fulfillOrder(
        acceptTarget.offer.rawOrder as Parameters<typeof fulfillOrder>[0],
        account
      );
      setAcceptTarget(null);
      setStatus("Offer accepted.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept offer.");
    } finally {
      setAccepting(false);
      setStatus(null);
    }
  }, [acceptTarget, account, accepting, refresh]);

  const visibleListings = applyFilters(listings, filters, rarityMap);
  // TRAIT bids (criteria orders with a committed snapshot) render as their own
  // rows — they have no single tokenId, so a token-card grid can't show them.
  const traitOffers = offers.filter(
    (o) => ((o as unknown as Offer).criteriaTokenIds?.length ?? 0) > 0
  ) as unknown as Array<WithOrder<Offer>>;
  const tokenOffers = offers.filter(
    (o) => !((o as unknown as Offer).criteriaTokenIds?.length ?? 0)
  );
  // Floor = cheapest live listing; every card at that exact price gets the badge.
  const floorPriceWei =
    listings.length > 0
      ? listings.reduce(
          (min, l) => (BigInt(l.priceWei) < BigInt(min) ? l.priceWei : min),
          listings[0].priceWei
        )
      : undefined;
  const detailListing = detailTokenId
    ? listings.find((l) => l.tokenId === detailTokenId)
    : undefined;

  return (
    <div className="space-y-5">
      <Reveal>
        <SectionHead eyebrow="Robinhood Chain" title="Marketplank" />
      </Reveal>

      <Reveal delayMs={40}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <MarketNav active={tab} onChange={selectTab} />
          {account && <WalletChip account={account} />}
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
          {/* "Offer any" (collection-wide bid) removed — FAIL CLOSED, audit
              2026-07-27: the criteria order it produced was unfillable (no
              considerationCriteria resolver was ever supplied at fulfillment),
              so it only minted dead bids backed by a live WETH approval.
              Re-enable only after the resolver path is wired and verified. */}
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
          traitMode={offerTarget.trait}
          listings={listings}
          onClose={() => setOfferTarget(null)}
          onSubmitted={() => {
            setOfferTarget(null);
            void refresh();
          }}
        />
      )}

      {acceptTraitTarget && COLLECTION && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm accepting trait offer"
        >
          <div className="wood-ledger w-full max-w-sm space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg text-gold-300">Accept trait offer</h3>
              <button
                type="button"
                onClick={() => !accepting && setAcceptTraitTarget(null)}
                aria-label="Cancel"
                className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300"
              >
                ✕
              </button>
            </div>
            <p className="text-sm text-foreground">
              This bid accepts any{" "}
              {acceptTraitTarget.offer.traits
                ?.map((t) => `${t.traitType}: ${t.value}`)
                .join(", ") ?? "qualifying"}{" "}
              plank. Pick which of yours to sell:
            </p>
            <label className="block">
              <span className="sr-only">Token to sell</span>
              <select
                value={acceptTraitTarget.chosenTokenId}
                onChange={(e) =>
                  setAcceptTraitTarget((prev) =>
                    prev ? { ...prev, chosenTokenId: e.target.value } : prev
                  )
                }
                className="min-h-10 w-full rounded-md border border-gold-500/30 bg-wood-950 px-2 text-sm text-foreground"
              >
                {acceptTraitTarget.qualifyingOwned.map((id) => (
                  <option key={id} value={id}>
                    {COLLECTION.name} #{id}
                  </option>
                ))}
              </select>
            </label>
            <dl className="space-y-1 rounded-lg border border-gold-500/20 bg-wood-900/60 px-3 py-2 text-xs">
              <div className="flex justify-between">
                <dt className="font-bold text-foreground">You receive (net)</dt>
                <dd className="font-display tabular-nums text-gold-300">
                  {formatTokenAmount(acceptTraitTarget.verifiedNetWei, 18, 6)} WETH
                </dd>
              </div>
            </dl>
            <p className="text-center text-[0.6rem] text-foreground/40">
              Amount and qualifying set verified against the buyer's signed order in this
              browser. Plus network gas.
            </p>
            <button
              type="button"
              disabled={accepting}
              onClick={confirmAcceptTraitOffer}
              className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
            >
              {accepting
                ? "Confirm in wallet…"
                : `Sell #${acceptTraitTarget.chosenTokenId}`}
            </button>
          </div>
        </div>
      )}

      {acceptTarget && COLLECTION && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm accepting offer"
        >
          <div className="wood-ledger w-full max-w-sm space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg text-gold-300">Accept offer</h3>
              <button
                type="button"
                onClick={() => !accepting && setAcceptTarget(null)}
                aria-label="Cancel"
                className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300"
              >
                ✕
              </button>
            </div>
            <p className="text-sm text-foreground">
              You are selling {COLLECTION.name} #{acceptTarget.tokenId}.
            </p>
            <dl className="space-y-1 rounded-lg border border-gold-500/20 bg-wood-900/60 px-3 py-2 text-xs">
              <div className="flex justify-between border-t border-gold-500/15 pt-1 first:border-t-0 first:pt-0">
                <dt className="font-bold text-foreground">You receive (net)</dt>
                <dd className="font-display tabular-nums text-gold-300">
                  {formatTokenAmount(acceptTarget.verifiedNetWei, 18, 6)} WETH
                </dd>
              </div>
            </dl>
            <p className="text-center text-[0.6rem] text-foreground/40">
              Amount verified against the buyer's signed order in this browser. Plus network gas.
            </p>
            <button
              type="button"
              disabled={accepting}
              onClick={confirmAcceptOffer}
              className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
            >
              {accepting ? "Confirm in wallet…" : "Accept offer"}
            </button>
          </div>
        </div>
      )}

      {detailTokenId && COLLECTION && (
        <ItemDetail
          key={detailTokenId}
          tokenId={detailTokenId}
          collection={COLLECTION}
          listing={detailListing}
          onBuy={(l) => {
            closeDetail();
            void handleBuy(l);
          }}
          onOffer={(tokenId) => {
            closeDetail();
            void handleOffer({ tokenId } as Listing);
          }}
          onClose={closeDetail}
        />
      )}

      {sweepTarget && COLLECTION && (
        <SweepConfirm
          items={sweepTarget.items}
          collection={COLLECTION}
          verifiedTotalWei={sweepTarget.totalWei}
          busy={sweeping}
          onConfirm={confirmSweep}
          onCancel={() => setSweepTarget(null)}
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
            <div className="flex flex-wrap items-center gap-2">
              <FilterBar
                filters={filters}
                onChange={setFilters}
                resultCount={loading ? 0 : visibleListings.length}
                rarityAvailable={rarityMap.size > 0}
              />
              {COLLECTION && !loading && (
                <SweepFloorboards
                  listings={listings}
                  collection={COLLECTION}
                  account={account}
                  onSweep={(plan) => void handleSweep(plan)}
                />
              )}
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
                listings={sortListings(visibleListings, sort)}
                collections={MARKET_COLLECTIONS}
                onBuy={handleBuy}
                onOffer={handleOffer}
                onSelect={openDetail}
                floorPriceWei={floorPriceWei}
                emptyMessage={
                  listings.length === 0
                    ? "No listings yet — be the first to sell."
                    : "No matches."
                }
              />
            )}
          </div>
        )}
        {tab === "offers" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 flex-1 rounded-lg border border-dashed border-emerald-500/30 bg-forest-900/50 px-3 py-2 text-center text-[0.7rem] text-foreground/70">
                Bids from buyers. Accepting one sells them your plank.
              </p>
              <button
                type="button"
                onClick={async () => {
                  const who = await requireAccount();
                  if (who) setOfferTarget({ trait: true });
                }}
                className="min-h-10 shrink-0 rounded-lg border border-gold-500/40 px-3.5 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
              >
                Bid on trait floor
              </button>
            </div>
            {!loading && traitOffers.length > 0 && (
              <ul className="space-y-2">
                {traitOffers.map((o) => {
                  const canAccept =
                    ownedTokenIds &&
                    o.criteriaTokenIds?.some((id) =>
                      ownedTokenIds.has(BigInt(id).toString())
                    );
                  return (
                    <li
                      key={o.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gold-500/25 bg-wood-900/60 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-foreground">
                          Any{" "}
                          {o.traits?.map((t) => `${t.traitType}: ${t.value}`).join(", ") ??
                            "qualifying plank"}
                        </p>
                        <p className="text-[0.65rem] text-foreground/60">
                          {o.criteriaTokenIds?.length ?? 0} planks qualify · seller nets{" "}
                          {formatTokenAmount(o.priceWei, 18, 6)} WETH
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleAcceptTraitOffer(o)}
                        disabled={account !== null && !canAccept}
                        title={
                          account !== null && !canAccept
                            ? "None of your planks carry this trait"
                            : undefined
                        }
                        className="min-h-9 rounded-md bg-gold-500 px-3 text-xs font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-40"
                      >
                        Accept
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {loading ? (
              <ListingSkeleton />
            ) : (
              <ListingGrid
                listings={sortListings(tokenOffers, sort === "price-asc" ? "price-desc" : sort)}
                collections={MARKET_COLLECTIONS}
                onBuy={handleAcceptOffer}
                onSelect={openDetail}
                buyLabel="Accept"
                variant="offer"
                ownedTokenIds={ownedTokenIds}
                emptyMessage={traitOffers.length > 0 ? "No single-token offers." : "No offers yet."}
              />
            )}
          </div>
        )}
        {tab === "activity" && <ActivityFeed onSelectToken={openDetail} />}
        {tab === "swap" && (
          <div className="space-y-3">
            <TreasuryDashboard />
            <SwapPanel />
          </div>
        )}
        {tab === "positions" && account && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setShowInventory((v) => !v)}
              aria-expanded={showInventory}
              className="min-h-10 rounded-lg border border-gold-500/40 px-3.5 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
            >
              {showInventory ? "Hide my planks" : "List from your wallet"}
            </button>
            {showInventory && (
              <MyInventory
                account={account}
                collections={MARKET_COLLECTIONS}
                alreadyListed={
                  new Set(
                    listings
                      .filter((l) => l.maker.toLowerCase() === account.toLowerCase())
                      .map((l) => `${l.collectionSlug}:${l.tokenId}`)
                  )
                }
                onListed={() => void refresh()}
              />
            )}
            <MyPositions account={account} listings={listings} offers={offers} onChanged={refresh} />
          </div>
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
