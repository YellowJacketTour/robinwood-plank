/**
 * $PLANK supply, read from the chain.
 *
 * This is the multiplicand behind every valuation figure on /trade, so it is
 * read from `totalSupply()` on the token contract rather than trusted from an
 * aggregator. See lib/plank-valuation.ts for the full write-up of WHICH
 * supply basis the UI publishes and why — that decision rests directly on the
 * three reads this module performs.
 *
 * Cost discipline (CONTRIBUTING.md, "Chain reads and provider budget"):
 *
 * - Every read goes through `ethCallMany` in lib/market/fetch-rpc.ts, so it
 *   is covered by lib/market/rpc-cache.ts — the app's only spend limiter.
 * - All three calls ride in ONE batched HTTP round-trip.
 * - There is no interval here and no interval anywhere upstream of it that
 *   reaches the chain. `totalSupply()` is effectively immutable (one
 *   constructor mint, ownership renounced, burn-only), so it is cached for
 *   six hours — far longer than rpc-cache's 5s `eth_call` TTL, which exists
 *   to collapse polling bursts and is much too short for a static value.
 * - A whole-page refresh therefore costs zero chain reads almost always: the
 *   price ticks from GeckoTerminal, the supply comes out of this cache.
 *
 * Six hours also bounds how stale the concentration disclosure can be. The
 * supply-recipient balance CAN move (it is an unlocked wallet — that is the
 * entire point of disclosing it), so the snapshot timestamp is returned and
 * rendered rather than presented as live.
 */

import { BURN_ADDRESS, CONTRACT_ADDRESS, PLANK_SUPPLY_RECIPIENT, TOKEN } from "@/lib/constants";
import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";
import { ethCallMany } from "@/lib/market/fetch-rpc";
import { baseUnitsToTokens } from "@/lib/plank-valuation";

/** `totalSupply()` */
const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";
/** `balanceOf(address)` */
const SELECTOR_BALANCE_OF = "0x70a08231";

function balanceOfCalldata(holder: string): string {
  return SELECTOR_BALANCE_OF + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export type PlankSupply = {
  /** Whole tokens from `totalSupply()`. */
  totalSupply: number;
  /** Exact base-unit string — the number a reader can diff against a block explorer. */
  totalSupplyRaw: string;
  /**
   * Tokens sitting at the conventional burn sink. Still counted by
   * `totalSupply()`, so a non-zero value here would mean total supply
   * overstates what is actually outstanding.
   */
  burnAddressBalance: number;
  /** Balance of the constructor's hard-coded mint target. */
  supplyRecipientBalance: number;
  /** That address, echoed so the UI never hard-codes it in copy. */
  supplyRecipient: string;
  fetchedAt: number;
  stale?: boolean;
};

const CACHE_TTL_SEC = 6 * 60 * 60;
const LAST_GOOD_TTL_SEC = 30 * 24 * 60 * 60;
const CACHE_KEY = `plank:supply:v1:${CONTRACT_ADDRESS}`;
const LAST_GOOD_KEY = `plank:supply:last-good:v1:${CONTRACT_ADDRESS}`;

const memCache = new Map<string, { at: number; data: PlankSupply }>();
const memLastGood = new Map<string, PlankSupply>();

function decodeUint256(hex: string | undefined): bigint {
  if (!hex || hex === "0x") {
    throw new Error("empty eth_call result decoding uint256");
  }
  return BigInt(hex);
}

async function fetchSupplyFresh(): Promise<PlankSupply> {
  const [totalHex, burnHex, recipientHex] = await ethCallMany([
    { to: CONTRACT_ADDRESS, data: SELECTOR_TOTAL_SUPPLY },
    { to: CONTRACT_ADDRESS, data: balanceOfCalldata(BURN_ADDRESS) },
    { to: CONTRACT_ADDRESS, data: balanceOfCalldata(PLANK_SUPPLY_RECIPIENT) },
  ]);

  const totalRaw = decodeUint256(totalHex);
  // BigInt(0), not `0n` — see the note in lib/plank-valuation.ts (TS2737).
  if (totalRaw <= BigInt(0)) {
    // A zero total supply would make FDV $0 and every derived percentage a
    // division by zero. Far more likely a bad RPC response than a real event.
    throw new Error("totalSupply() returned 0 — refusing to publish a valuation from it");
  }

  // TOKEN.decimals is 18, confirmed against the verified source, whose
  // decimals() is `public pure override returns (uint8) { return 18; }` — a
  // constant, so reading it every six hours would be pure waste.
  const decimals = TOKEN.decimals;

  return {
    totalSupply: baseUnitsToTokens(totalRaw, decimals),
    totalSupplyRaw: totalRaw.toString(),
    burnAddressBalance: baseUnitsToTokens(decodeUint256(burnHex), decimals),
    supplyRecipientBalance: baseUnitsToTokens(decodeUint256(recipientHex), decimals),
    supplyRecipient: PLANK_SUPPLY_RECIPIENT,
    fetchedAt: Date.now(),
  };
}

/**
 * Cached supply snapshot. Same cache-then-refetch-then-last-good discipline as
 * lib/plank-price.ts: an honest stale supply beats a blank valuation, and
 * supply is the slowest-moving number on the page by a wide margin.
 */
export async function getPlankSupply(): Promise<PlankSupply> {
  const useKv = hasDurableKv();

  if (useKv) {
    try {
      const cached = await kv.get<PlankSupply>(CACHE_KEY);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_SEC * 1000) {
        return cached;
      }
    } catch {
      // fall through to a live read
    }
  } else {
    const hit = memCache.get(CACHE_KEY);
    if (hit && Date.now() - hit.at < CACHE_TTL_SEC * 1000) {
      return hit.data;
    }
  }

  try {
    const fresh = await fetchSupplyFresh();
    if (useKv) {
      await kv.set(CACHE_KEY, fresh, { ex: CACHE_TTL_SEC * 2 }).catch(() => {});
      await kv.set(LAST_GOOD_KEY, fresh, { ex: LAST_GOOD_TTL_SEC }).catch(() => {});
    } else {
      memCache.set(CACHE_KEY, { at: Date.now(), data: fresh });
      memLastGood.set(CACHE_KEY, fresh);
    }
    return fresh;
  } catch (err) {
    if (useKv) {
      try {
        const lastGood = await kv.get<PlankSupply>(LAST_GOOD_KEY);
        if (lastGood) return { ...lastGood, stale: true };
      } catch {
        // no durable fallback either
      }
    } else {
      const lastGood = memLastGood.get(CACHE_KEY);
      if (lastGood) return { ...lastGood, stale: true };
    }
    throw err;
  }
}
