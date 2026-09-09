/**
 * The durable tape.
 *
 * `ArchiveStore` is synchronous by design -- the adapters call it inside hot
 * decode loops and an await on every `putEvent` would serialise block ingest
 * behind network latency. Postgres is not synchronous. So this is a
 * WRITE-THROUGH store: memory stays the read model, and every mutation is
 * appended to a durable queue that a background flush drains in order.
 *
 * WHAT THAT BUYS AND WHAT IT COSTS
 * --------------------------------
 * Buys: the tape survives a restart, and reads stay synchronous so no adapter
 * changes shape.
 *
 * Costs: a crash between a mutation and its flush loses that mutation. This is
 * survivable ONLY because of what the tape is -- coverage is a run-list, so a
 * lost write reopens a hole, and a hole is a first-class object the gap worker
 * absorbs. A lost write degrades to "not yet covered", never to "covered but
 * wrong". That property is the whole reason this design is allowed to be
 * asynchronous, and it is why `flush()` must run before any code reads
 * `complete_from_protocol`.
 *
 * THE WRITER RULE. One process. The tables are named akasha_* so a second
 * writer is visible in the database, not just in a comment. Two writers on a
 * tape is worse than the vendor ceiling it replaces: a tape with a second
 * author cannot be replayed by a stranger.
 */
import { ArchiveStore } from "./store.ts";
import { PROTOCOL_T0 } from "../shared/protocol-t0.ts";
import type {
  Artifact,
  ChainCursor,
  ChainEvent,
  ChainId,
  CoverageRun,
  Gap,
  Header,
} from "../shared/types.ts";
import type { Hex } from "../shared/hex.ts";

