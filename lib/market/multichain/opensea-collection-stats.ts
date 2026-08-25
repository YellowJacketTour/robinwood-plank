/**
 * Stub so leftover imports from hydrate-stats cannot crash the hub.
 * Live hydrate was removed from GlobalMarketHub until a compile-safe pass.
 */
export async function refreshOpenSeaStatsForContract(
  _chainSlug: string,
  _contractAddress: string
): Promise<{ ok: boolean; slug?: string }> {
  return { ok: false };
}
