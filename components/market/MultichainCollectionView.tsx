"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ListingCard from "@/components/market/ListingCard";
import BuyConfirm from "@/components/market/BuyConfirm";
import ForeignSweepConfirm from "@/components/market/ForeignSweepConfirm";
import ForeignSendConfirm from "@/components/market/ForeignSendConfirm";
import { useWallet } from "@/lib/wallet-context";
import { connectWallet } from "@/lib/wallet";
import type { SendFeeQuote } from "@/lib/market/send-fee";
import type { BatchSendStatus } from "@/lib/market/transfer";
import { chainDisplayName, FOREIGN_FEE_BPS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { isCrossChainBuyable, venueLabel, type Listing, type MarketCollection } from "@/lib/market/types";

type Props = {
  chainSlug: string;
  collectionSlug: string;
};

const SWEEP_SIZE_OPTIONS = [3, 5, 10];

/**
 * Browse + buy + sweep + send surface for ONE tracked multichain collection
 * (see plank_multichain_collections) -- deliberately a NEW page, not an
 * extension of MarketView.tsx, which is scoped to Marketplank's own single
 * RobinWood collection. See app/api/market/multichain/listings/route.ts's
 * header for why this can't live inside /market or /discover's existing,
 * documented contracts.
 *
 * Reuses the SAME ListingCard/BuyConfirm/foreign-fulfill machinery already
 * built and proven for the single-collection surface -- the cross-chain
 * buy/sweep/send flow is identical regardless of which collection or chain
 * an item came from, so nothing here reimplements that logic.
 */
export default function MultichainCollectionView({ chainSlug, collectionSlug }: Props) {
  const { address: account, adoptAccount } = useWallet();
  const [collection, setCollection] = useState<MarketCollection | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // SMART SEARCH / FILTER -- point-and-click, no page reload, applies
  // instantly to whatever is already loaded. Token-id search matches
  // exact or prefix (typing "54" finds #541, #5432, ...); price range is
  // inclusive on both ends and either side can be left blank.
  const [searchQuery, setSearchQuery] = useState("");
  const [minPriceEth, setMinPriceEth] = useState("");
  const [maxPriceEth, setMaxPriceEth] = useState("");

  const [buyTarget, setBuyTarget] = useState<Listing | null>(null);
  const [buyBusy, setBuyBusy] = useState(false);

  const [sweepCount, setSweepCount] = useState(SWEEP_SIZE_OPTIONS[0]);
  const [sweepPreview, setSweepPreview] = useState<Listing[] | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);

  // "MY ITEMS" / SEND -- owned tokens in this exact collection+chain for
  // the connected wallet, with single or batch send. Separate from the
  // listings grid on purpose: an owned token is not necessarily listed for
  // sale, and a listed token is not necessarily owned by the viewer.
  const [ownedTokenIds, setOwnedTokenIds] = useState<string[]>([]);
  const [ownedLoading, setOwnedLoading] = useState(false);
  const [selectedForSend, setSelectedForSend] = useState<Set<string>>(new Set());
  const [sendTarget, setSendTarget] = useState<string[] | null>(null); // token ids currently in the confirm modal
  const [sendRecipient, setSendRecipient] = useState("");
  const [sendFeeQuote, setSendFeeQuote] = useState<SendFeeQuote | null>(null);
  const [sendFeeError, setSendFeeError] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendStatuses, setSendStatuses] = useState<Map<string, BatchSendStatus> | null>(null);

  const chainLabel = `${chainDisplayName(chainSlug)} via OpenSea`;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // Collection identity comes from the SAME response as the listings.
      // An earlier version looked it up in /api/market/multichain by
      // matching contractAddress against collectionSlug -- those are
      // different identifiers entirely (an OpenSea slug like "gribbits" is
      // never a 0x address), so the lookup silently never matched and every
      // card fell back to an EMPTY image src. Real-browser loading caught
      // it: 120 console errors and an art-less grid. One source, no
      // cross-referencing by mismatched key.
      const res = await fetch(
        `/api/market/multichain/listings?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collectionSlug)}&limit=40`
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        collection: { slug: string; name: string; imageUrl: string | null; contractAddress: string };
        listings: Listing[];
      };
      // MarketCollection carries Robinhood-Chain-specific bookkeeping
      // (feeBps/royaltyBps/royaltyRecipient) that has no meaning for a
      // foreign collection -- real royalty is whatever the real Seaport
      // order's own consideration embeds (OpenSea's own enforcement), not
      // something this app tracks or sets. Zeroed here deliberately, not
      // a gap: ListingCard/BuyConfirm only read collection.name/image for
      // a cross-chain listing's display, never these fields.
      setCollection({
        slug: data.collection.slug,
        name: data.collection.name,
        contractAddress: data.collection.contractAddress,
        tokenStandard: "ERC721",
        image: data.collection.imageUrl ?? "",
        trustBadges: [],
        feeBps: 0,
        royaltyBps: 0,
        royaltyRecipient: "0x0000000000000000000000000000000000000000",
      });
      setListings(data.listings ?? []);
    } catch {
      setLoadError("Could not load this collection's listings right now.");
    } finally {
      setLoading(false);
    }
  }, [chainSlug, collectionSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOwned = useCallback(async () => {
    if (!account || !collection?.contractAddress) {
      setOwnedTokenIds([]);
      return;
    }
    setOwnedLoading(true);
    try {
      const res = await fetch(
        `/api/market/multichain/owned?chainSlug=${chainSlug}&owner=${account}&contractAddress=${collection.contractAddress}`
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { tokenIds: string[] };
      setOwnedTokenIds(data.tokenIds ?? []);
    } catch {
      setOwnedTokenIds([]);
    } finally {
      setOwnedLoading(false);
    }
  }, [account, chainSlug, collection?.contractAddress]);

  useEffect(() => {
    void loadOwned();
  }, [loadOwned]);

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

  const handleBuy = useCallback(
    async (listing: Listing) => {
      setError(null);
      if (!isCrossChainBuyable(listing)) return;
      const who = await requireAccount();
      if (!who) return;
      setBuyTarget(listing);
    },
    [requireAccount]
  );

  const confirmBuy = useCallback(async () => {
    if (!buyTarget) return;
    setError(null);
    try {
      setBuyBusy(true);
      setStatus("Confirm in wallet…");
      const { buyForeignListingNow } = await import("@/lib/market/multichain/trading/foreign-fulfill");
      await buyForeignListingNow({
        chainSlug: buyTarget.foreignChainSlug!,
        orderHash: buyTarget.foreignOrderHash!,
      });
      setBuyTarget(null);
      setStatus("Purchase confirmed.");
      await load();
    } catch (e) {
      console.error("Cross-chain buy failed:", e);
      setError(e instanceof Error ? e.message : "Purchase failed.");
    } finally {
      setBuyBusy(false);
      setStatus(null);
    }
  }, [buyTarget, load]);

  const openSweepPreview = useCallback(async () => {
    setError(null);
    const who = await requireAccount();
    if (!who) return;
    const cheapest = [...listings]
      .filter((l) => isCrossChainBuyable(l))
      .sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? -1 : 1))
      .slice(0, sweepCount);
    if (cheapest.length === 0) {
      setError("No cross-chain-buyable listings available to sweep right now.");
      return;
    }
    setSweepPreview(cheapest);
  }, [listings, sweepCount, requireAccount]);

  const confirmSweep = useCallback(async () => {
    if (!sweepPreview || sweepPreview.length === 0) return;
    setError(null);
    try {
      setSweepBusy(true);
      setStatus("Confirm in wallet…");
      const { sweepForeignListings } = await import("@/lib/market/multichain/trading/foreign-fulfill");
      const result = await sweepForeignListings({ chainSlug, collectionSlug, count: sweepPreview.length });
      setSweepPreview(null);
      setStatus(`Swept ${result.attempted} item(s).`);
      await load();
    } catch (e) {
      console.error("Cross-chain sweep failed:", e);
      setError(e instanceof Error ? e.message : "Sweep failed.");
    } finally {
      setSweepBusy(false);
      setStatus(null);
    }
  }, [sweepPreview, chainSlug, collectionSlug, load]);

  const toggleSendSelection = useCallback((tokenId: string) => {
    setSelectedForSend((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.add(tokenId);
      return next;
    });
  }, []);

  const openSendConfirm = useCallback(
    async (tokenIds: string[]) => {
      setError(null);
      const who = await requireAccount();
      if (!who) return;
      setSendTarget(tokenIds);
      setSendRecipient("");
      setSendFeeQuote(null);
      setSendFeeError(null);
      setSendStatuses(null);
      try {
        const { quoteForeignSendFee } = await import("@/lib/market/multichain/trading/foreign-transfer");
        const quote = await quoteForeignSendFee(chainSlug, tokenIds.length);
        setSendFeeQuote(quote);
      } catch (e) {
        setSendFeeError(e instanceof Error ? e.message : "Could not estimate the send fee.");
      }
    },
    [chainSlug, requireAccount]
  );

  const confirmSend = useCallback(async () => {
    if (!sendTarget || !account || !collection?.contractAddress) return;
    setError(null);
    try {
      setSendBusy(true);
      setStatus("Confirm in wallet…");
      if (sendTarget.length === 1) {
        const { sendForeignNft } = await import("@/lib/market/multichain/trading/foreign-transfer");
        await sendForeignNft(chainSlug, collection.contractAddress, sendTarget[0], sendRecipient, account);
      } else {
        const { sendForeignNftBatch } = await import("@/lib/market/multichain/trading/foreign-transfer");
        await sendForeignNftBatch(
          chainSlug,
          sendTarget.map((tokenId) => ({ chainSlug, collectionAddress: collection.contractAddress, tokenId })),
          sendRecipient,
          account,
          (statuses) => setSendStatuses(statuses)
        );
      }
      setStatus("Sent.");
      setSendTarget(null);
      setSelectedForSend(new Set());
      await loadOwned();
    } catch (e) {
      console.error("Send failed:", e);
      setError(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setSendBusy(false);
      setStatus(null);
    }
  }, [sendTarget, account, collection?.contractAddress, chainSlug, sendRecipient, loadOwned]);

  const filteredListings = useMemo(() => {
    const q = searchQuery.trim();
    const min = minPriceEth.trim() ? Number(minPriceEth) : null;
    const max = maxPriceEth.trim() ? Number(maxPriceEth) : null;
    return listings.filter((l) => {
      if (q && !l.tokenId.startsWith(q)) return false;
      const priceEth = Number(l.priceWei) / 1e18;
      if (min !== null && priceEth < min) return false;
      if (max !== null && priceEth > max) return false;
      return true;
    });
  }, [listings, searchQuery, minPriceEth, maxPriceEth]);

  if (loading) {
    return <p className="p-6 text-center text-foreground/50">Loading {chainDisplayName(chainSlug)} listings…</p>;
  }
  if (loadError || !collection) {
    return <p className="p-6 text-center text-red-300">{loadError ?? "Collection not found."}</p>;
  }

  const buyableCount = listings.filter((l) => isCrossChainBuyable(l)).length;
  const filtersActive = searchQuery.trim() !== "" || minPriceEth.trim() !== "" || maxPriceEth.trim() !== "";

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">{collection.name}</h2>
          <p className="text-xs text-foreground/50">
            {filteredListings.length !== listings.length
              ? `${filteredListings.length} of ${listings.length} listings`
              : `${listings.length} listing${listings.length === 1 ? "" : "s"}`}{" "}
            on {chainDisplayName(chainSlug)}
          </p>
        </div>
        {buyableCount > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={sweepCount}
              onChange={(e) => setSweepCount(Number(e.target.value))}
              className="min-h-11 rounded-md border border-line bg-panel px-2 text-sm text-foreground"
              aria-label="Sweep size"
            >
              {SWEEP_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  Sweep {n}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void openSweepPreview()}
              className="min-h-11 rounded-md bg-gold-500 px-3 text-sm font-bold text-wood-950 hover:bg-gold-400"
            >
              Sweep floor
            </button>
          </div>
        )}
      </div>

      {/* SMART SEARCH / FILTER -- instant, client-side over the loaded set. */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel p-2.5">
        <div className="min-w-[8rem] flex-1">
          <label htmlFor="mc-search" className="mb-1 block text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">
            Token #
          </label>
          <input
            id="mc-search"
            type="text"
            inputMode="numeric"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="Search #..."
            className="min-h-10 w-full rounded-md border border-line bg-background px-2 text-sm text-foreground placeholder:text-foreground/30"
          />
        </div>
        <div className="w-24">
          <label htmlFor="mc-min" className="mb-1 block text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">
            Min Ξ
          </label>
          <input
            id="mc-min"
            type="number"
            step="0.001"
            min="0"
            value={minPriceEth}
            onChange={(e) => setMinPriceEth(e.target.value)}
            placeholder="0"
            className="min-h-10 w-full rounded-md border border-line bg-background px-2 text-sm text-foreground placeholder:text-foreground/30"
          />
        </div>
        <div className="w-24">
          <label htmlFor="mc-max" className="mb-1 block text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">
            Max Ξ
          </label>
          <input
            id="mc-max"
            type="number"
            step="0.001"
            min="0"
            value={maxPriceEth}
            onChange={(e) => setMaxPriceEth(e.target.value)}
            placeholder="∞"
            className="min-h-10 w-full rounded-md border border-line bg-background px-2 text-sm text-foreground placeholder:text-foreground/30"
          />
        </div>
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setSearchQuery("");
              setMinPriceEth("");
              setMaxPriceEth("");
            }}
            className="min-h-10 rounded-md border border-line px-3 text-xs font-bold text-foreground/60 hover:border-gold-400 hover:text-gold-300"
          >
            Clear
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
          {error}
        </p>
      )}

      {/* MY ITEMS / SEND -- only appears once a wallet is connected and owns something here. */}
      {account && (ownedLoading || ownedTokenIds.length > 0) && (
        <div className="space-y-2 rounded-lg border border-line bg-panel p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-black uppercase tracking-wide text-foreground/60">
              Your items {ownedTokenIds.length > 0 ? `(${ownedTokenIds.length})` : ""}
            </h3>
            {selectedForSend.size > 0 && (
              <button
                type="button"
                onClick={() => void openSendConfirm([...selectedForSend])}
                className="min-h-9 rounded-md bg-gold-500 px-3 text-xs font-bold text-wood-950 hover:bg-gold-400"
              >
                Send {selectedForSend.size} selected
              </button>
            )}
          </div>
          {ownedLoading ? (
            <p className="text-xs text-foreground/45">Checking your wallet…</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {ownedTokenIds.map((tokenId) => (
                <div key={tokenId} className="flex items-center gap-1.5 rounded-md border border-line-strong bg-background px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={selectedForSend.has(tokenId)}
                    onChange={() => toggleSendSelection(tokenId)}
                    aria-label={`Select #${tokenId} to send`}
                    className="h-4 w-4"
                  />
                  <span className="text-xs font-bold text-foreground">#{tokenId}</span>
                  <button
                    type="button"
                    onClick={() => void openSendConfirm([tokenId])}
                    className="text-[0.6rem] font-bold text-gold-300 hover:text-gold-200"
                  >
                    Send
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {filteredListings.length === 0 ? (
        <p className="p-6 text-center text-foreground/45">
          {filtersActive ? "No listings match your search." : "No listings right now."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {filteredListings.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              collection={collection}
              onBuy={(l) => void handleBuy(l)}
            />
          ))}
        </ul>
      )}

      {buyTarget && (
        <BuyConfirm
          listing={buyTarget}
          collection={collection}
          verifiedPriceWei={buyTarget.priceWei}
          busy={buyBusy || status !== null}
          error={error}
          onConfirm={confirmBuy}
          onCancel={() => {
            setError(null);
            setBuyTarget(null);
          }}
          crossChain={{ chainLabel: `${chainDisplayName(chainSlug)} via ${venueLabel(buyTarget)}`, feeBps: FOREIGN_FEE_BPS }}
        />
      )}

      {sweepPreview && (
        <ForeignSweepConfirm
          items={sweepPreview}
          collectionName={collection.name}
          chainLabel={chainLabel}
          feeBps={FOREIGN_FEE_BPS}
          busy={sweepBusy || status !== null}
          error={error}
          onConfirm={confirmSweep}
          onCancel={() => {
            setError(null);
            setSweepPreview(null);
          }}
        />
      )}

      {sendTarget && (
        <ForeignSendConfirm
          chainLabel={chainDisplayName(chainSlug)}
          tokenIds={sendTarget}
          feeQuote={sendFeeQuote}
          feeQuoteError={sendFeeError}
          recipient={sendRecipient}
          onRecipientChange={setSendRecipient}
          busy={sendBusy || status !== null}
          error={error}
          statuses={sendStatuses}
          onConfirm={confirmSend}
          onCancel={() => {
            setError(null);
            setSendTarget(null);
          }}
        />
      )}
    </div>
  );
}
