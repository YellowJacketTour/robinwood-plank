import { tierFromBackground, TIER_ORDER } from "@/lib/rarity";
import type { RarityTier } from "@/lib/rarity";
import type { Listing } from "@/lib/market/types";
import { traitFloorWei } from "@/lib/market/traits";

/**
 * Multi-clause market criteria: AND of trait values and/or a rarity tier.
 *
 * Rarity maps to a UNION of Background trait values whose labels resolve to
 * that tier (e.g. Rare + RareGraded). Trait clauses AND with each other and
 * with rarity. All resolution is pure so client + server can share logic;
 * the server still re-resolves from its verified index before accepting bids.
 */

export type TraitPair = { traitType: string; value: string };

export type CriteriaClause =
  | { kind: "trait"; traitType: string; value: string }
  | { kind: "rarity"; tier: RarityTier }
  | { kind: "rank"; maxRank: number };

/** Minimal index shape (client response or server TraitIndex.traits). */
export type TraitMap = Record<string, Record<string, string[]>>;

export const MAX_CRITERIA_CLAUSES = 4;

export function emptyClauses(): CriteriaClause[] {
  return [];
}

export function isRarityTier(v: unknown): v is RarityTier {
  return typeof v === "string" && (TIER_ORDER as readonly string[]).includes(v);
}

/** Intersect lists of decimal token-id strings (canonical BigInt form). */
export function intersectTokenIdLists(lists: readonly (readonly string[])[]): string[] {
  if (lists.length === 0) return [];
  let set = new Set(lists[0]!.map((id) => BigInt(id).toString()));
  for (let i = 1; i < lists.length; i++) {
    const next = new Set(lists[i]!.map((id) => BigInt(id).toString()));
    set = new Set([...set].filter((id) => next.has(id)));
    if (set.size === 0) return [];
  }
  return [...set].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

export function unionTokenIdLists(lists: readonly (readonly string[])[]): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const id of list) {
      try {
        set.add(BigInt(id).toString());
      } catch {
        /* skip junk */
      }
    }
  }
  return [...set].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

/** Background trait values in the index that map to the given rarity tier. */
export function backgroundValuesForTier(traits: TraitMap, tier: RarityTier): string[] {
  const bg = traits["Background"] ?? {};
  return Object.keys(bg).filter((v) => tierFromBackground(v) === tier);
}

/** Token ids for a rarity tier = union of matching Background values. */
export function tokenIdsForRarityTier(traits: TraitMap, tier: RarityTier): string[] {
  const values = backgroundValuesForTier(traits, tier);
  return unionTokenIdLists(values.map((v) => traits["Background"]?.[v] ?? []));
}

export function tokenIdsForClause(
  traits: TraitMap,
  clause: CriteriaClause,
  rankings?: Readonly<Record<string, number>> | null
): string[] {
  if (clause.kind === "rarity") {
    return tokenIdsForRarityTier(traits, clause.tier);
  }
  if (clause.kind === "rank") {
    if (!rankings) return [];
    return Object.entries(rankings)
      .filter(([, rank]) => Number.isInteger(rank) && rank > 0 && rank <= clause.maxRank)
      .map(([tokenId]) => tokenId);
  }
  return traits[clause.traitType]?.[clause.value] ?? [];
}

/**
 * Resolve AND of all clauses. Empty clauses → empty set (caller must treat
 * "no criteria" separately as collection-wide / undefined).
 */
export function resolveCriteriaTokenIds(
  traits: TraitMap | null | undefined,
  clauses: readonly CriteriaClause[],
  rankings?: Readonly<Record<string, number>> | null
): string[] {
  if (!traits || clauses.length === 0) return [];
  const lists = clauses.map((c) => tokenIdsForClause(traits, c, rankings));
  if (lists.some((l) => l.length === 0)) return [];
  return intersectTokenIdLists(lists);
}

/** Human label for UI / offer list rows. */
export function formatCriteriaLabel(clauses: readonly CriteriaClause[]): string {
  if (clauses.length === 0) return "any plank";
  return clauses
    .map((c) =>
      c.kind === "rarity"
        ? `Rarity: ${c.tier}`
        : c.kind === "rank"
          ? `Rank: top ${c.maxRank}`
          : `${c.traitType}: ${c.value}`
    )
    .join(" · ");
}

/**
 * Normalize client criteria for the API:
 *  - trait pairs stored on Offer.traits
 *  - rarity stored as synthetic Background union labels when posting
 * For storage we keep both real trait pairs and a rarity pseudo-entry so
 * sellers see "Rarity: Epic" not every Background value.
 */
export function clausesToTraitLabels(clauses: readonly CriteriaClause[]): TraitPair[] {
  const out: TraitPair[] = [];
  for (const c of clauses) {
    if (c.kind === "trait") {
      out.push({ traitType: c.traitType, value: c.value });
    } else if (c.kind === "rarity") {
      // Display-only label; server re-resolves via rarityTier field.
      out.push({ traitType: "Rarity", value: c.tier });
    } else {
      // Display-only label; server re-resolves via rankMax field.
      out.push({ traitType: "Rank", value: `Top ${c.maxRank}` });
    }
  }
  return out;
}

