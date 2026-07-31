import {
  CHAIN,
  CONTRACT_ADDRESS,
  SNIPER_TRAP_MINUTES,
  TOKEN,
  TRADE_PAUSED as ENV_TRADE_PAUSED,
} from "@/lib/constants";
import { getTrapWindow, isListingWindowActive, WALLET_COOLDOWN_MINUTES } from "@/lib/boards";
import { buildUniswapSwapUrl, getCountdownParts, getTradeOpensAt } from "@/lib/trade";
import { getPublicSiteFee, isTradingApiConfigured } from "@/lib/uniswap-server";
import { getContent } from "@/lib/content-store";
import type { FlagsDoc } from "@/lib/content-docs";
import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public status only.
 * Never returns UNISWAP_API_KEY or any secret — only a boolean configured flag.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "status", limit: 180, windowMs: 60_000 });
  if (limited) return limited;

  const parts = getCountdownParts();
  const opensAt = getTradeOpensAt();

  // Admin runtime override (/admin → Flags, stored in the database):
  // null = the build-baked env flag stands. Clients fetch this route and OR
  // `paused` with their baked value (CountdownTimer), so PAUSING takes effect
  // everywhere without a deployment. UNPAUSING via override only affects
  // consumers that trust this route's value — a client bundle baked with
  // TRADE_PAUSED=true still shows paused until rebuilt.
  const flags = (await getContent("flags").catch(() => null)) as FlagsDoc | null;
  const TRADE_PAUSED =
    flags && flags.tradePaused !== null ? flags.tradePaused : ENV_TRADE_PAUSED;

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
    // Boolean only — never the key itself
    tradingApiConfigured: isTradingApiConfigured(),
    siteFee: {
      ...getPublicSiteFee(),
      appliesTo: "official_plank_widget_only",
      immutable: true,
      note: "Fee bps and recipient are hard-coded server-side and cannot be changed by the client.",
    },
    venuePolicy: TRADE_PAUSED
      ? "STAND BY — trading not live."
      : "Trade in the widget or via the official Uniswap app. Always verify CA.",
    tokenAddress: CONTRACT_ADDRESS,
  });
}

export function POST() {
  return publicJson({ error: "METHOD", message: "Use GET." }, 405);
}
