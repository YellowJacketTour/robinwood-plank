import { MARKET_ENABLED } from "@/lib/constants";
import { getContent } from "@/lib/content-store";
import type { FlagsDoc } from "@/lib/content-docs";

/**
 * The emergency stop, applied where trades actually enter the system.
 *
 * WHAT WAS WRONG
 * --------------
 * MARKET_ENABLED and GLOBAL_MARKET_ENABLED were read in page components only.
 * Grepped across all 181 API routes, the only other reference was
 * /api/health echoing their values back.
 *
 * So with the market "off", every order-accepting endpoint kept working. A
 * validly-signed order POSTed straight to /api/market/orders was verified,
 * accepted and stored exactly as before. Anyone who had previously loaded the
 * UI -- or who read the client bundle -- could keep listing and offering
 * against a marketplace the operator believed was closed.
 *
 * If those flags are a launch gate, that behaviour is defensible. If they are
 * an emergency stop -- "something is wrong, halt trading" -- it is not a stop
 * at all, it is a curtain. The ambiguity is the bug: an operator who throws
 * the switch during an incident must not discover afterwards that trading
 * continued.
 *
 * WHY THE LIVE FLAG AND NOT JUST THE ENV VAR
 * ------------------------------------------
 * NEXT_PUBLIC_* is inlined at build time (see lib/constants.ts's own header),
 * so flipping MARKET_ENABLED needs a rebuild and redeploy -- minutes, during
 * an incident, which is the worst possible latency for a stop button. The
 * pages already prefer a live `flags` document from the content store and
 * fall back to the env var; this reads the SAME source in the same order, so
 * there is one switch with one meaning rather than two that can disagree.
 *
 * WHAT IT DOES NOT GATE
 * ---------------------
 * Reads. Halting trade must never blank the site: browsing, archive coverage
 * and existing orders stay visible, because a marketplace that vanishes
 * during an incident tells its users far less than one that says "trading is
 * paused" while still showing them their positions.
 *
 * Nor does it cancel anything already signed. An order living on-chain is not
 * ours to revoke, and pretending otherwise would be a worse lie than the gap
 * this closes.
 */
export interface HaltState {
  halted: boolean;
  /** Which source decided, so an operator can tell why trading is closed. */
  source: "live-flag" | "build-flag";
}

/**
 * Is trading open right now?
 *
 * FAILS CLOSED ON THE LIVE FLAG, OPEN ON ITS ABSENCE. A content store that is
 * unreachable must not halt a healthy market -- that would turn every storage
 * blip into an outage. But a flag that is present and explicitly false must
 * always win, because that is an operator deliberately closing the door.
 */
export async function tradingHalt(): Promise<HaltState> {
  const flags = (await getContent("flags").catch(() => null)) as FlagsDoc | null;
  if (flags && typeof flags.marketEnabled === "boolean") {
    return { halted: !flags.marketEnabled, source: "live-flag" };
  }
  return { halted: !MARKET_ENABLED, source: "build-flag" };
}

/**
 * The response body a halted write path returns.
 *
 * 503 with Retry-After, deliberately: this is a temporary, operator-imposed
 * pause, and a client that treats it as permanent (4xx) would stop retrying
 * and require a manual reload once trading resumes. The message says what
 * happened in plain words -- an order rejected without explanation is
 * indistinguishable from a broken site.
 */
export const HALT_BODY = {
  error: "TRADING_PAUSED",
  message: "Trading is paused right now. Existing orders are unaffected.",
} as const;

export const HALT_STATUS = 503;
export const HALT_HEADERS = { "Retry-After": "120", "Cache-Control": "no-store" } as const;
