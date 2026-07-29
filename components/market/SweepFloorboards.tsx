"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTokenAmount } from "@/lib/trade";
import { planSweep, SWEEP_MAX } from "@/lib/market/sweep";
import type { SweepPlan } from "@/lib/market/sweep";
import type { Listing, MarketCollection } from "@/lib/market/types";
import type { RarityLookup } from "@/lib/market/rarityClient";
import type { RarityTier } from "@/lib/rarity";
import { fetchTraitIndex } from "@/lib/market/traits";
import type { TraitIndexResponse } from "@/lib/market/traits";
import {
  defaultFirstClause,
  formatCriteriaLabel,
  resolveCriteriaTokenIds,
  type CriteriaClause,
} from "@/lib/market/trait-criteria";
import TraitCriteriaPicker from "@/components/market/TraitCriteriaPicker";

type Props = {
  listings: Array<Listing & { rawOrder: unknown }>;
  collection: MarketCollection;
  account: string | null;
  rarity: Map<string, RarityLookup>;
  /** Linked to rarity floor chips / FilterBar — "all" or a tier. */
  tierScope: RarityTier | "all";
  /** Receives a fully validated plan; opens the confirm step. */
  onSweep: (plan: SweepPlan) => void;
};

const PRESETS = [3, 5, 10, SWEEP_MAX] as const;

type ScopeMode = "floor" | "tier" | "trait";

/**
 * "Sweep the floorboards" — batch buy the N cheapest validated listings.
 * Presets + custom count (1–SWEEP_MAX), optional rarity or multi-clause
 * trait/rarity criteria scope.
 */
