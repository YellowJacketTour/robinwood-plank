"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import { tierAnimationClass, tierCardStyle, tierColor, tierGlow } from "@/lib/market/rarityClient";
import type { RarityTier } from "@/lib/market/rarityClient";
import type { Listing, MarketCollection } from "@/lib/market/types";
import { sendNft, validateRecipient } from "@/lib/market/transfer";
import { quoteSendFee, type SendFeeQuote } from "@/lib/market/send-fee";

type TokenDetail = {
  tokenId: string;
  owner: string;
  image: string | null;
  attributes: Array<{ trait_type?: string; value?: string | number | boolean }>;
  history: Array<{
    kind: string;
    priceEth: string | null;
    txHash: string;
    timestamp: string | null;
    from: string;
    to: string;
  }>;
  /** Same rarity math and tier palette as the Gallery page — one source of truth. */
  rarity: { tier: RarityTier; rank: number; percentile: number } | null;
};

type Props = {
  tokenId: string;
  collection: MarketCollection;
  /** The live listing for this token, if one exists. */
  listing?: Listing;
  onBuy?: (listing: Listing) => void;
  onOffer?: (tokenId: string) => void;
  onClose: () => void;
  /** Connected wallet, if any — enables the Send action when it matches
   * this token's on-chain owner. Omit to leave Send unavailable, e.g. in a
   * read-only context. */
  account?: string | null;
};

const EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";

