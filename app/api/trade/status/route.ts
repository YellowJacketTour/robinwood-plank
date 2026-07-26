import {
  CHAIN,
  CONTRACT_ADDRESS,
  SNIPER_TRAP_MINUTES,
  TOKEN,
  TRADE_PAUSED,
} from "@/lib/constants";
import { getTrapWindow, isListingWindowActive, WALLET_COOLDOWN_MINUTES } from "@/lib/boards";
import { buildUniswapSwapUrl, getCountdownParts, getTradeOpensAt } from "@/lib/trade";
import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public status only. All trading happens on the official Uniswap app —
 * this site never builds or sends swap transactions itself.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "status", limit: 180, windowMs: 60_000 });
  if (limited) return limited;

  const parts = getCountdownParts();
  const opensAt = getTradeOpensAt();

  return publicJson({
    isOpen: parts.isOpen,
    paused: TRADE_PAUSED || parts.paused,
    opensAt: opensAt.toISOString(),
    serverNow: new Date().toISOString(),
    remainingMs: TRADE_PAUSED ? null : parts.totalMs,
    message: TRADE_PAUSED
      ? "Trading is paused. Stand by."
      : parts.isOpen
        ? "Trading is live — Uniswap only."
        : "Community trade not open yet.",
    token: {
      symbol: TOKEN.symbol,
      address: CONTRACT_ADDRESS,
      decimals: TOKEN.decimals,
      chainId: CHAIN.id,
      chainName: CHAIN.name,
    },
    sniperTrapMinutes: SNIPER_TRAP_MINUTES,
    walletCooldownMinutes: WALLET_COOLDOWN_MINUTES,
    listingWindow: (() => {
      const t = getTrapWindow();
      return {
        active: isListingWindowActive() && !TRADE_PAUSED,
        phase: TRADE_PAUSED ? "paused" : t.phase,
        trapStartsAt: t.trapStartsAt.toISOString(),
        cooldownsEndAt: t.cooldownsEndAt.toISOString(),
      };
    })(),
    // Official Uniswap FE deep-link — verified $PLANK CA on Robinhood Chain
    uniswapUrl: !TRADE_PAUSED ? buildUniswapSwapUrl({ direction: "buy" }) : null,
    uniswapUrlSell: !TRADE_PAUSED ? buildUniswapSwapUrl({ direction: "sell" }) : null,
    externalSwapsAllowed: !TRADE_PAUSED,
    venuePolicy: TRADE_PAUSED
      ? "STAND BY — trading not live."
      : "Trade only via the official Uniswap app. Always verify CA.",
    tokenAddress: CONTRACT_ADDRESS,
  });
}

export function POST() {
  return publicJson({ error: "METHOD", message: "Use GET." }, 405);
}
