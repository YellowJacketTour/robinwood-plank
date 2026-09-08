import type { Hex } from "../../shared/hex.ts";
import type { Header } from "../../shared/types.ts";
import type { RawLog } from "../decode-evm.ts";

export interface EvmRpc {
  getBlockNumber(): Promise<number>;
  getBlockByNumber(n: number | "latest" | "finalized"): Promise<Header | undefined>;
  getBlockByHash(hash: Hex): Promise<Header | undefined>;
  getBlockReceipts(hash: Hex): Promise<RawLog[] | undefined>;
  getLogs(opts: {
    fromBlock: number;
    toBlock: number;
    topics: Hex[][];
    address?: string;
  }): Promise<RawLog[]>;
}

export interface EvmStream {
  kind: "ws_newheads" | "http_tick";
  subscribeHeads(onHead: (h: Header) => void, onDead: (err: Error) => void): () => void;
}

export class HttpTickStream implements EvmStream {
  kind = "http_tick" as const;
  private rpc: EvmRpc;
  private intervalMs: number;
  constructor(rpc: EvmRpc, intervalMs: number) {
    this.rpc = rpc;
    this.intervalMs = intervalMs;
  }
  subscribeHeads(onHead: (h: Header) => void, onDead: (err: Error) => void): () => void {
    let stopped = false;
    let last = -1;
    const tick = async () => {
      if (stopped) return;
      try {
        const n = await this.rpc.getBlockNumber();
        for (let h = last < 0 ? n : last + 1; h <= n; h++) {
          const block = await this.rpc.getBlockByNumber(h);
          if (block) onHead(block);
        }
        last = n;
      } catch (e) {
        onDead(e instanceof Error ? e : new Error(String(e)));
      }
    };
    const id = setInterval(() => void tick(), this.intervalMs);
    void tick();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }
}

export class JsonRpcEvm implements EvmRpc {
  private url: string;
  private chain: Header["chain"];
  private fetchImpl: typeof fetch;
  constructor(url: string, chain: Header["chain"], fetchImpl: typeof fetch = fetch) {
    this.url = url;
    this.chain = chain;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  async getBlockNumber(): Promise<number> {
    const hex = await this.call<string>("eth_blockNumber", []);
    return Number.parseInt(hex, 16);
  }

  async getBlockByNumber(n: number | "latest" | "finalized"): Promise<Header | undefined> {
    const tag = typeof n === "number" ? "0x" + n.toString(16) : n;
    const raw = await this.call<RpcBlock | null>("eth_getBlockByNumber", [tag, false]);
    return raw ? this.toHeader(raw) : undefined;
  }

  async getBlockByHash(hash: Hex): Promise<Header | undefined> {
    const raw = await this.call<RpcBlock | null>("eth_getBlockByHash", [hash, false]);
    return raw ? this.toHeader(raw) : undefined;
  }

  async getBlockReceipts(hash: Hex): Promise<RawLog[] | undefined> {
    try {
      const recs = await this.call<RpcReceipt[] | null>("eth_getBlockReceipts", [hash]);
      if (!recs) return undefined;
      const logs: RawLog[] = [];
      for (const r of recs) {
        for (const l of r.logs ?? []) logs.push(this.toLog(l));
      }
      return logs;
    } catch {
      return undefined;
    }
  }

  async getLogs(opts: {
    fromBlock: number;
    toBlock: number;
    topics: Hex[][];
    address?: string;
  }): Promise<RawLog[]> {
    const raw = await this.call<RpcLog[]>("eth_getLogs", [
      {
        fromBlock: "0x" + opts.fromBlock.toString(16),
        toBlock: "0x" + opts.toBlock.toString(16),
        topics: opts.topics,
        ...(opts.address ? { address: opts.address } : {}),
      },
    ]);
    return raw.map((l) => this.toLog(l));
  }

  private toHeader(b: RpcBlock): Header {
    return {
      chain: this.chain,
      height: Number.parseInt(b.number, 16),
      hash: b.hash as Hex,
      parentHash: b.parentHash as Hex,
      logsBloom: b.logsBloom as Hex,
      receiptsRoot: b.receiptsRoot as Hex,
    };
  }

  private toLog(l: RpcLog): RawLog {
    return {
      address: l.address,
      topics: l.topics,
      data: l.data,
      logIndex: Number.parseInt(l.logIndex, 16),
      transactionHash: l.transactionHash,
      blockHash: l.blockHash,
      blockNumber: Number.parseInt(l.blockNumber, 16),
    };
  }
}

interface RpcBlock {
  number: string;
  hash: string;
  parentHash: string;
  logsBloom: string;
  receiptsRoot: string;
}
interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
}
interface RpcReceipt {
  logs: RpcLog[];
}
