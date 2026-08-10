"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { buildOffer } from "@/lib/market/seaport";
import { fetchTraitIndex } from "@/lib/market/traits";
import type { TraitIndexResponse } from "@/lib/market/traits";
import {
  clausesToTraitLabels,
  defaultFirstClause,
  formatCriteriaLabel,
  resolveCriteriaTokenIds,
  type CriteriaClause,
} from "@/lib/market/trait-criteria";
import { parseTokenAmount } from "@/lib/trade";
import type { Listing, MarketCollection } from "@/lib/market/types";
import EthUsdValue from "@/components/market/EthUsdValue";
import TraitCriteriaPicker from "@/components/market/TraitCriteriaPicker";

type Props = {
  account: string | null;
  collection: MarketCollection;
  /** Dialog for item/Buy & Sell entry points; inline for the Offers workbench. */
  presentation?: "dialog" | "inline";
  /** Set for a single-token offer; omit WITH traitMode for a criteria bid. */
  tokenId?: string;
  /**
   * Criteria bid mode: trait, rarity, and/or combos (AND). Snapshot is
   * re-resolved server-side from the verified trait index.
   */
  traitMode?: boolean;
  /** Live listings — used only to show the criteria's current floor price. */
  listings?: Array<Pick<Listing, "tokenId" | "priceWei">>;
  onSubmitted: () => void;
  onClose: () => void;
  /** Inline workbenches stay visible while disconnected; this owns the gate. */
  onConnect?: () => void;
};

const DURATIONS = [1, 3, 7, 30];

