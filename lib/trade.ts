import {
  CHAIN,
  CONTRACT_ADDRESS,
  NATIVE_TOKEN_ADDRESS,
  TOKEN,
  TRADE_OPENS_AT_ISO,
  TRADE_PAUSED,
} from "@/lib/constants";

export type CountdownParts = {
  totalMs: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  isOpen: boolean;
  /** Hard pause — trading not live; community stand by */
  paused: boolean;
};

export function getTradeOpensAt(): Date {
  const d = new Date(TRADE_OPENS_AT_ISO);
  if (Number.isNaN(d.getTime())) {
    // Fail closed: invalid env keeps the widget locked.
    return new Date("2099-01-01T00:00:00.000Z");
  }
  return d;
}

export function getCountdownParts(nowMs: number = Date.now()): CountdownParts {
  const opensAt = getTradeOpensAt().getTime();
  const totalMs = Math.max(0, opensAt - nowMs);
  // Never open while paused — widget + API stay locked
  const isOpen = !TRADE_PAUSED && totalMs <= 0;

  const totalSeconds = Math.floor(totalMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return {
    totalMs: TRADE_PAUSED ? Number.MAX_SAFE_INTEGER : totalMs,
    days: TRADE_PAUSED ? 0 : days,
    hours: TRADE_PAUSED ? 0 : hours,
    minutes: TRADE_PAUSED ? 0 : minutes,
    seconds: TRADE_PAUSED ? 0 : seconds,
    isOpen,
    paused: TRADE_PAUSED,
  };
}

export function isTradeOpen(nowMs: number = Date.now()): boolean {
  if (TRADE_PAUSED) return false;
  return getCountdownParts(nowMs).isOpen;
}

export { TRADE_PAUSED };

/** Official Uniswap interface deep-link — exact $PLANK CA on Robinhood Chain. */
export function buildUniswapSwapUrl(opts?: {
  amountEth?: string;
  /** buy = ETH→PLANK (default), sell = PLANK→ETH */
  direction?: "buy" | "sell";
}): string {
  const direction = opts?.direction ?? "buy";
  const params = new URLSearchParams();
  params.set("chain", CHAIN.uniswapSlug);
  params.set("theme", "dark");

  if (direction === "buy") {
    params.set("inputCurrency", "NATIVE");
    params.set("outputCurrency", CONTRACT_ADDRESS);
  } else {
    params.set("inputCurrency", CONTRACT_ADDRESS);
    params.set("outputCurrency", "NATIVE");
  }

  if (opts?.amountEth && Number(opts.amountEth) > 0) {
    params.set("field", "input");
    params.set("value", opts.amountEth);
  }

  return `https://app.uniswap.org/swap?${params.toString()}`;
}

export function explorerTokenUrl(): string {
  return `${CHAIN.blockExplorers.default.url}/token/${CONTRACT_ADDRESS}`;
}

export function explorerAddressUrl(address: string): string {
  return `${CHAIN.blockExplorers.default.url}/address/${address}`;
}

/** Parse a decimal string amount into integer base units (wei-style). */
export function parseTokenAmount(amount: string, decimals: number): bigint | null {
  const trimmed = amount.trim();
  if (!trimmed) return null;
  // Allow "1", "1.", ".5", "0.1" — reject multiple dots / non-numeric.
  if ((trimmed.match(/\./g) || []).length > 1) return null;
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return null;
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > decimals) return null;
  const whole = wholePart === "" ? "0" : wholePart;
  const frac = fracPart.padEnd(decimals, "0");
  if (!/^\d+$/.test(whole + frac)) return null;
  try {
    return BigInt(whole + frac);
  } catch {
    return null;
  }
}

export function formatTokenAmount(
  raw: string | bigint,
  decimals: number,
  maxFractionDigits = 8
): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const neg = value < BigInt(0);
  const abs = neg ? -value : value;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  // Show full precision for dust below default display threshold so "0" is not misleading.
  let digits = maxFractionDigits;
  if (abs > BigInt(0) && whole === BigInt(0)) {
    const minVisible = base / BigInt(10) ** BigInt(Math.min(maxFractionDigits, decimals));
    if (frac > BigInt(0) && frac < minVisible) {
      digits = decimals;
    }
  }
  digits = Math.min(digits, decimals);
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, digits);
  fracStr = fracStr.replace(/0+$/, "");
  const body = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}

