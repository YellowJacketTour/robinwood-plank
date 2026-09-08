/**
 * Floors, typed honestly.
 *
 * "The floor" implies a complete search of every venue. No such search is
 * possible: Bitcoin asks are venue-held PSBTs with no keyless book, and on
 * 2026-09-08 the venues that might have answered returned 402, 503, and 404.
 * So this module never produces a global minimum. It produces the cheapest
 * order we can EXHIBIT, with the bytes, which a stranger can verify without
 * asking us or the venue anything.
 *
 * The durability property is the point: a couriered Seaport order stays
 * verifiable after the venue's API dies. A number does not.
 */
import { registerProgram } from "./program.ts";

export interface ExhibitedOrder {
  orderHash: string;
  /** Native-currency price in atomic units, as a decimal string. */
  priceAtomic: string;
  /** Signature present and recoverable. Absent = not exhibitable. */
  signature: string | null;
  /** Cancelled or filled on-chain: cannot exhibit, regardless of signature. */
  cancelled: boolean;
  filled: boolean;
  /** Unix seconds; 0 or absent means no expiry. */
  expiresAt: number;
  /** For PSBTs: every input must still be unspent. */
  inputsUnspent?: boolean;
}

export interface ExhibitFloorInput {
  asOfUnix: number;
  orders: ExhibitedOrder[];
}

export interface ExhibitFloorOutput {
  /** null when nothing is exhibitable -- an honest "we cannot show a floor". */
  priceAtomic: string | null;
  orderHash: string | null;
  consideredCount: number;
  validCount: number;
}

/**
 * An order is exhibitable only if a stranger could act on it right now.
 * Each rejection below corresponds to a way a naive implementation shows a
 * price nobody can actually pay.
 */
export function isExhibitable(o: ExhibitedOrder, asOfUnix: number): boolean {
  if (!o.signature || o.signature === "0x") return false;
  if (o.cancelled) return false;
  if (o.filled) return false;
  if (o.expiresAt > 0 && o.expiresAt <= asOfUnix) return false;
  if (o.inputsUnspent === false) return false;
  return true;
}

/** Compare atomic price strings without precision loss. */
function ltAtomic(a: string, b: string): boolean {
  const A = a.replace(/^0+/, "") || "0";
  const B = b.replace(/^0+/, "") || "0";
  if (A.length !== B.length) return A.length < B.length;
  return A < B;
}

export function runExhibitFloor(inputs: ExhibitFloorInput[]): ExhibitFloorOutput {
  const first = inputs[0];
  if (!first) return { priceAtomic: null, orderHash: null, consideredCount: 0, validCount: 0 };

  let best: ExhibitedOrder | null = null;
  let validCount = 0;
  for (const o of first.orders) {
    if (!isExhibitable(o, first.asOfUnix)) continue;
    validCount++;
    if (!best || ltAtomic(o.priceAtomic, best.priceAtomic)) best = o;
  }

  return {
    priceAtomic: best?.priceAtomic ?? null,
    orderHash: best?.orderHash ?? null,
    consideredCount: first.orders.length,
    validCount,
  };
}

registerProgram<ExhibitFloorInput, ExhibitFloorOutput>("exhibit_floor.v1", runExhibitFloor);

/**
 * The sentence this product is not allowed to contain.
 *
 * Kept as a callable so the refusal is testable and greppable rather than a
 * comment someone can miss.
 */
export function assertNoGlobalFloorClaim(text: string): void {
  if (/\b(the|global)\s+floor\b/i.test(text) || /no lower ask exists/i.test(text)) {
    throw new Error(
      "a global floor is unprovable: venue-held asks are not on-chain. " +
        "Say min_exhibited_valid_order, min_observed_fill_in_window, or amm_state."
    );
  }
}
