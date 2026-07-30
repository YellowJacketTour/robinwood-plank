"use client";

import { useMemo } from "react";
import { TIER_ORDER } from "@/lib/rarity";
import type { RarityTier } from "@/lib/rarity";
import {
  MAX_CRITERIA_CLAUSES,
  formatCriteriaLabel,
  resolveCriteriaTokenIds,
  tokenIdsForClause,
  type CriteriaClause,
  type TraitMap,
} from "@/lib/market/trait-criteria";
import { formatTokenAmount } from "@/lib/trade";
import type { Listing } from "@/lib/market/types";
import { criteriaFloorWei } from "@/lib/market/trait-criteria";

type Props = {
  /** traitType → value → ids; null while incomplete. */
  traits: TraitMap | null;
  /** Token id → verified rank, used for top-N rank clauses. */
  rankings?: Record<string, number> | null;
  complete: boolean;
  building?: boolean;
  scanned?: number;
  totalSupply?: number | null;
  loading?: boolean;
  loadError?: string | null;
  onRetry?: () => void;
  clauses: CriteriaClause[];
  onChange: (next: CriteriaClause[]) => void;
  /** Live listings for floor-under-criteria display. */
  listings?: Array<Pick<Listing, "tokenId" | "priceWei">>;
  /** Compact strip (sweep) vs roomier panel (offer form). */
  dense?: boolean;
  /** Optional status line override. */
  className?: string;
};

/**
 * Shared multi-clause criteria builder: trait + trait combo + rarity, AND'd.
 * Used by SweepFloorboards (scope) and OfferForm (criteria bids).
 */
