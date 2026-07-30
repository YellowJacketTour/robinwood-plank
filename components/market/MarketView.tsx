"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MarketNav from "@/components/market/MarketNav";
import MarketBrowseLayout from "@/components/market/MarketBrowseLayout";
import {
  MarketCollectionHero,
  MarketContent,
  MarketDisclosure,
  MarketScaffold,
  MarketTabPanel,
  MarketTabRail,
  MarketTabSection,
  MarketWalletGate,
} from "@/components/market/MarketScaffold";
import ListingGrid from "@/components/market/ListingGrid";
import {
  dualVaultMode,
  getVaultByRole,
  type VaultRole,
} from "@/lib/market/vault-registry";
import VaultTradeHistory from "@/components/market/VaultTradeHistory";
import LivingLiquidityViz from "@/components/market/LivingLiquidityViz";
import RedeemOdds from "@/components/market/RedeemOdds";
import EventCountdown from "@/components/market/EventCountdown";
import CollectionStats from "@/components/market/CollectionStats";
import BuyConfirm from "@/components/market/BuyConfirm";
import SweepConfirm from "@/components/market/SweepConfirm";
import RarityFloorStrip from "@/components/market/RarityFloorStrip";
import IncomingBids from "@/components/market/IncomingBids";
import ListingSkeleton from "@/components/market/ListingSkeleton";
import ItemDetail from "@/components/market/ItemDetail";
import WalletChip from "@/components/market/WalletChip";
import WethBalance from "@/components/market/WethBalance";
import FilterBar, { applyFilters, EMPTY_FILTERS } from "@/components/market/FilterBar";
import type { MarketFilters } from "@/components/market/FilterBar";
import { getRarityMap } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { invalidateSwr, prefetchJson } from "@/lib/market/swr-fetch";
import { getOwnedTokenIds } from "@/lib/market/inventory";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { MARKET_TABS } from "@/lib/market/navigation";
import type { SweepPlan } from "@/lib/market/sweep";
import { ensureRobinhoodChain, getConnectedAccounts } from "@/lib/wallet";
import { MARKET_OFFER_CURRENCY } from "@/lib/constants";
import { formatTokenAmount } from "@/lib/trade";
import type { Listing, MarketTab, Offer } from "@/lib/market/types";
import dynamic from "next/dynamic";

const ConnectWalletModal = dynamic(() => import("@/components/ConnectWalletModal"), {
  ssr: false,
});

/** Seaport (plus its ethers ceremony) loads on the first buy/list/accept
 * click, not with the page — every use is inside a user-initiated handler. */
type SeaportModule = typeof import("@/lib/market/seaport");
const loadSeaport = () => import("@/lib/market/seaport");

/** Same deal for order validation: it drags in criteria hashing (ethers
 * keccak + Seaport's MerkleTree) and only runs inside buy/accept handlers. */
const loadOrderValidation = () => import("@/lib/market/order-validation");

/** Fixed-height pulse placeholder — tab bodies stream in as their own
 * chunks, and the placeholder keeps the layout from jumping meanwhile. */
function PanelSkeleton({ className = "min-h-64" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`${className} animate-pulse rounded-xl border border-line bg-wood-900/60`}
    />
  );
}

const panelLoading = () => <PanelSkeleton />;
const gridLoading = () => <ListingSkeleton />;

