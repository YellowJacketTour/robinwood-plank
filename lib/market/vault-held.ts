import { MARKET_VAULT_ADDRESS, MARKET_VAULT_ADDRESSES } from "@/lib/constants";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { BLOCKSCOUT_BASE, fetchNftsHeldBy } from "@/lib/market/blockscout";
import { resolveIpfsUrl } from "@/lib/ipfs";
import { resolveTokenImage } from "@/lib/market/token-image";
import {
  durableKv as kv,
  hasDurableKv,
} from "@/lib/market/durable-kv";

/**
 * Vault holdings via Blockscout REST (IDs + images) with KV fallback.
 */

const CACHE_MS = 45_000;
const KV_KEY_PREFIX = "plank:market:vault-held-full";

function resolveVaultAddress(vaultAddress?: string | null): string | null {
  if (vaultAddress && /^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
    const ok = MARKET_VAULT_ADDRESSES.some(
      (a) => a.toLowerCase() === vaultAddress.toLowerCase()
    );
    if (ok) return vaultAddress;
  }
  return MARKET_VAULT_ADDRESS;
}

function kvKeyFor(vault: string): string {
  return `${KV_KEY_PREFIX}:${vault.toLowerCase()}`;
}

export type HeldTokenRow = { tokenId: string; imageUrl: string | null };

const memCaches = new Map<string, { at: number; rows: HeldTokenRow[] }>();

function hasKv(): boolean {
  return hasDurableKv();
}

/** Generic unrevealed placeholder CID used for pre-reveal metadata. */
const UNREVEALED_MARKERS = [
  "bafybeig22ii7mvhgprof5shldqkr3w3jhyvfuijuwc3hatedmjzdkaodje",
  "unrevealed",
  "coming soon",
  "comingsoon",
];

function isUnrevealedArt(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const s = raw.toLowerCase();
  return UNREVEALED_MARKERS.some((m) => s.includes(m));
}

function normalizeImage(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  if (isUnrevealedArt(raw)) return null; // force tokenURI re-resolve below
  try {
    return resolveIpfsUrl(raw) || raw;
  } catch {
    return raw;
  }
}

async function readKv(vault: string): Promise<HeldTokenRow[] | null> {
  if (!hasKv()) return null;
  try {
    let v = await kv.get<{ at: number; rows: HeldTokenRow[] } | string>(kvKeyFor(vault));
    if (typeof v === "string") {
      try {
        v = JSON.parse(v) as { at: number; rows: HeldTokenRow[] };
      } catch {
        return null;
      }
    }
    return v?.rows?.length ? v.rows : null;
  } catch {
    return null;
  }
}

async function writeKv(vault: string, rows: HeldTokenRow[]): Promise<void> {
  if (!hasKv()) return;
  try {
    // No TTL. This row is only ever read as the last-known-good fallback for
    // when BOTH Blockscout paths fail (see the tail of getVaultHeldTokens), so
    // a 15-minute expiry meant the fallback was reliably absent during exactly
    // the outage it exists for — the fence would throw instead of showing the
    // holdings we already knew. Same rule as migrations 002 and 003: a
    // last-known-good snapshot is not a disposable request cache. Freshness
    // comes from the 45s memory cache and the cron, never from expiry.
    await kv.set(kvKeyFor(vault), { at: Date.now(), rows });
  } catch {
    /* best-effort */
  }
}

/**
 * Re-resolve only missing / pre-reveal stubs via post-reveal metadata CID.
 * Do NOT re-fetch every board on each request (that hung the Worker under
 * IPFS fan-out). Blockscout post-reveal image URLs already point at the
 * revealed art CID — the fence "looked like placeholders" was a crop issue
 * (object-cover on 26px boards), not wrong CIDs.
 */
