import { MAX_CRITERIA_TOKEN_IDS } from "@/lib/market/criteria";

/**
 * Criteria bids without a complete id set: collection wildcard vs Merkle
 * snapshot, chosen per completeness -- pure and tested.
 *
 * - A Merkle criteria root is only honest when the id set it is built from
 *   is the REAL, complete set for the clause (trait facet, tier) -- an
 *   incomplete snapshot silently excludes tokens the bidder meant to bid on.
 * - A collection wildcard (identifierOrCriteria = 0) needs no id set but
 *   can only express "any token in the collection", and on this app's
 *   native book it is not proven (foreign-offer.ts header).
 */

export type CriteriaScope = "collection" | "trait" | "tier";

export type CriteriaModeInput = {
  scope: CriteriaScope;
  /** Ids the caller actually holds for the clause. */
  tokenIds: readonly string[];
  /** Real coverage of the trait/rarity index for this collection (0..1) or null when supply is unknown. */
  indexCoverage: number | null;
  /** Whether the venue's wildcard form is proven on this surface. */
  wildcardProven: boolean;
};

export type CriteriaModeDecision =
  | { mode: "merkle"; tokenIds: string[]; reason: string }
  | { mode: "wildcard"; reason: string }
  | { mode: "refuse"; reason: string };

export function chooseCriteriaMode(input: CriteriaModeInput): CriteriaModeDecision {
  const ids = [...new Set(input.tokenIds.map((t) => t.trim()).filter(Boolean))];
  const complete = input.indexCoverage != null && input.indexCoverage >= 1;
  if (input.scope === "collection") {
    if (input.wildcardProven) return { mode: "wildcard", reason: "collection-wide bid; wildcard is proven on this surface, no id set needed" };
    if (complete && ids.length > 0 && ids.length <= MAX_CRITERIA_TOKEN_IDS) return { mode: "merkle", tokenIds: ids, reason: `wildcard unproven here; complete id set (${ids.length}) fits the Merkle cap` };
    return { mode: "refuse", reason: complete ? `id set of ${ids.length} exceeds the Merkle cap (${MAX_CRITERIA_TOKEN_IDS}) and wildcard is unproven` : "index incomplete and wildcard unproven: a bid would silently exclude tokens" };
  }
  // trait / tier: a wildcard cannot express the clause at all.
  if (!complete) return { mode: "refuse", reason: `trait/tier index is ${input.indexCoverage == null ? "of unknown coverage" : `${Math.round(input.indexCoverage * 100)}% complete`}; a Merkle snapshot would exclude real matches` };
  if (ids.length === 0) return { mode: "refuse", reason: "clause matches zero tokens" };
  if (ids.length > MAX_CRITERIA_TOKEN_IDS) return { mode: "refuse", reason: `clause matches ${ids.length} tokens, above the Merkle cap (${MAX_CRITERIA_TOKEN_IDS})` };
  return { mode: "merkle", tokenIds: ids, reason: `complete index; ${ids.length} matching ids under the Merkle cap` };
}
