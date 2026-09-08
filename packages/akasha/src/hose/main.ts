/**
 * The hose: one process, one writer, three families.
 *
 * This is the process the cutover switches to. It owns the tip, it is the only
 * writer of the akasha_* tables, and it reports completeness as a run-list
 * rather than as "the last event we happened to see".
 *
 * THE CUTOVER SEQUENCE this supports, per chain family, one at a time:
 *
 *   1. freeze the old puller for that family
 *   2. boot here at the CURRENT tip; archive_origin = finalized_head, so the
 *      chain is live-complete from now with a coverage run of length zero
 *   3. backfill_tail = archive_origin, then the past worker walks left
 *   4. retire the old puller for that family only
 *
 * Step 2 is why this is safe to start before the past is walked: a chain is
 * honestly "complete from block N" the moment the hose locks it, and says so.
 * It may not say "complete from genesis" until backfill_tail reaches
 * protocol_t0 with a single hash-linked run, which is what
 * `akasha_coverage_health.complete_from_protocol` computes.
 */
import { ArchiveStore } from "./store.ts";
import { PostgresArchiveStore, type SqlClient } from "./pg-store.ts";
import { assertCoverage } from "./coverage.ts";
import { EvmAdapter } from "./adapters/evm.ts";
import { BitcoinAdapter } from "./adapters/bitcoin.ts";
import { HttpTickStream, JsonRpcEvm } from "./rpc/evm.ts";
import { EsploraBitcoinRpc } from "./rpc/bitcoin.ts";
import { GapWorker } from "./gap.ts";
import { BackfillWorker } from "./backfill.ts";
import { EVM_CHAINS, FINALITY_LAG, type ChainId } from "../shared/types.ts";
import { asHex, type Hex } from "../shared/hex.ts";
import { assertPinnedForCutover, protocolT0, PROTOCOL_T0 } from "../shared/protocol-t0.ts";

export interface HoseConfig {
  endpoints: Partial<Record<ChainId, string>>;
  /** Omit to lock at the chain's current tip, which is the cutover default. */
  t0?: Partial<Record<ChainId, { height: number; hash: string }>>;
  /** Chains to actually run. One family at a time is the supported cutover. */
  chains: ChainId[];
  sql?: SqlClient;
  sha256: (b: Uint8Array) => Hex;
  bitcoinHosts?: string[];
}

export class Hose {
  readonly store: ArchiveStore;
  readonly evm = new Map<ChainId, EvmAdapter>();
  bitcoin: BitcoinAdapter | undefined;
  private bitcoinRpc: EsploraBitcoinRpc | undefined;
  private gapWorker: GapWorker | undefined;
  private backfill: BackfillWorker | undefined;
  private cfg: HoseConfig;
  private started = false;

  constructor(cfg: HoseConfig) {
    this.cfg = cfg;
    this.store = cfg.sql ? new PostgresArchiveStore(cfg.sql) : new ArchiveStore();
  }

  private get pg(): PostgresArchiveStore | undefined {
    return this.store instanceof PostgresArchiveStore ? this.store : undefined;
  }

  /**
   * Lock each configured chain at its current tip and start owning it.
   *
   * Refuses any chain without a reviewed protocol_t0. That refusal is the
   * point: a chain whose origin is a guess produces a completeness claim that
   * is a guess, and the UI would then repeat it.
   */
  async boot(): Promise<void> {
    if (this.started) throw new Error("hose already booted: one writer, one boot");
    this.started = true;

    for (const chain of this.cfg.chains) assertPinnedForCutover(chain);
    const restored = await this.pg?.load();

    for (const chain of this.cfg.chains) {
      if (chain === "bitcoin") {
        await this.bootBitcoin();
        continue;
      }
      if (!EVM_CHAINS.includes(chain)) continue;
      await this.bootEvm(chain);
    }

    this.gapWorker = new GapWorker(this.store, this.evm, async (chain, height) => {
      const url = this.cfg.endpoints[chain];
      if (!url) return undefined;
      return new JsonRpcEvm(url, chain).getBlockByNumber(height);
    });

    if (this.pg) {
      const pg = this.pg;
      this.backfill = new BackfillWorker({
        store: pg,
        ingestRange: async (chain, from, to) => {
          // EVM epochs replay through the same adapter that owns the tip, so
          // the past and the present cannot decode differently.
          const adapter = this.evm.get(chain);
          const url = this.cfg.endpoints[chain];
          if (!adapter || !url) return undefined;
          const rpc = new JsonRpcEvm(url, chain);
          let lowest;
          for (let h = to; h >= from; h--) {
            const header = await rpc.getBlockByNumber(h);
            if (!header) continue;
            await adapter.onHead(header);
            lowest = header;
          }
          return lowest;
        },
      });
    }

    if (restored) {
      console.log(
        `[hose] restored tape: ${restored.cursors} cursors, ${restored.headers} headers, ` +
          `${restored.coverage} coverage runs, ${restored.events} events`,
      );
    }
  }