async function enrichUnrevealedArt(rows: HeldTokenRow[]): Promise<HeldTokenRow[]> {
  const need = rows.filter((r) => !r.imageUrl || isUnrevealedArt(r.imageUrl));
  if (need.length === 0) return rows;
  const CONCURRENCY = 8;
  const fixes = new Map<string, string>();
  for (let i = 0; i < need.length; i += CONCURRENCY) {
    const slice = need.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (r) => {
        try {
          const img = await resolveTokenImage(NFT_CONTRACT_ADDRESS, r.tokenId);
          if (img && !isUnrevealedArt(img)) fixes.set(r.tokenId, img);
        } catch {
          /* keep existing */
        }
      })
    );
  }
  if (fixes.size === 0) return rows;
  return rows.map((r) => (fixes.has(r.tokenId) ? { ...r, imageUrl: fixes.get(r.tokenId)! } : r));
}

/** Token instances held by the vault (Blockscout token instances endpoint). */
async function fetchViaTokenInstances(vault: string): Promise<HeldTokenRow[]> {
  const rows: HeldTokenRow[] = [];
  let path = `/api/v2/tokens/${NFT_CONTRACT_ADDRESS}/instances?holder_address_hash=${vault}`;
  for (let page = 0; page < 25; page += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    const res = await fetch(`${BLOCKSCOUT_BASE}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "plank.love/1.0" },
      signal: ac.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Blockscout instances HTTP ${res.status}`);
    const data = (await res.json()) as {
      items?: Array<{
        id?: string;
        image_url?: string | null;
        media_url?: string | null;
        metadata?: { image?: string } | null;
      }>;
      next_page_params?: Record<string, string | number> | null;
    };
    for (const it of data.items || []) {
      if (it.id == null) continue;
      rows.push({
        tokenId: String(it.id),
        imageUrl: normalizeImage(it.image_url || it.media_url || it.metadata?.image),
      });
    }
    const next = data.next_page_params;
    if (!next || Object.keys(next).length === 0) break;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
    path = `/api/v2/tokens/${NFT_CONTRACT_ADDRESS}/instances?${qs.toString()}`;
  }
  return rows;
}

export async function getVaultHeldTokenIds(
  vaultAddress?: string | null
): Promise<string[]> {
  const rows = await getVaultHeldTokens(vaultAddress);
  return rows.map((r) => r.tokenId);
}

export async function getVaultHeldTokens(
  vaultAddress?: string | null
): Promise<HeldTokenRow[]> {
  const vault = resolveVaultAddress(vaultAddress);
  if (!vault) return [];
  const key = vault.toLowerCase();
  const hit = memCaches.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;

  const errors: string[] = [];

  // Path A: address NFT inventory
  try {
    const items = await fetchNftsHeldBy(vault);
    const nft = NFT_CONTRACT_ADDRESS.toLowerCase();
    const rows: HeldTokenRow[] = items
      .filter((it) => {
        const addr = it.token?.address_hash?.toLowerCase();
        return !addr || addr === nft;
      })
      .map((it) => ({
        tokenId: String(it.id),
        imageUrl: normalizeImage(it.image_url || it.media_url || it.metadata?.image),
      }));
    if (rows.length > 0) {
      const enriched = await enrichUnrevealedArt(rows);
      memCaches.set(key, { at: Date.now(), rows: enriched });
      void writeKv(vault, enriched);
      return enriched;
    }
    errors.push("address/nft returned 0 items");
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // Path B: token instances filtered by holder
  try {
    const rows = await fetchViaTokenInstances(vault);
    if (rows.length > 0) {
      const enriched = await enrichUnrevealedArt(rows);
      memCaches.set(key, { at: Date.now(), rows: enriched });
      void writeKv(vault, enriched);
      return enriched;
    }
    errors.push("token/instances returned 0 items");
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  if (hit?.rows?.length) return hit.rows;
  const stale = await readKv(vault);
  if (stale?.length) {
    memCaches.set(key, { at: Date.now(), rows: stale });
    return stale;
  }

  throw new Error(`Could not load vault holdings: ${errors.join(" | ")}`);
}
