/**
 * Claim kits: numbers that carry their own witnesses.
 *
 * Production publishes a bare `floorPriceWei`. A stranger cannot falsify it,
 * and neither can we -- which is the same problem, because it means a wrong
 * floor is indistinguishable from a right one. Parity against a third-party
 * API is not a fix either: Hiro returned `410 Gone` mid-session, and on
 * 2026-09-08 Magic Eden answered 503 and UniSat 404.
 *
 * A kit pairs a value with (a) the minimum chain objects needed to recompute
 * it, and (b) the name of a deterministic program. The stranger re-fetches
 * the inputs from THEIR node, runs the program, and demands equality. We are
 * not an oracle; we are a packer of inputs.
 */
import type { ClaimKind, ChainId } from "../shared/types.ts";
import type { Hex } from "../shared/hex.ts";

export interface ClaimAsOf {
  chain: ChainId;
  height: number;
  blockHash: Hex;
}

export interface ClaimKit<TInput = unknown, TOutput = unknown> {
  claim: { kind: ClaimKind; subject: string; value: TOutput; asOf: ClaimAsOf };
  programId: string;
  inputs: TInput[];
  inputDigest: Hex;
}

export type ClaimProgram<TInput, TOutput> = (inputs: TInput[]) => TOutput;

const REGISTRY = new Map<string, ClaimProgram<never, unknown>>();

export function registerProgram<TInput, TOutput>(
  id: string,
  fn: ClaimProgram<TInput, TOutput>
): void {
  REGISTRY.set(id, fn as ClaimProgram<never, unknown>);
}

export function getProgram(id: string): ClaimProgram<never, unknown> | undefined {
  return REGISTRY.get(id);
}

/**
 * Every kind a UI number may have. A number whose kind is not here cannot be
 * displayed -- see `assertTypedFloor`.
 */
export const VALID_CLAIM_KINDS: ClaimKind[] = [
  "holders_at_block",
  "holders_at_block_partial",
  "traits_content_addressed",
  "traits_under_obs",
  "min_exhibited_valid_order",
  "min_observed_fill_in_window",
  "amm_state",
  "creator_from_genesis",
];

/**
 * The refusal that keeps "floor: 0.42" out of the product.
 *
 * "floor" is not a fact about a market; it is a claim about a search. The
 * honest kinds say which search: the cheapest order we can EXHIBIT, the
 * cheapest fill we OBSERVED in a window, or an AMM's state. Bitcoin has no
 * keyless order book at all, so "no lower ask exists" is not a sentence this
 * product is allowed to contain.
 */
export function assertTypedFloor(kind: string): asserts kind is ClaimKind {
  if (kind === "floor" || kind === "floorPriceWei" || kind === "price") {
    throw new Error(
      `bare "${kind}" is not a claim kind: use min_exhibited_valid_order, ` +
        `min_observed_fill_in_window, or amm_state -- a floor must say what search produced it`
    );
  }
  if (!VALID_CLAIM_KINDS.includes(kind as ClaimKind)) {
    throw new Error(`unknown claim kind "${kind}"`);
  }
}

export interface VerifyResult {
  ok: boolean;
  reason: string;
  recomputed?: unknown;
}

/**
 * What a stranger runs. Note it takes NO archive handle: if this function
 * needed our database, the kit would be an assertion rather than a proof.
 */
export function verifyClaimKit(
  kit: ClaimKit,
  deps: { sha256Hex: (s: string) => Hex; canonical?: (i: unknown[]) => string }
): VerifyResult {
  const program = getProgram(kit.programId);
  if (!program) return { ok: false, reason: `unknown program "${kit.programId}"` };

  const canonical = deps.canonical ?? ((i: unknown[]) => JSON.stringify(i));
  const digest = deps.sha256Hex(canonical(kit.inputs));
  if (digest !== kit.inputDigest) {
    return { ok: false, reason: "input digest mismatch: inputs were altered" };
  }

  let recomputed: unknown;
  try {
    recomputed = (program as ClaimProgram<unknown, unknown>)(kit.inputs);
  } catch (e) {
    return { ok: false, reason: `program threw: ${e instanceof Error ? e.message : String(e)}` };
  }

  const same = JSON.stringify(recomputed) === JSON.stringify(kit.claim.value);
  return {
    ok: same,
    reason: same ? "recomputed value matches" : "recomputed value differs from claim",
    recomputed,
  };
}