/**
 * Compact display variant of formatTokenAmount for tight UI real estate
 * (tier-floor chips, price badges): genuine sub-cent / dust-level amounts
 * (e.g. spam listings priced at a handful of wei) render as full raw
 * decimals under formatTokenAmount's own dust rule, which is correct for
 * precision but is 10-14 characters wide and breaks fixed-width badge
 * layouts. This keeps normal-range amounts identical to formatTokenAmount
 * and only compacts values below `threshold` (default 1e-6 units) into
 * scientific notation, e.g. "8e-12" instead of "0.000000000008".
 *
 * Only used for display; never for arithmetic — full BigInt precision is
 * still what powers sweeps/comparisons via the raw wei value.
 */
export function formatTokenAmountCompact(
  raw: string | bigint,
  decimals: number,
  maxFractionDigits = 8,
  threshold = 1e-6
): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const neg = value < BigInt(0);
  const abs = neg ? -value : value;
  if (abs === BigInt(0)) return "0";

  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;

  // Only dust (no whole part) can ever be small enough to need scientific
  // notation, and only if it clears formatTokenAmount's normal precision
  // (i.e. its dust rule would otherwise expand to full raw decimals).
  if (whole === BigInt(0)) {
    const minVisible = base / BigInt(10) ** BigInt(Math.min(maxFractionDigits, decimals));
    if (frac > BigInt(0) && frac < minVisible) {
      // Exact value = frac / 10^decimals. Render as significant-digit
      // scientific notation from the exact fractional string (no float
      // round-trip needed since we only ever read a short digit prefix).
      const fracStr = frac.toString().padStart(decimals, "0");
      const firstNonZero = fracStr.search(/[1-9]/);
      const exponent = -(firstNonZero + 1);
      const sig = fracStr.slice(firstNonZero, firstNonZero + 3).replace(/0+$/, "") || "0";
      const mantissa = sig.length > 1 ? `${sig[0]}.${sig.slice(1)}` : sig;
      const asNumber = Number(`0.${fracStr}`);
      if (asNumber < threshold) {
        return `${neg ? "-" : ""}${mantissa}e${exponent}`;
      }
    }
  }

  return formatTokenAmount(raw, decimals, maxFractionDigits);
}

/**
 * Thousands separators for a decimal string's INTEGER part only — display
 * only, operates on the string formatTokenAmount already produced. Never
 * parses the value (no Number()/parseFloat), so full BigInt precision from
 * the caller is untouched; this is pure string grouping.
 */
export function groupThousands(decimalStr: string): string {
  const neg = decimalStr.startsWith("-");
  const body = neg ? decimalStr.slice(1) : decimalStr;
  const [whole, frac] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}

/**
 * The display-ready form of a base-unit amount: adaptive fraction-digit
 * precision (huge whole amounts don't need 8 decimal places to be
 * meaningful; small/dust amounts still get enough digits to not read as
 * zero) plus thousands separators on the integer part. Built entirely from
 * formatTokenAmount's bigint-precise string — never a float pass.
 */
export function formatDisplayAmount(raw: string | bigint, decimals: number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const abs = value < BigInt(0) ? -value : value;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  const wholeDigits = whole === BigInt(0) ? 0 : whole.toString().length;
  const maxFractionDigits =
    wholeDigits >= 9 ? 2 : wholeDigits >= 6 ? 3 : wholeDigits >= 1 ? 4 : 8;
  return groupThousands(formatTokenAmount(raw, decimals, maxFractionDigits));
}

/** Quotes older than this should be refreshed before swap (tight for meme volatility). */
export const QUOTE_MAX_AGE_MS = 20_000;

export function shortAddress(address: string, chars = 4): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}

export { NATIVE_TOKEN_ADDRESS, TOKEN, CONTRACT_ADDRESS, CHAIN };
