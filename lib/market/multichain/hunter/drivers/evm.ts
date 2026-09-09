import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";
import { TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC, NFT_OWNERSHIP_TOPICS } from "@/lib/market/multichain/discovery/evm-log-scan";
import { initialChunk, onChunkSuccess, onChunkTooLarge, isRangeTooLargeError, suggestedRangeFromError, type ChunkState } from "../chunk";
import { readChunkMemory, writeChunkMemory } from "../cursor";
import type { HunterDriver, HunterFinding } from "../types";

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string };

/**
 * Token ids carried by one log. ERC-721 Transfer: topics[3]. ERC-1155
 * TransferSingle: first data word is `id`. ERC-1155 TransferBatch: data is
 * abi.encode(ids[], values[]) -- word0 = offset of ids, word at offset =
 * length, then the ids (review M5: the first word is always 0x40, so
 * reading it as an id collapsed every batch to one key).
 */
export function tokenIdsOf(topic0: string, log: Pick<RawLog, "topics" | "data">): string[] {
  if (topic0 === TRANSFER_TOPIC) return log.topics[3] ? [log.topics[3].toLowerCase()] : [];
  const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  const word = (i: number) => hex.slice(i * 64, i * 64 + 64);
  if (topic0 === TRANSFER_SINGLE_TOPIC) return hex.length >= 64 ? [word(0)] : [];
  if (topic0 === TRANSFER_BATCH_TOPIC) {
    const offset = Number.parseInt(word(0) || "0", 16);
    if (!Number.isFinite(offset) || offset % 32 !== 0) return [];
    const lenIdx = offset / 32;
    const len = Number.parseInt(word(lenIdx) || "0", 16);
    if (!Number.isFinite(len) || len <= 0 || len > 10_000) return [];
    const ids: string[] = [];
    for (let i = 0; i < len; i += 1) {
      const w = word(lenIdx + 1 + i);
      if (w.length === 64) ids.push(w);
    }
    return ids;
  }
  return [];
}

/**
 * EVM driver: one adaptive eth_getLogs chunk of NFT Transfer topics,
 * chain-wide (no address filter), over the keyless public RPC pool.
 * Yields a per-contract transfer tally with distinct token ids, which is
 * exactly what the activity axis and the admission law need. Blocks
 * behind the head by `confirmations` are left alone so reorgs never land.
 */
export function createEvmHunter(opts: { confirmations?: number; maxBlocksPerRun?: number } = {}): HunterDriver {
  const confirmations = opts.confirmations ?? 3;
  const maxBlocksPerRun = opts.maxBlocksPerRun ?? 20_000;
  return {
    family: "evm",
    async hunt(cursor, ctx) {
      let calls = 0;
      const head = await rpcCall<string>(ctx.chainSlug, "eth_blockNumber", []).catch(() => null);
      calls += 1;
      if (!head) return { findings: [], cursorAfter: cursor, sourceCalls: calls, sourceStatus: "no-provider", note: "eth_blockNumber failed on every provider" };
      const safeHead = Number.parseInt(head.result, 16) - confirmations;
      const from = cursor?.kind === "block" ? cursor.block + 1 : Math.max(0, safeHead - 500);
      if (from > safeHead) return { findings: [], cursorAfter: cursor, sourceCalls: calls, sourceStatus: "ok", note: "caught up" };

      let chunk: ChunkState = (await readChunkMemory("evm", ctx.chainSlug)) ?? initialChunk(10, 5_000, 200);
      let position = from;
      const findings: HunterFinding[] = [];
      const runCeiling = Math.min(safeHead, from + maxBlocksPerRun - 1);

      while (position <= runCeiling && Date.now() < ctx.deadline - 1_500 && !ctx.signal?.aborted) {
        const to = Math.min(runCeiling, position + chunk.size - 1);
        let logs: RawLog[];
        try {
          const r = await rpcCall<RawLog[]>(ctx.chainSlug, "eth_getLogs", [
            { fromBlock: `0x${position.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [[...NFT_OWNERSHIP_TOPICS]] },
          ]);
          calls += 1;
          logs = r.result;
        } catch (err) {
          calls += 1;
          const msg = err instanceof Error ? err.message : String(err);
          if (isRangeTooLargeError(msg)) {
            const hint = suggestedRangeFromError(msg);
            // A hint that is not smaller than the current size would retry the same range forever (review L3).
            chunk = hint != null && hint < chunk.size ? { ...chunk, size: Math.max(chunk.min, hint) } : onChunkTooLarge(chunk);
            await writeChunkMemory("evm", ctx.chainSlug, chunk);
            if (chunk.size <= chunk.min && to - position + 1 <= chunk.min) {
              return { findings, cursorAfter: position > from ? { kind: "block", block: position - 1 } : cursor, sourceCalls: calls, sourceStatus: "error", note: `range rejected at min chunk: ${msg.slice(0, 120)}` };
            }
            continue;
          }
          const status = /429|rate/i.test(msg) ? "rate-limited" : "error";
          return { findings, cursorAfter: position > from ? { kind: "block", block: position - 1 } : cursor, sourceCalls: calls, sourceStatus: status, note: msg.slice(0, 160) };
        }
        const tally = new Map<string, number>();
        const distinct = new Map<string, Set<string>>();
        for (const log of logs) {
          const topic0 = log.topics[0]?.toLowerCase();
          if (topic0 === TRANSFER_TOPIC && log.topics.length !== 4) continue; // ERC-20
          const key = log.address.toLowerCase();
          tally.set(key, (tally.get(key) ?? 0) + 1);
          const set = distinct.get(key) ?? new Set<string>();
          for (const id of tokenIdsOf(topic0 ?? "", log)) set.add(id);
          distinct.set(key, set);
        }
        if (tally.size > 0) {
          findings.push({
            kind: "transfer-tally",
            chainSlug: ctx.chainSlug,
            tally,
            distinctTokens: new Map([...distinct.entries()].map(([k, v]) => [k, v.size])),
            fromBlock: position,
            toBlock: to,
          });
        }
        chunk = onChunkSuccess(chunk, logs.length);
        position = to + 1;
      }
      await writeChunkMemory("evm", ctx.chainSlug, chunk);
      return { findings, cursorAfter: { kind: "block", block: position - 1 }, sourceCalls: calls, sourceStatus: "ok", note: `chunk ${chunk.size}` };
    },
  };
}
