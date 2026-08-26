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

/**
 * A per-token USD price this small (~$8e-10) needs scientific notation to
 * carry any real information -- "$0.00" under fixed-digit formatting is
 * technically not wrong, just uninformative. Renders as "$8.48e-10" for
 * anything under $0.01; ordinary formatUsd-shaped output otherwise (a
 * $PLANK price this cheap is the expected case, but this helper must stay
 * correct if the token ever appreciates past cent-scale).
 */
export function formatPlankUsdPrice(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return "—";
  if (usd >= 0.01) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(
      usd
    );
  }
  const [mantissa, exponent] = usd.toExponential(2).split("e");
  return `$${mantissa}e${exponent}`;
}