/** Minimal driver surface, so this file does not depend on a pg build. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

type Op = { sql: string; values: unknown[] };

const hexToBuf = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
const bufToHex = (b: unknown): `0x${string}` =>
  `0x${Buffer.isBuffer(b) ? b.toString("hex") : String(b ?? "")}` as `0x${string}`;

export class PostgresArchiveStore extends ArchiveStore {
  private sql: SqlClient;
  private pending: Op[] = [];
  private failed: Error | undefined;
  /** Protocol origins, per chain. Never moved by a worker. */
  readonly protocolT0 = new Map<ChainId, number>();
  private backfillTail = new Map<ChainId, number>();

  constructor(sql: SqlClient) {
    super();
    this.sql = sql;
  }

  private enqueue(sql: string, values: unknown[]): void {
    this.pending.push({ sql, values });
  }

  /** Pending durable writes not yet flushed. Exposed for health reporting. */
  get pendingWrites(): number {
    return this.pending.length;
  }

  /**
   * Drain the queue in order.
   *
   * Order matters: a coverage run must not land before the events it counts,
   * or a reader between the two writes sees a covered range with no content.
   * On failure the batch is put back so the next flush retries rather than
   * silently dropping tape.
   */
  async flush(): Promise<number> {
    if (this.pending.length === 0) return 0;
    const batch = this.pending;
    this.pending = [];
    let done = 0;
    try {
      for (const op of batch) {
        await this.sql.query(op.sql, op.values);
        done++;
      }
    } catch (e) {
      // Un-drained remainder goes back at the FRONT: the tape is ordered.
      this.pending = [...batch.slice(done), ...this.pending];
      this.failed = e instanceof Error ? e : new Error(String(e));
      throw this.failed;
    }
    return done;
  }

  lastError(): Error | undefined {
    return this.failed;
  }

  // --- mutations: memory first (so reads stay sync), then durable ----------

  override putCursor(c: ChainCursor): void {
    super.putCursor(c);
    // protocol_t0 comes from the reviewed constant, NEVER from the cursor.
    //
    // This used to fall back to `c.t0Height`, which is the block the chain was
    // locked at. Because bootBitcoin writes a cursor before the pin is
    // installed, that fallback stamped the CURRENT TIP as the protocol origin
    // -- and `complete_from_protocol` is `backfill_tail <= protocol_t0`, so a
    // freshly booted chain would have declared itself complete from genesis
    // while holding one block. A forged completeness certificate, produced by
    // a convenience default.
    //
    // Falling back to the shipped constant keeps the write honest even if the
    // caller forgot to set the pin, and `assertPinnedForCutover` still refuses
    // any chain whose constant is a placeholder.
    const t0 = this.protocolT0.get(c.chain) ?? PROTOCOL_T0[c.chain].height;
    const tail = this.backfillTail.get(c.chain) ?? c.t0Height;
    this.enqueue(
      `INSERT INTO akasha_cursor
         (chain, protocol_t0, t0_hash, t0_height, tip_hash, tip_height,
          finalized_hash, finalized_height, backfill_tail, stream_alive, stream_kind, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (chain) DO UPDATE SET
         tip_hash = EXCLUDED.tip_hash,
         tip_height = EXCLUDED.tip_height,
         finalized_hash = EXCLUDED.finalized_hash,
         finalized_height = EXCLUDED.finalized_height,
         stream_alive = EXCLUDED.stream_alive,
         stream_kind = EXCLUDED.stream_kind,
         updated_at = NOW()`,
      [
        c.chain, t0, hexToBuf(c.t0Hash), c.t0Height,
        hexToBuf(c.tipHash), c.tipHeight,
        hexToBuf(c.finalizedHash), c.finalizedHeight,
        tail, c.streamAlive, c.streamKind,
      ],
    );
  }

  override putHeader(h: Header): void {
    super.putHeader(h);
    this.enqueue(
      `INSERT INTO akasha_header (chain, hash, parent_hash, height, logs_bloom, receipts_root)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (chain, hash) DO NOTHING`,
      [
        h.chain, hexToBuf(h.hash), hexToBuf(h.parentHash), h.height,
        h.logsBloom ? hexToBuf(h.logsBloom) : null,
        h.receiptsRoot ? hexToBuf(h.receiptsRoot) : null,
      ],
    );
  }

  /**
   * Correct a header's parent hash in place.
   *
   * putHeader is deliberately ON CONFLICT DO NOTHING -- a header is immutable
   * once seen, and re-writing one on every re-walk would be pure churn. That
   * is right for the normal path and WRONG for a repair: the lock block was
   * written at boot with `parentHash = its own hash`, a placeholder, and
   * DO NOTHING means no amount of re-writing the correct value would ever
   * replace it. The repair would have looked like it worked (the in-memory
   * store updates) while the durable row stayed poisoned.
   *
   * Narrow on purpose: it only ever replaces a SELF-PARENT, which no real
   * non-genesis block has. A general "update any parent hash" would be a way
   * to rewrite history.
   */
  repairSelfParent(chain: ChainId, hash: Hex, parentHash: Hex): void {
    super.putHeader({ chain, hash, parentHash, height: this.getHeader(chain, hash)?.height ?? 0 });
    this.enqueue(
      `UPDATE akasha_header SET parent_hash = $3
        WHERE chain = $1 AND hash = $2 AND parent_hash = $2`,
      [chain, hexToBuf(hash), hexToBuf(parentHash)],
    );
  }

  override putEvent(e: ChainEvent): boolean {
    const inserted = super.putEvent(e);
    if (!inserted) return false; // already on the tape: do not double-write
    this.enqueue(
      `INSERT INTO akasha_event
         (chain, block_hash, loc, height, tx_hash, kind, contract_or_program,
          token_or_inscription, from_addr, to_addr, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (chain, block_hash, loc) DO NOTHING`,
      [
        e.chain, hexToBuf(e.blockHash), e.loc, e.height, hexToBuf(e.txHash),
        e.kind, e.contractOrProgram, e.tokenOrInscription,
        e.fromAddr, e.toAddr, JSON.stringify(e.raw ?? {}),
      ],
    );
    return true;
  }

  override deleteEventsByHashes(chain: ChainId, hashes: string[]): number {
    const n = super.deleteEventsByHashes(chain, hashes);
    if (hashes.length > 0) {
      // Delete by HASH. A height-scoped delete would take a same-height
      // sibling on the surviving branch with the orphan.
      this.enqueue(
        `DELETE FROM akasha_event WHERE chain = $1 AND block_hash = ANY($2::bytea[])`,
        [chain, hashes.map(hexToBuf)],
      );
    }
    return n;
  }

  override putArtifact(a: Artifact): void {
    super.putArtifact(a);
    this.enqueue(
      `INSERT INTO akasha_artifact
         (id, chain, kind, genesis_hash, genesis_loc, first_hash, first_height)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [
        a.id, a.chain, a.kind,
        hexToBuf(a.genesisEvent.blockHash), a.genesisEvent.loc,
        hexToBuf(a.firstHash), a.firstHeight,
      ],
    );
  }

  override putCoverage(run: CoverageRun): void {
    super.putCoverage(run);
    this.enqueue(
      `INSERT INTO akasha_coverage_run
         (chain, from_height, to_height, to_hash, event_count, artifact_count, receipt_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (chain, from_height) DO UPDATE SET
         to_height = EXCLUDED.to_height,
         to_hash = EXCLUDED.to_hash,
         event_count = EXCLUDED.event_count,
         artifact_count = EXCLUDED.artifact_count,
         receipt_digest = EXCLUDED.receipt_digest`,
      [
        run.chain, run.fromHeight, run.toHeight, hexToBuf(run.toHash),
        run.eventCount, run.artifactCount, hexToBuf(run.receiptDigest),
      ],
    );
  }

  override enqueueGap(
    g: Omit<Gap, "enqueuedAt" | "attempts"> & Partial<Pick<Gap, "enqueuedAt" | "attempts">>,
  ): void {
    super.enqueueGap(g);
    this.enqueue(
      `INSERT INTO akasha_gap_queue (chain, from_height, to_height, reason, artifact_id, attempts)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [g.chain, g.fromHeight, g.toHeight, g.reason, g.artifactId ?? null, g.attempts ?? 0],
    );
  }

  // --- pins the in-memory store has no concept of --------------------------

  setProtocolT0(chain: ChainId, height: number): void {
    this.protocolT0.set(chain, height);
  }

  getBackfillTail(chain: ChainId): number | undefined {
    return this.backfillTail.get(chain);
  }

  /**
   * Move the tail LEFT. Refuses to move right, because a tail that can advance
   * forward would let a chain claim history it dropped.
   */
  setBackfillTail(chain: ChainId, height: number): boolean {
    const cur = this.backfillTail.get(chain);
    if (cur !== undefined && height >= cur) return false;
    this.backfillTail.set(chain, height);
    this.enqueue(`UPDATE akasha_cursor SET backfill_tail = $2, updated_at = NOW() WHERE chain = $1`, [
      chain,
      height,
    ]);
    return true;
  }

  /**
   * Rebuild the read model from the tape. Called once at boot so a restart
   * resumes instead of re-walking from the protocol origin.
   */
  async load(): Promise<{ cursors: number; headers: number; coverage: number; events: number }> {
    const cur = await this.sql.query(`SELECT * FROM akasha_cursor`);
    for (const r of cur.rows) {
      const chain = String(r.chain) as ChainId;
      super.putCursor({
        chain,
        t0Hash: bufToHex(r.t0_hash),
        t0Height: Number(r.t0_height),
        tipHash: bufToHex(r.tip_hash),
        tipHeight: Number(r.tip_height),
        finalizedHash: bufToHex(r.finalized_hash),
        finalizedHeight: Number(r.finalized_height),
        streamAlive: false, // never trust a persisted liveness bit across a restart
        streamKind: String(r.stream_kind) as ChainCursor["streamKind"],
      });
      this.protocolT0.set(chain, Number(r.protocol_t0));
      this.backfillTail.set(chain, Number(r.backfill_tail));
    }

    const hdr = await this.sql.query(
      `SELECT chain, hash, parent_hash, height FROM akasha_header
        ORDER BY chain, height DESC LIMIT 10000`,
    );
    for (const r of hdr.rows) {
      super.putHeader({
        chain: String(r.chain) as ChainId,
        hash: bufToHex(r.hash),
        parentHash: bufToHex(r.parent_hash),
        height: Number(r.height),
      });
    }

    const cov = await this.sql.query(`SELECT * FROM akasha_coverage_run`);
    for (const r of cov.rows) {
      super.putCoverage({
        chain: String(r.chain) as ChainId,
        fromHeight: Number(r.from_height),
        toHeight: Number(r.to_height),
        toHash: bufToHex(r.to_hash),
        eventCount: Number(r.event_count),
        artifactCount: Number(r.artifact_count),
        receiptDigest: bufToHex(r.receipt_digest),
      });
    }

    const ev = await this.sql.query(`SELECT COUNT(*)::bigint AS n FROM akasha_event`);
    return {
      cursors: cur.rows.length,
      headers: hdr.rows.length,
      coverage: cov.rows.length,
      events: Number(ev.rows[0]?.n ?? 0),
    };
  }
}
