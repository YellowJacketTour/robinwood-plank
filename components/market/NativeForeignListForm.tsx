"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { parseTokenAmount, formatTokenAmount } from "@/lib/trade";
import { MARKETPLANK_NATIVE_LISTING_FEE_BPS } from "@/lib/constants";
import { chainDisplayName } from "@/lib/market/multichain/trading/foreign-chain-registry";
import type { MarketCollection } from "@/lib/market/types";
import EthUsdValue from "@/components/market/EthUsdValue";
import { ensureChain } from "@/lib/wallet";

type OwnedItem = { tokenId: string; name: string | null; imageUrl: string | null };

type Props = {
  chainSlug: string;
  currencySymbol: string;
  account: string | null;
  collection: MarketCollection;
  ownedItems: OwnedItem[];
  ownedLoading: boolean;
  onListed: () => void;
  onConnect: () => void;
};

const DURATIONS = [1, 3, 7, 30];

/**
 * List one owned item for sale DIRECTLY with Marketplank on a foreign EVM
 * chain -- no OpenSea, no Magic Eden, no UniSat. Same underlying mechanism
 * as Robinhood Chain's own native listing (a signed Seaport order,
 * non-custodial, this app only stores and serves it), just pointed at
 * app/api/market/multichain/native-orders instead of /api/market/orders,
 * and chain-parameterized via lib/market/seaport.ts's now-generic
 * getSeaport/buildListing (see this session's plan doc).
 *
 * Single-item only for this first pass -- MyInventory.tsx's bulk flow
 * (lib/market/bulk-list.ts) is the natural place to extend this into a
 * multi-select later; deliberately not done here to keep the first native
 * foreign-chain listing surface small and easy to verify.
 *
 * Fee is ALWAYS MARKETPLANK_NATIVE_LISTING_FEE_BPS (1.8%) -- never the
 * passed-in collection.feeBps, which MultichainCollectionView.tsx
 * deliberately zeroes for foreign collections (see that file's own
 * setCollection comment). Royalty is 0 for the same reason
 * app/api/market/multichain/native-orders/route.ts's server-side check
 * starts at 0: no real per-chain EIP-2981 data exists yet for a collection
 * Marketplank doesn't curate.
 */
