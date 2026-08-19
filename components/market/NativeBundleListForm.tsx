"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { parseTokenAmount, formatTokenAmount } from "@/lib/trade";
import { MARKETPLANK_NATIVE_LISTING_FEE_BPS } from "@/lib/constants";
import { chainDisplayName, foreignChainByChainSlug, foreignRpcUrls, FOREIGN_SEAPORT_ADDRESS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import type { MarketCollection } from "@/lib/market/types";
import EthUsdValue from "@/components/market/EthUsdValue";
import { ensureChain } from "@/lib/wallet";
import { buildBundleListing, type SeaportChain } from "@/lib/market/seaport";

type OwnedItem = { tokenId: string; name: string | null; imageUrl: string | null };

type Props = {
  chainSlug: string;
  currencySymbol: string;
  account: string | null;
  collection: MarketCollection;
  ownedItems: OwnedItem[];
  onListed: () => void;
  onConnect: () => void;
};

const MAX_BUNDLE_ITEMS = 20;
const DURATIONS = [1, 3, 7, 30];

/**
 * Roadmap item #7: sell 2+ owned items from THIS collection as one
 * package, one combined price, one signature -- a real Seaport order with
 * multiple ERC-721 offer items (buildBundleListing, lib/market/seaport.ts),
 * fulfillable in one transaction by any buyer via the same fulfillOrder
 * every other native order already uses (see native-fulfill.ts's
 * fulfillMarketplankNativeBundleOrder).
 *
 * Cross-collection bundles are explicitly out of scope -- a bundle here
 * always draws from ONE collection's owned items (the page this form
 * renders on), matching validateBundleListingOrder's own same-contract
 * requirement (order-validation.ts). Royalty is 0, same reason every other
 * native foreign-chain order in this pass is: no real per-chain EIP-2981
 * data exists yet for a collection Marketplank doesn't curate.
 */
export default function NativeBundleListForm({ chainSlug, currencySymbol, account, collection, ownedItems, onListed, onConnect }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [priceEth, setPriceEth] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const feePct = MARKETPLANK_NATIVE_LISTING_FEE_BPS / 100;
  const priceWei = parseTokenAmount(priceEth, 18);
  const netWei = priceWei !== null ? (priceWei * BigInt(10_000 - MARKETPLANK_NATIVE_LISTING_FEE_BPS)) / 10_000n : null;

  const toggle = (tokenId: string) => {
    if (busy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else if (next.size < MAX_BUNDLE_ITEMS) next.add(tokenId);
      return next;
    });
    setError(null);
    setSuccess(null);
  };

  const selectedIds = useMemo(() => [...selected], [selected]);

  const submit = async () => {
    setError(null);
    setSuccess(null);
    if (!account) {
      onConnect();
      return;
    }
    if (selectedIds.length < 2) {
      setError("Pick at least two items to bundle -- list a single item instead if you only want one.");
      return;
    }
    if (priceWei === null || priceWei <= 0n) {
      setError("Enter a valid combined price.");
      return;
    }
    try {
      setBusy(true);
      const target = foreignChainByChainSlug(chainSlug);
      if (!target) throw new Error(`"${chainSlug}" is not a supported foreign chain.`);
      const chain: SeaportChain = {
        chainSlug,
        chainId: target.chainId,
        chainName: chainDisplayName(chainSlug),
        nativeCurrencySymbol: target.nativeCurrencySymbol,
        rpcUrl: foreignRpcUrls(chainSlug)[0],
        blockExplorerUrl: target.blockExplorerUrl,
        seaportAddress: FOREIGN_SEAPORT_ADDRESS,
      };
      await ensureChain({
        chainId: chain.chainId,
        name: chain.chainName,
        nativeCurrencySymbol: chain.nativeCurrencySymbol,
        rpcUrl: chain.rpcUrl,
        blockExplorerUrl: chain.blockExplorerUrl,
      });

      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const rawOrder = await buildBundleListing(
        account,
        {
          contractAddress: collection.contractAddress,
          offerTokenIds: selectedIds,
          considerationWei: priceWei.toString(),
          expiresAt,
          feeBps: MARKETPLANK_NATIVE_LISTING_FEE_BPS,
        },
        chain
      );

      const res = await fetch("/api/market/multichain/native-bundle-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainSlug, contractAddress: collection.contractAddress, rawOrder }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(data.message || "The relay rejected this bundle.");

      setSelected(new Set());
      setPriceEth("");
      setSuccess(`Bundle of ${selectedIds.length} listed directly with Marketplank.`);
      onListed();
    } catch (e) {
      console.error("Native bundle listing failed:", e);
      setError(e instanceof Error ? e.message : "Bundle listing failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wood-ledger space-y-3 rounded-xl border border-line p-4">
      <div>
        <h3 className="font-display text-lg text-gold-300">Sell as a bundle</h3>
        <p className="text-[0.65rem] text-foreground/55">
          Pick 2 or more items to sell as one package, one price, one signature. A buyer gets the whole bundle in a
          single transaction. {feePct}% Marketplank fee, same as an individual listing.
        </p>
      </div>

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
        {ownedItems.map((item) => {
          const isSelected = selected.has(item.tokenId);
          return (
            <li key={item.tokenId}>
              <button
                type="button"
                disabled={busy}
                aria-pressed={isSelected}
                aria-label={`${isSelected ? "Remove" : "Add"} #${item.tokenId} to bundle`}
                onClick={() => toggle(item.tokenId)}
                title={item.name ?? `#${item.tokenId}`}
                className={`relative block aspect-square w-full cursor-pointer rounded-md border bg-wood-900 bg-cover bg-center outline-none transition ${
                  isSelected ? "border-gold-400 ring-2 ring-gold-400" : "border-line hover:border-line-strong"
                }`}
                style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}
              >
                {!item.imageUrl && <span className="flex h-full items-center justify-center text-[0.55rem] font-bold text-foreground/60">#{item.tokenId}</span>}
                {isSelected && (
                  <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gold-500 text-wood-950">
                    <Check size={10} strokeWidth={3} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {selectedIds.length > 0 && (
        <p className="text-center text-[0.65rem] text-foreground/50">
          {selectedIds.length} of {MAX_BUNDLE_ITEMS} max selected
        </p>
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
        <span className="text-xs font-bold text-gold-300">{currencySymbol} (combined)</span>
      </div>
      <EthUsdValue wei={priceWei} className="block text-right text-[0.65rem] text-foreground/50" />
      {netWei !== null && (
        <p className="text-right text-[0.6rem] text-foreground/45">You receive {formatTokenAmount(netWei.toString(), 18, 5)} {currencySymbol} after the {feePct}% fee</p>
      )}

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
        disabled={busy || selectedIds.length < 2}
        onClick={() => void submit()}
        className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Signing…" : !account ? "Connect to list a bundle" : `List bundle of ${selectedIds.length || "…"}`}
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
