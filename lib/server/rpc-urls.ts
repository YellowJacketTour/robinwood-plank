import { ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";

/**
 * DEV-ONLY: when NEXT_PUBLIC_DEV_LOCAL_CHAIN=1 the whole app talks to a local
 * Hardhat/anvil node instead of Robinhood Chain, so every RPC list below must
 * short-circuit to that node — otherwise browser reads (inventory pickers,
 * vault stats) would silently answer from the production chain while writes hit
 * the local one. Never set in a real build.
 */
const DEV_LOCAL = process.env.NEXT_PUBLIC_DEV_LOCAL_CHAIN === "1";
const DEV_LOCAL_RPC = process.env.NEXT_PUBLIC_DEV_LOCAL_RPC || "http://127.0.0.1:8545";

/**
 * Ordered RPC list for SERVER-side callers only: the private provider
 * endpoint first (RPC_URL — e.g. a keyed Alchemy URL; the public endpoint
 * is rate-limited and documented "not recommended for production"), then
 * the public fallbacks from ROBINHOOD_RPC_URLS.
 *
 * Never import this from client components — RPC_URL may carry an API key.
 * (If it does leak into a client bundle, process.env.RPC_URL is simply
 * undefined there and the list degrades to the public URLs — the key
 * itself cannot ship because it is not NEXT_PUBLIC_.)
 */
export const SERVER_RPC_URLS: string[] = DEV_LOCAL
  ? [DEV_LOCAL_RPC]
  : Array.from(
      new Set(
        [process.env.RPC_URL?.trim(), ...ROBINHOOD_RPC_URLS].filter(
          (url): url is string => Boolean(url && url.length > 0)
        )
      )
    );

/**
 * Ordered RPC list for the /api/rpc browser proxy — public endpoint FIRST,
 * keyed provider only as fallback. The reverse of SERVER_RPC_URLS, deliberately.
 *
 * That proxy exists solely because the public RPC sends a malformed duplicate
 * `Access-Control-Allow-Origin: *,*` header that browsers reject; it is a CORS
 * shim, not a quality upgrade. Sending browser display reads through the metered
 * provider meant every anonymous visitor's gallery scroll was billed, while a
 * connected wallet would have read the very same public endpoint for free —
 * chain 4663 is registered in wallets with this exact URL, so "route through the
 * wallet" and "route through the public RPC" reach the same node either way.
 *
 * Reads that a decision depends on — ownership checks, order validation,
 * signature verification — keep using SERVER_RPC_URLS. Those must not be at the
 * mercy of a rate-limited public endpoint, and must never be sourced from
 * anything a user could control.
 *
 * Worst case here is a 429 from the public node, which falls through to the
 * keyed provider: the same request we would have made anyway.
 */
/**
 * Free endpoints only — the public Robinhood RPC and the Blockscout eth-rpc
 * bridge. Never the keyed provider.
 *
 * For reads that must not cost anything but should still survive one endpoint
 * failing. Ownership checks behind order validation are the case this exists
 * for: they were posting directly to a single hardcoded public URL with no
 * failover, no coalescing and no metering. Routing them through here keeps them
 * free, adds a second endpoint to fall through to, and lets rpc-cache collapse
 * the duplicate reads a whole-book validation pass generates.
 *
 * Deliberately NOT the keyed provider, even as a last resort: a security read
 * silently escalating onto a metered endpoint under load is how a rate-limit
 * incident turns into a billing one.
 */
export const FREE_RPC_URLS: string[] = DEV_LOCAL
  ? [DEV_LOCAL_RPC]
  : Array.from(new Set(ROBINHOOD_RPC_URLS));

/**
 * True when this URL is the metered provider, i.e. calls to it cost compute
 * units. The public Robinhood endpoints are free, so counting them would make
 * the rpc-usage meter overstate spend and hide the effect of moving traffic off
 * the paid provider.
 */
export function isMeteredRpcUrl(url: string): boolean {
  const keyed = process.env.RPC_URL?.trim();
  return Boolean(keyed && url === keyed);
}

export const CLIENT_PROXY_RPC_URLS: string[] = DEV_LOCAL
  ? [DEV_LOCAL_RPC]
  : Array.from(
      new Set(
        [...ROBINHOOD_RPC_URLS, process.env.RPC_URL?.trim()].filter(
          (url): url is string => Boolean(url && url.length > 0)
        )
      )
    );

/**
 * Ordered RPC list for SERVER-side reads that are display-only — public
 * endpoint FIRST, keyed provider as fallback. Same ordering as
 * CLIENT_PROXY_RPC_URLS, deliberately, but for server code that has no
 * browser proxy to go through (SSR/route handlers reading vault reserves,
 * fee-revenue history, etc.).
 *
 * These are the server-side analog of "gallery scroll" reads: vault stats,
 * fee schedules, trade-history enrichment. Nothing here gates a wallet
 * prompt or a security decision — see SERVER_RPC_URLS above and
 * FREE_RPC_URLS below for those. Falling through to the keyed provider on a
 * public-RPC failure is fine; the worst case is the same request we'd have
 * made anyway, same as the browser proxy's reasoning.
 */
export const SERVER_DISPLAY_RPC_URLS: string[] = DEV_LOCAL
  ? [DEV_LOCAL_RPC]
  : Array.from(
      new Set(
        [...ROBINHOOD_RPC_URLS, process.env.RPC_URL?.trim()].filter(
          (url): url is string => Boolean(url && url.length > 0)
        )
      )
    );
