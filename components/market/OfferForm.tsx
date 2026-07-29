"use client";

import { useEffect, useMemo, useState } from "react";
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
import TraitCriteriaPicker from "@/components/market/TraitCriteriaPicker";

type Props = {
  account: string;
  collection: MarketCollection;
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
};

const DURATIONS = [1, 3, 7, 30];

/** Bottom sheet on mobile, inline panel on desktop — same shell as ListForm. */
export default function OfferForm({
  account,
  collection,
  tokenId,
  traitMode,
  listings,
  onSubmitted,
  onClose,
}: Props) {
  const [priceEth, setPriceEth] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [index, setIndex] = useState<TraitIndexResponse | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [clauses, setClauses] = useState<CriteriaClause[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
  }, [traitMode, collection]);

  const qualifyingIds = useMemo(
    () => resolveCriteriaTokenIds(index?.traits, clauses),
    [index, clauses]
  );

  const submit = async () => {
    setError(null);
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
      });

      const traitPairs = clausesToTraitLabels(clauses).filter((t) => t.traitType !== "Rarity");
      const rarityClause = clauses.find((c): c is Extract<CriteriaClause, { kind: "rarity" }> => c.kind === "rarity");

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
                },
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Offer failed.");
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Offer failed.");
    } finally {
      setBusy(false);
    }
  };

  const traitReady =
    !traitMode ||
    Boolean(index?.complete && index.traits && clauses.length > 0 && qualifyingIds.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="wood-ledger w-full max-w-md space-y-3 rounded-b-none p-4 sm:rounded-b-xl">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg text-gold-300">
            {traitMode
              ? "Bid on criteria"
              : tokenId
                ? `Offer · #${tokenId}`
                : `Offer · any ${collection.name}`}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/60 hover:text-gold-300"
          >
            ✕
          </button>
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
                  className="min-h-8 rounded-md border border-gold-500/35 px-2.5 text-[0.65rem] font-bold text-gold-300 transition hover:border-gold-400"
                >
                  {m.label}
                </button>
              ))}
            </div>
            <TraitCriteriaPicker
              traits={index?.traits ?? null}
              complete={Boolean(index?.complete && index.traits)}
              building={index?.building}
              scanned={index?.scanned}
              totalSupply={index?.totalSupply}
              loading={!index && !indexError}
              loadError={indexError}
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

        <div className="flex min-h-12 items-center gap-2 rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5">
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

        <div className="flex gap-1.5">
          {DURATIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`min-h-9 flex-1 rounded-md text-xs font-bold ${
                days === d ? "bg-gold-500 text-wood-950" : "border border-gold-500/30 text-foreground/70"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>

        <p className="text-center text-[0.65rem] text-foreground/50">
          {collection.feeBps > 0
            ? `${(collection.feeBps / 100).toFixed(2)}% marketplace fee`
            : "No marketplace fee"}
        </p>

        <button
          type="button"
          disabled={busy || !traitReady}
          onClick={submit}
          className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-50"
        >
          {busy
            ? "Signing…"
            : traitMode
              ? clauses.length > 1
                ? "Bid on combo"
                : "Bid on criteria"
              : "Make offer"}
        </button>
        {error && (
          <p className="text-center text-xs text-red-300" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