// Heavy tab bodies split out of the initial /market chunk. Everything the
// default Buy & Sell view needs (ListingGrid, FilterBar, scaffold) stays
// static; these mount when their tab is first visited (or pre-warmed).
const SwapPanel = dynamic(() => import("@/components/market/SwapPanel"), {
  ssr: false,
  loading: panelLoading,
});
const InstantVaultSwitcher = dynamic(
  () => import("@/components/market/InstantVaultSwitcher"),
  { ssr: false, loading: () => <PanelSkeleton className="min-h-16" /> }
);
const VaultMigrate = dynamic(() => import("@/components/market/VaultMigrate"), {
  ssr: false,
  loading: panelLoading,
});
const SeedVaultPanel = dynamic(() => import("@/components/market/SeedVaultPanel"), {
  ssr: false,
});
const MyPositions = dynamic(() => import("@/components/market/MyPositions"), {
  ssr: false,
  loading: panelLoading,
});
const MyInventory = dynamic(() => import("@/components/market/MyInventory"), {
  ssr: false,
  loading: gridLoading,
});
const MyNfts = dynamic(() => import("@/components/market/MyNfts"), {
  ssr: false,
  loading: gridLoading,
});
const TreasuryDashboard = dynamic(() => import("@/components/market/TreasuryDashboard"), {
  ssr: false,
  loading: panelLoading,
});
const VaultDashboard = dynamic(() => import("@/components/market/VaultDashboard"), {
  ssr: false,
  loading: panelLoading,
});
const NftPriceChart = dynamic(() => import("@/components/market/NftPriceChart"), {
  ssr: false,
  loading: panelLoading,
});
const ActivityFeed = dynamic(() => import("@/components/market/ActivityFeed"), {
  ssr: false,
  loading: gridLoading,
});
const OfferForm = dynamic(() => import("@/components/market/OfferForm"), {
  ssr: false,
});
const SweepFloorboards = dynamic(() => import("@/components/market/SweepFloorboards"), {
  ssr: false,
  loading: () => <PanelSkeleton className="min-h-24" />,
});

const COLLECTION = MARKET_COLLECTIONS[0];

function OrderBookAlert({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  if (!message) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-950/15 px-3 py-2.5"
      role="alert"
    >
      <div>
        <p className="text-sm font-bold text-red-200">{message}</p>
        <p className="text-xs text-foreground/50">
          Any last good listings and offers remain visible while you reconnect.
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-10 rounded-md border border-line-strong px-3 text-xs font-bold text-gold-300 transition hover:border-gold-400"
      >
        Retry order book
      </button>
    </div>
  );
}

