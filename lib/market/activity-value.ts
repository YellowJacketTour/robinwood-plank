import { getMultiAssetUsdPrices, normalizeAssetSymbol } from "@/lib/multi-asset-price";

export type ActivityValue = {
  priceAtomic: string | null;
  priceDecimals: number | null;
  priceSymbol: string | null;
  priceTokenAddress: string | null;
  priceAmount: string | null;
  priceUsd: number | null;
  usdRate: number | null;
  usdSource: string | null;
  usdQuotedAt: string | null;
};

const TOKEN_PLATFORM: Record<string, string> = {
  "eth-mainnet": "ethereum", ethereum: "ethereum",
  "polygon-mainnet": "polygon-pos", polygon: "polygon-pos",
  "arb-mainnet": "arbitrum-one", arbitrum: "arbitrum-one",
  "base-mainnet": "base", base: "base",
  "opt-mainnet": "optimistic-ethereum", optimism: "optimistic-ethereum",
  "bnb-mainnet": "binance-smart-chain", bsc: "binance-smart-chain",
  "avax-mainnet": "avalanche", avalanche: "avalanche",
  "zksync-mainnet": "zksync", zora: "zora",
};

const tokenQuoteCache = new Map<string, { usd: number | null; at: number }>();

async function tokenUsdPrice(chain: string | null | undefined, address: string | null | undefined): Promise<number | null> {
  if (!chain || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const platform = TOKEN_PLATFORM[chain.toLowerCase()];
  if (!platform) return null;
  const key = `${platform}:${address.toLowerCase()}`;
  const cached = tokenQuoteCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.usd;
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 2_500);
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${address}&vs_currencies=usd`,
      { headers: { accept: "application/json" }, cache: "no-store", signal: ac.signal }
    ).finally(() => clearTimeout(timeout));
    const data = res.ok ? await res.json() as Record<string, { usd?: number }> : {};
    const usd = data[address.toLowerCase()]?.usd;
    const valid = typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : null;
    tokenQuoteCache.set(key, { usd: valid, at: Date.now() });
    return valid;
  } catch {
    tokenQuoteCache.set(key, { usd: null, at: Date.now() });
    return null;
  }
}

function decimalAmount(atomic: string, decimals: number): string | null {
  if (!/^\d+$/.test(atomic) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const padded = atomic.padStart(decimals + 1, "0");
  if (decimals === 0) return padded;
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Canonical, fail-closed activity valuation. Never assumes all EVM tokens use 18 decimals. */
export async function activityValue(input: {
  atomic: string | null | undefined;
  decimals: number | null | undefined;
  symbol: string | null | undefined;
  tokenAddress?: string | null;
  chain?: string | null;
}): Promise<ActivityValue> {
  const atomic = input.atomic && /^\d+$/.test(input.atomic) ? input.atomic : null;
  const decimals = Number.isInteger(input.decimals) && input.decimals! >= 0 ? input.decimals! : null;
  const symbol = input.symbol?.trim() || null;
  const amount = atomic != null && decimals != null ? decimalAmount(atomic, decimals) : null;
  const normalized = normalizeAssetSymbol(symbol);
  const prices = normalized ? await getMultiAssetUsdPrices() : null;
  const quote = normalized ? prices?.[normalized] : null;
  const contractRate = quote?.usd == null ? await tokenUsdPrice(input.chain, input.tokenAddress) : null;
  const usdRate = quote?.usd ?? contractRate;
  const numericAmount = amount == null ? null : Number(amount);
  const priceUsd = numericAmount != null && Number.isFinite(numericAmount) && usdRate != null ? numericAmount * usdRate : null;
  return {
    priceAtomic: atomic,
    priceDecimals: decimals,
    priceSymbol: symbol,
    priceTokenAddress: input.tokenAddress?.toLowerCase() ?? null,
    priceAmount: amount,
    priceUsd: priceUsd != null && Number.isFinite(priceUsd) ? priceUsd : null,
    usdRate,
    usdSource: usdRate != null ? quote?.source ?? "coingecko-token-address" : null,
    usdQuotedAt: usdRate != null ? new Date().toISOString() : null,
  };
}
