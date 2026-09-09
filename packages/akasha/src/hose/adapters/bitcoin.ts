/**
 * Bitcoin adapter: ZMQ is a doorbell, the header walk is the tape.
 *
 * bitcoind's own documentation is explicit that `hashblock`/`rawblock` fire on
 * tip change only, can drop under load, and on a reorg notify the NEW tip
 * without walking you back. So a design that treats the notification stream as
 * the record will silently miss blocks and never know.
 *
 * Here the notification is only a wake-up. Completeness is "every block hash
 * from t0 to best, connected by parent links", which is checkable against any
 * node and survives a dropped socket.
 *
 * WHY THIS ADAPTER IS THE ONE THAT MATTERS
 * ----------------------------------------
 * Measured 2026-09-08: Bitcoin's catalog sources are exhausted or closed
 * (OrdinalsWallet offers ~1,837 real collections against the 19,601 we already
 * hold; Ordiscan 402, Magic Eden 503, UniSat 404). Parsing envelopes from
 * witness data is the only path to Bitcoin existence that no vendor can
 * revoke.
 */
import type { ChainEvent, Header, StreamKind } from "../../shared/types.ts";
import type { Hex } from "../../shared/hex.ts";
import type { ArchiveStore } from "../store.ts";
import { parseEnvelopes, type Inscription } from "./envelope.ts";
import { extendCoverage } from "../coverage.ts";

export interface BitcoinBlock {
  hash: string;
  previousblockhash: string | null;
  height: number;
  tx: Array<{
    txid: string;
    /** Witness stacks per input; tapscript is typically the second-to-last item. */
    vin: Array<{ txinwitness?: string[] }>;
  }>;
}

export interface BitcoinRpc {
  getBestBlockHash(): Promise<string>;
  getBlock(hash: string): Promise<BitcoinBlock | null>;
  getBlockHeader(hash: string): Promise<{ hash: string; previousblockhash: string | null; height: number } | null>;
  /**
   * The hash at a HEIGHT. The forward walk never needs this -- it follows
   * parent links from the tip -- but a backfill walks left through a range
   * of heights and has no parent to follow until it has the block.
   */
  getBlockHashAtHeight?(height: number): Promise<string | null>;
}

export interface BitcoinAdapterOpts {
  store: ArchiveStore;
  rpc: BitcoinRpc;
  sha256: (b: Uint8Array) => Hex;
}

/** Normalise a bitcoind hash (no 0x) to the tape's Hex convention. */
export function toHex(h: string): Hex {
  return (h.startsWith("0x") ? h : `0x${h}`) as Hex;
}