function isTab(value: string | null): value is MarketTab {
  return value !== null && MARKET_TABS.some((tab) => tab.id === value);
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
  /** Instant Swap vault book: primary = V2, legacy = V1 deposits. */
  const [vaultRole, setVaultRole] = useState<VaultRole>("primary");
  const activeVault = getVaultByRole(vaultRole) ?? getVaultByRole("primary");
  // Each tab mounts the first time it's actually opened, then stays mounted
  // (hidden, not removed) for the rest of the visit — switching back to an
  // already-opened tab is then instant with no re-fetch. Mounting every tab
  // up front instead was tried and reverted: it fires every tab's RPC-heavy
  // requests simultaneously on first load, which measurably 429'd the
  // public RPC and left several panels stuck on "Could not read vault
  // state." A lazy-then-sticky mount gets the same instant-switch outcome
  // without the request burst.
  const [visitedTabs, setVisitedTabs] = useState<Set<MarketTab>>(() => new Set(["buy-sell"]));
  const [filters, setFilters] = useState<MarketFilters>(EMPTY_FILTERS);
  const [rarityMap, setRarityMap] = useState<Map<string, RarityLookup>>(new Map());
  const [detailTokenId, setDetailTokenId] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [listings, setListings] = useState<Array<WithOrder<Listing>>>([]);
  const [offers, setOffers] = useState<Array<WithOrder<Listing>>>([]);
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
  /** Finalized mockup: the sweep planner is progressive disclosure — a
   * toolbar toggle opens it instead of the full control cluster living
   * inline in the toolbar. */
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sort, setSort] = useState<SortKey>("price-asc");
  const [loading, setLoading] = useState(true);
  const [bookError, setBookError] = useState<string | null>(null);
  const [ownedTokenIds, setOwnedTokenIds] = useState<Set<string> | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!COLLECTION) return;
    try {
      const slug = COLLECTION.slug;
      const { swrJson } = await import("@/lib/market/swr-fetch");
      const [listingsRes, offersRes] = await Promise.all([
        swrJson<{ items?: Array<WithOrder<Listing>> }>(
          `/api/market/orders?collection=${slug}&kind=listing`,
          { ttlMs: 12_000, swrMs: 60_000, session: true }
        ),
        swrJson<{ items?: Array<WithOrder<Listing>> }>(
          `/api/market/orders?collection=${slug}&kind=offer`,
          { ttlMs: 12_000, swrMs: 60_000, session: true }
        ),
      ]);
      setListings(listingsRes.items ?? []);
      setOffers(offersRes.items ?? []);
      setBookError(null);
    } catch {
      setBookError("The live order book could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  const retryOrderBook = useCallback(() => {
    if (!COLLECTION) return;
    invalidateSwr(`/api/market/orders?collection=${COLLECTION.slug}`);
    setBookError(null);
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void refresh();
    });
    void getConnectedAccounts().then((accounts) => {
      if (accounts[0]) setAccount(accounts[0]);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [refresh]);

  // Warm every public tab's data as soon as /market mounts so tab switches
  // hit memory/session/SWR (and edge Cache-Control), not a cold Worker trip.
  useEffect(() => {
    const slug = COLLECTION?.slug ?? "robinwood";
    // Buy & Sell + Offers book
    prefetchJson(`/api/market/orders?collection=${slug}&kind=listing`, {
      ttlMs: 12_000,
      swrMs: 60_000,
      session: true,
    });
    prefetchJson(`/api/market/orders?collection=${slug}&kind=offer`, {
      ttlMs: 12_000,
      swrMs: 60_000,
      session: true,
    });
    // Activity feed. The ?full=1 lineage is deliberately NOT prefetched:
    // it's the most expensive activity query and rate-limited to 60/min
    // globally — every visitor requesting it on mount was eating the whole
    // budget. The Activity tab fetches it when actually opened.
    prefetchJson("/api/market/activity", { ttlMs: 20_000, swrMs: 120_000, session: true });
    // Instant Swap
    prefetchJson("/api/market/vault/stats", { ttlMs: 10_000, swrMs: 90_000, session: true });
    prefetchJson("/api/market/vault/held", { ttlMs: 15_000, swrMs: 120_000, session: true });
    prefetchJson("/api/market/vault/activity", { ttlMs: 12_000, swrMs: 90_000, session: true });
    void getRarityMap();
  }, []);

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
      const resolved = urlTab ?? "buy-sell";
      setTab(resolved);
      setVisitedTabs((prev) => (prev.has(resolved) ? prev : new Set(prev).add(resolved)));
      setDetailTokenId(item);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // While the user lingers on whichever tab they landed on, quietly mount
  // one more not-yet-visited tab every few seconds in the background (still
  // hidden — same lazy-then-sticky mechanism as an actual click, see
  // visitedTabs above) so by the time they do click over, it's often
  // already loaded. Deliberately staggered, not all six at once: mounting
  // everything simultaneously on page load was tried and reverted earlier
  // (see visitedTabs' own comment) — it 429'd the public RPC. One at a time
  // on a real delay avoids that same burst while still getting there.
  useEffect(() => {
    const STAGGER_MS = 15_000;
    const timer = window.setInterval(() => {
      // Never pre-warm into a backgrounded page — each mount costs an
      // initial data load the user isn't there to see.
      if (document.hidden) return;
      setVisitedTabs((prev) => {
        const next = MARKET_TABS.map((marketTab) => marketTab.id).find((id) => !prev.has(id));
        if (!next) {
          window.clearInterval(timer);
          return prev;
        }
        return new Set(prev).add(next);
      });
    }, STAGGER_MS);
    return () => window.clearInterval(timer);
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
      setVisitedTabs((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
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
      // Disconnecting invalidates the wallet-scoped ownership snapshot.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const [connectOpen, setConnectOpen] = useState(false);

  const handleConnect = useCallback(() => {
    setError(null);
    setConnectOpen(true);
  }, []);

  // Header "Connect wallet" hand-off: the nav button routes to
  // /market?connect=1 (or fires this event when already here) — connection
  // itself stays owned by this workspace, per DESIGN.md.
  useEffect(() => {
    const openConnect = () => handleConnect();
    window.addEventListener("plank:connect-wallet", openConnect);
    const params = new URLSearchParams(window.location.search);
    if (params.get("connect") === "1") {
      params.delete("connect");
      const query = params.toString();
      window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
      handleConnect();
    }
    return () => window.removeEventListener("plank:connect-wallet", openConnect);
  }, [handleConnect]);

  const onWalletConnected = useCallback(async (addr: string) => {
    try {
      await ensureRobinhoodChain();
    } catch {
      /* WC may already be on 4663; ensure will prompt if not */
    }
    setAccount(addr);
    setConnectOpen(false);
  }, []);

  const requireAccount = useCallback(async () => {
    if (account) return account;
    handleConnect();
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
        const { validateListingOrder } = await loadOrderValidation();
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
      const { fulfillOrder } = await loadSeaport();
      await fulfillOrder(
        buyTarget.listing.rawOrder as Parameters<SeaportModule["fulfillOrder"]>[0],
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
      const { sweepFloor } = await loadSeaport();
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

        const { validateOfferOrder } = await loadOrderValidation();
        const derived = validateOfferOrder(full.rawOrder, COLLECTION, MARKET_OFFER_CURRENCY);
        const { assertAcceptableOffer } = await loadSeaport();
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
        const { validateOfferOrder } = await loadOrderValidation();
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
        const { assertAcceptableTraitOffer } = await loadSeaport();
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
      const { validateOfferOrder } = await loadOrderValidation();
      const derived = validateOfferOrder(offer.rawOrder, COLLECTION, MARKET_OFFER_CURRENCY, {
        criteriaTokenIds: offer.criteriaTokenIds ?? [],
      });
      const { assertAcceptableTraitOffer, fulfillOrder } = await loadSeaport();
      const criteria = assertAcceptableTraitOffer(
        { priceWei: acceptTraitTarget.verifiedNetWei, criteriaTokenIds: offer.criteriaTokenIds },
        derived,
        chosenTokenId
      );
      setStatus(`Accepting trait offer with #${chosenTokenId}…`);
      await fulfillOrder(
        offer.rawOrder as Parameters<SeaportModule["fulfillOrder"]>[0],
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
      const { fulfillOrder } = await loadSeaport();
      await fulfillOrder(
        acceptTarget.offer.rawOrder as Parameters<SeaportModule["fulfillOrder"]>[0],
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

  // Derived book data is memoized on its actual inputs: this component
  // re-renders on every countdown tick and poll update, and the BigInt
  // filter/sort/floor passes were re-running each time.
  const visibleListings = useMemo(
    () => applyFilters(listings, filters, rarityMap),
    [listings, filters, rarityMap]
  );
  const sortedVisibleListings = useMemo(
    () => sortListings(visibleListings, sort),
    [visibleListings, sort]
  );
  // Listed count per tier for the filter rail's rarity rows (mockup parity).
  const tierListedCounts = useMemo(() => {
    const counts: Partial<Record<string, number>> = {};
    for (const l of listings) {
      const t = l.tokenId ? rarityMap.get(l.tokenId)?.tier : undefined;
      if (t) counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  }, [listings, rarityMap]);
  // TRAIT bids (criteria orders with a committed snapshot) render as their own
  // rows — they have no single tokenId, so a token-card grid can't show them.
  const traitOffers = useMemo(
    () =>
      offers.filter(
        (o) => ((o as unknown as Offer).criteriaTokenIds?.length ?? 0) > 0
      ) as unknown as Array<WithOrder<Offer>>,
    [offers]
  );
  const tokenOffers = useMemo(
    () => offers.filter((o) => !((o as unknown as Offer).criteriaTokenIds?.length ?? 0)),
    [offers]
  );
  // Offers invert the price sort — "low to high" means best (highest) bid
  // first on the offers tab, mirroring the original inline call.
  const sortedTokenOffers = useMemo(
    () => sortListings(tokenOffers, sort === "price-asc" ? "price-desc" : sort),
    [tokenOffers, sort]
  );
  // Floor = cheapest live listing; every card at that exact price gets the badge.
  const floorPriceWei = useMemo(
    () =>
      listings.length > 0
        ? listings.reduce(
            (min, l) => (BigInt(l.priceWei) < BigInt(min) ? l.priceWei : min),
            listings[0].priceWei
          )
        : undefined,
    [listings]
  );
  const detailListing = detailTokenId
    ? listings.find((l) => l.tokenId === detailTokenId)
    : undefined;

  return (
    <MarketScaffold>
      <ConnectWalletModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={(addr) => void onWalletConnected(addr)}
      />
      {COLLECTION && <MarketCollectionHero collection={COLLECTION} />}
      <MarketTabRail
        navigation={
          <MarketNav
            active={tab}
            onChange={selectTab}
            counts={{ "buy-sell": listings.length, offers: offers.length }}
            onPrewarm={(id) =>
              setVisitedTabs((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
            }
          />
        }
        actions={
          <>
            {account ? (
              <WalletChip account={account} />
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                className="min-h-11 shrink-0 rounded-lg bg-gold-500 px-3.5 text-xs font-bold text-wood-950 transition hover:bg-gold-400"
              >
                Connect
              </button>
            )}
            {tab === "buy-sell" &&
              account && (
                // Routes to "My Listings" (MyInventory) rather than opening a
                // duplicate typed-token form. One picker, not two.
                <button
                  type="button"
                  onClick={() => selectTab("positions")}
                  className="min-h-11 shrink-0 rounded-lg border border-line-strong px-3.5 text-xs font-bold text-gold-300 transition hover:border-gold-400"
                >
                  Sell
                </button>
              )}
          </>
        }
      />
      {/* Collection-wide "Offer any" remains intentionally absent: its
          fulfillment resolver is not wired. The working criteria bid flow
          stays available in Buy & Sell and Offers. */}

      <MarketContent>
      {(status || error) && (
        <p
          className={`text-center text-xs ${error ? "text-red-300" : "text-forest-600"}`}
          role={error ? "alert" : "status"}
        >
          {error ?? status}
        </p>
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
                className="min-h-10 w-full rounded-md border border-line bg-wood-950 px-2 text-sm text-foreground"
              >
                {acceptTraitTarget.qualifyingOwned.map((id) => (
                  <option key={id} value={id}>
                    {COLLECTION.name} #{id}
                  </option>
                ))}
              </select>
            </label>
            <dl className="space-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
              <div className="flex justify-between">
                <dt className="font-bold text-foreground">You receive (net)</dt>
                <dd className="font-display tabular-nums text-gold-300">
                  {formatTokenAmount(acceptTraitTarget.verifiedNetWei, 18, 6)} WETH
                </dd>
              </div>
            </dl>
            <p className="text-center text-[0.6rem] text-foreground/40">
              Amount and qualifying set verified against the buyer&apos;s signed order in this
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
            <dl className="space-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
              <div className="flex justify-between border-t border-line pt-1 first:border-t-0 first:pt-0">
                <dt className="font-bold text-foreground">You receive (net)</dt>
                <dd className="font-display tabular-nums text-gold-300">
                  {formatTokenAmount(acceptTarget.verifiedNetWei, 18, 6)} WETH
                </dd>
              </div>
            </dl>
            <p className="text-center text-[0.6rem] text-foreground/40">
              Amount verified against the buyer&apos;s signed order in this browser. Plus network gas.
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
          account={account}
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

      {/* Every tab below stays mounted once first visited instead of
          unmounting on switch — a tab you've already opened snaps back
          instantly (its data, images, and any live connections are still
          there) instead of re-fetching and re-rendering from scratch.
          Hidden tabs are display:none, not removed from the tree. */}
      <div>
        <MarketTabPanel id="buy-sell" active={tab === "buy-sell"}>
          {visitedTabs.has("buy-sell") && (
            <MarketTabSection
              eyebrow="Live order book"
              title="Explore floorboards"
              description="Search every live listing, compare rarity floors, make a criteria bid, or sweep several planks in one verified flow."
              labelled={false}
            >
              <div className="space-y-3">
                <EventCountdown />
                {COLLECTION && (
                  <CollectionStats
                    collection={COLLECTION}
                    listings={listings}
                    offers={offers}
                    totalSupply={TOTAL_SUPPLY}
                  />
                )}
                <OrderBookAlert message={bookError} onRetry={retryOrderBook} />
                {account && !loading && (
                  <IncomingBids
                    dense
                    offers={offers as unknown as Array<WithOrder<Offer>>}
                    ownedTokenIds={ownedTokenIds}
                    onAcceptToken={(o) => void handleAcceptOffer(o as unknown as Listing)}
                    onAcceptCriteria={(o) => void handleAcceptTraitOffer(o as WithOrder<Offer>)}
                  />
                )}
                <MarketBrowseLayout
                  summary={
                    loading
                      ? "Loading live listings…"
                      : `${visibleListings.length} ${visibleListings.length === 1 ? "Plank" : "Planks"} on the market`
                  }
                  filters={
                    <FilterBar
                      filters={filters}
                      onChange={setFilters}
                      resultCount={loading ? 0 : visibleListings.length}
                      rarityAvailable={rarityMap.size > 0}
                      orientation="sidebar"
                      tierCounts={tierListedCounts}
                    />
                  }
                  lead={
                    !loading && rarityMap.size > 0 && listings.length > 0 ? (
                      <RarityFloorStrip
                        listings={listings}
                        rarity={rarityMap}
                        activeTier={filters.tier}
                        onSelectTier={(tier) => {
                          setFilters((f) => ({
                            ...f,
                            tier,
                            tiers: tier === "all" ? [] : [tier],
                          }));
                        }}
                      />
                    ) : undefined
                  }
                  toolbar={
                    <>
                      {COLLECTION && !loading && (
                        <button
                          type="button"
                          onClick={() => setSweepOpen((v) => !v)}
                          aria-pressed={sweepOpen}
                          aria-controls="sweep-planner"
                          className={`min-h-10 shrink-0 rounded-lg border px-3 text-xs font-bold transition ${
                            sweepOpen
                              ? "border-gold-400 bg-gold-500/15 text-gold-200"
                              : "border-line-strong text-gold-300 hover:border-gold-400"
                          }`}
                          title="Batch-buy the cheapest listings — scopes, presets, and confirmation"
                        >
                          Sweep floorboards
                        </button>
                      )}
                      {COLLECTION && !loading && (
                        <button
                          type="button"
                          onClick={async () => {
                            const who = await requireAccount();
                            if (who) setOfferTarget({ trait: true });
                          }}
                          className="min-h-10 shrink-0 rounded-lg border border-line-strong px-3 text-xs font-bold text-gold-300 transition hover:border-gold-400"
                          title="Bid on any plank matching trait, rarity, or combo"
                        >
                          Bid by criteria
                        </button>
                      )}
                      <label className="flex items-center gap-1.5">
                        <span className="sr-only">Sort listings</span>
                        <select
                          value={sort}
                          onChange={(e) => setSort(e.target.value as SortKey)}
                          className="min-h-10 max-w-[12rem] rounded-md border border-line bg-wood-950 px-2 text-xs text-foreground"
                        >
                          {SORTS.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  }
                >
                  {COLLECTION && !loading && sweepOpen && (
                    <div
                      id="sweep-planner"
                      className="mb-3 rounded-xl border border-line bg-wood-900/80 p-3"
                    >
                      <SweepFloorboards
                        listings={listings}
                        collection={COLLECTION}
                        account={account}
                        rarity={rarityMap}
                        tierScope={filters.tier}
                        onSweep={(plan) => void handleSweep(plan)}
                      />
                    </div>
                  )}
                  {loading ? (
                    <ListingSkeleton />
                  ) : (
                    <ListingGrid
                      listings={sortedVisibleListings}
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
                      emptyAction={
                        listings.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setFilters(EMPTY_FILTERS)}
                            className="min-h-10 rounded-md border border-line-strong px-3 text-xs text-gold-300 hover:border-gold-400"
                          >
                            Clear filters
                          </button>
                        ) : undefined
                      }
                    />
                  )}
                </MarketBrowseLayout>
              </div>
            </MarketTabSection>
          )}
        </MarketTabPanel>
        <MarketTabPanel id="offers" active={tab === "offers"}>
          {visitedTabs.has("offers") && (
          <MarketTabSection
            eyebrow="Name your price"
            title="Offers"
            description="Bid on one Plank, a rarity tier, or a precise trait combo. Criteria clauses use AND logic and sellers verify net proceeds before accepting."
          >
            <OrderBookAlert message={bookError} onRetry={retryOrderBook} />
            {account && (
              <div className="mb-3 flex justify-end">
                <WethBalance account={account} />
              </div>
            )}
            <div className="grid items-start gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
              <div className="lg:sticky lg:top-[8.75rem]">
                {COLLECTION ? (
                  <OfferForm
                    presentation="inline"
                    account={account}
                    collection={COLLECTION}
                    traitMode
                    listings={listings}
                    onClose={() => undefined}
                    onConnect={handleConnect}
                    onSubmitted={() => void refresh()}
                  />
                ) : null}
              </div>
              <div className="min-w-0 space-y-3">
                {account && !loading && (
                  <IncomingBids
                    offers={offers as unknown as Array<WithOrder<Offer>>}
                    ownedTokenIds={ownedTokenIds}
                    onAcceptToken={(o) => void handleAcceptOffer(o as unknown as Listing)}
                    onAcceptCriteria={(o) => void handleAcceptTraitOffer(o as WithOrder<Offer>)}
                  />
                )}
                {!loading && traitOffers.length > 0 && (
                  <section aria-labelledby="open-criteria-bids">
                    <div className="mb-2 flex items-end justify-between gap-3">
                      <div>
                        <h3 id="open-criteria-bids" className="font-display text-xl text-gold-300">
                          Open criteria bids
                        </h3>
                        <p className="text-xs text-foreground/55">
                          Rarity, trait, rank, and combo orders.
                        </p>
                      </div>
                      <span className="rounded-full border border-line px-2 py-1 text-[0.65rem] text-gold-300">
                        {traitOffers.length} active
                      </span>
                    </div>
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
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-bold text-foreground">
                                Any{" "}
                                {o.traits
                                  ?.map((t) => `${t.traitType}: ${t.value}`)
                                  .join(", ") ?? "qualifying plank"}
                              </p>
                              <p className="text-xs text-foreground/60">
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
                              className="min-h-10 rounded-md bg-gold-500 px-3 text-xs font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-40"
                            >
                              Accept
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
                <section aria-labelledby="single-token-offers">
                  <div className="mb-2">
                    <h3 id="single-token-offers" className="font-display text-xl text-gold-300">
                      Single-token offers
                    </h3>
                    <p className="text-xs text-foreground/55">
                      Offers tied to one exact token ID.
                    </p>
                  </div>
                  {loading ? (
                    <ListingSkeleton />
                  ) : (
                    <ListingGrid
                      listings={sortedTokenOffers}
                      collections={MARKET_COLLECTIONS}
                      onBuy={handleAcceptOffer}
                      onSelect={openDetail}
                      buyLabel="Accept"
                      variant="offer"
                      ownedTokenIds={ownedTokenIds}
                      emptyMessage={
                        traitOffers.length > 0
                          ? "No single-token offers."
                          : "No offers yet. Build the first criteria bid."
                      }
                    />
                  )}
                </section>
              </div>
            </div>
          </MarketTabSection>
          )}
        </MarketTabPanel>
        <MarketTabPanel id="activity" active={tab === "activity"}>
          {visitedTabs.has("activity") && (
          <MarketTabSection
            eyebrow="On-chain record"
            title="Activity"
            description="Follow collection sales, mints, transfers, venue attribution, price history, and live V1/V2 liquidity-pool trades."
          >
            <div className="space-y-3">
              <ActivityFeed
                onSelectToken={openDetail}
              />
              <VaultTradeHistory />
            </div>
          </MarketTabSection>
          )}
        </MarketTabPanel>
        <MarketTabPanel id="swap" active={tab === "swap"}>
          {visitedTabs.has("swap") && (
          <MarketTabSection
            eyebrow="Trade shares · redeem NFTs"
            title="Instant Swap"
            description="Buy or sell vault shares instantly, provide liquidity, deposit a Plank, or redeem shares for an NFT."
          >
            <div className="space-y-3">
            {/* Dual vault: pick V1 (legacy deposits) or V2 (new book / LP) first */}
            <InstantVaultSwitcher role={vaultRole} onChange={setVaultRole} active={tab === "swap"} />
            <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <SwapPanel
                account={account}
                onConnect={handleConnect}
                active={tab === "swap"}
                vaultAddress={activeVault?.address ?? null}
                vaultLabel={
                  vaultRole === "legacy"
                    ? "legacy deposits"
                    : activeVault?.isV1
                      ? "primary vault"
                      : "new Instant Swap"
                }
              />
              <div className="space-y-3">
                <LivingLiquidityViz vaultAddress={activeVault?.address ?? null} active={tab === "swap"} />
                <VaultDashboard vaultAddress={activeVault?.address ?? null} active={tab === "swap"} />
              </div>
            </div>
            <div className="grid items-start gap-3 md:grid-cols-2">
              <NftPriceChart active={tab === "swap"} />
              <RedeemOdds vaultAddress={activeVault?.address ?? null} active={tab === "swap"} />
            </div>
            {/* Trades stay dual-vault (V1 + V2) regardless of selection */}
            <VaultTradeHistory />
            {dualVaultMode() && (
              <MarketDisclosure
                eyebrow="Migration"
                title="Move V1 value to V2"
                description="Optional migration, fee details, dust recovery, redeem, and re-deposit steps."
              >
                <VaultMigrate account={account} onConnect={handleConnect} embedded active={tab === "swap"} />
              </MarketDisclosure>
            )}
            {/* Seed/bootstrap only on primary (V2) — never seed into legacy V1 */}
            {vaultRole === "primary" && (
              <MarketDisclosure
                eyebrow="Operator controls"
                title="Seed and bootstrap the V2 vault"
                description="Treasury-only setup and liquidity controls for the primary vault."
              >
                <SeedVaultPanel account={account} onConnect={handleConnect} active={tab === "swap"} />
              </MarketDisclosure>
            )}
            <MarketDisclosure
              eyebrow="Protocol accounting"
              title="Treasury and fee dashboard"
              description="Live fee balances, collection flows, and treasury status."
            >
              <TreasuryDashboard />
            </MarketDisclosure>
            </div>
          </MarketTabSection>
          )}
        </MarketTabPanel>
        <MarketTabPanel id="my-nfts" active={tab === "my-nfts"}>
          {visitedTabs.has("my-nfts") && (account ? (
            <MarketTabSection
              eyebrow="Wallet inventory"
              title="My NFTs"
              description="Review every Plank in your wallet, inspect rarity and listing state, or select several for a verified transfer."
            >
              <MyNfts
                account={account}
                collections={MARKET_COLLECTIONS}
                alreadyListed={
                  new Set(
                    listings
                      .filter((l) => l.maker.toLowerCase() === account.toLowerCase())
                      .map((l) => `${l.collectionSlug}:${l.tokenId}`)
                  )
                }
              />
            </MarketTabSection>
          ) : (
            <MarketWalletGate
              title="See your Planks"
              description="Connect to load your collection, inspect rarity and listing status, and access the multi-select send workflow."
              onConnect={handleConnect}
            />
          ))}
        </MarketTabPanel>
        <MarketTabPanel id="positions" active={tab === "positions"}>
          {visitedTabs.has("positions") && (account ? (
            <MarketTabSection
              eyebrow="Seller workspace"
              title="My Listings"
              description="List Planks from your wallet, accept matching bids, cancel active orders, and manage marketplace approvals."
            >
              <div className="space-y-3">
              <OrderBookAlert message={bookError} onRetry={retryOrderBook} />
              <IncomingBids
                offers={offers as unknown as Array<WithOrder<Offer>>}
                ownedTokenIds={ownedTokenIds}
                onAcceptToken={(o) => void handleAcceptOffer(o as unknown as Listing)}
                onAcceptCriteria={(o) => void handleAcceptTraitOffer(o as WithOrder<Offer>)}
              />
              <button
                type="button"
                onClick={() => setShowInventory((v) => !v)}
                aria-expanded={showInventory}
                className="min-h-10 rounded-lg border border-line-strong px-3.5 text-xs font-bold text-gold-300 transition hover:border-gold-400 sm:text-sm"
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
            </MarketTabSection>
          ) : (
            <MarketWalletGate
              title="Manage your listings"
              description="Connect to list Planks, review active listings and offers, accept matching bids, cancel orders, and revoke approvals."
              onConnect={handleConnect}
            />
          ))}
        </MarketTabPanel>
      </div>
      </MarketContent>
    </MarketScaffold>
  );
}
