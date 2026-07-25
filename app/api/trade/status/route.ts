import {
  CHAIN,
  CONTRACT_ADDRESS,
  RULES_RELAXED,
  SNIPER_TRAP_MINUTES,
  TOKEN,
  TRADE_PAUSED,
} from "@/lib/constants";
import { getTrapWindow, isListingWindowActive, WALLET_COOLDOWN_MINUTES } from "@/lib/boards";
import { buildUniswapSwapUrl, getCountdownParts, getTradeOpensAt } from "@/lib/trade";
import { getPublicSiteFee, isTradingApiConfigured } from "@/lib/uniswap-server";
import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public status only.
 * Never returns UNISWAP_API_KEY or any secret — only a boolean configured flag.
 * External Uniswap URLs are withheld until RULES_RELAXED (launch safety).
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "status", limit: 60, windowMs: 60_000 });
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
      ? "Trading is paused. Stand by — do not trade $PLANK anywhere. Official widget is locked."
      : parts.isOpen
        ? "Official widget open — trade only on plank.love."
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
    rulesRelaxed: RULES_RELAXED,
    // Do not hand bots a deep-link while the sniper trap / limits are active
    uniswapUrl: RULES_RELAXED && !TRADE_PAUSED ? buildUniswapSwapUrl({ direction: "buy" }) : null,
    externalSwapsAllowed: RULES_RELAXED && !TRADE_PAUSED,
    // Boolean only — never the key itself
    tradingApiConfigured: isTradingApiConfigured(),
    siteFee: {
      ...getPublicSiteFee(),
      appliesTo: "official_plank_widget_only",
      immutable: true,
      note: "Fee bps and recipient are hard-coded server-side and cannot be changed by the client.",
    },
    venuePolicy: TRADE_PAUSED
      ? "STAND BY — trading not live. Do not swap on Uniswap.app or anywhere else."
      : RULES_RELAXED
        ? "Rules relaxed — open markets OK; still verify CA."
        : "Official plank.love widget only until launch rules are relaxed. Do not swap elsewhere.",
  });
}

export function POST() {
  return publicJson({ error: "METHOD", message: "Use GET." }, 405);
}
