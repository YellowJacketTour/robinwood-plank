import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";
import { TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC } from "@/lib/market/multichain/discovery/evm-log-scan";
import { initialChunk, onChunkSuccess, onChunkTooLarge, isRangeTooLargeError, suggestedRangeFromError, type ChunkState } from "../chunk";
import { readChunkMemory, writeChunkMemory } from "../cursor";
import type { HunterDriver, HunterFinding } from "../types";

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string };

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
            { fromBlock: `0x${position.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [[TRANSFER_TOPIC, TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]] },
          ]);
          calls += 1;
          logs = r.result;
        } catch (err) {
          calls += 1;
          const msg = err instanceof Error ? err.message : String(err);
          if (isRangeTooLargeError(msg)) {
            const hint = suggestedRangeFromError(msg);
            chunk = hint ? { ...chunk, size: Math.max(chunk.min, Math.min(chunk.size, hint)) } : onChunkTooLarge(chunk);
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
          const tokenKey = topic0 === TRANSFER_TOPIC ? log.topics[3] : log.data.slice(0, 66);
          const set = distinct.get(key) ?? new Set<string>();
          set.add(tokenKey ?? "");
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
