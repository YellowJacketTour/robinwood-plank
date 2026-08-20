/**
 * Token ids differ by venue: "6770", "06770", BigInt strings, Solana mints.
 * One lookup so floors, filters, badges, and sweeps share the same keying.
 */
export function rarityMapGet<T>(map: Map<string, T>, tokenId: string | null | undefined): T | undefined {
  if (!tokenId) return undefined;
  const direct = map.get(tokenId) ?? map.get(tokenId.toLowerCase());
  if (direct) return direct;
  try {
    const n = BigInt(tokenId).toString();
    return map.get(n) ?? map.get(tokenId.replace(/^0+/, "") || "0");
  } catch {
    return undefined;
  }
}

export function countTiers<T extends { tier: string }>(map: Map<string, T>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of map.values()) {
    out[v.tier] = (out[v.tier] ?? 0) + 1;
  }
  return out;
}
