/** Full semantic identity: later subjects and focused token IDs matter. */
export function demandIntentKey(intent: {
  kind: string; chainSlug: string; subjects: string[];
  tokenIds?: string[]; moneyAtStakeUsd?: number; context?: string;
}): string {
  return JSON.stringify([intent.kind, intent.chainSlug, [...new Set(intent.subjects)].sort(),
    [...new Set(intent.tokenIds ?? [])].sort(), intent.moneyAtStakeUsd ?? 0, intent.context ?? ""]);
}
