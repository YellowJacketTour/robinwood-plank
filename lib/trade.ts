import {
  CHAIN,
  CONTRACT_ADDRESS,
  NATIVE_TOKEN_ADDRESS,
  TOKEN,
  TRADE_OPENS_AT_ISO,
} from "@/lib/constants";

export type CountdownParts = {
  totalMs: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  isOpen: boolean;
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
  const isOpen = totalMs <= 0;

  const totalSeconds = Math.floor(totalMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return { totalMs, days, hours, minutes, seconds, isOpen };
}

export function isTradeOpen(nowMs: number = Date.now()): boolean {
  return getCountdownParts(nowMs).isOpen;
}

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
  if (!trimmed || !/^\d*\.?\d+$/.test(trimmed)) return null;
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > decimals) return null;
  const whole = wholePart === "" ? "0" : wholePart;
  const frac = fracPart.padEnd(decimals, "0");
  try {
    return BigInt(whole + frac);
  } catch {
    return null;
  }
}

export function formatTokenAmount(
  raw: string | bigint,
  decimals: number,
  maxFractionDigits = 6
): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const neg = value < BigInt(0);
  const abs = neg ? -value : value;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFractionDigits);
  fracStr = fracStr.replace(/0+$/, "");
  const body = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}

export function shortAddress(address: string, chars = 4): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}

export { NATIVE_TOKEN_ADDRESS, TOKEN, CONTRACT_ADDRESS, CHAIN };
