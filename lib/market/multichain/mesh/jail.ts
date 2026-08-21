/**
 * Durable per-source jail. In-memory source-budget.ts resets on process
 * start; UniSat 403 in one lane must cool the next spawn too.
 */
import { durableKv } from "@/lib/market/durable-kv";
import { checkSourceBudget, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";

/** Vendor monthly budget is global. 429/403 cool-off is per source×chain so ETH cannot park OP. */
export function sourceJailKey(source: string, chainSlug?: string | null): string {
  const chain = (chainSlug ?? "").trim();
  return chain
    ? `plank:market:source-jail-until:${source}:${chain}`
    : `plank:market:source-jail-until:${source}`;
}

export async function isSourceJailed(source: string, chainSlug?: string | null): Promise<boolean> {
  if (!checkSourceBudget(source).allowed) return true;
  const chainUntil = chainSlug ? await durableKv.get<number>(sourceJailKey(source, chainSlug)) : null;
  if (typeof chainUntil === "number" && Date.now() < chainUntil) return true;
  const until = await durableKv.get<number>(sourceJailKey(source));
  return typeof until === "number" && Date.now() < until;
}

export async function jailSource(source: string, ms: number, quota = true, chainSlug?: string | null): Promise<void> {
  recordSourceFailure(source, quota, ms);
  const key = sourceJailKey(source, chainSlug);
  await durableKv.set(key, Date.now() + ms, { ex: Math.ceil(ms / 1000) + 60 });
}

export async function jailRemainingMs(source: string, chainSlug?: string | null): Promise<number> {
  const chainUntil = chainSlug ? await durableKv.get<number>(sourceJailKey(source, chainSlug)) : null;
  const until = await durableKv.get<number>(sourceJailKey(source));
  const latest = Math.max(
    typeof chainUntil === "number" ? chainUntil : 0,
    typeof until === "number" ? until : 0
  );
  return Math.max(0, latest - Date.now());
}
