/**
 * Live ETH/USD price helper for Bad Boards volume display.
 * Cached briefly so SSE tickers can refresh without hammering upstream.
 */

type PriceCache = {
  usd: number;
  fetchedAt: number;
  source: string;
};

const g = globalThis as typeof globalThis & { __plankEthUsd?: PriceCache };

const CACHE_MS = 12_000;

export async function getEthUsdPrice(): Promise<{ usd: number; source: string; ageMs: number }> {
  const now = Date.now();
  const hit = g.__plankEthUsd;
  if (hit && now - hit.fetchedAt < CACHE_MS) {
    return { usd: hit.usd, source: hit.source, ageMs: now - hit.fetchedAt };
  }

  let usd = hit?.usd ?? 0;
  let source = hit?.source ?? "stale";

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { ethereum?: { usd?: number } };
      const n = data?.ethereum?.usd;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) {
        usd = n;
        source = "coingecko";
      }
    }
  } catch {
    // keep prior cache
  }

  // Fallback: Coinbase if CG failed and we have no price yet
  if (!(usd > 0)) {
    try {
      const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: { amount?: string } };
        const n = Number(data?.data?.amount);
        if (Number.isFinite(n) && n > 0) {
          usd = n;
          source = "coinbase";
        }
      }
    } catch {
      // ignore
    }
  }

  if (usd > 0) {
    g.__plankEthUsd = { usd, fetchedAt: now, source };
  }

  return {
    usd: usd > 0 ? usd : 0,
    source,
    ageMs: g.__plankEthUsd ? now - g.__plankEthUsd.fetchedAt : Number.POSITIVE_INFINITY,
  };
}

const WEI_PER_ETH = BigInt("1000000000000000000");
const WEI_PER_MILLI = BigInt("1000000000000000");

/** Wei string → ETH fixed to 3 decimal places (floor, never round up sniper glory). */
export function formatEth3(wei: string | bigint | number | undefined | null): string {
  try {
    const w = typeof wei === "bigint" ? wei : BigInt(wei ?? 0);
    const whole = w / WEI_PER_ETH;
    const frac = w % WEI_PER_ETH;
    // 3 decimal digits from the fractional part
    const milli = frac / WEI_PER_MILLI; // 0..999
    return `${whole.toString()}.${milli.toString().padStart(3, "0")}`;
  } catch {
    return "0.000";
  }
}

export function ethWeiToNumber(wei: string | bigint | undefined | null): number {
  try {
    const w = typeof wei === "bigint" ? wei : BigInt(wei ?? 0);
    // Keep milli-ETH precision for USD math without float wei loss on huge values
    const milli = Number(w / WEI_PER_MILLI); // eth * 1000
    return milli / 1000;
  } catch {
    return 0;
  }
}

export function formatUsd(amount: number, digits = 2): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

export function weiToUsd(wei: string | bigint | undefined | null, ethUsd: number): number {
  if (!(ethUsd > 0)) return 0;
  return ethWeiToNumber(wei) * ethUsd;
}
