/**
 * Cross-isolate cache for vault stats.
 *
 * Cloudflare Workers share no module memory between isolates, and the public
 * Robinhood RPC rate-limits CF egress (HTTP 429). Without a durable cache,
 * Instant Swap's live panels go blank after the first successful read.
 * Upstash (KV_REST_API_*) is already wired for market orders.
 */

import { kv } from "@vercel/kv";
import { MARKET_VAULT_ADDRESS } from "@/lib/constants";
import type { VaultStats } from "@/lib/market/vault-stats";

const STALE_OK_MS = 5 * 60_000; // serve up to 5 min old on RPC failure

/** Key includes vault address so switching V1→V2 never serves the old book. */
function kvKey(vaultAddress?: string | null): string {
  const v = (vaultAddress ?? MARKET_VAULT_ADDRESS)?.toLowerCase() ?? "none";
  return `plank:market:vault-stats:${v}`;
}

function hasKv(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

type Blob = { at: number; stats: VaultStats };

export async function readVaultStatsCache(
  vaultAddress?: string | null
): Promise<Blob | null> {
  if (!hasKv()) return null;
  try {
    const v = await kv.get<Blob>(kvKey(vaultAddress));
    if (!v?.stats || typeof v.at !== "number") return null;
    return v;
  } catch {
    return null;
  }
}

export async function writeVaultStatsCache(
  stats: VaultStats,
  vaultAddress?: string | null
): Promise<void> {
  if (!hasKv()) return;
  try {
    const blob: Blob = { at: Date.now(), stats };
    // TTL slightly longer than STALE_OK so a quiet period still has a fallback
    await kv.set(kvKey(vaultAddress), blob, { ex: 15 * 60 });
  } catch {
    // cache is best-effort
  }
}

export function isFreshEnough(blob: Blob, maxAgeMs = STALE_OK_MS): boolean {
  return Date.now() - blob.at < maxAgeMs;
}
