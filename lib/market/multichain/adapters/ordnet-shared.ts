export function resolveOrdNetCollectionSlug(canonicalKey: string): string {
  const raw = process.env.ORDNET_COLLECTION_SLUG_MAP?.trim();
  if (!raw) return canonicalKey;
  try {
    const map = JSON.parse(raw) as Record<string, unknown>;
    const mapped = map[canonicalKey];
    return typeof mapped === "string" && mapped.trim() ? mapped.trim() : canonicalKey;
  } catch {
    throw new Error("ORDNET_COLLECTION_SLUG_MAP must be a JSON object of canonical keys to ORD.NET slugs");
  }
}

/** BTC display scaling used by the shared Listing model: sats -> 1e18 BTC units. */
export function ordNetSatsToPriceWei(sats: number): string {
  if (!Number.isSafeInteger(sats) || sats < 0) throw new Error("ORD.NET priceSats must be a non-negative safe integer");
  return (BigInt(sats) * 10_000_000_000n).toString();
}
