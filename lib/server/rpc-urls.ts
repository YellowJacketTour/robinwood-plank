import { ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";

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
export const SERVER_RPC_URLS: string[] = Array.from(
  new Set(
    [process.env.RPC_URL?.trim(), ...ROBINHOOD_RPC_URLS].filter(
      (url): url is string => Boolean(url && url.length > 0)
    )
  )
);