export function fromHex(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = fromHex(hex);
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export class BitcoinAdapter {
  private store: ArchiveStore;
  private rpc: BitcoinRpc;
  private sha256: (b: Uint8Array) => Hex;

  constructor(opts: BitcoinAdapterOpts) {
    this.store = opts.store;
    this.rpc = opts.rpc;
    this.sha256 = opts.sha256;
  }

  streamKind(): StreamKind {
    return "zmq";
  }

  /**
   * The header walk. Given the current tip we hold and the node's best hash,
   * produce the path of blocks to ingest, in order, plus any hashes to
   * disconnect.
   *
   * Handles the reorg case bitcoind will NOT walk back for us: if best's
   * parent is not our tip, climb parents until we reach a header we stored,
   * and treat everything above that ancestor as orphaned.
   */
  async walkPath(
    tipHash: string | null,
    bestHash: string
  ): Promise<{ connect: string[]; disconnect: string[] }> {
    if (tipHash && fromHex(tipHash) === fromHex(bestHash)) {
      return { connect: [], disconnect: [] };
    }

    const connect: string[] = [];
    let cursor: string | null = bestHash;
    // Bounded: a reorg deeper than this is an incident, not a routine walk.
    for (let i = 0; i < 200 && cursor; i++) {
      const stored = this.store.getHeader("bitcoin", toHex(cursor));
      if (stored) break; // common ancestor
      const hdr = await this.rpc.getBlockHeader(cursor);
      if (!hdr) break;
      connect.push(cursor);
      cursor = hdr.previousblockhash;
      if (tipHash && cursor && fromHex(cursor) === fromHex(tipHash)) break;
    }
    connect.reverse();

    // Anything we stored above the ancestor is no longer on the best chain.
    const disconnect: string[] = [];
    if (tipHash && connect.length > 0) {
      const ancestorHeights = new Set(connect.map((h) => h));
      void ancestorHeights;
      const tip = this.store.getHeader("bitcoin", toHex(tipHash));
      if (tip) {
        const firstNew = connect[0]!;
        const firstHdr = await this.rpc.getBlockHeader(firstNew);
        if (firstHdr && tip.height >= firstHdr.height) {
          for (let h = firstHdr.height; h <= tip.height; h++) {
            for (const hdr of this.store.headersAtHeight("bitcoin", h)) {
              if (!connect.some((c) => fromHex(c) === fromHex(hdr.hash))) {
                disconnect.push(hdr.hash);
              }
            }
          }
        }
      }
    }

    return { connect, disconnect };
  }

  /** Parse every envelope in a block and write events plus artifacts. */
  async ingestBlock(hash: string): Promise<{ events: ChainEvent[]; inscriptions: Inscription[] }> {
    const block = await this.rpc.getBlock(hash);
    if (!block) return { events: [], inscriptions: [] };

    const header: Header = {
      chain: "bitcoin",
      height: block.height,
      hash: toHex(block.hash),
      parentHash: toHex(block.previousblockhash ?? "0".repeat(64)),
    };
    this.store.putHeader(header);

    const events: ChainEvent[] = [];
    const all: Inscription[] = [];
    let loc = 0;

    for (const tx of block.tx) {
      for (let vin = 0; vin < tx.vin.length; vin++) {
        const witness = tx.vin[vin]?.txinwitness;
        if (!witness || witness.length < 2) continue;
        // Tapscript is the second-to-last witness item (last is the control block).
        const scriptHex = witness[witness.length - 2];
        if (!scriptHex) continue;

        let found: Inscription[];
        try {
          found = parseEnvelopes(hexToBytes(scriptHex), { revealTxid: tx.txid, inputIndex: vin }, this.sha256);
        } catch {
          continue; // a malformed witness is not a reason to drop the block
        }

        for (const ins of found) {
          all.push(ins);
          const ev: ChainEvent = {
            chain: "bitcoin",
            blockHash: header.hash,
            height: block.height,
            loc: loc++,
            txHash: toHex(tx.txid),
            kind: "envelope",
            contractOrProgram: "ord",
            tokenOrInscription: ins.id,
            fromAddr: "",
            toAddr: "",
            // `parent` rides as RAW so the cluster graph can make it a hard
            // edge later. The adapter never writes clusters itself.
            raw: {
              parent: ins.parent,
              contentType: ins.contentType,
              bodySha256: ins.bodySha256,
              bodyLength: ins.bodyLength,
              inputIndex: ins.inputIndex,
            },
          };
          if (this.store.putEvent(ev)) events.push(ev);

          this.store.putArtifact({
            id: ins.id,
            chain: "bitcoin",
            kind: "inscription",
            genesisEvent: { blockHash: header.hash, loc: ev.loc },
            firstHash: header.hash,
            firstHeight: block.height,
          });
        }
      }
    }

    // RECORD THE RUN. Everything above writes what the block CONTAINED
    // (header, events, artifacts); this writes that the block was COVERED.
    //
    // Bitcoin walked blocks for hours on production with `runs=0`, because
    // `extendCoverage` was called from the EVM adapter only. Real headers,
    // real parsed envelopes, and no record that the range was accounted for
    // -- and since `complete_from_protocol` requires `run_count = 1`, a
    // chain that never records a run can never report completeness at all.
    //
    // It goes here, at the END, so a block that threw on the way through is
    // never claimed as covered. Coverage has to be earned by a completed
    // ingest, not by the attempt.
    extendCoverage(this.store, "bitcoin", block.height, header.hash);

    return { events, inscriptions: all };
  }

  /**
   * One wake-up cycle. The ZMQ notification (or a timer) only triggers this;
   * the node's best hash and the stored headers decide what actually happens.
   */
  async onWake(tipHash: string | null): Promise<{ ingested: string[]; disconnected: string[] }> {
    const best = await this.rpc.getBestBlockHash();
    const { connect, disconnect } = await this.walkPath(tipHash, best);

    if (disconnect.length > 0) {
      // Delete by HASH. Two blocks can share a height; deleting by height
      // leaves orphaned events behind and produces a ghost holder.
      this.store.deleteEventsByHashes("bitcoin", disconnect.map((h) => toHex(h)));
    }

    const ingested: string[] = [];
    for (const h of connect) {
      await this.ingestBlock(h);
      ingested.push(h);
    }
    return { ingested, disconnected: disconnect };
  }
}
