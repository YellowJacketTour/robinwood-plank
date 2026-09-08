/**
 * protocol_t0: the first block in which the event class we archive can exist.
 *
 * NOT chain genesis. Pointing the hose at Bitcoin block 0 or Ethereum block 0
 * indexes a decade of empty matter and never finishes. The origin that matches
 * the archive is the first block where a watched event is even possible.
 *
 * These are constants, reviewed like a consensus parameter. A worker may never
 * move one. Changing a value here is a migration -- every coverage claim
 * downstream is stated relative to it, so moving a pin silently rewrites what
 * "complete" means for that chain.
 *
 * THE FOUR PINS, and who may move each:
 *
 *   protocol_t0       here, by review only        first block the class can exist
 *   archive_origin    set once when the hose      first block held in a run
 *                     first locks a chain
 *   finalized_head    hose only                   covered tip, minus finality lag
 *   backfill_tail     gap worker only, LEFTWARD   lowest block in the run union
 */
import type { ChainId } from "./types.ts";

export interface ProtocolOrigin {
  height: number;
  /** Why this height and not another. Cited, because the number is load-bearing. */
  because: string;
  /** How confident we are that this is exactly right. */
  precision: "exact" | "conservative";
}

/**
 * A `conservative` pin sits at or BEFORE the true origin. That direction is
 * the safe one: too-early costs a bounded walk over empty blocks, while
 * too-late silently omits history and then calls the result complete.
 */
export const PROTOCOL_T0: Record<ChainId, ProtocolOrigin> = {
  bitcoin: {
    height: 767_430,
    because:
      "block of inscription #0 (2022-12-14). Taproot activation at 709,632 is a " +
      "prerequisite, not the origin: there is no envelope to parse before the first one.",
    precision: "exact",
  },
  ethereum: {
    height: 4_605_167,
    because:
      "CryptoKitties deployment window (late 2017), the first widely-deployed ERC-721. " +
      "Conservative: a handful of earlier experimental NFT contracts exist, so this is " +
      "pinned at the start of that window rather than at the first known mint.",
    precision: "conservative",
  },
  // L2s and alt-L1s: the watched log class exists from their own genesis,
  // because each chain launched long after ERC-721 was standard. Zero is the
  // correct and exact origin here -- these are not decade-old chains.
  base: { height: 0, because: "chain launched 2023, long after ERC-721", precision: "exact" },
  optimism: { height: 0, because: "OP mainnet regenesis; ERC-721 predates it", precision: "exact" },
  polygon: { height: 0, because: "PoS chain launched 2020, after ERC-721", precision: "exact" },
  arbitrum: { height: 0, because: "launched 2021, after ERC-721", precision: "exact" },
  bsc: { height: 0, because: "launched 2020, after ERC-721", precision: "exact" },
  avalanche: { height: 0, because: "C-Chain launched 2020, after ERC-721", precision: "exact" },
  zora: { height: 0, because: "launched 2023, after ERC-721", precision: "exact" },
  solana: {
    height: 0,
    because:
      "PLACEHOLDER. The true origin is the deploy slot of the sealed program set " +
      "(Token Metadata / Bubblegum), which must be pinned before Solana is cut over. " +
      "Zero here would walk the entire slot history, so `assertPinnedForCutover` " +
      "refuses this chain until a real slot is supplied.",
    precision: "conservative",
  },
};

/**
 * Chains whose pin is a real, defensible origin rather than a placeholder.
 *
 * Solana is deliberately excluded: its pin is 0 with a comment, and 0 on
 * Solana means "walk every slot ever produced", which is not a backfill plan.
 * Cutting over a chain whose origin is a guess produces a coverage claim that
 * is a guess.
 */
const CUTOVER_READY: ChainId[] = [
  "bitcoin",
  "ethereum",
  "base",
  "optimism",
  "polygon",
  "arbitrum",
  "bsc",
  "avalanche",
  "zora",
];

export function protocolT0(chain: ChainId): number {
  return PROTOCOL_T0[chain].height;
}

/**
 * The gate in front of a cutover. Throws rather than returning false: cutting
 * over an unpinned chain is not a condition to branch on, it is a mistake.
 */
export function assertPinnedForCutover(chain: ChainId): void {
  if (!CUTOVER_READY.includes(chain)) {
    throw new Error(
      `${chain} has no reviewed protocol_t0 (${PROTOCOL_T0[chain].because.split(".")[0]}). ` +
        `Pin a real origin before cutting this chain over: an unpinned chain produces a ` +
        `completeness claim nobody can defend.`,
    );
  }
}

export function isCutoverReady(chain: ChainId): boolean {
  return CUTOVER_READY.includes(chain);
}
