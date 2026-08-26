/**
 * $PLANK-specific number formatting. Two real, distinct problems `formatUsd`
 * (lib/eth-price.ts) doesn't solve, both from the same root cause -- $PLANK
 * has an enormous real supply (~888.42 trillion, see lib/plank-supply.ts)
 * and a correspondingly tiny real per-token price (~$8e-10):
 *
 *  1. A per-token USD price this small rounds to "$0.00" under fixed-digit
 *     formatting, which is not wrong so much as useless -- it throws away
 *     the only real information the number carries. Scientific notation is
 *     the honest way to show a value at this scale.
 *  2. A whole-supply-scale token AMOUNT (a prize of trillions of PLANK) is
 *     unreadable as a bare digit string. Real fix: a comma-grouped full
 *     number for precision PLUS an abbreviated K/M/B/T form for at-a-glance
 *     reading, never one or the other alone.
 */

const ABBREVIATIONS: Array<[number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** "6,167,412,121,919.8" -- full precision, comma-grouped, for a tooltip or subtext. */
export function formatPlankFull(amount: number, maxDigits = 2): string {
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxDigits }).format(amount);
}

/** "6.17T" -- the at-a-glance headline form. */
export function formatPlankAbbreviated(amount: number, digits = 2): string {
  if (!Number.isFinite(amount)) return "—";
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  for (const [threshold, suffix] of ABBREVIATIONS) {
    if (abs >= threshold) return `${sign}${(abs / threshold).toFixed(digits)}${suffix}`;
  }
  return formatPlankFull(amount, digits);
}

/** Combined real amount (raw base units, 18 decimals) -> both display forms. */
export function formatPlankAmount(raw: string | bigint, decimals = 18): { abbreviated: string; full: string } {
  try {
    const value = Number(BigInt(raw)) / 10 ** decimals;
    return { abbreviated: formatPlankAbbreviated(value), full: formatPlankFull(value) };
  } catch {
    return { abbreviated: "—", full: "—" };
  }
}

const SUBSCRIPT_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

function toSubscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPT_DIGITS[Number(d)] ?? d)
    .join("");
}

/**
 * A per-token USD price this small (~$8e-10) needs more than fixed-digit
 * formatting to carry any real information -- "$0.00" is technically not
 * wrong, just uninformative. Real "e-notation" (e.g. "$8.48e-10") is
 * precise but reads as a debugger dump, not a price -- this uses the
 * convention real DEX interfaces (Uniswap's own token price display among
 * them) already settled on for sub-cent tokens: the leading run of zeros
 * after the decimal point is collapsed into one subscripted digit giving
 * the COUNT of zeros, followed by the real significant digits at full
 * size -- "$0.0₉848" reads as "0.0, then 9 more zeros, then 848", exactly
 * as precise as "$0.000000000848" without asking a reader to count zeros.
 * Ordinary formatUsd-shaped output above $0.01 (this helper must stay
 * correct if the token ever appreciates past cent-scale).
 */
export function formatPlankUsdPrice(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return "—";
  if (usd >= 0.01) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(
      usd
    );
  }
  const exponent = Math.floor(Math.log10(usd));
  const leadingZeros = Math.max(0, -exponent - 1);
  const mantissa = usd / 10 ** exponent; // 1 <= mantissa < 10
  const significantDigits = Math.round(mantissa * 100)
    .toString()
    .padStart(3, "0"); // 3 significant digits, e.g. "848"
  return `$0.0${toSubscript(leadingZeros)}${significantDigits}`;
}