export default function ItemDetail({
  tokenId,
  collection,
  listing,
  onBuy,
  onOffer,
  onClose,
  account,
}: Props) {
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendConfirming, setSendConfirming] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendDone, setSendDone] = useState(false);
  const [sendFeeQuote, setSendFeeQuote] = useState<SendFeeQuote | null>(null);

  useEffect(() => {
    if (!sendOpen) {
      setSendFeeQuote(null);
      return;
    }
    let cancelled = false;
    quoteSendFee(1)
      .then((q) => {
        if (!cancelled) setSendFeeQuote(q);
      })
      .catch(() => {
        if (!cancelled) setSendFeeQuote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sendOpen]);

  // Mounted per token via a `key` at the call site, so there is no stale state
  // to clear here when the token changes.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/market/token?tokenId=${encodeURIComponent(tokenId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tokenId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${collection.name} #${tokenId}`}
      onClick={onClose}
    >
      {/* Whole-modal tint + border, but NOT tierAnimationClass here — that
          class's shimmer relies on `overflow: hidden`, which would fight
          this container's own overflow-y-auto (the modal needs to scroll on
          tall content). The image panel below still gets the full
          glow+shimmer treatment. */}
      <div
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-gold-500/30 bg-wood-950 sm:rounded-2xl"
        style={detail?.rarity ? tierCardStyle(detail.rarity.tier) : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gold-500/15 px-4 py-3">
          <div className="flex items-center gap-2">
            <p className="font-display text-lg text-foreground">#{tokenId}</p>
            {detail?.rarity && (
              <span
                className="rounded-full px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wide text-wood-950 shadow-[0_1px_3px_rgba(0,0,0,0.6)]"
                style={{ backgroundColor: tierColor(detail.rarity.tier) }}
              >
                {detail.rarity.tier} · #{detail.rarity.rank}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-9 min-w-9 rounded-lg border border-gold-500/30 text-sm text-foreground/70 transition hover:border-gold-400"
          >
            ✕
          </button>
        </div>

        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <div
            className={`relative aspect-square w-full overflow-hidden rounded-xl bg-wood-900 ${
              detail?.rarity ? `${tierAnimationClass(detail.rarity.tier)} holo-card` : ""
            }`}
            style={
              detail?.rarity
                ? { boxShadow: tierGlow(detail.rarity.tier), ...tierCardStyle(detail.rarity.tier) }
                : undefined
            }
          >
            <Image
              src={detail?.image || listing?.imageUrl || collection.image}
              alt={`${collection.name} #${tokenId}`}
              fill
              sizes="(min-width: 640px) 40vw, 100vw"
              className="object-cover"
              unoptimized
            />
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-[0.6rem] uppercase tracking-wide text-foreground/40">Owner</p>
              <p className="text-sm text-foreground">
                {failed ? "—" : detail ? shortAddress(detail.owner) : "…"}
              </p>
            </div>

            {listing && (
              <div>
                <p className="text-[0.6rem] uppercase tracking-wide text-foreground/40">Price</p>
                <p className="font-display text-2xl text-gold-300">
                  {formatTokenAmount(listing.priceWei, 18, 4)} Ξ
                </p>
              </div>
            )}

            <div className="flex gap-2">
              {listing && onBuy && (
                <button
                  type="button"
                  onClick={() => onBuy(listing)}
                  className="min-h-11 flex-1 rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
                >
                  Buy
                </button>
              )}
              {onOffer && (
                <button
                  type="button"
                  onClick={() => onOffer(tokenId)}
                  className="min-h-11 flex-1 rounded-lg border border-gold-500/40 text-sm font-bold text-gold-300 transition hover:border-gold-400"
                >
                  Offer
                </button>
              )}
              {account && detail?.owner.toLowerCase() === account.toLowerCase() && !sendDone && (
                <button
                  type="button"
                  onClick={() => setSendOpen((v) => !v)}
                  className="min-h-11 flex-1 rounded-lg border border-gold-500/40 text-sm font-bold text-gold-300 transition hover:border-gold-400"
                >
                  {sendOpen ? "Cancel" : "Send"}
                </button>
              )}
            </div>

            {sendOpen && !sendDone && account && (
              <div className="space-y-2 rounded-lg border border-gold-500/25 bg-black/20 p-2.5">
                <div className="flex items-center justify-between text-[0.65rem] text-foreground/50">
                  <span>Send fee</span>
                  <span className="font-mono font-bold text-gold-300">
                    {sendFeeQuote ? `${formatTokenAmount(sendFeeQuote.totalFeeWei, 18, 5)} Ξ` : "Quoting…"}
                  </span>
                </div>
                <input
                  type="text"
                  placeholder="Recipient address (0x…)"
                  value={sendTo}
                  disabled={sendBusy}
                  onChange={(e) => {
                    setSendTo(e.target.value);
                    setSendConfirming(false);
                    setSendError(null);
                  }}
                  className="min-h-10 w-full rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5 font-mono text-xs text-foreground outline-none focus:border-gold-400"
                />
                {sendConfirming && !sendBusy && (
                  <p className="rounded-lg border border-red-500/30 bg-red-950/20 px-2 py-1.5 text-center text-[0.65rem] text-red-200">
                    Sending is permanent. Confirm the address, then tap again.
                  </p>
                )}
                <button
                  type="button"
                  disabled={sendBusy}
                  onClick={async () => {
                    setSendError(null);
                    try {
                      validateRecipient(sendTo, account);
                    } catch (e) {
                      setSendError(e instanceof Error ? e.message : "Enter a valid address.");
                      return;
                    }
                    if (!sendConfirming) {
                      setSendConfirming(true);
                      return;
                    }
                    try {
                      setSendBusy(true);
                      await sendNft(account, collection.contractAddress, tokenId, sendTo);
                      setSendDone(true);
                    } catch (e) {
                      setSendError(e instanceof Error ? e.message : "Send failed.");
                    } finally {
                      setSendBusy(false);
                      setSendConfirming(false);
                    }
                  }}
                  className={`min-h-10 w-full rounded-lg text-xs font-bold transition disabled:opacity-50 ${
                    sendConfirming
                      ? "bg-red-500 text-white hover:bg-red-400"
                      : "bg-gold-500 text-wood-950 hover:bg-gold-400"
                  }`}
                >
                  {sendBusy ? "Sending…" : sendConfirming ? "Confirm send" : `Send #${tokenId}`}
                </button>
                {sendError && (
                  <p className="text-center text-[0.65rem] text-red-300" role="alert">
                    {sendError}
                  </p>
                )}
              </div>
            )}
            {sendDone && (
              <p className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-2.5 py-2 text-center text-xs text-emerald-300">
                Sent #{tokenId} to {shortAddress(sendTo)}.
              </p>
            )}

            <div>
              <p className="mb-1.5 text-[0.6rem] uppercase tracking-wide text-foreground/40">
                Traits
              </p>
              {failed ? (
                <p className="text-xs text-foreground/45">Unavailable.</p>
              ) : !detail ? (
                <p className="text-xs text-foreground/45">Loading…</p>
              ) : detail.attributes.length === 0 ? (
                <p className="text-xs text-foreground/45">None.</p>
              ) : (
                <ul className="grid grid-cols-2 gap-1.5">
                  {detail.attributes.map((a, i) => (
                    <li
                      key={`${a.trait_type}-${i}`}
                      className="rounded-lg border border-gold-500/20 px-2 py-1.5"
                    >
                      <p className="truncate text-[0.6rem] uppercase tracking-wide text-foreground/40">
                        {a.trait_type ?? "Trait"}
                      </p>
                      <p className="truncate text-xs font-bold text-foreground">{String(a.value)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="border-t border-gold-500/15 px-4 py-3">
          <p className="mb-1.5 text-[0.6rem] uppercase tracking-wide text-foreground/40">History</p>
          {!detail || detail.history.length === 0 ? (
            <p className="text-xs text-foreground/45">No transfers recorded.</p>
          ) : (
            <ul className="space-y-1">
              {detail.history.map((h) => (
                <li key={h.txHash} className="flex items-center justify-between gap-2 text-xs">
                  <a
                    href={`${EXPLORER_TX}${h.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-bold capitalize text-gold-300 hover:underline"
                  >
                    {h.kind}
                  </a>
                  <span className="truncate text-foreground/45">
                    {shortAddress(h.from)} → {shortAddress(h.to)}
                  </span>
                  <span className="shrink-0 text-foreground/40">
                    {h.timestamp ? new Date(h.timestamp).toLocaleDateString() : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
