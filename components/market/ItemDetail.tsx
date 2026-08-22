"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { formatTokenAmount, parseTokenAmount, shortAddress } from "@/lib/trade";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityTier } from "@/lib/market/rarityClient";
import { formatRank } from "@/lib/rarity";
import {
  isForeignListing,
  isMarketplankRelistRequired,
  MARKETPLANK_RELIST_MESSAGE,
  venueLabel,
  type Listing,
  type MarketCollection,
} from "@/lib/market/types";
import { sendNft, validateRecipient } from "@/lib/market/transfer";
import NftFocusedMedia from "@/components/market/NftFocusedMedia";
import { quoteSendFee, type SendFeeQuote } from "@/lib/market/send-fee";
import { fetchTraitIndex, type TraitIndexResponse } from "@/lib/market/traits";
import EthUsdValue from "@/components/market/EthUsdValue";

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
  rarity: {
    name: string;
    tier: RarityTier;
    rank: number;
    percentile: number;
    normalizedScore: number;
  } | null;
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
  /**
   * Rarity the grid already knows for this token.
   *
   * Without it the panel opens showing only Token/Owner/History and fills in
   * name, tier, rank, exclusivity and traits once /api/market/token returns —
   * so for the first moment it looks far thinner than the Gallery viewer,
   * which is what "the Marketplank one is basic" actually was. The caller has
   * this in hand (it draws the tier pill on every card), so seeding it costs
   * nothing and the panel opens complete.
   */
  initialRarity?: {
    name: string;
    tier: string;
    rank: number;
    percentile: number;
  } | null;
};

const EXPLORER_BASE = "https://robinhoodchain.blockscout.com";
const EXPLORER_TX = `${EXPLORER_BASE}/tx/`;
/** Fixed collection supply — same fallback the trait index itself resolves
 * to once its scan completes; used only while `totalSupply` is still null. */
const TOTAL_SUPPLY_FALLBACK = 1542;

type TraitRarityRow = { trait: string; value: string; count: number; pct: number };

