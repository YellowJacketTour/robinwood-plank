/**
 * Trait histograms, split by what the evidence can actually support.
 *
 * A trait distribution over content-addressed bodies is a fact: every body
 * hashes to a value the chain committed to. The same distribution over
 * mutable HTTPS metadata is an observation, because the origin may serve
 * different bytes to different vantages.
 *
 * Mixing them produces a number that looks complete and is not, which is how
 * a rarity rank ends up wrong for exactly the tokens whose metadata moved.
 * So the two are different claim kinds and this module refuses to combine
 * them.
 */
import { registerProgram } from "./program.ts";

export interface TraitBody {
  tokenId: string;
  /** True only when the body verified against an on-chain commitment. */
  contentAddressed: boolean;
  attributes: Array<{ trait_type: string; value: string | number }>;
}

export interface TraitsOutput {
  tokenCount: number;
  /** trait_type -> value -> count, sorted for byte-comparable output. */
  histogram: Array<[string, Array<[string, number]>]>;
}

export function runTraits(inputs: TraitBody[]): TraitsOutput {
  const h = new Map<string, Map<string, number>>();
  for (const b of inputs) {
    for (const a of b.attributes) {
      const type = String(a.trait_type);
      const val = String(a.value);
      const inner = h.get(type) ?? new Map<string, number>();
      inner.set(val, (inner.get(val) ?? 0) + 1);
      h.set(type, inner);
    }
  }
  const histogram = [...h.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([type, inner]) => {
      const vals = [...inner.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
      );
      return [type, vals] as [string, Array<[string, number]>];
    });
  return { tokenCount: inputs.length, histogram };
}

registerProgram<TraitBody, TraitsOutput>("traits.v1", runTraits);

/**
 * Refuse a mixed input set rather than silently producing a number whose
 * completeness nobody can state.
 */
export function traitsClaimKind(
  bodies: TraitBody[]
): "traits_content_addressed" | "traits_under_obs" {
  const anyMutable = bodies.some((b) => !b.contentAddressed);
  return anyMutable ? "traits_under_obs" : "traits_content_addressed";
}

export function assertNotMixedSilently(bodies: TraitBody[], declaredKind: string): void {
  const actual = traitsClaimKind(bodies);
  if (actual !== declaredKind) {
    throw new Error(
      `trait claim declared "${declaredKind}" but the body set is "${actual}": ` +
        `content-addressed and observed traits are different claims and may not be merged`
    );
  }
}