  private async bootEvm(chain: ChainId): Promise<void> {
    const url = this.cfg.endpoints[chain];
    if (!url) {
      console.warn(`[hose] ${chain}: no endpoint configured, skipping`);
      return;
    }
    const rpc = new JsonRpcEvm(url, chain);
    const pinned = this.cfg.t0?.[chain];
    // Default: lock at the CURRENT tip. archive_origin = finalized_head.
    const t0 = pinned ?? (await this.lockAtTip(rpc, chain));
    if (!t0) {
      console.warn(`[hose] ${chain}: could not read a tip to lock at, skipping`);
      return;
    }

    const adapter = new EvmAdapter({
      chain,
      store: this.store,
      rpc,
      stream: new HttpTickStream(rpc, 2000),
      t0: { height: t0.height, hash: asHex(t0.hash) },
    });
    this.evm.set(chain, adapter);
    this.initPins(chain, t0.height);
    adapter.start();
    console.log(`[hose] ${chain}: locked at ${t0.height}, protocol_t0 ${protocolT0(chain)}`);
  }

  private async bootBitcoin(): Promise<void> {
    const rpc = new EsploraBitcoinRpc({ hosts: this.cfg.bitcoinHosts });
    this.bitcoinRpc = rpc;
    this.bitcoin = new BitcoinAdapter({ store: this.store, rpc, sha256: this.cfg.sha256 });

    const pinned = this.cfg.t0?.bitcoin;
    let height: number;
    let hash: string;
    if (pinned) {
      height = pinned.height;
      hash = pinned.hash;
    } else {
      hash = await rpc.getBestBlockHash();
      const header = await rpc.getBlockHeader(hash);
      if (!header) throw new Error("bitcoin: could not read the tip header to lock at");
      height = header.height;
    }

    const existing = this.store.getCursor("bitcoin");
    if (!existing) {
      this.store.putCursor({
        chain: "bitcoin",
        t0Hash: asHex(hash),
        t0Height: height,
        tipHash: asHex(hash),
        tipHeight: height,
        finalizedHash: asHex(hash),
        finalizedHeight: height,
        streamAlive: false,
        streamKind: "zmq",
      });
      this.store.putHeader({
        chain: "bitcoin",
        height,
        hash: asHex(hash),
        parentHash: asHex(hash),
      });
    }
    this.initPins("bitcoin", height);
    console.log(
      `[hose] bitcoin: locked at ${height}, protocol_t0 ${protocolT0("bitcoin")} ` +
        `(${PROTOCOL_T0.bitcoin.because.split(".")[0]})`,
    );
  }

  /**
   * The block a chain is locked at on cutover.
   *
   * Prefers the node's own `finalized` tag: locking at an unfinalized tip
   * means archive_origin can itself be reorged out, and an origin that moves
   * is not an origin. Falls back to tip-minus-lag for chains whose node does
   * not serve the tag.
   */
  private async lockAtTip(
    rpc: JsonRpcEvm,
    chain: ChainId,
  ): Promise<{ height: number; hash: string } | undefined> {
    const finalized = await rpc.getBlockByNumber("finalized").catch(() => undefined);
    if (finalized) return { height: finalized.height, hash: finalized.hash };
    const lag = FINALITY_LAG[chain] ?? 0;
    const n = await rpc.getBlockNumber().catch(() => undefined);
    if (typeof n !== "number") return undefined;
    const header = await rpc.getBlockByNumber(Math.max(0, n - lag));
    return header ? { height: header.height, hash: header.hash } : undefined;
  }

  /** archive_origin and backfill_tail both start at the locked block. */
  private initPins(chain: ChainId, height: number): void {
    const pg = this.pg;
    if (!pg) return;
    pg.setProtocolT0(chain, protocolT0(chain));
    if (pg.getBackfillTail(chain) === undefined) {
      // Seed directly: setBackfillTail only moves left, so the first value
      // cannot be installed through it.
      pg.setBackfillTail(chain, height + 1);
      pg.setBackfillTail(chain, height);
    }
  }

