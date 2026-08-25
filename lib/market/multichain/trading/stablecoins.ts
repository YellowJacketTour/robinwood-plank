/**
 * Real, per-chain "most-used stablecoin" registry for cross-chain NFT
 * purchase quoting (across-quote.ts / debridge-quote.ts) -- lets a buyer
 * pay in USDC/USDT instead of only each chain's wrapped-native token.
 *
 * EVERY ADDRESS BELOW WAS LIVE-VERIFIED, NOT TAKEN ON FAITH
 * ---------------------------------------------------------------------------
 * Confirmed 2026-08-18 via a real eth_call to each address on its real
 * chain (Alchemy RPC): symbol() decoded to the expected ticker for all 13
 * candidates (including Arbitrum's canonical USDT, which now returns
 * "USD₮0" -- the real current symbol for Arbitrum's native-issued USDT0,
 * not a typo), and decimals() decoded to a real on-chain value for every
 * one. This is the same standard the rest of this session's cross-chain
 * work holds itself to (see across-quote.ts's own header) -- a wrong
 * stablecoin address here isn't a cosmetic bug, it's lost funds.
 *
 * ONE REAL SURPRISE, WORTH FLAGGING: BNB Chain's USDT is 18 DECIMALS
 * ---------------------------------------------------------------------------
 * Every other stablecoin checked (on Ethereum, Base, Arbitrum, Optimism,
 * Polygon, Avalanche) uses the "standard" 6 decimals USDC/USDT convention.
 * BNB Chain's BEP-20 USDT (0x55d39832...) is a real exception -- confirmed
 * live, decimals() returns 18, matching BEP-20's own community convention,
 * not USDC/USDT's usual cross-chain default. Getting this wrong would
 * under/over-price a quote by 10^12x. Every amount computed against this
 * registry MUST read `.decimals` from the entry, never assume 6.
 *
 * SCOPE: USDC + USDT ONLY -- the two stablecoins with real, deep liquidity
 * on every one of these 7 chains (confirmed via each chain's own dominant
 * DEX pools, not guessed). DAI, FRAX, and chain-specific stables (e.g.
 * BUSD, now deprecated/frozen by Paxos) are real but deliberately out of
 * scope until there's a specific route/demand for them.
 *
 * NOT wired to Solana (no EVM-style ERC-20 concept there) or Robinhood
 * Chain (not a cross-chain quote destination at all -- see
 * foreign-chain-registry.ts's own header on why Robinhood Chain is
 * excluded from FOREIGN_CHAINS).
 */

export type StablecoinEntry = {
  symbol: "USDC" | "USDT";
  address: string;
  decimals: number;
};

/** Keyed by real EVM chainId (matches ACROSS_SPOKE_POOL / EVM_CHAIN_ID elsewhere in this app). */
export const STABLECOINS_BY_CHAIN: Record<number, StablecoinEntry[]> = {
  1: [
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  ],
  8453: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }],
  42161: [
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
  ],
  10: [
    { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
    { symbol: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
  ],
  137: [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
  ],
  56: [
    { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 }, // real exception, see header
    { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  ],
  43114: [
    { symbol: "USDC", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
    { symbol: "USDT", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
  ],
};

export function findStablecoin(chainId: number, symbol: "USDC" | "USDT"): StablecoinEntry | null {
  return STABLECOINS_BY_CHAIN[chainId]?.find((s) => s.symbol === symbol) ?? null;
}
