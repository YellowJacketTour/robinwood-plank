import { normalizeContractAddress } from "../collection-key";

export type MarketScope = { chainSlug: string; collectionKey: string };
export type MarketChange = {
  type: "invalidate" | "resync";
  family: string;
  scopes: MarketScope[];
  changedRows: number;
  omittedScopes: number;
  reason?: string;
};

export function matchesChange(change: MarketChange, scopes: MarketScope[]): boolean {
  return change.type === "resync" || scopes.length === 0 || change.scopes.some((changed) =>
    scopes.some((scope) => scope.chainSlug === changed.chainSlug &&
      normalizeContractAddress(scope.chainSlug, scope.collectionKey) ===
      normalizeContractAddress(changed.chainSlug, changed.collectionKey)));
}

export function parseScopes(value: unknown): MarketScope[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const scopes: MarketScope[] = [];
  for (const item of value) {
    if (!item || typeof item.chainSlug !== "string" || typeof item.collectionKey !== "string" ||
        !item.chainSlug || !item.collectionKey || item.chainSlug.length > 80 || item.collectionKey.length > 512) return null;
    scopes.push({ chainSlug: item.chainSlug, collectionKey: item.collectionKey });
  }
  return scopes;
}

export function parseChange(raw: string): MarketChange | null {
  try {
    const value = JSON.parse(raw);
    const scopes = parseScopes(value.scopes);
    if (!scopes || !["invalidate", "resync"].includes(value.type) || typeof value.family !== "string" ||
        !Number.isSafeInteger(value.changedRows) || value.changedRows < 0 ||
        !Number.isSafeInteger(value.omittedScopes) || value.omittedScopes < 0) return null;
    return { ...value, scopes };
  } catch { return null; }
}
