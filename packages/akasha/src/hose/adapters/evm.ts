import { ALL_WATCHED_TOPICS, DISCOVERY_TOPICS, bloomMayContain } from "../../shared/topics.ts";
import { FINALITY_LAG, type ChainId, type Header } from "../../shared/types.ts";
import type { Hex } from "../../shared/hex.ts";
import type { ArchiveStore } from "../store.ts";
import { artifactId } from "../store.ts";
import { canMarkStreamAlive, extendCoverage } from "../coverage.ts";
import { isChildOfTip, rewindToCommonAncestor } from "../reorg.ts";
import { decodeLog, isMint, type RawLog } from "../decode-evm.ts";
import type { EvmRpc, EvmStream } from "../rpc/evm.ts";

export const BLOOM_AUDIT_MOD = 32;

export interface EvmAdapterOpts {
  chain: ChainId;
  store: ArchiveStore;
  rpc: EvmRpc;
  stream: EvmStream;
  t0: { height: number; hash: Hex };
  forceReceipts?: boolean;
}

/**
 * Discovery path: topic-only over a single block. No address filter.
 * The two address-scoped helpers live at the bottom of this file and are
 * pinned by test to remain exactly those two names.
 */
export class EvmAdapter {
  readonly chain: ChainId;
  private stop: (() => void) | undefined;
  forceReceipts: boolean;

  private opts: EvmAdapterOpts;
  constructor(opts: EvmAdapterOpts) {
    this.opts = opts;
    this.chain = opts.chain;
    this.forceReceipts = opts.forceReceipts ?? false;
    const c = opts.store.getCursor(opts.chain);
    if (!c) {
      opts.store.putCursor({
        chain: opts.chain,
        t0Hash: opts.t0.hash,
        t0Height: opts.t0.height,
        tipHash: opts.t0.hash,
        tipHeight: opts.t0.height,
        finalizedHash: opts.t0.hash,
        finalizedHeight: opts.t0.height,
        streamAlive: false,
        streamKind: opts.stream.kind,
      });
      opts.store.putHeader({
        chain: opts.chain,
        height: opts.t0.height,
        hash: opts.t0.hash,
        parentHash: opts.t0.hash,
      });
      extendCoverage(opts.store, opts.chain, opts.t0.height, opts.t0.hash);
    }
  }

  start(): void {
    this.stop = this.opts.stream.subscribeHeads(
      (h) => void this.onHead(h),
      (err) => this.onDead(err),
    );
  }

  halt(): void {
    this.stop?.();
    const c = this.opts.store.getCursor(this.chain);
    if (c) this.opts.store.putCursor({ ...c, streamAlive: false, streamKind: "dead" });
  }

  private onDead(_err: Error): void {
    const c = this.opts.store.getCursor(this.chain);
    if (!c) return;
    this.opts.store.putCursor({ ...c, streamAlive: false });
    void this.opts.rpc.getBlockNumber().then((remote) => {
      if (remote > c.tipHeight) {
        this.opts.store.enqueueGap({
          chain: this.chain,
          fromHeight: c.tipHeight + 1,
          toHeight: remote,
          reason: "reconnect",
        });
      }
    });
  }