export default function SweepFloorboards({
  listings,
  collection,
  account,
  rarity,
  tierScope,
  onSweep,
}: Props) {
  const [count, setCount] = useState<number>(PRESETS[0]);
  const [customDraft, setCustomDraft] = useState("");
  const [scopeMode, setScopeMode] = useState<ScopeMode>("floor");
  const [traitIndex, setTraitIndex] = useState<TraitIndexResponse | null>(null);
  const [clauses, setClauses] = useState<CriteriaClause[]>([]);
  const [traitLoading, setTraitLoading] = useState(false);
  const [traitError, setTraitError] = useState<string | null>(null);

  // Keep sweep scope in lockstep with rarity floor chips when user taps a tier.
  useEffect(() => {
    if (tierScope === "all") {
      if (scopeMode === "tier") setScopeMode("floor");
    } else {
      setScopeMode("tier");
    }
  }, [tierScope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scopeMode !== "trait") return;
    let cancelled = false;
    setTraitLoading(true);
    setTraitError(null);
    fetchTraitIndex(collection)
      .then((idx) => {
        if (cancelled) return;
        setTraitIndex(idx);
        if (idx.complete && idx.traits) {
          setClauses((prev) => {
            if (prev.length > 0) return prev;
            const first = defaultFirstClause(idx.traits!);
            return first ? [first] : [];
          });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setTraitIndex(null);
          setTraitError(e instanceof Error ? e.message : "Could not load traits.");
        }
      })
      .finally(() => {
        if (!cancelled) setTraitLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeMode, collection]);

  const scopeTokenIds = useMemo(() => {
    if (scopeMode === "floor") return undefined;
    if (scopeMode === "tier") {
      if (tierScope === "all") return undefined;
      const ids: string[] = [];
      for (const l of listings) {
        if (!l.tokenId) continue;
        const r = rarity.get(l.tokenId) ?? rarity.get(String(Number(l.tokenId)));
        if (r?.tier === tierScope) ids.push(BigInt(l.tokenId).toString());
      }
      return new Set(ids);
    }
    // Multi-clause trait / rarity criteria
    if (clauses.length === 0 || !traitIndex?.traits) return new Set<string>();
    return new Set(resolveCriteriaTokenIds(traitIndex.traits, clauses));
  }, [scopeMode, tierScope, listings, rarity, clauses, traitIndex]);

  const plan = useMemo(
    () =>
      planSweep(listings, count, collection, account ?? undefined, {
        tokenIds: scopeTokenIds,
      }),
    [listings, count, collection, account, scopeTokenIds]
  );

  const scopedListed = useMemo(() => {
    if (!scopeTokenIds) return listings.length;
    return listings.filter(
      (l) => l.tokenId && scopeTokenIds.has(BigInt(l.tokenId).toString())
    ).length;
  }, [listings, scopeTokenIds]);

  const applyCustom = () => {
    const n = Math.floor(Number(customDraft));
    if (!Number.isFinite(n)) return;
    setCount(Math.max(1, Math.min(SWEEP_MAX, n)));
  };

  if (listings.length < 2) {
    return (
      <div className="flex min-h-9 items-center rounded-md border border-dashed border-gold-500/25 px-3 text-xs text-foreground/45">
        🧹 Nothing to sweep
      </div>
    );
  }

  const scopeLabel =
    scopeMode === "floor"
      ? "floor"
      : scopeMode === "tier" && tierScope !== "all"
        ? tierScope
        : scopeMode === "trait" && clauses.length > 0
          ? formatCriteriaLabel(clauses)
          : "scope";

  return (
    <div className="flex w-full flex-col gap-1.5 rounded-lg border border-gold-500/20 bg-black/15 px-2 py-1.5 sm:w-auto sm:min-w-[16rem]">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
          🧹 Sweep
        </span>
        {(
          [
            { id: "floor" as const, label: "All" },
            { id: "tier" as const, label: "Rarity" },
            { id: "trait" as const, label: "Trait / combo" },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setScopeMode(m.id)}
            aria-pressed={scopeMode === m.id}
            className={`min-h-8 rounded-md border px-2 text-[0.65rem] font-bold transition ${
              scopeMode === m.id
                ? "border-gold-400 bg-gold-500/15 text-gold-300"
                : "border-gold-500/25 text-foreground/55 hover:border-gold-400/50"
            }`}
          >
            {m.label}
          </button>
        ))}
        <span className="text-[0.58rem] text-foreground/40">
          {scopedListed} listed · max {SWEEP_MAX}
        </span>
      </div>

      {scopeMode === "trait" && (
        <div className="rounded-md border border-gold-500/20 bg-wood-950/60 p-2">
          <p className="mb-1.5 text-[0.6rem] font-bold uppercase tracking-wide text-gold-400/80">
            Select traits / rarity to sweep
          </p>
          <TraitCriteriaPicker
            traits={traitIndex?.traits ?? null}
            complete={Boolean(traitIndex?.complete && traitIndex.traits)}
            building={traitIndex?.building}
            scanned={traitIndex?.scanned}
            totalSupply={traitIndex?.totalSupply}
            loading={traitLoading}
            loadError={traitError}
            clauses={clauses}
            onChange={setClauses}
            listings={listings}
            dense
          />
        </div>
      )}

      {scopeMode === "tier" && tierScope === "all" && (
        <p className="text-[0.58rem] text-foreground/45">
          Pick a rarity chip above (or filter) to sweep that tier&apos;s floor.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => {
              setCount(n);
              setCustomDraft("");
            }}
            aria-pressed={count === n && customDraft === ""}
            className={`min-h-8 rounded-md border px-2 text-xs font-bold transition ${
              count === n && customDraft === ""
                ? "border-gold-400 bg-gold-500/15 text-gold-300"
                : "border-gold-500/30 text-foreground/60 hover:border-gold-400"
            }`}
          >
            {n}
          </button>
        ))}
        <label className="flex min-h-8 items-center gap-1 rounded-md border border-gold-500/30 bg-wood-950 px-1.5">
          <span className="sr-only">Custom sweep size</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="N"
            value={
              customDraft !== ""
                ? customDraft
                : count === PRESETS.find((p) => p === count)
                  ? ""
                  : String(count)
            }
            onChange={(e) => {
              const raw = e.target.value.replace(/[^0-9]/g, "");
              setCustomDraft(raw);
              const n = Math.floor(Number(raw));
              if (Number.isFinite(n) && n >= 1) {
                setCount(Math.min(SWEEP_MAX, n));
              }
            }}
            onBlur={applyCustom}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyCustom();
              }
            }}
            className="w-8 bg-transparent text-center text-xs font-bold text-foreground outline-none"
            aria-label={`Custom count 1–${SWEEP_MAX}`}
          />
        </label>
        <button
          type="button"
          disabled={
            plan.items.length === 0 ||
            (scopeMode === "trait" && (clauses.length === 0 || qualifyingEmpty(scopeTokenIds)))
          }
          onClick={() => onSweep(plan)}
          className="min-h-8 rounded-md bg-gold-500 px-2.5 text-xs font-bold text-wood-950 transition hover:bg-gold-400 disabled:opacity-40"
          title={scopeMode === "trait" ? formatCriteriaLabel(clauses) : undefined}
        >
          Sweep {plan.items.length || count}
          {scopeMode === "trait" && clauses.length > 0
            ? " matching"
            : ` ${scopeLabel.length > 18 ? "…" : scopeLabel}`}
          {plan.items.length > 0
            ? ` · ${formatTokenAmount(plan.totalWei, 18, 4)} Ξ`
            : ""}
        </button>
      </div>
    </div>
  );
}

function qualifyingEmpty(scope: Set<string> | undefined): boolean {
  return Boolean(scope && scope.size === 0);
}
