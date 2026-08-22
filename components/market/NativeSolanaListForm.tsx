"use client";

import { useMemo, useState } from "react";
import { parseTokenAmount, formatTokenAmount } from "@/lib/trade";
import { listSolanaTokenNow } from "@/lib/market/multichain/trading/foreign-fulfill";
import type { MarketCollection } from "@/lib/market/types";

type OwnedItem = { tokenId: string; name: string | null; imageUrl: string | null };

type Props = {
  account: string | null;
  collection: MarketCollection;
  ownedItems: OwnedItem[];
  ownedLoading: boolean;
  onListed: () => void;
  onConnect: () => void;
  /** Same real-floor value the EVM sibling (NativeForeignListForm) is given, for the same "Floor" preset UX. Null when there's nothing to derive one from yet. */
  floorWei: string | null;
};

type ItemStatus = { tokenId: string; state: "pending" | "signing" | "listed" | "failed"; error?: string };

/** SOL has 9 decimals (lamports), never this app's usual 18-decimal wei convention -- see foreign-fulfill.ts's buySolanaListingNow header on why Solana amounts are always true lamports, never 1e18-scaled. */
const SOL_DECIMALS = 9;

const FLOOR_PRESETS = [
  { label: "Floor", pct: 0 },
  { label: "Floor -5%", pct: -5 },
  { label: "Floor +5%", pct: 5 },
  { label: "Floor +10%", pct: 10 },
];

/**
 * List owned Solana tokens for sale via Magic Eden's own real Auction House
 * program -- the Solana counterpart to NativeForeignListForm.tsx, but
 * necessarily a separate, simpler component rather than a chain-parameterized
 * variant of it: that form is built entirely around lib/market/bulk-list.ts +
 * lib/market/seaport.ts's EIP-712 order construction, which has no Solana
 * meaning (see magiceden-solana-trade.ts's own "SOLANA HAS NO SEAPORT
 * EQUIVALENT" header -- each Magic Eden listing is its own on-chain
 * instruction + signature, not a portable off-chain-signed order object).
 * Sequential per-item signing, same real pattern sweepSolanaListingsNow
 * already uses for multiple Magic Eden transactions in one flow.
 *
 * One price mode only (same price for every selected item) -- the EVM
 * form's per-item pricing mode isn't reproduced here yet; scope this out
 * further once same-price listing is proven live, rather than shipping an
 * unproven per-item variant alongside it.
 */
export default function NativeSolanaListForm({ account, collection, ownedItems, ownedLoading, onListed, onConnect, floorWei }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<ItemStatus[] | null>(null);

  const selectedItems = useMemo(() => ownedItems.filter((i) => selected.has(i.tokenId)), [ownedItems, selected]);
  const priceLamports = useMemo(() => parseTokenAmount(price, SOL_DECIMALS), [price]);
  const totalLamports = priceLamports !== null && priceLamports > 0n ? priceLamports * BigInt(selectedItems.length) : null;

  const toggle = (tokenId: string) => {
    if (busy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.add(tokenId);
      return next;
    });
    setStatuses(null);
    setError(null);
  };

  const applyFloorPreset = (pct: number) => {
    if (!floorWei) return;
    const floor = BigInt(floorWei);
    const adjusted = floor + (floor * BigInt(pct)) / 100n;
    setPrice(formatTokenAmount(adjusted.toString(), SOL_DECIMALS, 4));
  };

  const submit = async () => {
    if (!account) {
      onConnect();
      return;
    }
    setError(null);
    if (priceLamports === null || priceLamports <= 0n) {
      setError("Enter a real price greater than 0.");
      return;
    }
    if (selectedItems.length === 0) {
      setError("Select at least one item to list.");
      return;
    }
    setBusy(true);
    const results: ItemStatus[] = selectedItems.map((i) => ({ tokenId: i.tokenId, state: "pending" }));
    setStatuses(results);
    let anyListed = false;
    for (let i = 0; i < selectedItems.length; i++) {
      const item = selectedItems[i];
      results[i] = { ...results[i], state: "signing" };
      setStatuses([...results]);
      try {
        await listSolanaTokenNow({ tokenMint: item.tokenId, priceLamports: priceLamports.toString(), mode: "list" });
        results[i] = { ...results[i], state: "listed" };
        anyListed = true;
      } catch (e) {
        results[i] = { ...results[i], state: "failed", error: e instanceof Error ? e.message : "Listing failed." };
      }
      setStatuses([...results]);
    }
    setBusy(false);
    if (anyListed) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const r of results) if (r.state === "listed") next.delete(r.tokenId);
        return next;
      });
      onListed();
    }
  };

  if (ownedLoading) {
    return <p className="p-4 text-center text-xs text-foreground/45">Loading your {collection.name} tokens…</p>;
  }
  if (ownedItems.length === 0) {
    return <p className="p-4 text-center text-xs text-foreground/45">You don&apos;t own any {collection.name} tokens on this wallet.</p>;
  }

  return (
    <div className="space-y-3 rounded-lg border border-line bg-panel p-3">
      <h3 className="text-xs font-black uppercase tracking-wide text-foreground/60">List for sale (Magic Eden)</h3>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {ownedItems.map((item) => {
          const isSelected = selected.has(item.tokenId);
          return (
            <button
              key={item.tokenId}
              type="button"
              onClick={() => toggle(item.tokenId)}
              disabled={busy}
              className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 text-left transition ${
                isSelected ? "border-gold-400 bg-gold-500/10" : "border-line hover:border-line-strong"
              }`}
            >
              {item.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- small unoptimized thumbnail in a selection grid, same pattern as the EVM sibling form.
                <img src={item.imageUrl} alt={item.name ?? item.tokenId} className="aspect-square w-full rounded object-cover" />
              )}
              <span className="truncate text-[0.6rem] text-foreground/70">{item.name ?? `${item.tokenId.slice(0, 4)}…${item.tokenId.slice(-4)}`}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          disabled={busy}
          placeholder="Price in SOL"
          className="w-32 rounded-md border border-line bg-panel-strong px-2 py-1.5 text-sm tabular-nums"
        />
        {floorWei && (
          <div className="flex gap-1">
            {FLOOR_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyFloorPreset(p.pct)}
                disabled={busy}
                className="rounded-md border border-line px-2 py-1 text-[0.6rem] font-bold uppercase text-foreground/60 hover:border-line-strong"
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {totalLamports !== null && selectedItems.length > 0 && (
        <p className="text-xs text-foreground/50">
          {selectedItems.length} item{selectedItems.length === 1 ? "" : "s"} · {formatTokenAmount(totalLamports.toString(), SOL_DECIMALS, 4)} SOL total
        </p>
      )}

      {error && <p className="text-xs text-red-300">{error}</p>}

      {statuses && (
        <ul className="space-y-1">
          {statuses.map((s) => (
            <li key={s.tokenId} className="flex items-center justify-between text-[0.65rem]">
              <span className="text-foreground/60">{s.tokenId.slice(0, 4)}…{s.tokenId.slice(-4)}</span>
              <span
                className={
                  s.state === "listed"
                    ? "text-emerald-300"
                    : s.state === "failed"
                      ? "text-red-300"
                      : "text-foreground/45"
                }
              >
                {s.state === "listed" ? "Listed ✓" : s.state === "failed" ? (s.error ?? "Failed") : s.state === "signing" ? "Sign in wallet…" : "Waiting"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || selectedItems.length === 0}
        className="w-full rounded-md bg-gold-500 px-3 py-2 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {!account ? "Connect wallet" : busy ? "Listing…" : `List ${selectedItems.length || ""} item${selectedItems.length === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}
