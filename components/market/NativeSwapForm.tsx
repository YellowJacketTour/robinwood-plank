"use client";

import { useMemo, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { parseTokenAmount, formatTokenAmount } from "@/lib/trade";
import { MARKETPLANK_SWAP_FEE_BPS } from "@/lib/constants";
import { chainDisplayName, foreignChainByChainSlug, foreignRpcUrls, FOREIGN_SEAPORT_ADDRESS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import type { MarketCollection } from "@/lib/market/types";
import EthUsdValue from "@/components/market/EthUsdValue";
import { ensureChain } from "@/lib/wallet";
import { buildSwapOrder, type SeaportChain, type SwapItemInput } from "@/lib/market/seaport";

type OwnedItem = { tokenId: string; name: string | null; imageUrl: string | null };

type Props = {
  chainSlug: string;
  account: string | null;
  collection: MarketCollection;
  ownedItems: OwnedItem[];
  onListed: () => void;
  onConnect: () => void;
};

const MAX_ITEMS_PER_SIDE = 10;
const DURATIONS = [1, 3, 7, 30];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Roadmap: "nft for nft trades... otc nft and coin trades for any asset
 * combination." Offer side is always owned items FROM THIS collection
 * (matches the page's own context -- the same "you're looking at collection
 * X" convenience NativeBundleListForm already gives). Consideration side is
 * whatever the maker wants back: manually entered (contract, tokenId)
 * pairs, since a swap target can be from ANY collection, including ones
 * this app hasn't indexed yet (see native-swap-orders/route.ts's own
 * header on why there's no tracked-collection gate). Optional ETH top-up
 * is what the maker is asking the TAKER to also pay -- see
 * validateSwapOrder's own header on why a top-up can only ever flow that
 * direction (Seaport has no allowance mechanism for native ETH, so it can
 * never be pulled FROM the maker at fulfillment time).
 */
export default function NativeSwapForm({ chainSlug, account, collection, ownedItems, onListed, onConnect }: Props) {
  const [selectedOffer, setSelectedOffer] = useState<Set<string>>(new Set());
  const [wantItems, setWantItems] = useState<{ contractAddress: string; tokenId: string }[]>([]);
  const [wantContract, setWantContract] = useState("");
  const [wantTokenId, setWantTokenId] = useState("");
  const [topUpEth, setTopUpEth] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const feePct = MARKETPLANK_SWAP_FEE_BPS / 100;
  const topUpWei = topUpEth.trim() ? parseTokenAmount(topUpEth, 18) : BigInt(0);

  const toggleOffer = (tokenId: string) => {
    if (busy) return;
    setSelectedOffer((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else if (next.size < MAX_ITEMS_PER_SIDE) next.add(tokenId);
      return next;
    });
    setError(null);
    setSuccess(null);
  };

  const offerIds = useMemo(() => [...selectedOffer], [selectedOffer]);

  const addWantItem = () => {
    setError(null);
    const contractAddress = wantContract.trim().toLowerCase();
    const tokenId = wantTokenId.trim();
    if (!ADDRESS_RE.test(contractAddress)) {
      setError("Enter a real contract address for the item you want.");
      return;
    }
    if (!/^\d+$/.test(tokenId)) {
      setError("Enter a valid token id.");
      return;
    }
    if (wantItems.length >= MAX_ITEMS_PER_SIDE) {
      setError(`You can only ask for up to ${MAX_ITEMS_PER_SIDE} items.`);
      return;
    }
    if (wantItems.some((i) => i.contractAddress === contractAddress && i.tokenId === tokenId)) {
      setError("You already added that exact item.");
      return;
    }
    setWantItems((prev) => [...prev, { contractAddress, tokenId }]);
    setWantContract("");
    setWantTokenId("");
  };

  const removeWantItem = (index: number) => {
    setWantItems((prev) => prev.filter((_, i) => i !== index));
  };

  const submit = async () => {
    setError(null);
    setSuccess(null);
    if (!account) {
      onConnect();
      return;
    }
    if (offerIds.length === 0) {
      setError("Pick at least one item you own to offer.");
      return;
    }
    if (wantItems.length === 0) {
      setError("Add at least one item you want in return.");
      return;
    }
    if (topUpWei === null) {
      setError("Enter a valid ETH top-up amount, or leave it blank.");
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
      const offerItems: SwapItemInput[] = offerIds.map((tokenId) => ({ contractAddress: collection.contractAddress, tokenId }));
      const rawOrder = await buildSwapOrder(
        account,
        {
          offerItems,
          considerationItems: wantItems,
          considerationNativeWei: topUpWei && topUpWei > 0n ? topUpWei.toString() : undefined,
          expiresAt,
        },
        chain
      );

      const res = await fetch("/api/market/multichain/native-swap-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainSlug, rawOrder }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) throw new Error(data.message || "The relay rejected this swap.");

      setSelectedOffer(new Set());
      setWantItems([]);
      setTopUpEth("");
      setSuccess(`Swap listed: ${offerIds.length} of yours for ${wantItems.length} of theirs.`);
      onListed();
    } catch (e) {
      console.error("Native swap listing failed:", e);
      setError(e instanceof Error ? e.message : "Swap listing failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wood-ledger space-y-3 rounded-xl border border-line p-4">
      <div>
        <h3 className="font-display text-lg text-gold-300">Swap for another NFT</h3>
        <p className="text-[0.65rem] text-foreground/55">
          Trade item(s) you own here for specific item(s) from any collection -- optionally asking for an ETH
          top-up too. {feePct}% Marketplank fee on any ETH top-up, or a small flat fee for a pure item-for-item
          trade.
        </p>
      </div>

      <div>
        <p className="mb-1.5 text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">
          You give ({offerIds.length}/{MAX_ITEMS_PER_SIDE})
        </p>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2">
          {ownedItems.map((item) => {
            const isSelected = selectedOffer.has(item.tokenId);
            return (
              <li key={item.tokenId}>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={isSelected}
                  aria-label={`${isSelected ? "Remove" : "Add"} #${item.tokenId} to swap offer`}
                  onClick={() => toggleOffer(item.tokenId)}
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
      </div>

      <div>
        <p className="mb-1.5 text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">
          You want ({wantItems.length}/{MAX_ITEMS_PER_SIDE})
        </p>
        {wantItems.length > 0 && (
          <ul className="mb-2 space-y-1">
            {wantItems.map((item, i) => (
              <li key={`${item.contractAddress}-${item.tokenId}`} className="flex items-center justify-between gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate text-foreground/80">
                  #{item.tokenId} · {item.contractAddress.slice(0, 6)}…{item.contractAddress.slice(-4)}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removeWantItem(i)}
                  aria-label={`Remove #${item.tokenId}`}
                  className="shrink-0 text-foreground/40 hover:text-red-300"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-1.5">
          <input
            type="text"
            placeholder="Contract address (0x...)"
            value={wantContract}
            onChange={(e) => setWantContract(e.target.value)}
            disabled={busy}
            className="min-h-10 min-w-0 flex-[2] rounded-md border border-line bg-background px-2.5 text-xs text-foreground placeholder:text-foreground/30 focus:border-gold-400/60"
          />
          <input
            type="text"
            inputMode="numeric"
            placeholder="Token id"
            value={wantTokenId}
            onChange={(e) => setWantTokenId(e.target.value.replace(/[^0-9]/g, ""))}
            disabled={busy}
            className="min-h-10 min-w-0 flex-1 rounded-md border border-line bg-background px-2.5 text-xs text-foreground placeholder:text-foreground/30 focus:border-gold-400/60"
          />
          <button
            type="button"
            onClick={addWantItem}
            disabled={busy}
            aria-label="Add item to swap for"
            className="flex min-h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line-strong text-gold-300 hover:border-gold-400"
          >
            <Plus size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">
          Also ask for (optional ETH top-up)
        </p>
        <div className="flex min-h-12 items-center gap-2 rounded-lg border border-line bg-panel px-2.5">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={topUpEth}
            onChange={(e) => setTopUpEth(e.target.value.replace(/[^0-9.]/g, ""))}
            className="min-w-0 flex-1 bg-transparent py-2.5 text-lg font-semibold text-foreground outline-none"
          />
          <span className="text-xs font-bold text-gold-300">ETH (from them)</span>
        </div>
        {topUpWei != null && topUpWei > 0n && <EthUsdValue wei={topUpWei} className="mt-1 block text-right text-[0.65rem] text-foreground/50" />}
        {topUpWei != null && topUpWei > 0n && (
          <p className="mt-1 text-right text-[0.6rem] text-foreground/45">
            You receive {formatTokenAmount(((topUpWei * BigInt(10_000 - MARKETPLANK_SWAP_FEE_BPS)) / 10_000n).toString(), 18, 5)} ETH after the {feePct}% fee
          </p>
        )}
      </div>

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
        disabled={busy || offerIds.length === 0 || wantItems.length === 0}
        onClick={() => void submit()}
        className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Signing…" : !account ? "Connect to list a swap" : "List swap"}
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