export default function TraitCriteriaPicker({
  traits,
  rankings,
  complete,
  building,
  scanned,
  totalSupply,
  loading,
  loadError,
  onRetry,
  clauses,
  onChange,
  listings,
  dense,
  className,
}: Props) {
  const traitTypes = useMemo(
    () => (traits ? Object.keys(traits).sort() : []),
    [traits]
  );

  const qualifyingIds = useMemo(
    () => resolveCriteriaTokenIds(traits, clauses, rankings),
    [traits, clauses, rankings]
  );

  const floorWei = useMemo(
    () => (listings && qualifyingIds.length > 0 ? criteriaFloorWei(listings, qualifyingIds) : null),
    [listings, qualifyingIds]
  );

  const usedTraitTypes = useMemo(
    () => new Set(clauses.filter((c): c is Extract<CriteriaClause, { kind: "trait" }> => c.kind === "trait").map((c) => c.traitType)),
    [clauses]
  );
  const hasRarity = clauses.some((c) => c.kind === "rarity");
  const hasRank = clauses.some((c) => c.kind === "rank");

  const addTraitClause = () => {
    if (!traits || clauses.length >= MAX_CRITERIA_CLAUSES) return;
    const freeType = traitTypes.find((t) => !usedTraitTypes.has(t));
    if (!freeType) return;
    const values = Object.keys(traits[freeType] ?? {}).sort();
    const value = values[0];
    if (!value) return;
    onChange([...clauses, { kind: "trait", traitType: freeType, value }]);
  };

  const addRarityClause = () => {
    if (hasRarity || clauses.length >= MAX_CRITERIA_CLAUSES) return;
    onChange([...clauses, { kind: "rarity", tier: "Rare" }]);
  };

  const addRankClause = () => {
    if (!rankings || hasRank || clauses.length >= MAX_CRITERIA_CLAUSES) return;
    onChange([...clauses, { kind: "rank", maxRank: 100 }]);
  };

  const updateClause = (idx: number, next: CriteriaClause) => {
    const copy = clauses.slice();
    copy[idx] = next;
    onChange(copy);
  };

  const removeClause = (idx: number) => {
    onChange(clauses.filter((_, i) => i !== idx));
  };

  const selectCls = dense
    ? "min-h-8 max-w-[9rem] rounded-md border border-gold-500/30 bg-wood-950 px-1.5 text-[0.65rem] text-foreground"
    : "min-h-10 w-full rounded-md border border-gold-500/30 bg-wood-950 px-2 text-xs text-foreground";

  if (loading) {
    return (
      <p className={`text-[0.65rem] text-foreground/45 ${className ?? ""}`}>Loading traits…</p>
    );
  }
  if (loadError) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`} role="alert">
        <p className="text-xs text-red-300">{loadError}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="min-h-9 rounded-md border border-gold-500/35 px-3 text-xs font-bold text-gold-300"
          >
            Retry criteria index
          </button>
        )}
      </div>
    );
  }
  if (!complete || !traits) {
    return (
      <p className={`text-[0.65rem] text-foreground/55 ${className ?? ""}`} role="status">
        Trait index is still building
        {typeof scanned === "number"
          ? ` (${scanned}${totalSupply ? ` / ${totalSupply}` : ""} planks)`
          : ""}
        {building ? "…" : ""} — trait / rarity criteria open once every plank is indexed.
      </p>
    );
  }

  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      {clauses.length === 0 && (
        <p className="text-[0.65rem] text-foreground/50">
          Add a trait, rarity, or both (AND). Combos like{" "}
          <span className="text-foreground/70">Holo · Epic</span> bid only on planks that match
          every clause.
        </p>
      )}

      {clauses.map((clause, idx) => (
        <div
          key={idx}
          className={`flex flex-wrap items-end gap-1.5 ${dense ? "" : "rounded-md border border-gold-500/15 bg-wood-950/90 p-2"}`}
        >
          {idx > 0 && (
            <span className="mb-1.5 text-[0.55rem] font-bold uppercase tracking-wide text-gold-400/70">
              AND
            </span>
          )}
          <label className={dense ? "" : "min-w-[5.5rem]"}>
            {!dense && (
              <span className="mb-1 block text-[0.65rem] font-bold text-foreground/60">Kind</span>
            )}
            <select
              value={clause.kind}
              onChange={(e) => {
                const kind = e.target.value as "trait" | "rarity" | "rank";
                if (kind === "rarity") {
                  if (hasRarity && clause.kind !== "rarity") return;
                  updateClause(idx, { kind: "rarity", tier: "Rare" });
                } else if (kind === "rank") {
                  if (!rankings || (hasRank && clause.kind !== "rank")) return;
                  updateClause(idx, { kind: "rank", maxRank: 100 });
                } else {
                  const freeType =
                    traitTypes.find((t) => !usedTraitTypes.has(t) || (clause.kind === "trait" && t === clause.traitType)) ??
                    traitTypes[0];
                  if (!freeType || !traits) return;
                  const values = Object.keys(traits[freeType] ?? {}).sort();
                  updateClause(idx, {
                    kind: "trait",
                    traitType: freeType,
                    value: values[0] ?? "",
                  });
                }
              }}
              className={selectCls}
              aria-label={`Clause ${idx + 1} kind`}
            >
              <option value="trait">Trait</option>
              <option value="rarity" disabled={hasRarity && clause.kind !== "rarity"}>
                Rarity
              </option>
              <option
                value="rank"
                disabled={!rankings || (hasRank && clause.kind !== "rank")}
              >
                Rank
              </option>
            </select>
          </label>

          {clause.kind === "trait" ? (
            <>
              <label className={dense ? "" : "min-w-0 flex-1"}>
                {!dense && (
                  <span className="mb-1 block text-[0.65rem] font-bold text-foreground/60">
                    Trait
                  </span>
                )}
                <select
                  value={clause.traitType}
                  onChange={(e) => {
                    const traitType = e.target.value;
                    const values = Object.keys(traits[traitType] ?? {}).sort();
                    updateClause(idx, {
                      kind: "trait",
                      traitType,
                      value: values[0] ?? "",
                    });
                  }}
                  className={selectCls}
                  aria-label={`Clause ${idx + 1} trait type`}
                >
                  {traitTypes.map((t) => (
                    <option
                      key={t}
                      value={t}
                      disabled={usedTraitTypes.has(t) && t !== clause.traitType}
                    >
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className={dense ? "" : "min-w-0 flex-1"}>
                {!dense && (
                  <span className="mb-1 block text-[0.65rem] font-bold text-foreground/60">
                    Value
                  </span>
                )}
                <select
                  value={clause.value}
                  onChange={(e) =>
                    updateClause(idx, {
                      kind: "trait",
                      traitType: clause.traitType,
                      value: e.target.value,
                    })
                  }
                  className={selectCls}
                  aria-label={`Clause ${idx + 1} trait value`}
                >
                  {Object.keys(traits[clause.traitType] ?? {})
                    .sort()
                    .map((v) => (
                      <option key={v} value={v}>
                        {v}
                        {dense
                          ? ""
                          : ` (${(traits[clause.traitType]?.[v] ?? []).length})`}
                      </option>
                    ))}
                </select>
              </label>
            </>
          ) : clause.kind === "rarity" ? (
            <label className={dense ? "" : "min-w-0 flex-1"}>
              {!dense && (
                <span className="mb-1 block text-[0.65rem] font-bold text-foreground/60">
                  Tier
                </span>
              )}
              <select
                value={clause.tier}
                onChange={(e) =>
                  updateClause(idx, {
                    kind: "rarity",
                    tier: e.target.value as RarityTier,
                  })
                }
                className={selectCls}
                aria-label={`Clause ${idx + 1} rarity tier`}
              >
                {TIER_ORDER.map((t) => {
                  const n = tokenIdsForClause(traits, { kind: "rarity", tier: t }).length;
                  return (
                    <option key={t} value={t} disabled={n === 0}>
                      {t}
                      {dense ? "" : ` (${n})`}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : (
            <label className={dense ? "" : "min-w-0 flex-1"}>
              {!dense && (
                <span className="mb-1 block text-[0.65rem] font-bold text-foreground/60">
                  Maximum rank
                </span>
              )}
              <select
                value={clause.maxRank}
                onChange={(e) =>
                  updateClause(idx, {
                    kind: "rank",
                    maxRank: Number(e.target.value),
                  })
                }
                className={selectCls}
                aria-label={`Clause ${idx + 1} maximum rank`}
              >
                {[10, 25, 50, 100, 250, 500, 1000].map((maxRank) => (
                  <option key={maxRank} value={maxRank}>
                    Top {maxRank}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button
            type="button"
            onClick={() => removeClause(idx)}
            aria-label={`Remove clause ${idx + 1}`}
            className="min-h-8 rounded-md border border-gold-500/25 px-2 text-[0.65rem] text-foreground/55 hover:border-red-400/50 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={
            clauses.length >= MAX_CRITERIA_CLAUSES ||
            traitTypes.every((t) => usedTraitTypes.has(t))
          }
          onClick={addTraitClause}
          className="min-h-8 rounded-md border border-gold-500/35 px-2 text-[0.65rem] font-bold text-gold-300 transition hover:border-gold-400 disabled:opacity-40"
        >
          + Trait
        </button>
        <button
          type="button"
          disabled={hasRarity || clauses.length >= MAX_CRITERIA_CLAUSES}
          onClick={addRarityClause}
          className="min-h-8 rounded-md border border-gold-500/35 px-2 text-[0.65rem] font-bold text-gold-300 transition hover:border-gold-400 disabled:opacity-40"
        >
          + Rarity
        </button>
        <button
          type="button"
          disabled={!rankings || hasRank || clauses.length >= MAX_CRITERIA_CLAUSES}
          onClick={addRankClause}
          className="min-h-8 rounded-md border border-gold-500/35 px-2 text-[0.65rem] font-bold text-gold-300 transition hover:border-gold-400 disabled:opacity-40"
        >
          + Rank
        </button>
        {clauses.length > 0 && (
          <span className="text-[0.65rem] text-foreground/60">
            {qualifyingIds.length.toLocaleString()} match
            {floorWei ? ` · floor ${formatTokenAmount(floorWei, 18, 4)} Ξ` : " · none listed"}
            {clauses.length > 1 ? ` · ${formatCriteriaLabel(clauses)}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
