"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import type { Listing, MarketCollection } from "@/lib/market/types";

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
};

type Props = {
  tokenId: string;
  collection: MarketCollection;
  /** The live listing for this token, if one exists. */
  listing?: Listing;
  onBuy?: (listing: Listing) => void;
  onOffer?: (tokenId: string) => void;
  onClose: () => void;
};

const EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";

export default function ItemDetail({
  tokenId,
  collection,
  listing,
  onBuy,
  onOffer,
  onClose,
}: Props) {
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [failed, setFailed] = useState(false);

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
      <div
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-gold-500/30 bg-wood-950 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gold-500/15 px-4 py-3">
          <p className="font-display text-lg text-foreground">#{tokenId}</p>
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
          <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-wood-900">
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
            </div>

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
