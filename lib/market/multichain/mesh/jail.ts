/**
 * Durable per-source jail. In-memory source-budget.ts resets on process
 * start; UniSat 403 in one lane must cool the next spawn too.
 */
import { durableKv } from "@/lib/market/durable-kv";
import { checkSourceBudget, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";

const KEY = (source: string) => `plank:market:source-jail-until:${source}`;

export async function isSourceJailed(source: string): Promise<boolean> {
  if (!checkSourceBudget(source).allowed) return true;
  const until = await durableKv.get<number>(KEY(source));
  return typeof until === "number" && Date.now() < until;
}

export async function jailSource(source: string, ms: number, quota = true): Promise<void> {
  recordSourceFailure(source, quota, ms);
  await durableKv.set(KEY(source), Date.now() + ms, { ex: Math.ceil(ms / 1000) + 60 });
}

export async function jailRemainingMs(source: string): Promise<number> {
  const until = await durableKv.get<number>(KEY(source));
  if (typeof until !== "number") return 0;
  return Math.max(0, until - Date.now());
}