export default function ItemDetail({
  tokenId,
  collection,
  listing,
  onBuy,
  onOffer,
  onClose,
  account,
  initialRarity,
}: Props) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  /**
   * Seeded with what the caller already knows so the panel opens complete —
   * name, tier, rank and exclusivity render on the first paint instead of
   * after a round trip. Owner, traits and history still stream in; the fetch
   * below replaces this wholesale, so nothing here can go stale.
   */
  const [detail, setDetail] = useState<TokenDetail | null>(
    initialRarity
      ? ({
          tokenId,
          owner: "",
          image: listing?.imageUrl ?? null,
          attributes: [],
          history: [],
          rarity: { ...initialRarity, normalizedScore: initialRarity.percentile },
        } as TokenDetail)
      : null
  );
  const [failed, setFailed] = useState(false);
  const [traitIndex, setTraitIndex] = useState<TraitIndexResponse | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendConfirming, setSendConfirming] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendDone, setSendDone] = useState(false);
  const [sendFeeQuote, setSendFeeQuote] = useState<SendFeeQuote | null>(null);

  // Same gallery-modal manners: lock page scroll, hand focus to the close
  // button so keyboard/AT users land somewhere sane on open.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

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
    fetch(`/api/market/token?tokenId=${encodeURIComponent(tokenId)}&history=1`)
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

  // Same verified per-trait-value counts FilterBar/SweepFloorboards/OfferForm
  // already fetch — one shared source of truth for "how rare is this trait".
  useEffect(() => {
    let cancelled = false;
    fetchTraitIndex(collection)
      .then((res) => {
        if (!cancelled) setTraitIndex(res);
      })
      .catch(() => {
        if (!cancelled) setTraitIndex(null);
      });
    return () => {
      cancelled = true;
    };
  }, [collection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const traitRarity = useMemo<TraitRarityRow[] | null>(() => {
    if (!detail || !traitIndex?.traits) return null;
    const totalSupply = traitIndex.totalSupply ?? TOTAL_SUPPLY_FALLBACK;
    const rows: TraitRarityRow[] = [];
    for (const a of detail.attributes) {
      const trait = a.trait_type ?? "Trait";
      const value = String(a.value ?? "");
      const count = traitIndex.traits[trait]?.[value]?.length ?? 0;
      if (count > 0) rows.push({ trait, value, count, pct: (count / totalSupply) * 100 });
    }
    // Rarest (lowest count) first — same read as the gallery's score-sorted list.
    return rows.sort((a, b) => a.count - b.count);
  }, [detail, traitIndex]);

  const isOwner = Boolean(account && detail?.owner && account.toLowerCase() === detail.owner.toLowerCase());
  const relistRequired = Boolean(listing && isMarketplankRelistRequired(listing));

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/85 p-0 sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[min(92dvh,880px)] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-line-strong bg-panel-strong shadow-panel sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="text-[0.6rem] font-black uppercase tracking-[0.14em] text-gold-300">
              {listing && isForeignListing(listing)
                ? `${venueLabel(listing)} · Display only`
                : `Marketplank · ${listing ? "Listed" : "Unlisted"}`}
              {detail?.rarity && (
                <span className="ml-2" style={{ color: tierColor(detail.rarity.tier) }}>
                  · {detail.rarity.tier} {formatRank(detail.rarity.rank)}
                </span>
              )}
            </p>
            <h3 id={titleId} className="mt-1 truncate font-display text-lg text-cream sm:text-xl">
              {detail?.rarity?.name ?? `#${tokenId}`}
            </h3>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line text-gold-300 transition hover:border-line-strong"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="grid sm:grid-cols-2">
            <div className="relative mx-auto aspect-square w-full max-w-[360px] bg-wood-950 sm:max-w-none">
              <NftFocusedMedia
                imageUrl={detail?.image || listing?.imageUrl || collection.image}
                animationUrl={listing?.animationUrl}
                mediaType={listing?.mediaType}
                alt={detail?.rarity?.name ?? `${collection.name} #${tokenId}`}
              />
              {detail?.rarity && (
                <span
                  className="tier-badge absolute left-2 top-2 rounded-full px-2 py-1 text-[0.55rem] font-black uppercase tracking-wide"
                  style={{ color: tierColor(detail.rarity.tier) }}
                >
                  {detail.rarity.tier}
                </span>
              )}
            </div>

            <div className="min-w-0 space-y-4 p-4 sm:p-5">
              <dl className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
                  <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Token</dt>
                  <dd className="mt-1 text-xs font-bold text-foreground">#{tokenId}</dd>
                </div>
                <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
                  <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Owner</dt>
                  <dd className="mt-1 text-xs font-bold text-foreground" title={detail?.owner || undefined}>
                    {failed ? "—" : detail ? shortAddress(detail.owner) : "…"}
                  </dd>
                </div>
                {detail?.rarity && (
                  <>
                    <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
                      <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Rank</dt>
                      <dd className="mt-1 text-xs font-bold" style={{ color: tierColor(detail.rarity.tier) }}>
                        {formatRank(detail.rarity.rank)} · {detail.rarity.tier}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
                      <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
                        Exclusivity
                      </dt>
                      <dd className="mt-1 text-xs font-bold text-foreground">
                        {detail.rarity.normalizedScore.toFixed(1)}
                        <span className="text-foreground/45"> · outranks %</span>
                      </dd>
                    </div>
                  </>
                )}
              </dl>

              {listing && (
                <div className="rounded-lg border border-line bg-wood-950 px-3 py-2.5">
                  <p className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Price</p>
                  <p className="mt-1 font-display text-2xl text-gold-300">
                    {formatTokenAmount(listing.priceWei, 18, 4)} Ξ
                  </p>
                  <EthUsdValue wei={listing.priceWei} className="mt-0.5 block text-xs tabular-nums text-foreground/55" />
                </div>
              )}

              {relistRequired && (
                <div
                  role="status"
                  className="space-y-1 rounded-lg border border-red-400/55 bg-red-950/35 px-3 py-3 text-red-100"
                >
                  <p className="text-sm font-black uppercase tracking-[0.08em]">Relist required</p>
                  <p className="text-sm font-bold leading-snug text-red-100/85">
                    {MARKETPLANK_RELIST_MESSAGE}
                  </p>
                </div>
              )}

              {isOwner && !sendDone && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setSendOpen((v) => !v)}
                    className="min-h-10 w-full rounded-lg border border-line-strong text-sm font-bold text-gold-300 transition hover:border-gold-400"
                  >
                    {sendOpen ? "Cancel send" : "Send this Plank"}
                  </button>
                  {sendOpen && (
                    <div className="space-y-2 rounded-lg border border-line bg-wood-950 p-2.5">
                      <div className="flex items-center justify-between text-[0.65rem] text-cream-muted">
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
                        className="min-h-10 w-full rounded-lg border border-line bg-panel px-2.5 font-mono text-xs text-foreground outline-none focus:border-gold-400"
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
                            validateRecipient(sendTo, account!);
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
                            await sendNft(account!, collection.contractAddress, tokenId, sendTo);
                            setSendDone(true);
                          } catch (e) {
                            console.error("Send NFT failed:", e);
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
                </div>
              )}
              {sendDone && (
                <p className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-2.5 py-2 text-center text-xs text-emerald-300">
                  Sent #{tokenId} to {shortAddress(sendTo)}.
                </p>
              )}

              {traitRarity && traitRarity.length > 0 ? (
                <div>
                  <h4 className="mb-1.5 text-[0.7rem] font-black uppercase tracking-[0.1em] text-foreground">
                    Trait rarity
                  </h4>
                  <ul className="space-y-1.5">
                    {traitRarity.map((row) => (
                      <li
                        key={`${row.trait}-${row.value}`}
                        className="min-w-0 rounded-lg border border-line bg-wood-950 px-2.5 py-2"
                      >
                        <div className="flex items-center justify-between gap-2 text-[0.7rem]">
                          <span className="min-w-0 truncate font-bold text-gold-300/90">
                            {row.trait}: {row.value}
                          </span>
                          <span className="shrink-0 font-mono text-foreground/55">
                            {row.count} · {row.pct < 1 ? row.pct.toFixed(2) : row.pct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/40">
                          <div
                            className="h-full rounded-full bg-gold-500/80"
                            style={{
                              width: `${Math.min(100, Math.max(4, 100 - row.pct))}%`,
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : detail && detail.attributes.length > 0 ? (
                <div>
                  <h4 className="mb-1.5 text-[0.7rem] font-black uppercase tracking-[0.1em] text-foreground">
                    Trait rarity
                  </h4>
                  <ul className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                    {detail.attributes.map((a, i) => (
                      <li
                        key={`${a.trait_type}-${i}`}
                        className="min-w-0 rounded-lg border border-line bg-wood-950 px-3 py-2.5"
                      >
                        <p className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
                          {a.trait_type ?? "Trait"}
                        </p>
                        <p className="mt-1 text-xs font-bold text-foreground">{String(a.value ?? "—")}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div>
                <h4 className="mb-1.5 text-[0.7rem] font-black uppercase tracking-[0.1em] text-foreground">
                  History
                </h4>
                {!detail || detail.history.length === 0 ? (
                  <p className="rounded-lg border border-line bg-wood-950 px-3 py-2.5 text-xs text-cream-muted">
                    {failed ? "Unavailable." : "No transfers recorded."}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.history.map((h) => (
                      <li
                        key={h.txHash}
                        className="min-w-0 rounded-lg border border-line bg-wood-950 px-2.5 py-2"
                      >
                        <div className="flex items-center justify-between gap-2 text-[0.7rem]">
                          <a
                            href={`${EXPLORER_TX}${h.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-bold capitalize text-gold-300 hover:underline"
                          >
                            {h.kind}
                          </a>
                          <span className="shrink-0 text-right font-bold text-gold-300">
                            {h.priceEth ? (
                              <>
                                <span className="block">{Number(h.priceEth).toFixed(4)} Ξ</span>
                                <EthUsdValue
                                  wei={parseTokenAmount(h.priceEth, 18)}
                                  className="block text-[0.6rem] font-normal text-foreground/50"
                                />
                              </>
                            ) : h.kind === "sale" ? (
                              "Unavailable"
                            ) : (
                              "—"
                            )}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[0.6rem] text-foreground/45">
                          <span className="min-w-0 truncate font-mono">
                            {shortAddress(h.from)} → {shortAddress(h.to)}
                          </span>
                          <span className="shrink-0">
                            {h.timestamp ? new Date(h.timestamp).toLocaleDateString() : "—"}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:flex-wrap sm:px-5">
          {listing && isForeignListing(listing) ? (
            /**
             * Foreign listing: no rawOrder to fulfil, so this can only ever
             * link out — same affordance and copy as ListingCard's "View" so
             * a buyer doesn't hit a working Buy button on the grid and a dead
             * one here for the identical listing.
             */
            <a
              href={listing.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-12 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#58BDF0]/40 px-4 py-3 text-sm font-bold text-[#58BDF0] transition hover:border-[#58BDF0]"
            >
              View on {venueLabel(listing)}
              <ExternalLink size={14} strokeWidth={2.5} aria-hidden />
            </a>
          ) : (
            listing &&
            onBuy &&
            (relistRequired ? (
              <button
                type="button"
                disabled
                title={MARKETPLANK_RELIST_MESSAGE}
                className="inline-flex min-h-12 flex-1 cursor-not-allowed items-center justify-center rounded-lg border border-red-400/60 bg-red-950/40 px-4 py-3 text-sm font-black text-red-100"
              >
                Relist required
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onBuy(listing)}
                className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg bg-gold-500 px-4 py-3 text-sm font-bold text-wood-950 transition hover:bg-gold-400"
              >
                Buy
              </button>
            ))
          )}
          {onOffer && (
            <button
              type="button"
              onClick={() => onOffer(tokenId)}
              title={
                listing && isForeignListing(listing)
                  ? `Creates a separate Marketplank offer; it does not modify the ${venueLabel(listing)} listing.`
                  : undefined
              }
              className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border border-line-strong px-4 py-3 text-sm font-bold text-gold-300 transition hover:border-gold-400"
            >
              {listing && isForeignListing(listing) ? "Make Marketplank offer" : "Offer"}
            </button>
          )}
          <a
            href={`${EXPLORER_BASE}/token/${collection.contractAddress}/instance/${tokenId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border border-line-strong px-4 py-3 text-sm font-bold text-gold-300 transition hover:border-gold-400"
          >
            View on explorer
          </a>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-lg border border-line-strong px-4 py-3 text-sm font-bold text-gold-300 transition hover:border-gold-400"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
