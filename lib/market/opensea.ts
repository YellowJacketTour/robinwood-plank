import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";

/**
 * OpenSea API v2 client with a self-renewing credential.
 *
 * OpenSea supports Robinhood Chain (chain identifier "robinhood"), so the
 * collection's activity there is visible to us — the older claim in this repo
 * that no aggregator indexes chain 4663 is wrong.
 *
 * The credential is the interesting part. Free keys are issued instantly with
 * no signup but **expire after 30 days**, and a silently expired key would make
 * volume quietly stop updating — the same class of failure as the sales catalog
 * expiring with nothing to rebuild it. So the key is treated as managed state
 * rather than static config: stored in PostgreSQL, checked on every cron run,
 * and re-minted before it lapses.
 *
 * Set OPENSEA_API_KEY to override with a full (non-expiring) key from
 * opensea.io/settings/developer. That takes precedence and is never rotated.
 *
 * Server-only. The key must never reach a client bundle or a public response.
 */

const KEY_KV = "plank:market:opensea-api-key-v1";
const BASE = "https://api.opensea.io/api/v2";

/** Renew with a week in hand — a cron can miss a few runs without lapsing. */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * OpenSea allows one key creation per hour per caller. Overshoot it, so a
 * failed mint cannot turn into a retry loop that stays permanently rate
 * limited and never recovers.
 */
const MINT_COOLDOWN_MS = 70 * 60 * 1000;

export type StoredOpenSeaKey = {
  apiKey: string;
  /** ISO-8601 from OpenSea. */
  expiresAt: string;
  mintedAt: number;
  name?: string;
  /** Last mint ATTEMPT, success or not — drives the cooldown. */
  lastAttemptAt?: number;
};

function envKey(): string | null {
  return process.env.OPENSEA_API_KEY?.trim() || null;
}

async function readStored(): Promise<StoredOpenSeaKey | null> {
  if (!hasDurableKv()) return null;
  try {
    return (await kv.get<StoredOpenSeaKey>(KEY_KV)) ?? null;
  } catch {
    return null;
  }
}

async function writeStored(value: StoredOpenSeaKey): Promise<void> {
  if (!hasDurableKv()) return;
  try {
    // No TTL. This is managed state, not a cache — see migration 003.
    await kv.set(KEY_KV, value);
  } catch {
    /* a failed write just means we mint again next run */
  }
}

function msUntilExpiry(stored: StoredOpenSeaKey): number {
  const t = Date.parse(stored.expiresAt);
  return Number.isFinite(t) ? t - Date.now() : -1;
}

/**
 * The key to use right now, or null if we have none.
 *
 * Read-only by design: request paths must never mint. Several Passenger
 * workers hitting a 1-per-hour endpoint at once would rate-limit each other
 * and leave everyone without a key. Minting is the cron's job.
 */
export async function getOpenSeaApiKey(): Promise<string | null> {
  const fromEnv = envKey();
  if (fromEnv) return fromEnv;
  const stored = await readStored();
  if (!stored?.apiKey) return null;
  // Serve it even past expiry — OpenSea decides, not our clock skew.
  return stored.apiKey;
}

async function mintKey(): Promise<StoredOpenSeaKey | null> {
  const res = await fetch(`${BASE}/auth/keys`, {
    method: "POST",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenSea key mint failed: HTTP ${res.status} ${body.slice(0, 160)}`
    );
  }
  const json = (await res.json()) as {
    api_key?: string;
    expires_at?: string;
    name?: string;
  };
  if (!json.api_key || !json.expires_at) {
    throw new Error("OpenSea key mint returned an unexpected shape.");
  }
  return {
    apiKey: json.api_key,
    expiresAt: json.expires_at,
    mintedAt: Date.now(),
    name: json.name,
  };
}

export type KeyEnsureResult = {
  status: "env" | "fresh" | "renewed" | "cooldown" | "failed" | "unavailable";
  /** Safe to log — never contains the key. */
  detail: string;
};

/**
 * Mint or renew as needed. Call from the cron only.
 */
export async function ensureOpenSeaKey(): Promise<KeyEnsureResult> {
  if (envKey()) {
    return { status: "env", detail: "using OPENSEA_API_KEY from the environment" };
  }
  if (!hasDurableKv()) {
    return { status: "unavailable", detail: "no datastore configured to hold the key" };
  }

  const stored = await readStored();
  if (stored?.apiKey) {
    const remaining = msUntilExpiry(stored);
    if (remaining > RENEW_BEFORE_MS) {
      const days = Math.floor(remaining / 86_400_000);
      return { status: "fresh", detail: `key valid for ${days} more day(s)` };
    }
  }

  const lastAttempt = stored?.lastAttemptAt ?? 0;
  const sinceAttempt = Date.now() - lastAttempt;
  if (sinceAttempt < MINT_COOLDOWN_MS) {
    const mins = Math.ceil((MINT_COOLDOWN_MS - sinceAttempt) / 60_000);
    return {
      status: "cooldown",
      detail: `renewal needed but OpenSea allows one key per hour; retrying in ~${mins}m`,
    };
  }

  // Record the attempt BEFORE the call, so a crash mid-mint still burns the
  // cooldown rather than letting the next run hammer a rate-limited endpoint.
  if (stored) await writeStored({ ...stored, lastAttemptAt: Date.now() });

  try {
    const minted = await mintKey();
    if (!minted) return { status: "failed", detail: "mint returned nothing" };
    await writeStored({ ...minted, lastAttemptAt: Date.now() });
    return {
      status: "renewed",
      detail: `new key expires ${minted.expiresAt}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!stored) {
      await writeStored({
        apiKey: "",
        expiresAt: new Date(0).toISOString(),
        mintedAt: 0,
        lastAttemptAt: Date.now(),
      });
    }
    return { status: "failed", detail };
  }
}

/** Credential state for /api/health — never includes the key itself. */
export async function openSeaKeyStatus(): Promise<{
  source: "env" | "managed" | "none";
  expiresAt: string | null;
  daysRemaining: number | null;
}> {
  if (envKey()) return { source: "env", expiresAt: null, daysRemaining: null };
  const stored = await readStored();
  if (!stored?.apiKey) return { source: "none", expiresAt: null, daysRemaining: null };
  const remaining = msUntilExpiry(stored);
  return {
    source: "managed",
    expiresAt: stored.expiresAt,
    daysRemaining: Math.floor(remaining / 86_400_000),
  };
}

/**
 * GET an OpenSea endpoint. Returns null rather than throwing on any failure:
 * OpenSea being unreachable must never blank Marketplank's own numbers.
 */
export async function openSeaGet<T>(path: string): Promise<T | null> {
  const key = await getOpenSeaApiKey();
  if (!key) return null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "x-api-key": key, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[opensea] GET ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    console.warn(
      `[opensea] GET ${path} failed:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

export type OpenSeaCollectionStats = {
  total?: {
    volume?: number;
    sales?: number;
    average_price?: number;
    num_owners?: number;
    market_cap?: number;
    floor_price?: number;
    floor_price_symbol?: string;
  };
  intervals?: Array<{
    interval?: string;
    volume?: number;
    volume_change?: number;
    sales?: number;
  }>;
};

export async function fetchOpenSeaCollectionStats(
  slug: string
): Promise<OpenSeaCollectionStats | null> {
  return openSeaGet<OpenSeaCollectionStats>(
    `/collections/${encodeURIComponent(slug)}/stats`
  );
}