  async onHead(h: Header): Promise<void> {
    const store = this.opts.store;
    const cursor = store.getCursor(this.chain);
    if (!cursor) throw new Error("cursor missing");

    if (h.hash.toLowerCase() === cursor.tipHash.toLowerCase()) return;

    if (!isChildOfTip(store, this.chain, h) && h.height >= cursor.t0Height) {
      const remoteParent = await this.opts.rpc.getBlockByHash(h.parentHash);
      const walk = (hash: Hex) => store.getHeader(this.chain, hash) ?? undefined;
      if (remoteParent) store.putHeader(remoteParent);
      rewindToCommonAncestor(store, this.chain, h, (hash) => walk(hash));
    }

    store.putHeader(h);
    const audit = h.height % BLOOM_AUDIT_MOD === 0;
    const bloomHit = bloomMayContain(h.logsBloom ?? "0x", ALL_WATCHED_TOPICS);
    const pull = this.forceReceipts || audit || bloomHit || !h.logsBloom;

    if (pull) {
      const logs = await this.receiptsOrLogs(h);
      if (audit && !this.forceReceipts) {
        const bloomMiss = logs.filter((l) =>
          DISCOVERY_TOPICS.includes(l.topics[0]?.toLowerCase() as Hex),
        );
        const wouldSkip = !bloomHit;
        if (wouldSkip && bloomMiss.length > 0) {
          this.forceReceipts = true;
          store.enqueueGap({
            chain: this.chain,
            fromHeight: h.height,
            toHeight: h.height,
            reason: "bloom_audit",
          });
        }
      }
      for (const log of logs) {
        const ev = decodeLog(this.chain, log);
        if (!ev) continue;
        const inserted = store.putEvent(ev);
        if (inserted && isMint(ev)) {
          store.putArtifact({
            id: artifactId(this.chain, "evm_token", `${ev.contractOrProgram}:${ev.tokenOrInscription}`),
            chain: this.chain,
            kind: "evm_token",
            genesisEvent: { blockHash: ev.blockHash, loc: ev.loc },
            firstHash: ev.blockHash,
            firstHeight: ev.height,
          });
          const cid = artifactId(this.chain, "evm_contract", ev.contractOrProgram);
          if (!store.getArtifact(cid)) {
            store.putArtifact({
              id: cid,
              chain: this.chain,
              kind: "evm_contract",
              genesisEvent: { blockHash: ev.blockHash, loc: ev.loc },
              firstHash: ev.blockHash,
              firstHeight: ev.height,
            });
          }
        }
      }
    }

    extendCoverage(store, this.chain, h.height, h.hash);

    const lag = FINALITY_LAG[this.chain];
    const finHeight = Math.max(cursor.t0Height, h.height - lag);
    const finHeaders = store.headersAtHeight(this.chain, finHeight);
    const fin = finHeaders[finHeaders.length - 1];
    const next = {
      ...store.getCursor(this.chain)!,
      tipHash: h.hash,
      tipHeight: h.height,
      finalizedHeight: fin?.height ?? cursor.finalizedHeight,
      finalizedHash: fin?.hash ?? cursor.finalizedHash,
      streamKind: this.opts.stream.kind,
    };
    next.streamAlive = canMarkStreamAlive(store, this.chain);
    store.putCursor(next);
  }

  async receiptsOrLogs(h: Header): Promise<RawLog[]> {
    const rec = await this.opts.rpc.getBlockReceipts(h.hash);
    if (rec) {
      return rec.filter((l) =>
        ALL_WATCHED_TOPICS.includes((l.topics[0] ?? "").toLowerCase() as Hex),
      );
    }
    const orTopics = [ALL_WATCHED_TOPICS as Hex[]];
    return this.opts.rpc.getLogs({
      fromBlock: h.height,
      toBlock: h.height,
      topics: orTopics,
    });
  }
}

export async function findEarliestTransferBlock(
  rpc: EvmRpc,
  address: string,
  from: number,
  to: number,
): Promise<number | undefined> {
  assertAddress(address);
  let lo = from;
  let hi = to;
  let found: number | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const logs = await rpc.getLogs({
      fromBlock: lo,
      toBlock: mid,
      address,
      topics: [DISCOVERY_TOPICS as Hex[]],
    });
    const hit = logs[0];
    if (hit) {
      found = hit.blockNumber;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

export async function runAddressScopedMembershipScan(
  rpc: EvmRpc,
  address: string,
  from: number,
  to: number,
): Promise<RawLog[]> {
  assertAddress(address);
  return rpc.getLogs({
    fromBlock: from,
    toBlock: to,
    address,
    topics: [DISCOVERY_TOPICS as Hex[]],
  });
}

function assertAddress(address: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`bad address ${address}`);
}

export const ADDRESS_SCOPED_FNS = [
  "findEarliestTransferBlock",
  "runAddressScopedMembershipScan",
] as const;
