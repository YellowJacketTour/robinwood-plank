import {
  CHAIN,
  CONTRACT_ADDRESS,
  RULES_RELAXED,
  SNIPER_TRAP_MINUTES,
  TOKEN,
} from "@/lib/constants";
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
    opensAt: opensAt.toISOString(),
    serverNow: new Date().toISOString(),
    remainingMs: parts.totalMs,
    token: {
      symbol: TOKEN.symbol,
      address: CONTRACT_ADDRESS,
      decimals: TOKEN.decimals,
      chainId: CHAIN.id,
      chainName: CHAIN.name,
    },
    sniperTrapMinutes: SNIPER_TRAP_MINUTES,
    rulesRelaxed: RULES_RELAXED,
    // Do not hand bots a deep-link while the sniper trap / limits are active
    uniswapUrl: RULES_RELAXED ? buildUniswapSwapUrl({ direction: "buy" }) : null,
    externalSwapsAllowed: RULES_RELAXED,
    // Boolean only — never the key itself
    tradingApiConfigured: isTradingApiConfigured(),
    siteFee: {
      ...getPublicSiteFee(),
      appliesTo: "official_plank_widget_only",
      immutable: true,
      note: "Fee bps and recipient are hard-coded server-side and cannot be changed by the client.",
    },
    venuePolicy: RULES_RELAXED
      ? "Rules relaxed — open markets OK; still verify CA."
      : "Official plank.love widget only until launch rules are relaxed. Do not swap elsewhere.",
  });
}

export function POST() {
  return publicJson({ error: "METHOD", message: "Use GET." }, 405);
}
