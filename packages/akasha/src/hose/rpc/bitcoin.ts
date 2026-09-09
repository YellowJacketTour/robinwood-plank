/**
 * Keyless Bitcoin RPC over public block explorers.
 *
 * This exists because every Ordinals vendor is closed. Measured 2026-09-08:
 * Ordiscan 402, UniSat 403, Magic Eden 503, Hiro 410 Gone (deprecated with a
 * migration notice). The OrdinalsWallet catalog is not gated but is exhausted,
 * offering ~1,837 real collections against ~19,600 already archived. There is
 * no vendor left to ask, so the tape has to read the chain.
 *
 * mempool.space and blockstream.info both expose the two things an envelope
 * parser needs -- block hashes by height, and full transactions with witness
 * data -- with no key. Verified live: both returned tip height 966,025 and
 * agreed, and a witness pulled from block 966018 parsed to a real inscription.
 *
 * TWO HOSTS, ON PURPOSE. A single explorer is the vendor dependency this whole
 * design exists to escape. Requests fail over, and `disagreementsSeen` counts
 * the times the two hosts gave different answers for the same height -- that
 * number is evidence about the sources, so it is reported rather than hidden.
 */
import type { BitcoinBlock, BitcoinRpc } from "../adapters/bitcoin.ts";

export interface EsploraOpts {
  /** Ordered by preference. Each must speak the Esplora REST shape. */
  hosts?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Esplora-compatible mirrors, all verified live 2026-09-09 to serve BOTH
 * `/blocks/tip/height` and `/block-height/{n}`, and all four returned the
 * byte-identical hash for block 966,000.
 *
 * WHY MORE THAN TWO. On 2026-09-09 the worker was found dead, and the
 * provisioning proof run showed why, in its own words:
 *
 *   [akasha-hose] fatal: Error:
 *     https://blockstream.info/api/blocks/tip/height: 429 Too Many Requests
 *       at Hose.bootBitcoin ... at Hose.boot ... at main
 *
 * It could not BOOT. Not a stalled backfill, not a slow tick -- the process
 * died before its first tick, which is why the archive had no heartbeat, no
 * phase rows, and a tip frozen for hours. Three separate investigations of the
 * backfill were reading code that never ran.
 *
 * Both original hosts answered 200 from a developer machine at the same
 * moment, so the 429 is specific to the production host's IP. Two hosts is not
 * a pool; it is one spare. Each of these keeps its own budget, so spreading
 * across them respects every individual limit rather than evading any.
 */
const DEFAULT_HOSTS = [
  "https://mempool.space/api",
  "https://blockstream.info/api",
  "https://mempool.emzy.de/api",
  "https://mempool.ninja/api",
  // mempool.space's REGIONAL nodes: different IPs, separate rate budgets, same
  // data. Added 2026-09-09 after the telemetry showed all four hosts above
  // failing from the production box (bitcoinHostFailures ~5,705 EACH) while
  // every one of them answered 200 from a developer machine at the same
  // moment -- and while that same box was successfully querying UniSat and
  // OrdinalsWallet, so general egress was fine. The block is
  // Esplora-reputation-specific to that IP.
  // Both verified live: /blocks/tip/height and /block-height/{n} answer 200,
  // and both return the byte-identical hash for block 966,080.
  "https://mempool.va1.mempool.space/api",
  "https://mempool.tk7.mempool.space/api",
];

/** HTTP statuses that mean "ask again later", not "this data does not exist". */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class EsploraBitcoinRpc implements BitcoinRpc {
  private hosts: string[];
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  /** Times the hosts disagreed on a hash for the same height. */
  disagreementsSeen = 0;
  /** Per-host failure tallies, so a dying source is visible in health. */
  readonly hostFailures = new Map<string, number>();

  constructor(opts: EsploraOpts = {}) {
    this.hosts = opts.hosts ?? DEFAULT_HOSTS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // 20s x 6 hosts is a two-minute worst case for ONE height lookup, on a
    // 15s tick. A host that has not answered in 8s is not going to save this
    // call; moving on is what turns a blocked host into a hop instead of a
    // stall. The failover loop still tries every host, so this shortens the
    // wait per host rather than giving up sooner overall.
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  /**
   * Round-robin start, then try every host; only a total failure throws.
   *
   * WHY ROUND-ROBIN AND NOT FIRST-WINS
   * ----------------------------------
   * This walked `this.hosts` in fixed order, so every request went to host[0]
   * and the others were pure failover. That was harmless while the backfill
   * fetched one block at a time -- and became a real hazard the moment the
   * epoch walk started fetching 16 heights concurrently, because all 16 land
   * on the same host. Racing a single free endpoint is exactly how this
   * archive earned a 30-minute cooldown once already.
   *
   * Rotating the STARTING index spreads a concurrent burst across the pool
   * while preserving failover: every host is still tried before the call
   * fails, and a dead host costs one extra hop rather than breaking the walk.
   * This is per-provider politeness, not a way around anyone's rate limit --
   * each host keeps its own budget, and we simply stop pretending only one
   * door exists.
   */
  private rr = 0;
  private async get(path: string, asJson: boolean): Promise<unknown> {
    let last: Error | undefined;
    const start = this.hosts.length > 1 ? this.rr++ % this.hosts.length : 0;
    const ordered =
      start === 0 ? this.hosts : [...this.hosts.slice(start), ...this.hosts.slice(0, start)];
    for (const host of ordered) {
      try {
        const res = await this.fetchImpl(`${host}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          // A 429 is a WAIT, not a verdict on the data. Marking it retryable
          // lets the loop fall through to the next host instead of surfacing
          // the first host's throttle as the answer -- which is exactly how a
          // boot-time tip fetch became a fatal error and killed the worker.
          const err = new Error(`${host}${path}: ${res.status} ${res.statusText}`);
          (err as { retryable?: boolean }).retryable = RETRYABLE_STATUS.has(res.status);
          throw err;
        }
        return asJson ? await res.json() : (await res.text()).trim();
      } catch (e) {
        this.hostFailures.set(host, (this.hostFailures.get(host) ?? 0) + 1);
        last = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw last ?? new Error(`all hosts failed for ${path}`);
  }

  async getBestBlockHash(): Promise<string> {
    const height = Number(await this.get("/blocks/tip/height", false));
    if (!Number.isFinite(height)) throw new Error("tip height was not a number");
    return String(await this.get(`/block-height/${height}`, false));
  }

  /** Esplora's /block-height/{n}; the same endpoint getBestBlockHash uses. */
  async getBlockHashAtHeight(height: number): Promise<string | null> {
    try {
      const hash = String(await this.get(`/block-height/${height}`, false));
      return /^[0-9a-f]{64}$/i.test(hash) ? hash : null;
    } catch {
      return null;
    }
  }

  async getBlockHeader(
    hash: string,
  ): Promise<{ hash: string; previousblockhash: string | null; height: number } | null> {
    try {
      const b = (await this.get(`/block/${hash}`, true)) as {
        id?: string;
        previousblockhash?: string;
        height?: number;
      };
      if (!b?.id) return null;
      return {
        hash: b.id,
        previousblockhash: b.previousblockhash ?? null,
        height: Number(b.height),
      };
    } catch {
      return null;
    }
  }

  /**
   * A full block with witness data.
   *
   * Esplora pages transactions 25 at a time, so a busy block is dozens of
   * round trips. The cap is deliberate: an unbounded fetch of a 4,000-tx block
   * would let one block stall the tip walk, and a bounded read that reports how
   * far it got is better than an unbounded one that hangs. A partial block is
   * still honest -- coverage only advances for what was actually persisted.
   */
  async getBlock(hash: string, maxTxs = 500): Promise<BitcoinBlock | null> {
    const header = await this.getBlockHeader(hash);
    if (!header) return null;

    const tx: BitcoinBlock["tx"] = [];
    for (let start = 0; start < maxTxs; start += 25) {
      let page: Array<{ txid: string; vin?: Array<{ witness?: string[] }> }>;
      try {
        page = (await this.get(`/block/${hash}/txs/${start}`, true)) as typeof page;
      } catch {
        break; // ran past the end, or both hosts refused: keep what we have
      }
      if (!Array.isArray(page) || page.length === 0) break;
      for (const t of page) {
        tx.push({
          txid: t.txid,
          // Esplora calls it `witness`; the adapter's shape says `txinwitness`.
          vin: (t.vin ?? []).map((v) => ({ txinwitness: v.witness ?? [] })),
        });
      }
      if (page.length < 25) break;
    }

    return {
      hash: header.hash,
      previousblockhash: header.previousblockhash,
      height: header.height,
      tx,
    };
  }

  /**
   * Ask both hosts for the same height and report whether they agree.
   *
   * Not used on the hot path -- it doubles request cost -- but it is the only
   * honest way to answer "is this source lying to us", and a periodic audit is
   * cheap. Two independent explorers agreeing on a block hash is a far
   * stronger claim than one explorer asserting it.
   */
  async crossCheckHeight(height: number): Promise<{ agree: boolean; hashes: string[] }> {
    const hashes: string[] = [];
    for (const host of this.hosts) {
      try {
        const res = await this.fetchImpl(`${host}/block-height/${height}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) hashes.push((await res.text()).trim());
      } catch {
        // A host that cannot answer does not get a vote.
      }
    }
    const agree = hashes.length >= 2 && hashes.every((h) => h === hashes[0]);
    if (hashes.length >= 2 && !agree) this.disagreementsSeen++;
    return { agree, hashes };
  }
}