export function parseCriteriaFromBody(input: {
  trait?: unknown;
  traits?: unknown;
  rarityTier?: unknown;
  criteria?: unknown;
}): { clauses: CriteriaClause[]; error?: string } {
  const clauses: CriteriaClause[] = [];

  // Nested criteria object (preferred)
  if (input.criteria !== undefined && input.criteria !== null) {
    if (typeof input.criteria !== "object") {
      return { clauses: [], error: "Malformed criteria." };
    }
    const c = input.criteria as {
      traits?: unknown;
      rarityTier?: unknown;
      rankMax?: unknown;
    };
    if (c.traits !== undefined) {
      if (!Array.isArray(c.traits)) return { clauses: [], error: "Malformed criteria.traits." };
      for (const t of c.traits) {
        const pair = parseTraitPair(t);
        if (!pair) return { clauses: [], error: "Malformed trait." };
        clauses.push({ kind: "trait", ...pair });
      }
    }
    if (c.rarityTier !== undefined && c.rarityTier !== null && c.rarityTier !== "") {
      if (!isRarityTier(c.rarityTier)) return { clauses: [], error: "Unknown rarity tier." };
      clauses.push({ kind: "rarity", tier: c.rarityTier });
    }
    if (c.rankMax !== undefined && c.rankMax !== null && c.rankMax !== "") {
      const maxRank = Number(c.rankMax);
      if (!Number.isInteger(maxRank) || maxRank < 1 || maxRank > 1542) {
        return { clauses: [], error: "Rank must be between 1 and 1542." };
      }
      clauses.push({ kind: "rank", maxRank });
    }
  }

  // Legacy single trait
  if (input.trait !== undefined && input.trait !== null) {
    const pair = parseTraitPair(input.trait);
    if (!pair) return { clauses: [], error: "Malformed trait." };
    // Avoid double-adding if criteria already included it
    if (!clauses.some((x) => x.kind === "trait" && x.traitType === pair.traitType && x.value === pair.value)) {
      clauses.push({ kind: "trait", ...pair });
    }
  }

  // Flat traits array
  if (input.traits !== undefined && input.traits !== null) {
    if (!Array.isArray(input.traits)) return { clauses: [], error: "Malformed traits." };
    for (const t of input.traits) {
      const pair = parseTraitPair(t);
      if (!pair) return { clauses: [], error: "Malformed trait." };
      if (!clauses.some((x) => x.kind === "trait" && x.traitType === pair.traitType && x.value === pair.value)) {
        clauses.push({ kind: "trait", ...pair });
      }
    }
  }

  if (input.rarityTier !== undefined && input.rarityTier !== null && input.rarityTier !== "") {
    if (!isRarityTier(input.rarityTier)) return { clauses: [], error: "Unknown rarity tier." };
    if (!clauses.some((x) => x.kind === "rarity" && x.tier === input.rarityTier)) {
      clauses.push({ kind: "rarity", tier: input.rarityTier });
    }
  }

  if (clauses.length > MAX_CRITERIA_CLAUSES) {
    return { clauses: [], error: `At most ${MAX_CRITERIA_CLAUSES} criteria clauses.` };
  }

  // One rarity max
  if (clauses.filter((c) => c.kind === "rarity").length > 1) {
    return { clauses: [], error: "Only one rarity tier per bid." };
  }
  if (clauses.filter((c) => c.kind === "rank").length > 1) {
    return { clauses: [], error: "Only one rank threshold per bid." };
  }

  // One value per trait type (AND of two Bases is always empty)
  const seenTypes = new Set<string>();
  for (const c of clauses) {
    if (c.kind !== "trait") continue;
    if (seenTypes.has(c.traitType)) {
      return { clauses: [], error: "Duplicate trait type in criteria." };
    }
    seenTypes.add(c.traitType);
  }

  return { clauses };
}

function parseTraitPair(t: unknown): TraitPair | null {
  if (!t || typeof t !== "object") return null;
  const o = t as { traitType?: unknown; value?: unknown };
  const traitType = typeof o.traitType === "string" ? o.traitType.trim() : "";
  const value = typeof o.value === "string" ? o.value.trim() : "";
  if (!traitType || !value || traitType.length > 64 || value.length > 64) return null;
  return { traitType, value };
}

export function criteriaFloorWei(
  listings: readonly Pick<Listing, "tokenId" | "priceWei">[],
  tokenIds: readonly string[]
): string | null {
  return traitFloorWei(listings, tokenIds);
}

/** Suggest a default first clause once the index is ready. */
export function defaultFirstClause(traits: TraitMap): CriteriaClause | null {
  const types = Object.keys(traits).sort();
  // Prefer Holographic / Background over long Base lists for first pick.
  const preferred = ["Holographic", "Background", "Base"];
  const traitType = preferred.find((p) => types.includes(p)) ?? types[0];
  if (!traitType) return null;
  const values = Object.keys(traits[traitType] ?? {}).sort();
  const value = values[0];
  if (!value) return null;
  return { kind: "trait", traitType, value };
}
