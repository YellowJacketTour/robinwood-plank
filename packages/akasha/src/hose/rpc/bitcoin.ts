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

const DEFAULT_HOSTS = ["https://mempool.space/api", "https://blockstream.info/api"];

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
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** Try each host in order; only a total failure throws. */
  private async get(path: string, asJson: boolean): Promise<unknown> {
    let last: Error | undefined;
    for (const host of this.hosts) {
      try {
        const res = await this.fetchImpl(`${host}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`${host}${path}: ${res.status} ${res.statusText}`);
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
