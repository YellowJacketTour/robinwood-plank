"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getOwnedInventory, type OwnedInventory } from "@/lib/market/inventory";
import { sendNft, sendNftBatch, validateRecipient, type BatchSendStatus } from "@/lib/market/transfer";
import { quoteSendFee, type SendFeeQuote } from "@/lib/market/send-fee";
import { formatTokenAmount } from "@/lib/trade";
import ItemDetail from "@/components/market/ItemDetail";
import {
  getRarityMap,
  tierAnimationClass,
  tierCardStyle,
  tierColor,
  tierGlow,
} from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import type { MarketCollection } from "@/lib/market/types";
import { withImageWidth } from "@/lib/ipfs";

type Props = {
  account: string;
  collections: MarketCollection[];
  /** `${slug}:${tokenId}` keys already listed by this wallet — sending a
   * listed token would leave a dead, unfillable order behind, so those are
   * shown but not selectable here, same guard MyInventory uses for listing. */
  alreadyListed: Set<string>;
};

type SelectedItem = { collection: MarketCollection; tokenId: string };

function itemKey(item: SelectedItem): string {
  return `${item.collection.slug}:${item.tokenId}`;
}

const STATE_LABEL: Record<BatchSendStatus["state"], string> = {
  pending: "Waiting",
  sending: "Sign in wallet…",
  sent: "Sent ✓",
  failed: "Failed",
};

/**
 * Browse the connected wallet's NFTs, tap to select one or many, send them
 * to one recipient. Sits alongside MyInventory (which lists for sale) as a
 * distinct action on the same underlying inventory data — selecting exactly
 * one item IS the single-send flow, selecting several is the batch-send
 * flow; there's no separate code path for "one" vs "many" the way OpenSea's
 * own transfer flow doesn't have one either.
 */
