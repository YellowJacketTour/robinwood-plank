import { Block } from "bitcoinjs-lib";
import type { BitcoinBlock } from "../adapters/bitcoin.ts";

/** Verify the complete transaction and witness commitments before indexing. */
export function decodeBitcoinBlock(bytes: Uint8Array, hash: string, height: number): BitcoinBlock {
  const block = Block.fromBuffer(bytes);
  if (block.getId() !== hash.replace(/^0x/, "").toLowerCase()) throw new Error("Bitcoin raw block hash mismatch");
  if (!block.transactions?.length || !block.checkTxRoots()) throw new Error("Bitcoin transaction/witness commitment mismatch");
  if (block.byteLength() !== bytes.length || block.weight() > 4_000_000) throw new Error("Bitcoin block size/weight mismatch");
  return {
    complete: true,
    hash: block.getId(),
    previousblockhash: Buffer.from(block.prevHash!).reverse().toString("hex"),
    height,
    tx: block.transactions.map((tx) => ({
      txid: tx.getId(),
      vin: tx.ins.map((input) => ({ txinwitness: input.witness.map((item) => Buffer.from(item).toString("hex")) })),
    })),
  };
}

/** A consensus-valid serialized block cannot exceed four million bytes. */
export async function readBitcoinBlockBody(response: Response): Promise<Uint8Array> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4_000_000) throw new Error(`Bitcoin block response exceeds byte limit: ${size}`);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
