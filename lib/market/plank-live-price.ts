/**
 * $PLANK/ETH live spot price, read directly from the canonical Uniswap v2
 * pool's own on-chain reserves — zero third-party dependency.
 *
 * This exists specifically for Season 2's prize ETH figure
 * (PlankKothBoard.tsx), which was found (2026-08-26 audit) to be silently
 * riding lib/plank-price.ts's `poolStats.priceEth` -- GeckoTerminal's own
 * derived number, cached 60s server-side on top of the client's own poll
 * interval, so the "live" ETH value could lag the real pool by up to ~90s
 * and was never actually the pair's own live trade value. Reading
 * getReserves() straight from the pool contract is the real trade value,
 * bounded only by RPC latency + this module's own short cache (a few
 * seconds), not a vendor's refresh cadence.
 *
 * Same pool as lib/plank-price.ts's own POOL_ADDRESS, for the same reason
 * documented there: deepest of $PLANK's real pools, the more honest single
 * price reference. Do not point this at a different pool without updating
 * that file's own reasoning too.
 *
 * No real websocket RPC endpoint exists for Robinhood Chain anywhere in
 * this codebase (see lib/mint-contract.ts / lib/server/rpc-urls.ts -- HTTP
 * only), so this is a short-interval on-chain poll, not a push
 * subscription. It is still strictly more "live and real" than the
 * GeckoTerminal path it replaces: every read is the pool's own current
 * reserves, not a third-party's cached derivation of them.
 */
import { ethCallDisplay } from "@/lib/market/fetch-rpc";

const V2_POOL_ADDRESS = "0x01b1BEf6fBA02c846eA5c4Ff59193988B5f86F73";
/** WETH (MARKET_OFFER_CURRENCY) -- same address plank-pools.ts pairs this pool against. */
const WETH_ADDRESS = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const TOKEN0_SELECTOR = "0x0dfe1681"; // token0()
const GET_RESERVES_SELECTOR = "0x0902f1ac"; // getReserves()

function decodeAddress(hex: string): string {
  const clean = hex.replace(/^0x/, "");
  return `0x${clean.slice(-40)}`;
}

function decodeReserves(hex: string): { reserve0: bigint; reserve1: bigint } {
  const clean = hex.replace(/^0x/, "");
  const reserve0 = BigInt(`0x${clean.slice(0, 64)}`);
  const reserve1 = BigInt(`0x${clean.slice(64, 128)}`);
  return { reserve0, reserve1 };
}

/** Pool token ordering never changes post-deploy -- resolved once, reused forever. */
let token0Promise: Promise<string> | null = null;
async function resolveToken0(): Promise<string> {
  if (!token0Promise) {
    token0Promise = ethCallDisplay(V2_POOL_ADDRESS, TOKEN0_SELECTOR)
      .then(decodeAddress)
      .catch((error) => {
        token0Promise = null; // allow retry on a later call
        throw error;
      });
  }
  return token0Promise;
}

const CACHE_TTL_MS = 4_000;
let cache: { at: number; ethPerPlank: number } | null = null;
let inflight: Promise<number> | null = null;

/**
 * ETH per 1 $PLANK, read live from the canonical v2 pool's own reserves.
 * Both tokens are 18-decimal (lib/constants.ts), so the raw reserve ratio
 * is directly the price -- no decimal-normalization needed.
 */
export async function getPlankEthSpotPrice(): Promise<number> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.ethPerPlank;
  if (inflight) return inflight;

  inflight = (async () => {
    const [token0, reservesHex] = await Promise.all([
      resolveToken0(),
      ethCallDisplay(V2_POOL_ADDRESS, GET_RESERVES_SELECTOR),
    ]);
    const { reserve0, reserve1 } = decodeReserves(reservesHex);
    const token0IsWeth = token0.toLowerCase() === WETH_ADDRESS.toLowerCase();
    const [reserveWeth, reservePlank] = token0IsWeth ? [reserve0, reserve1] : [reserve1, reserve0];
    if (reservePlank === BigInt(0)) throw new Error("plank-live-price: zero PLANK reserve");

    // Full precision via BigInt fixed-point, then a single float divide at
    // the end -- avoids the precision loss of dividing two huge bigints as
    // floats directly while $PLANK's reserve is in the trillions of tokens.
    const SCALE = BigInt(1_000_000_000_000); // 1e12
    const scaled = (reserveWeth * SCALE) / reservePlank;
    const ethPerPlank = Number(scaled) / 1e12;

    cache = { at: Date.now(), ethPerPlank };
    return ethPerPlank;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
