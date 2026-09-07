/**
 * Adaptive chunk policy (pure, unit-tested).
 *
 * Every public log/history endpoint has a ceiling that is NOT documented
 * consistently: Alchemy free = 10 blocks per eth_getLogs, publicnode and
 * drpc accept thousands until the response is too large, Solana caps
 * getSignaturesForAddress at 1,000. Hard-coding the smallest ceiling
 * (the old CHUNK_BLOCKS = 10) made the keyless scan crawl at two minutes
 * of chain time per call. The Hunter instead PROBES: grow the range on
 * success, halve it on a "range too large / too many results / timeout"
 * error, and remember the last good size per (chain, provider) so the
 * next run starts where this one left off. Same idea as TCP congestion
 * control: additive increase, multiplicative decrease.
 */
export type ChunkState = { size: number; min: number; max: number };

export function initialChunk(min = 10, max = 5_000, start = 200): ChunkState {
  return { size: Math.max(min, Math.min(max, start)), min, max };
}

/** After a successful call: grow by 50% (never past max). */
export function onChunkSuccess(s: ChunkState, resultCount: number, softLimit = 8_000): ChunkState {
  // A very large page means the next growth step would likely trip the
  // server's response ceiling; hold instead of growing.
  if (resultCount >= softLimit) return s;
  return { ...s, size: Math.min(s.max, Math.max(s.min, Math.floor(s.size * 1.5))) };
}

/** After a "too large" style failure: halve (never below min). */
export function onChunkTooLarge(s: ChunkState): ChunkState {
  return { ...s, size: Math.max(s.min, Math.floor(s.size / 2)) };
}

/** Provider error text that means "ask for less", across the vendors seen live. */
export function isRangeTooLargeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("block range") ||
    m.includes("too many") ||
    m.includes("query returned more than") ||
    m.includes("exceeds") ||
    m.includes("limit exceeded") ||
    m.includes("response size") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("payload too large") ||
    m.includes("413")
  );
}

/** Parse the usable range some vendors state in their own error ("up to 10 block range"). */
export function suggestedRangeFromError(message: string): number | null {
  const m = /up to (?:a )?(\d+)[ -]block/i.exec(message) ?? /(\d+) block(?:s)? range/i.exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