export default function NativeForeignListForm({
  chainSlug,
  currencySymbol,
  account,
  collection,
  ownedItems,
  ownedLoading,
  onListed,
  onConnect,
}: Props) {
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [priceEth, setPriceEth] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const priceWei = parseTokenAmount(priceEth, 18);
  const selectedItem = ownedItems.find((i) => i.tokenId === selectedTokenId) ?? null;
  const feePct = (MARKETPLANK_NATIVE_LISTING_FEE_BPS / 100).toFixed(1);
  const netWei = priceWei !== null ? (priceWei * BigInt(10_000 - MARKETPLANK_NATIVE_LISTING_FEE_BPS)) / 10_000n : null;

  const openReview = () => {
    setError(null);
    setSuccess(null);
    if (!account) {
      onConnect();
      return;
    }
    if (!selectedTokenId) {
      setError("Pick an item to list.");
      return;
    }
    if (priceWei === null || priceWei <= 0n) {
      setError("Enter a valid price.");
      return;
    }
    setReviewOpen(true);
  };

  const submit = async () => {
    if (!account || !selectedTokenId || priceWei === null) return;
    setError(null);
    try {
      setBusy(true);
      const chain = await import("@/lib/market/multichain/trading/foreign-chain-registry");
      const target = chain.foreignChainByChainSlug(chainSlug);
      if (!target) throw new Error(`"${chainSlug}" is not a supported foreign chain.`);
      // Assert chain ID immediately before signing, matching foreign-fulfill.ts's own
      // established call pattern -- never sign against whatever chain the wallet happens
      // to be on.
      await ensureChain({
        chainId: target.chainId,
        name: chainDisplayName(chainSlug),
        nativeCurrencySymbol: target.nativeCurrencySymbol,
        rpcUrl: chain.foreignRpcUrls(chainSlug)[0],
        blockExplorerUrl: target.blockExplorerUrl,
      });

      const { buildListing } = await import("@/lib/market/seaport");
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const rawOrder = await buildListing(
        account,
        {
          offerTokenAddress: collection.contractAddress,
          offerTokenId: selectedTokenId,
          considerationWei: priceWei.toString(),
          expiresAt,
          feeBps: MARKETPLANK_NATIVE_LISTING_FEE_BPS,
          royaltyBps: 0,
          royaltyRecipient: "0x0000000000000000000000000000000000000000",
        },
        {
          chainSlug,
          chainId: target.chainId,
          chainName: chainDisplayName(chainSlug),
          nativeCurrencySymbol: target.nativeCurrencySymbol,
          rpcUrl: chain.foreignRpcUrls(chainSlug)[0],
          blockExplorerUrl: target.blockExplorerUrl,
          seaportAddress: chain.FOREIGN_SEAPORT_ADDRESS,
        }
      );

      const res = await fetch("/api/market/multichain/native-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainSlug,
          kind: "listing",
          contractAddress: collection.contractAddress,
          rawOrder,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(data.message || "The relay rejected this listing.");

      setSelectedTokenId(null);
      setPriceEth("");
      setReviewOpen(false);
      setSuccess("Listed directly with Marketplank. No OpenSea, no third-party fee.");
      onListed();
    } catch (e) {
      console.error("Native foreign listing failed:", e);
      setError(e instanceof Error ? e.message : "Listing failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wood-ledger w-full space-y-3 rounded-xl border border-line p-4">
      {reviewOpen && selectedItem && priceWei !== null && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="native-list-review-title">
          <div className="wood-ledger w-full max-w-lg rounded-t-xl border border-line-strong p-4 sm:rounded-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[0.65rem] font-black uppercase tracking-[0.14em] text-gold-300/75">Verify before signing</p>
                <h3 id="native-list-review-title" className="mt-1 font-display text-2xl text-gold-300">
                  List directly with Marketplank
                </h3>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setReviewOpen(false);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-line text-foreground/65 hover:text-gold-300 disabled:opacity-40"
                aria-label="Close review"
              >
                <X size={14} strokeWidth={2.5} />
              </button>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Item</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">{selectedItem.name ?? `#${selectedItem.tokenId}`}</dd>
              </div>
              <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Price</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">
                  <span className="block">
                    {priceEth} {currencySymbol}
                  </span>
                  <EthUsdValue wei={priceWei} className="mt-0.5 block text-[0.65rem] text-foreground/50" />
                </dd>
              </div>
              <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Marketplank fee</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">{feePct}%</dd>
              </div>
              <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">You receive</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">
                  {netWei !== null ? formatTokenAmount(netWei.toString(), 18, 5) : "—"} {currencySymbol}
                </dd>
              </div>
              <div className="col-span-2 rounded-lg border border-line bg-wood-950 px-3 py-2">
                <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Chain</dt>
                <dd className="mt-1 text-xs font-bold text-foreground">{chainDisplayName(chainSlug)} · Seaport 1.6 · {days} days</dd>
              </div>
            </dl>

            <p className="mt-3 text-xs leading-5 text-foreground/55">
              This is a direct, non-custodial Marketplank listing -- not an OpenSea order. Only you can accept a buyer's
              transaction; Marketplank never holds your NFT or your proceeds.
            </p>

            {error && (
              <p role="alert" className="mt-3 rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
                {error}
              </p>
            )}

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setReviewOpen(false);
                }}
                className="min-h-11 rounded-lg border border-line text-sm text-foreground/75 hover:text-gold-300 disabled:opacity-40"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                className="min-h-11 rounded-lg bg-gold-500 text-sm font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
              >
                {busy ? "Confirm in wallet…" : "Continue to wallet"}
              </button>
            </div>
          </div>
        </div>
      )}

      <h3 className="font-display text-lg text-gold-300">List directly with Marketplank</h3>
      <p className="text-center text-[0.65rem] text-foreground/55">
        {feePct}% Marketplank fee -- no OpenSea, no Magic Eden, no UniSat. Any buyer fulfills your order straight
        against Seaport, the same canonical contract those marketplaces use.
      </p>

      {ownedLoading ? (
        <p className="text-center text-xs text-foreground/45">Loading what you own on {chainDisplayName(chainSlug)}…</p>
      ) : ownedItems.length === 0 ? (
        <p className="text-center text-xs text-foreground/45">You don't own any {collection.name} on {chainDisplayName(chainSlug)} yet.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-1.5">
          {ownedItems.map((item) => (
            <button
              key={item.tokenId}
              type="button"
              onClick={() => setSelectedTokenId(item.tokenId)}
              aria-pressed={selectedTokenId === item.tokenId}
              title={item.name ?? `#${item.tokenId}`}
              className={`aspect-square rounded-md border text-[0.55rem] font-bold text-foreground/70 outline-none transition ${
                selectedTokenId === item.tokenId ? "border-gold-400 ring-2 ring-gold-400" : "border-line hover:border-line-strong"
              } bg-wood-900 bg-cover bg-center`}
              style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}
            >
              {!item.imageUrl && <span className="flex h-full items-center justify-center">#{item.tokenId}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-12 items-center gap-2 rounded-lg border border-line bg-panel px-2.5">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={priceEth}
          onChange={(e) => setPriceEth(e.target.value.replace(/[^0-9.]/g, ""))}
          className="min-w-0 flex-1 bg-transparent py-2.5 text-lg font-semibold text-foreground outline-none"
        />
        <span className="text-xs font-bold text-gold-300">{currencySymbol}</span>
      </div>
      <EthUsdValue wei={priceWei} className="block text-right text-[0.65rem] text-foreground/50" />

      <div className="flex gap-1.5">
        {DURATIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={`min-h-9 flex-1 rounded-md text-xs font-bold ${days === d ? "bg-gold-500 text-wood-950" : "border border-line text-foreground/70"}`}
          >
            {d}d
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={busy || ownedItems.length === 0}
        onClick={openReview}
        className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
      >
        {busy ? "Signing…" : !account ? "Connect to list" : "Review & sign listing"}
      </button>
      {error && (
        <p className="text-center text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="text-center text-xs text-emerald-300" role="status">
          {success}
        </p>
      )}
    </div>
  );
}
