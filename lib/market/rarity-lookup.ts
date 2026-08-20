/**
 * Token ids differ by venue: "6770", "06770", BigInt strings, Solana mints.
 * One lookup so floors, filters, badges, and sweeps share the same keying.
 */
export function tokenIdAliases(tokenId: string): string[] {
  const out = new Set<string>([tokenId, tokenId.toLowerCase()]);
  try {
    out.add(BigInt(tokenId).toString());
  } catch {
    /* non-numeric (Solana mint, inscription id) */
  }
  return [...out];
}

export function rarityMapGet<T>(map: Map<string, T>, tokenId: string | null | undefined): T | undefined {
  if (!tokenId) return undefined;
  for (const k of tokenIdAliases(tokenId)) {
    const hit = map.get(k);
    if (hit) return hit;
  }
  return undefined;
}

export function countTiers<T extends { tier: string }>(map: Map<string, T>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of map.values()) {
    out[v.tier] = (out[v.tier] ?? 0) + 1;
  }
  return out;
}