/** Bottom sheet on mobile, inline panel on desktop — same shell as ListForm. */
export default function OfferForm({
  account,
  collection,
  presentation = "dialog",
  tokenId,
  traitMode,
  listings,
  onSubmitted,
  onClose,
  onConnect,
}: Props) {
  const [priceEth, setPriceEth] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [indexReloadKey, setIndexReloadKey] = useState(0);

  const [index, setIndex] = useState<TraitIndexResponse | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [clauses, setClauses] = useState<CriteriaClause[]>([]);

  useEffect(() => {
    if (presentation !== "dialog") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, presentation]);

  useEffect(() => {
    if (!traitMode) return;
    let cancelled = false;
    fetchTraitIndex(collection)
      .then((res) => {
        if (cancelled) return;
        setIndex(res);
        if (res.complete && res.traits) {
          setClauses((prev) => {
            if (prev.length > 0) return prev;
            const first = defaultFirstClause(res.traits!);
            return first ? [first] : [];
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setIndexError(e instanceof Error ? e.message : "Could not load traits.");
      });
    return () => {
      cancelled = true;
    };
  }, [traitMode, collection, indexReloadKey]);

  const qualifyingIds = useMemo(
    () => resolveCriteriaTokenIds(index?.traits, clauses, index?.rankings),
    [index, clauses]
  );
  const offerWei = useMemo(() => parseTokenAmount(priceEth, 18), [priceEth]);

  const submit = async () => {
    setError(null);
    setSuccess(null);
    if (!account) {
      onConnect?.();
      return;
    }
    const wei = parseTokenAmount(priceEth, 18);
    if (wei === null || wei <= BigInt(0)) {
      setError("Enter an amount.");
      return;
    }
    if (traitMode && (clauses.length === 0 || qualifyingIds.length === 0)) {
      setError("Pick at least one trait or rarity that matches some planks.");
      return;
    }
    try {
      setBusy(true);
      const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const executed = await buildOffer(account, {
        offerWei: wei.toString(),
        considerationTokenAddress: collection.contractAddress,
        considerationTokenId: traitMode ? undefined : tokenId,
        criteriaTokenIds: traitMode ? qualifyingIds : undefined,
        expiresAt,
        feeBps: collection.feeBps,
        royaltyBps: collection.royaltyBps,
        royaltyRecipient: collection.royaltyRecipient,
      });

      const traitPairs = clausesToTraitLabels(clauses).filter(
        (trait) => trait.traitType !== "Rarity" && trait.traitType !== "Rank"
      );
      const rarityClause = clauses.find((c): c is Extract<CriteriaClause, { kind: "rarity" }> => c.kind === "rarity");
      const rankClause = clauses.find(
        (c): c is Extract<CriteriaClause, { kind: "rank" }> => c.kind === "rank"
      );

      const res = await fetch("/api/market/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "offer",
          collectionSlug: collection.slug,
          rawOrder: executed,
          // Labels only — server re-resolves token ids from verified index.
          ...(traitMode
            ? {
                criteria: {
                  traits: traitPairs,
                  ...(rarityClause ? { rarityTier: rarityClause.tier } : {}),
                  ...(rankClause ? { rankMax: rankClause.maxRank } : {}),
                },
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Offer failed.");
      setPriceEth("");
      setReviewOpen(false);
      setSuccess("Bid published. The open offers list is refreshing.");
      onSubmitted();
    } catch (e) {
      console.error("Offer failed:", e);
      setError(e instanceof Error ? e.message : "Offer failed.");
    } finally {
      setBusy(false);
    }
  };

  const traitReady =
    !traitMode ||
    Boolean(index?.complete && index.traits && clauses.length > 0 && qualifyingIds.length > 0);

  const openReview = () => {
    setError(null);
    setSuccess(null);
    if (!account) {
      onConnect?.();
      return;
    }
    const wei = parseTokenAmount(priceEth, 18);
    if (wei === null || wei <= BigInt(0)) {
      setError("Enter an amount.");
      return;
    }
    if (traitMode && (clauses.length === 0 || qualifyingIds.length === 0)) {
      setError("Pick at least one trait or rarity that matches some planks.");
      return;
    }
    setReviewOpen(true);
  };

  return (
    <div
      className={
        presentation === "dialog"
          ? "fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
          : ""
      }
      role={presentation === "dialog" ? "dialog" : undefined}
      aria-modal={presentation === "dialog" ? "true" : undefined}
    >
      <div
        className={`wood-ledger w-full space-y-3 p-4 ${
          presentation === "dialog"
            ? "max-w-md rounded-b-none sm:rounded-b-xl"
            : "rounded-xl border border-line"
        }`}
      >
        {reviewOpen && (
          <div
            className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="offer-review-title"
          >
            <div className="wood-ledger w-full max-w-lg rounded-t-xl border border-line-strong p-4 sm:rounded-xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[0.65rem] font-black uppercase tracking-[0.14em] text-gold-300/75">
                    Verify before signing
                  </p>
                  <h3 id="offer-review-title" className="mt-1 font-display text-2xl text-gold-300">
                    Review {traitMode ? "criteria bid" : "offer"}
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
                  <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
                    Scope
                  </dt>
                  <dd className="mt-1 text-xs font-bold text-foreground">
                    {traitMode
                      ? formatCriteriaLabel(clauses)
                      : tokenId
                        ? `Plank #${tokenId}`
                        : collection.name}
                  </dd>
                </div>
                <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                  <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
                    Qualifying
                  </dt>
                  <dd className="mt-1 text-xs font-bold text-foreground">
                    {traitMode ? `${qualifyingIds.length} Planks` : "1 exact token"}
                  </dd>
                </div>
                <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                  <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
                    Offer
                  </dt>
                  <dd className="mt-1 text-xs font-bold text-foreground">
                    <span className="block">{priceEth} WETH</span>
                    <EthUsdValue
                      wei={offerWei}
                      className="mt-0.5 block text-[0.65rem] text-foreground/50"
                    />
                  </dd>
                </div>
                <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                  <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
                    Duration
                  </dt>
                  <dd className="mt-1 text-xs font-bold text-foreground">{days} days</dd>
                </div>
                <div className="col-span-2 rounded-lg border border-line bg-wood-950 px-3 py-2">
                  <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">
                    Fees / seller net
                  </dt>
                  <dd className="mt-1 text-xs font-bold text-foreground">
                    {(collection.royaltyBps / 100).toFixed(2)}% creator royalty ·{" "}
                    {(collection.feeBps / 100).toFixed(2)}% marketplace fee · seller net
                    verified from the signed order before acceptance
                  </dd>
                </div>
              </dl>

              <p className="mt-3 text-xs leading-5 text-foreground/55">
                WETH balance, allowance, expiry, and the order payload are checked before
                signing. The server re-resolves the criteria snapshot before publication.
              </p>

              {error && (
                <p
                  role="alert"
                  className="mt-3 rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100"
                >
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
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">
            {presentation === "inline" && traitMode
              ? "Build a criteria bid"
              : traitMode
              ? "Bid on criteria"
              : tokenId
                ? `Offer · #${tokenId}`
                : `Offer · any ${collection.name}`}
          </h3>
          {presentation === "dialog" && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300"
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          )}
        </div>

        {traitMode && (
          <div className="space-y-2">
            <p className="text-center text-[0.65rem] text-foreground/55">
              Same scopes as Sweep: rarity tier, single trait, or AND combo. Sellers of any
              matching plank can accept.
            </p>
            {/* Quick-start chips mirror SweepFloorboards (Rarity / Trait). */}
            <div className="flex flex-wrap justify-center gap-1">
              {(
                [
                  { id: "rarity", label: "Rarity" },
                  { id: "trait", label: "Trait" },
                  { id: "combo", label: "Combo" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    if (!index?.traits) return;
                    if (m.id === "rarity") {
                      setClauses([{ kind: "rarity", tier: "Rare" }]);
                    } else if (m.id === "trait") {
                      const first = defaultFirstClause(index.traits);
                      setClauses(first ? [first] : []);
                    } else {
                      const first = defaultFirstClause(index.traits);
                      setClauses(
                        first
                          ? [first, { kind: "rarity", tier: "Epic" }]
                          : [{ kind: "rarity", tier: "Epic" }]
                      );
                    }
                  }}
                  className="min-h-8 rounded-md border border-line-strong px-2.5 text-[0.65rem] font-bold text-gold-300 transition hover:border-gold-400"
                >
                  {m.label}
                </button>
              ))}
            </div>
            <TraitCriteriaPicker
              traits={index?.traits ?? null}
              rankings={index?.rankings}
              complete={Boolean(index?.complete && index.traits)}
              building={index?.building}
              scanned={index?.scanned}
              totalSupply={index?.totalSupply}
              loading={!index && !indexError}
              loadError={indexError}
              onRetry={() => {
                setIndexError(null);
                setIndex(null);
                setIndexReloadKey((key) => key + 1);
              }}
              clauses={clauses}
              onChange={setClauses}
              listings={listings}
            />
            {clauses.length > 0 && qualifyingIds.length > 0 && (
              <p className="text-center text-[0.6rem] text-foreground/40">
                Bid locks {formatCriteriaLabel(clauses)} · {qualifyingIds.length} planks
                snapshotted into the signed order.
              </p>
            )}
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
            autoFocus={!traitMode}
          />
          <span className="text-xs font-bold text-gold-300">WETH</span>
        </div>
        <EthUsdValue
          wei={offerWei}
          className="block text-right text-[0.65rem] text-foreground/50"
        />

        <div className="flex gap-1.5">
          {DURATIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`min-h-9 flex-1 rounded-md text-xs font-bold ${
                days === d ? "bg-gold-500 text-wood-950" : "border border-line text-foreground/70"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>

        <p className="text-center text-[0.65rem] text-foreground/50">
          {(collection.royaltyBps / 100).toFixed(2)}% creator royalty included ·{" "}
          {collection.feeBps > 0
            ? `${(collection.feeBps / 100).toFixed(2)}% marketplace fee`
            : "no marketplace fee"}
        </p>

        <button
          type="button"
          disabled={busy || !traitReady}
          onClick={openReview}
          className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {busy
            ? "Signing…"
            : !account
              ? "Connect to build this bid"
            : traitMode
              ? "Review & sign criteria bid"
              : "Review offer"}
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
    </div>
  );
}
