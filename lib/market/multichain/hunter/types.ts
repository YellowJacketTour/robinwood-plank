/**
 * The Hunter (2026-09-07) -- one engine that goes and gets exactly the
 * slices of any chain it needs, from that chain's own public surfaces,
 * and keeps only what it finds.
 *
 * Owner brief: "an on-server mini super-fast indexer for taking chunks of
 * blockchain data from anything including Solana and Bitcoin ... rather
 * than index entire chains on my storage, we simply hunt and gather all
 * the data and then make plank.love hold all the data we find."
 *
 * The primitives already existed in this codebase, one per chain family,
 * each verified live against the real network with no vendor key:
 *   EVM      eth_getLogs over the multi-vendor public RPC pool
 *            (discovery/rpc-provider-pool.ts, publicnode + drpc + Alchemy)
 *   Solana   getProgramAccounts on marketplace programs (Tensor list state,
 *            Magic Eden M2 trade state) and getSignaturesForAddress
 *   Bitcoin  mempool.space tx / outspends (settlement-first index) and the
 *            from-scratch ord envelope parser
 * What was missing was the kernel: one query shape, one cursor discipline,
 * one adaptive chunk policy, one receipt per run, one sink. Every driver
 * below is a thin wrapper that turns a chain's chunk primitive into
 * Findings; the engine owns everything else.
 *
 * Non-goals, on purpose: no full-chain index, no local node, no vendor
 * key on the critical path. Keyed accelerators (HyperSync, Helius DAS)
 * stay as accelerators for the lanes that already use them.
 */

export type HunterFamily = "evm" | "solana" | "bitcoin";

/** A durable position in a chain's own ordering. */
export type HunterCursor =
  | { kind: "block"; block: number }
  | { kind: "signature"; signature: string | null; slot: number | null }
  | { kind: "ledger-id"; id: number };

export type HunterFinding =
  | {
      kind: "transfer-tally";
      chainSlug: string;
      /** contract (EVM) / collection key -> transfers observed in this chunk */
      tally: Map<string, number>;
      /** Distinct token ids seen per contract; the admission law needs it. */
      distinctTokens: Map<string, number>;
      fromBlock: number;
      toBlock: number;
    }
  | {
      kind: "listing-book";
      chainSlug: string;
      collectionKey: string;
      venue: string;
      listedCount: number;
      floorAtomic: string | null;
      observedAt: string;
    }
  | {
      kind: "settlements";
      chainSlug: string;
      written: number;
    };

/** What a run actually did. Stored on the job so "succeeded" can be told from "succeeded-noop". */
export type HunterReceipt = {
  family: HunterFamily;
  chainSlug: string;
  startedAt: string;
  finishedAt: string;
  sourceCalls: number;
  sourceStatus: "ok" | "rate-limited" | "error" | "no-provider";
  cursorBefore: HunterCursor | null;
  cursorAfter: HunterCursor | null;
  findings: number;
  rowsWritten: number;
  note?: string;
};

export type HunterContext = {
  chainSlug: string;
  /** Wall-clock budget for this run; drivers must return before it. */
  deadline: number;
  signal?: AbortSignal;
  log: (msg: string) => void;
};

export interface HunterDriver {
  family: HunterFamily;
  /** Run ONE bounded chunk from the stored cursor; return findings and the new cursor. */
  hunt(cursor: HunterCursor | null, ctx: HunterContext): Promise<{
    findings: HunterFinding[];
    cursorAfter: HunterCursor | null;
    sourceCalls: number;
    sourceStatus: HunterReceipt["sourceStatus"];
    note?: string;
  }>;
}
