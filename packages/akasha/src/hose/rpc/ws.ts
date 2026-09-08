import type { Hex } from "../../shared/hex.ts";
import type { Header } from "../../shared/types.ts";
import type { EvmStream } from "./evm.ts";

/**
 * newHeads over a raw WebSocket. No vendor SDK.
 * Disconnect is the normal case; the adapter enqueues a reconnect gap.
 */
export class WsNewHeads implements EvmStream {
  kind = "ws_newheads" as const;
  constructor(
    private url: string,
    private chain: Header["chain"],
  ) {}

  subscribeHeads(onHead: (h: Header) => void, onDead: (err: Error) => void): () => void {
    const ws = new WebSocket(this.url);
    let id = 1;
    let stopped = false;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: id++, method: "eth_subscribe", params: ["newHeads"] }));
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        method?: string;
        params?: { result?: RpcHead };
        result?: unknown;
      };
      if (msg.method === "eth_subscription" && msg.params?.result) {
        onHead(toHeader(this.chain, msg.params.result));
      }
    });
    ws.addEventListener("close", () => {
      if (!stopped) onDead(new Error("ws closed"));
    });
    ws.addEventListener("error", () => {
      if (!stopped) onDead(new Error("ws error"));
    });
    return () => {
      stopped = true;
      ws.close();
    };
  }
}

interface RpcHead {
  number: string;
  hash: string;
  parentHash: string;
  logsBloom?: string;
  receiptsRoot?: string;
}

function toHeader(chain: Header["chain"], h: RpcHead): Header {
  return {
    chain,
    height: Number.parseInt(h.number, 16),
    hash: h.hash as Hex,
    parentHash: h.parentHash as Hex,
    logsBloom: h.logsBloom as Hex | undefined,
    receiptsRoot: h.receiptsRoot as Hex | undefined,
  };
}
