/**
 * Solana adapter: a CLOSED program set, never a mint catalog.
 *
 * The distinction that keeps this from becoming the catalog again: we
 * subscribe to a fixed, versioned list of PROTOCOL programs, not to a list of
 * collections. That list changes only when Solana ships a new NFT standard,
 * and it is reviewable in one diff. A collection list changes every minute
 * and is somebody else's business decision.
 *
 * COMPLETENESS IS SLOT ARITHMETIC, NOT SUBSCRIPTION HEALTH
 * --------------------------------------------------------
 * `programSubscribe` is a hint. It drops, it needs validator flags, and busy
 * programs overrun it. So the tape's completeness is "every slot in
 * [t0, finalized] was ingested", and a hole is a gap to fill -- exactly the
 * same shape as EVM, so one repair path serves both.
 */
import type { ChainCursor, ChainEvent, StreamKind } from "../../shared/types.ts";
import type { ArchiveStore } from "../store.ts";

/**
 * The closed protocol surface. Adding an entry is a deliberate act; this is
 * the Solana analogue of the EVM topic0 list.
 */
export const SOLANA_PROGRAMS = {
  tokenMetadata: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  bubblegum: "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY",
  mplCore: "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
} as const;

export const SOLANA_PROGRAM_IDS: string[] = Object.values(SOLANA_PROGRAMS);

export interface SolanaSlotBlock {
  slot: number;
  blockhash: string;
  parentSlot: number;
  /** Instructions already filtered to the program set by the caller. */
  instructions: Array<{
    programId: string;
    index: number;
    txSignature: string;
    accounts: string[];
    kind: "sol_mint" | "mpl_collection" | "mpl_verify";
    mint: string;
    authority: string;
  }>;
}

export interface SolanaRpc {
  getSlot(commitment: "confirmed" | "finalized"): Promise<number>;
  getBlock(slot: number): Promise<SolanaSlotBlock | null>;
}

export interface SolanaAdapterOpts {
  store: ArchiveStore;
  rpc: SolanaRpc;
  /** Wall clock, injected so tests are deterministic. */
  now?: () => number;
}

export class SolanaAdapter {
  private store: ArchiveStore;
  private rpc: SolanaRpc;
  private now: () => number;
  /** Slots we have actually ingested; the completeness object for this chain. */
  private seenSlots = new Set<number>();

  constructor(opts: SolanaAdapterOpts) {
    this.store = opts.store;
    this.rpc = opts.rpc;
    this.now = opts.now ?? Date.now;
  }

  streamKind(): StreamKind {
    return "sol_program";
  }

  /**
   * Ingest one slot. Returns the events written, so a caller can assert that
   * an independently-parsed block yields the same set.
   */
  async ingestSlot(slot: number): Promise<ChainEvent[]> {
    const block = await this.rpc.getBlock(slot);
    if (!block) return [];

    this.store.putHeader({
      chain: "solana",
      height: block.slot,
      hash: block.blockhash as `0x${string}`,
      parentHash: String(block.parentSlot) as `0x${string}`,
    });

    const written: ChainEvent[] = [];
    for (const ix of block.instructions) {
      if (!SOLANA_PROGRAM_IDS.includes(ix.programId)) continue; // closed set
      const ev: ChainEvent = {
        chain: "solana",
        blockHash: block.blockhash as `0x${string}`,
        height: block.slot,
        loc: ix.index,
        txHash: ix.txSignature as `0x${string}`,
        kind: ix.kind,
        contractOrProgram: ix.programId,
        tokenOrInscription: ix.mint,
        fromAddr: "",
        toAddr: ix.authority,
        raw: { accounts: ix.accounts },
      };
      if (this.store.putEvent(ev)) written.push(ev);

      // A mint or a verified-collection instruction is an ANNOUNCEMENT: the
      // artifact exists from this slot onward, with this instruction as its
      // genesis witness.
      if (ix.kind === "sol_mint" || ix.kind === "mpl_verify") {
        this.store.putArtifact({
          id: `solana:${ix.mint}`,
          chain: "solana",
          kind: "sol_mint",
          genesisEvent: { blockHash: block.blockhash as `0x${string}`, loc: ix.index },
          firstHash: block.blockhash as `0x${string}`,
          firstHeight: block.slot,
        });
      }
    }

    this.seenSlots.add(slot);
    return written;
  }

  /**
   * Holes in [from, to] that were never ingested. This is the ONLY way a
   * Solana gap is created -- there is no path that enqueues a range because a
   * collection looked stale.
   */
  missingSlots(from: number, to: number, limit = 512): number[] {
    const out: number[] = [];
    for (let s = from; s <= to && out.length < limit; s++) {
      if (!this.seenSlots.has(s)) out.push(s);
    }
    return out;
  }

  markSeen(slot: number): void {
    this.seenSlots.add(slot);
  }

  /** Advance finality from a follower; the subscription never sets this. */
  async advanceFinalized(cursor: ChainCursor): Promise<ChainCursor> {
    const finalized = await this.rpc.getSlot("finalized");
    if (finalized <= cursor.finalizedHeight) return cursor;
    const next: ChainCursor = {
      ...cursor,
      finalizedHeight: finalized,
      finalizedHash: cursor.tipHash,
      streamAlive: this.missingSlots(cursor.t0Height, finalized, 1).length === 0,
    };
    this.store.putCursor(next);
    return next;
  }
}