export default function MyNfts({ account, collections, alreadyListed }: Props) {
  const [inventory, setInventory] = useState<OwnedInventory[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map());
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [ackRecipient, setAckRecipient] = useState(false);
  const [ackPermanent, setAckPermanent] = useState(false);
  const [statuses, setStatuses] = useState<BatchSendStatus[] | null>(null);
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());
  const [feeQuote, setFeeQuote] = useState<SendFeeQuote | null>(null);
  const [feeQuoting, setFeeQuoting] = useState(false);
  const [detailItem, setDetailItem] = useState<SelectedItem | null>(null);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setLoadError(null);
    void getOwnedInventory(collections, account)
      .then(setInventory)
      .catch(() => setLoadError("Could not load your planks — try again."))
      .finally(() => setRefreshing(false));
  }, [account, collections]);

  useEffect(() => {
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      setRefreshing(true);
      setLoadError(null);
      void getOwnedInventory(collections, account)
        .then((nextInventory) => {
          if (!cancelled) setInventory(nextInventory);
        })
        .catch(() => {
          if (!cancelled) setLoadError("Could not load your planks — try again.");
        })
        .finally(() => {
          if (!cancelled) setRefreshing(false);
        });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [account, collections]);

  useEffect(() => {
    let cancelled = false;
    void getRarityMap().then((map) => {
      if (!cancelled) setRarity(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedItems = useMemo(() => Array.from(selected.values()), [selected]);

  // Re-quoted live off current gas price every time the selection count
  // changes — never a stale or assumed number, and never shown as final
  // until this resolves (see send-fee.ts for why it tracks gas directly).
  useEffect(() => {
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (selectedItems.length === 0) {
        setFeeQuote(null);
        setFeeQuoting(false);
        return;
      }
      setFeeQuoting(true);
      quoteSendFee(selectedItems.length)
        .then((q) => {
          if (!cancelled) setFeeQuote(q);
        })
        .catch(() => {
          if (!cancelled) setFeeQuote(null);
        })
        .finally(() => {
          if (!cancelled) setFeeQuoting(false);
        });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [selectedItems.length]);

  const toggle = useCallback(
    (collection: MarketCollection, tokenId: string) => {
      if (busy) return;
      const key = `${collection.slug}:${tokenId}`;
      if (alreadyListed.has(key)) return;
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(key)) next.delete(key);
        else next.set(key, { collection, tokenId });
        return next;
      });
      setStatuses(null);
      setError(null);
      setConfirming(false);
      setAckRecipient(false);
      setAckPermanent(false);
    },
    [busy, alreadyListed]
  );

  const submit = useCallback(async () => {
    setError(null);
    try {
      validateRecipient(recipient, account);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enter a valid recipient.");
      return;
    }
    if (!confirming) {
      setConfirming(true);
      return;
    }
    if (!ackRecipient || !ackPermanent) {
      setError("Confirm the recipient and permanent-transfer warnings.");
      return;
    }
    try {
      setBusy(true);
      if (selectedItems.length === 1) {
        const item = selectedItems[0];
        const localKey = itemKey(item);
        setStatuses([{ key: localKey, state: "sending" }]);
        try {
          const hash = await sendNft(account, item.collection.contractAddress, item.tokenId, recipient);
          setStatuses([{ key: localKey, state: "sent", txHash: hash }]);
          setSelected(new Map());
        } catch (e) {
          setStatuses([
            {
              key: localKey,
              state: "failed",
              error: e instanceof Error ? e.message : "Send failed.",
            },
          ]);
        }
      } else {
        // transfer.ts keys its own progress map by collection ADDRESS
        // (works for any collection, not just ones with a local slug) —
        // remap back to this component's slug-based keys via the original
        // array order rather than string-matching two different key
        // formats against each other.
        const result = await sendNftBatch(
          account,
          selectedItems.map((i) => ({
            collectionAddress: i.collection.contractAddress,
            tokenId: i.tokenId,
          })),
          recipient,
          (live) =>
            setStatuses(
              selectedItems.map((item, i) => {
                const remote = Array.from(live.values())[i];
                return { ...(remote ?? { state: "pending" as const }), key: itemKey(item) };
              })
            )
        );
        const sent = Array.from(result.values());
        setSelected((prev) => {
          const next = new Map(prev);
          selectedItems.forEach((item, i) => {
            if (sent[i]?.state === "sent") next.delete(itemKey(item));
          });
          return next;
        });
      }
      refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The fee or transfer transaction failed. Your selection is preserved for retry."
      );
    } finally {
      setBusy(false);
      setConfirming(false);
      setAckRecipient(false);
      setAckPermanent(false);
    }
  }, [
    account,
    ackPermanent,
    ackRecipient,
    confirming,
    recipient,
    selectedItems,
    refresh,
  ]);

  if (loadError && inventory === null) {
    return (
      <div className="rounded-lg border border-dashed border-red-500/30 px-4 py-6 text-center" role="alert">
        <p className="text-sm text-red-300">{loadError}</p>
        <button
          type="button"
          onClick={refresh}
          className="mt-3 min-h-10 rounded-md border border-red-500/35 px-3 text-xs text-red-200"
        >
          Retry inventory
        </button>
      </div>
    );
  }
  if (inventory === null) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-panel px-4 py-8 text-center text-sm text-foreground/60">
        Reading your planks from chain…
      </p>
    );
  }

  const totalOwned = inventory.reduce((n, g) => n + g.items.length, 0);
  if (totalOwned === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-panel px-4 py-8 text-center text-sm text-foreground/60">
        This wallet holds no planks yet.
      </p>
    );
  }

  const groups = inventory.filter((g) => g.items.length > 0);

  return (
    // The sticky action bar grew taller once the fee quote + batch-savings
    // line were added — bottom padding has to grow with it, or cards near
    // the end of the grid sit underneath it and become unclickable
    // (confirmed live: this was a real bug, not a hypothetical).
    <div className={`space-y-4 ${selected.size > 0 ? "pb-64 sm:pb-4" : "pb-4"}`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-display text-xl text-gold-300">Owned Planks</h3>
          <p className="text-xs text-foreground/55">
            {totalOwned} owned · {selectedItems.length} selected
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="min-h-10 rounded-md border border-line px-3 text-xs text-gold-300 disabled:opacity-50"
        >
          {refreshing ? "Reloading…" : "Reload"}
        </button>
      </div>

      {loadError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-xs text-red-200" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={refresh} className="min-h-9 underline">
            Retry
          </button>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.collection.slug} className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-foreground/50">
            {group.collection.name} · {group.items.length} owned
          </h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
            {group.items.map((item) => {
              const key = `${group.collection.slug}:${item.tokenId}`;
              const isSelected = selected.has(key);
              const isListed = alreadyListed.has(key);
              const r = rarity.get(item.tokenId);
              return (
                <li
                  key={key}
                  className={`relative dense-card overflow-hidden p-0 ${r ? tierAnimationClass(r.tier) : ""}`}
                  style={r ? { boxShadow: tierGlow(r.tier), ...tierCardStyle(r.tier) } : undefined}
                >
                  {/* Separate from the select action — tapping the card
                      selects it for send, this opens full metadata/rarity/
                      traits without changing the selection. */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDetailItem({ collection: group.collection, tokenId: item.tokenId });
                    }}
                    aria-label={`View details for #${item.tokenId}`}
                    className="absolute bottom-1.5 right-1.5 z-[3] flex h-6 w-6 items-center justify-center rounded-full bg-black/90 text-xs text-gold-300 transition hover:bg-black hover:text-gold-200"
                  >
                    ⓘ
                  </button>
                  <button
                    type="button"
                    disabled={isListed || busy}
                    aria-pressed={isSelected}
                    aria-label={`${isSelected ? "Deselect" : "Select"} #${item.tokenId}`}
                    onClick={() => toggle(group.collection, item.tokenId)}
                    className={`relative block aspect-square w-full bg-wood-900 outline-none transition ${
                      r ? "holo-card" : ""
                    } ${isSelected ? "ring-2 ring-inset ring-gold-400" : ""} ${isListed ? "cursor-not-allowed opacity-50" : "cursor-pointer focus-visible:ring-2 focus-visible:ring-gold-400/60"}`}
                  >
                    <Image
                      src={withImageWidth(item.imageUrl, 256) || group.collection.image}
                      alt={`${group.collection.name} #${item.tokenId}`}
                      fill
                      sizes="(min-width: 1024px) 20vw, 50vw"
                      className="object-cover"
                      unoptimized={Boolean(item.imageUrl)}
                    />
                    {isSelected && (
                      <span className="card-overlay absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gold-500 text-[0.7rem] font-bold text-wood-950">
                        ✓
                      </span>
                    )}
                    {isListed && (
                      <span className="card-overlay legible-text absolute left-1.5 top-1.5 rounded-full bg-black/90 px-2 py-0.5 text-[0.6rem] font-bold text-emerald-300">
                        Listed
                      </span>
                    )}
                    {r && (
                      <span
                        className={`tier-badge absolute left-1.5 ${isListed ? "top-7" : "top-1.5"} rounded-full px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide`}
                        style={{ color: tierColor(r.tier) }}
                        title={`Rank #${r.rank} · ${r.percentile.toFixed(0)}th percentile`}
                      >
                        {r.tier}
                      </span>
                    )}
                    <span className="card-overlay legible-text absolute bottom-1.5 left-1.5 right-8 flex flex-col rounded-lg bg-black/90 px-2 py-0.5 text-left leading-tight">
                      <span className="truncate text-[0.6rem] font-bold text-foreground">
                        {r?.name ?? `#${item.tokenId}`}
                      </span>
                      <span className="truncate text-[0.5rem] text-foreground/60">
                        #{item.tokenId}
                        {r ? ` · R${r.rank} · ${r.tier}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {selectedItems.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel-strong p-3 backdrop-blur sm:sticky sm:rounded-xl sm:border">
          <div className="mx-auto max-w-2xl space-y-2.5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-foreground">
                Send {selectedItems.length} plank{selectedItems.length > 1 ? "s" : ""}
              </p>
              <button
                type="button"
                onClick={() => {
                setSelected(new Map());
                setConfirming(false);
                setAckRecipient(false);
                setAckPermanent(false);
                }}
                className="text-xs font-bold text-foreground/50 hover:text-gold-300"
              >
                Clear
              </button>
            </div>

            <input
              type="text"
              placeholder="Recipient address (0x…)"
              value={recipient}
              disabled={busy}
              onChange={(e) => {
                setRecipient(e.target.value);
                setConfirming(false);
                setAckRecipient(false);
                setAckPermanent(false);
              }}
              className="min-h-11 w-full rounded-lg border border-line bg-panel px-2.5 font-mono text-sm text-foreground outline-none focus:border-gold-400"
            />

            {confirming && !busy && (
              <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-3 text-xs text-red-100">
                <p className="font-bold">Review permanent transfer</p>
                <p>
                  {selectedItems.length} Plank{selectedItems.length > 1 ? "s" : ""} ·{" "}
                  {selectedItems.length + 1} wallet confirmation
                  {selectedItems.length + 1 > 1 ? "s" : ""} including the send fee · recipient{" "}
                  {recipient}
                </p>
                <label className="flex min-h-10 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ackRecipient}
                    onChange={(event) => setAckRecipient(event.target.checked)}
                    className="accent-[#d9a441]"
                  />
                  I verified the complete recipient address.
                </label>
                <label className="flex min-h-10 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ackPermanent}
                    onChange={(event) => setAckPermanent(event.target.checked)}
                    className="accent-[#d9a441]"
                  />
                  I understand these transfers are permanent.
                </label>
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg border border-line bg-panel-strong px-2.5 py-2">
              <span className="text-[0.65rem] text-foreground/50">
                Send fee ({selectedItems.length > 1 ? "batch, cheaper per item" : "flat"})
              </span>
              <span className="font-mono text-xs font-bold text-gold-300">
                {feeQuoting
                  ? "Quoting…"
                  : feeQuote
                    ? `${formatTokenAmount(feeQuote.totalFeeWei, 18, 5)} Ξ`
                    : "—"}
              </span>
            </div>
            {feeQuote && selectedItems.length > 1 && (
              <p className="text-center text-[0.6rem] text-foreground/40">
                vs {formatTokenAmount(feeQuote.equivalentSingleSendsFeeWei, 18, 5)} Ξ as{" "}
                {selectedItems.length} separate single sends — batching saves{" "}
                {formatTokenAmount(
                  feeQuote.equivalentSingleSendsFeeWei - feeQuote.totalFeeWei,
                  18,
                  5
                )}{" "}
                Ξ. No native batch transfer on this collection though — your
                wallet will still ask for {selectedItems.length + 1} confirmations:
                one fee payment, then {selectedItems.length} transfer
                {selectedItems.length > 1 ? "s" : ""}.
              </p>
            )}

            <button
              type="button"
              disabled={busy || (confirming && (!ackRecipient || !ackPermanent))}
              onClick={() => void submit()}
              className={`min-h-12 w-full rounded-lg text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                confirming
                  ? "bg-red-500 text-white hover:bg-red-400"
                  : "bg-gold-500 text-wood-950 hover:bg-gold-400"
              }`}
            >
              {busy
                ? "Sending…"
                : confirming
                  ? `Confirm & send to ${recipient.slice(0, 6)}…${recipient.slice(-4)}`
                  : `Review transfer · ${selectedItems.length}`}
            </button>

            {error && (
              <p className="text-center text-xs text-red-300" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      )}

      {statuses && (
        <ul className="wood-ledger overflow-hidden" aria-label="Send progress">
          {statuses.map((s) => (
            <li
              key={s.key}
              className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 first:border-t-0"
            >
              <span className="text-xs font-bold text-foreground">
                #{s.key.split(":")[1]}
              </span>
              <span
                className={`text-xs ${
                  s.state === "sent"
                    ? "text-emerald-300"
                    : s.state === "failed"
                      ? "text-red-300"
                      : "text-foreground/60"
                }`}
              >
                {STATE_LABEL[s.state]}
                {s.error ? ` — ${s.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {detailItem && (
        <ItemDetail
          key={`${detailItem.collection.slug}:${detailItem.tokenId}`}
          tokenId={detailItem.tokenId}
          collection={detailItem.collection}
          account={account}
          onClose={() => setDetailItem(null)}
        />
      )}
    </div>
  );
}