  /** One turn of the present-repair queue. */
  async repairTick(): Promise<boolean> {
    return (await this.gapWorker?.step()) ?? false;
  }

  /** One epoch of the past. */
  async backfillTick(): Promise<unknown> {
    return this.backfill?.step(this.cfg.chains);
  }

  /** Poll Bitcoin's tip and ingest the path. */
  async bitcoinTick(): Promise<{ ingested: string[]; disconnected: string[] } | undefined> {
    if (!this.bitcoin) return undefined;
    const cursor = this.store.getCursor("bitcoin");
    return this.bitcoin.onWake(cursor?.tipHash ?? null);
  }

  /** Persist everything queued. Must run before reading completeness. */
  async flush(): Promise<number> {
    return (await this.pg?.flush()) ?? 0;
  }

  health(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      durable: !!this.pg,
      pendingWrites: this.pg?.pendingWrites ?? 0,
      lastWriteError: this.pg?.lastError()?.message ?? null,
      bitcoinHostFailures: this.bitcoinRpc
        ? Object.fromEntries(this.bitcoinRpc.hostFailures)
        : undefined,
      bitcoinSourceDisagreements: this.bitcoinRpc?.disagreementsSeen ?? 0,
      chains: {} as Record<string, unknown>,
    };
    const chains = out.chains as Record<string, unknown>;
    for (const chain of this.store.cursors.keys()) {
      const coverage = assertCoverage(this.store, chain);
      const tail = this.pg?.getBackfillTail(chain);
      const t0 = protocolT0(chain);
      chains[chain] = {
        ...coverage,
        protocolT0: t0,
        backfillTail: tail ?? null,
        // The ONLY sentence the UI may promote to "complete from genesis".
        completeFromProtocol: tail !== undefined && tail <= t0 && coverage.ok,
        // Until then, this is the honest one.
        completeFrom: coverage.expectedFrom,
      };
    }
    return out;
  }
}

// --- process entry ---------------------------------------------------------

async function makeSql(): Promise<SqlClient | undefined> {
  if (!process.env.PGHOST && !process.env.DATABASE_URL) return undefined;
  const { Pool } = await import("pg");
  const pool = new Pool(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, max: 2 }
      : {
          host: process.env.PGHOST,
          port: Number(process.env.PGPORT ?? 5432),
          database: process.env.PGDATABASE,
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          max: 2,
          application_name: "akasha-hose",
        },
  );
  return { query: (text, values) => pool.query(text, values) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chains = (process.env.AKASHA_CHAINS ?? "bitcoin")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean) as ChainId[];

  const { createHash } = await import("node:crypto");
  const sql = await makeSql();
  if (!sql) {
    console.error(
      "[hose] refusing to start without a database: an in-memory tape forgets on restart, " +
        "which is not an archive. Set PGHOST/PGDATABASE/PGUSER/PGPASSWORD or DATABASE_URL.",
    );
    process.exit(2);
  }

  const hose = new Hose({
    chains,
    endpoints: {
      ethereum: process.env.AKASHA_RPC_ETHEREUM,
      base: process.env.AKASHA_RPC_BASE,
      optimism: process.env.AKASHA_RPC_OPTIMISM,
      polygon: process.env.AKASHA_RPC_POLYGON,
      arbitrum: process.env.AKASHA_RPC_ARBITRUM,
      bsc: process.env.AKASHA_RPC_BSC,
      avalanche: process.env.AKASHA_RPC_AVALANCHE,
      zora: process.env.AKASHA_RPC_ZORA,
    },
    sql,
    sha256: (b) => `0x${createHash("sha256").update(b).digest("hex")}` as Hex,
  });

  await hose.boot();
  console.log(`[hose] owning tip for: ${chains.join(", ")}`);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[hose] ${sig}: flushing tape before exit`);
    await hose.flush().catch((e) => console.error("[hose] final flush failed", e));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const tick = async () => {
    if (stopping) return;
    try {
      if (chains.includes("bitcoin")) await hose.bitcoinTick();
      await hose.repairTick();
      await hose.backfillTick();
      await hose.flush();
    } catch (e) {
      // A tick that throws must not kill the process: the next tick retries,
      // and unflushed writes stay queued rather than being dropped.
      console.error("[hose] tick failed", e instanceof Error ? e.message : e);
    }
  };
  setInterval(() => void tick(), Number(process.env.AKASHA_TICK_MS ?? 15_000));
  setInterval(
    () => console.log("[hose] health", JSON.stringify(hose.health())),
    Number(process.env.AKASHA_HEALTH_MS ?? 60_000),
  );
  await tick();
}
