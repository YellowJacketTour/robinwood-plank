import { postgresQuery } from "@/lib/postgres";
import { durableKv } from "@/lib/market/durable-kv";
import { rpcCall } from "@/lib/market/multichain/discovery/rpc-provider-pool";
import { chainManifest } from "@/lib/market/multichain/chains/manifest";

/**
 * Creator identity as its own cell with its own lane (2026-09-07, owner:
 * "all the verified checks are falling off collections we for sure know
 * the socials for so something fundamental is broken").
 *
 * What was fundamentally broken: the hub's known-creator check reads
 * creator_handle / creator_ens, and the ONLY writer of those was the rarity
 * index runner, as a side effect of indexing a collection once. A finished
 * collection never ran it again, so any purge, rebuild or row re-creation
 * left identity empty forever (BAYC: handle, address and ENS all null on
 * production while its floor, listed, volume and holders were current).
 *
 * This lane owns identity. Sources, keyless first:
 *   - CoinGecko NFT detail `links.twitter` (every family; paced like parity)
 *   - Magic Eden collection detail `twitter` (Solana)
 *   - on-chain `owner()` (Ownable) over the public RPC pool, then ENS reverse
 * An attempt is remembered for 7 days so a collection with no public
 * identity is not re-queried every rotation.
 */
const ATTEMPT_TTL_SEC = 7 * 24 * 3600;
// The CoinGecko pace (one call per 6.5s keyless) is the ceiling, so a pass
// should use its whole budget rather than stopping at an arbitrary 10.
// Live 2026-09-07: ~11 handles filled per pass against 25,000 Ethereum rows
// alone -- the owner sees "tons of verifieds missing" because the lane is
// simply too slow, not because it fails. On-chain owner() and ENS need no
// third-party pacing at all, so an EVM row costs a fraction of a CoinGecko
// call and many rows resolve without touching CoinGecko.
// A row that resolves from on-chain owner() + ENS costs nothing against any
// third-party limit, so the old flat 60 throttled the FREE path to the pace
// of the paid one. Two budgets: how many rows a pass may look at, and how
// many of them may spend the 6.5s CoinGecko slot. Measured 2026-09-07 the
// lane filled ~11 handles per pass against 25,000 Ethereum rows -- that is
// ~6 years to cover Ethereum alone, which is why the owner sees the badges
// as broken rather than merely slow.
const PER_PASS = 400;
/** Rows per pass that may spend a paced CoinGecko call. */
const CG_PER_PASS = 8;

const attemptKey = (chain: string, key: string) => `plank:creator-attempt:${chain}:${key.toLowerCase()}`;

let cgNextAt = 0;
async function paceCoinGecko(): Promise<void> {
  const gapMs = process.env.COINGECKO_API_KEY?.trim() ? 2_200 : 6_500;
  const wait = cgNextAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  cgNextAt = Date.now() + gapMs;
}

/**
 * Accounts that belong to a marketplace or aggregator, never to a
 * collection's creator. CoinGecko returns the marketplace link when a
 * collection has no creator social, which badged Gemesis as "openseapro".
 */
export const MARKETPLACE_HANDLES = [
  "opensea", "openseapro", "opensea_io", "magiceden", "blur_io", "blureth",
  "looksrare", "x2y2_io", "rarible", "coingecko", "nftgo", "tensor_hq",
];

export function handleFromTwitterUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /(?:twitter\.com|x\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i.exec(url);
  const h = m?.[1] ?? (/^@?([A-Za-z0-9_]{1,15})$/.exec(url.trim())?.[1] ?? null);
  if (!h) return null;
  const low = h.toLowerCase();
  if (["home", "share", "intent", "search", "i", "hashtag"].includes(low)) return null;
  // A marketplace's own account is not the collection's creator. Live
  // 2026-09-07: Gemesis came back as "openseapro" because CoinGecko lists
  // the marketplace link for collections with no creator social. A wrong
  // checkmark is worse than none -- the badge claims "this is who made it".
  if (MARKETPLACE_HANDLES.includes(low)) return null;
  return h;
}

async function getJson<T>(url: string, headers: Record<string, string> = { accept: "application/json" }): Promise<T | null> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

export async function readCoinGeckoTwitter(chainSlug: string, contractAddress: string, coingeckoId?: string | null): Promise<string | null> {
  const platform = chainManifest(chainSlug)?.coingeckoPlatform ?? null;
  const url = coingeckoId
    ? `https://api.coingecko.com/api/v3/nfts/${encodeURIComponent(coingeckoId)}`
    : platform
      ? `https://api.coingecko.com/api/v3/nfts/${encodeURIComponent(platform)}/contract/${encodeURIComponent(contractAddress)}`
      : null;
  if (!url) return null;
  await paceCoinGecko();
  const key = process.env.COINGECKO_API_KEY?.trim();
  const body = await getJson<{ links?: { twitter?: string | null } }>(url, key ? { accept: "application/json", "x-cg-demo-api-key": key } : { accept: "application/json" });
  return handleFromTwitterUrl(body?.links?.twitter);
}

export async function readMagicEdenTwitter(symbol: string): Promise<string | null> {
  const body = await getJson<{ twitter?: string | null }>(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}`);
  return handleFromTwitterUrl(body?.twitter);
}

/** `owner()` on an Ownable contract, keyless over the public RPC pool; null when not implemented. */
export async function readContractOwner(chainSlug: string, contractAddress: string): Promise<string | null> {
  try {
    const { result } = await rpcCall<string>(chainSlug, "eth_call", [{ to: contractAddress, data: "0x8da5cb5b" }, "latest"]);
    if (!result || result.length < 66) return null;
    const addr = "0x" + result.slice(-40);
    return /^0x0{40}$/.test(addr) ? null : addr.toLowerCase();
  } catch {
    return null;
  }
}

export type CreatorIdentityResult = { chainSlug: string; considered: number; filledHandle: number; filledAddress: number; filledEns: number; skipped: number };

export async function runCreatorIdentityLane(chainSlug: string, perPass = PER_PASS, deadline = Date.now() + 80_000): Promise<CreatorIdentityResult> {
  const out: CreatorIdentityResult = { chainSlug, considered: 0, filledHandle: 0, filledAddress: 0, filledEns: 0, skipped: 0 };
  const rows = await postgresQuery<{ contract_address: string; alias_symbol: string | null; creator_handle: string | null; creator_address: string | null; creator_ens: string | null }>(
    `SELECT c.contract_address, c.alias_symbol, c.creator_handle, c.creator_address, c.creator_ens
       FROM plank_multichain_collections c
       JOIN plank_multichain_snapshots s ON s.collection_id = c.id
      -- THE BADGE IS (handle OR ens). A row holding a good handle but no ENS
      -- already shows its checkmark, yet handle IS NULL OR ens IS NULL
      -- re-selected it on every single pass -- so those rows consumed the
      -- 60-row budget forever while the rows with NO identity at all, the
      -- ones actually rendering a missing badge, queued behind them.
      -- Ask for what is actually missing.
      WHERE c.chain_slug = $1 AND c.creator_handle IS NULL AND c.creator_ens IS NULL
        AND (s.floor_price_wei IS NOT NULL OR s.volume_24h_wei IS NOT NULL OR s.holder_count IS NOT NULL)
      ORDER BY s.volume_24h_wei DESC NULLS LAST, s.holder_count DESC NULLS LAST
      LIMIT $2`,
    [chainSlug, perPass * 4]
  );
  const { updateCollectionDisplay } = await import("@/lib/market/multichain/store");

  // Retract handles stored BEFORE the marketplace filter shipped. The lane
  // only fills NULL fields, so a wrong value already in the table would never
  // be revisited -- Gemesis kept showing "openseapro" after the filter landed.
  // A verified badge asserts authorship; a wrong one has to be withdrawn.
  const scrubbed = await postgresQuery(
    `UPDATE plank_multichain_collections
        SET creator_handle = NULL
      WHERE chain_slug = $1 AND creator_handle IS NOT NULL
        AND lower(creator_handle) = ANY($2::text[])`,
    [chainSlug, MARKETPLACE_HANDLES]
  ).catch(() => ({ rowCount: 0 }));
  if ((scrubbed.rowCount ?? 0) > 0) out.skipped += scrubbed.rowCount ?? 0;
  const isEvm = chainSlug !== "solana-mainnet" && chainSlug !== "bitcoin-mainnet";
  let cgSpent = 0;
  for (const r of rows.rows) {
    if (out.considered >= perPass || Date.now() > deadline - 8_000) break;
    if (await durableKv.get(attemptKey(chainSlug, r.contract_address))) {
      out.skipped += 1;
      continue;
    }
    out.considered += 1;
    let handle: string | null = r.creator_handle;
    let address: string | null = r.creator_address;
    let ens: string | null = r.creator_ens;
    // Free, unpaced sources first: owner() over the public RPC pool and an
    // ENS reverse lookup cost nothing against anyone's rate limit, so a row
    // that resolves this way never spends a CoinGecko slot.
    if (isEvm && !address) address = await readContractOwner(chainSlug, r.contract_address);
    if (isEvm && address && !ens && chainSlug === "eth-mainnet") {
      const { resolveEnsName } = await import("@/lib/market/multichain/ens");
      ens = await resolveEnsName(address).catch(() => null);
    }
    if (!handle && chainSlug === "solana-mainnet" && r.alias_symbol) handle = await readMagicEdenTwitter(r.alias_symbol);
    // Only spend the paced vendor call when the free sources produced nothing.
    // Only spend the paced vendor call when the free sources produced
    // nothing AND the pass still has vendor budget. Without this cap a
    // single pass of 400 rows would sit in CoinGecko's 6.5s pacer for 43
    // minutes and be killed by the lane timeout, registering nothing --
    // the same shape as the ow-catalog lane that could not finish 4 pages.
    if (!handle && !ens && cgSpent < CG_PER_PASS) {
      cgSpent += 1;
      handle = await readCoinGeckoTwitter(chainSlug, r.contract_address, isEvm ? null : r.alias_symbol ?? r.contract_address);
    }
    const changed = (handle && handle !== r.creator_handle) || (address && address !== r.creator_address) || (ens && ens !== r.creator_ens);
    if (changed) {
      await updateCollectionDisplay(chainSlug, r.contract_address, { name: null, imageUrl: null, creatorHandle: handle, creatorAddress: address, creatorEns: ens });
      if (handle && handle !== r.creator_handle) out.filledHandle += 1;
      if (address && address !== r.creator_address) out.filledAddress += 1;
      if (ens && ens !== r.creator_ens) out.filledEns += 1;
    }
    // A row we never actually ASKED about (vendor budget spent) must not be
    // remembered as a failed attempt for 7 days -- that would turn a
    // throughput cap into a week-long blackout for exactly the rows the
    // badge is missing on. Only a real, completed attempt is cached.
    const askedEverything = handle != null || ens != null || cgSpent <= CG_PER_PASS;
    if (askedEverything) {
      await durableKv.set(attemptKey(chainSlug, r.contract_address), { at: new Date().toISOString(), handle, address, ens }, { ex: ATTEMPT_TTL_SEC });
    }
  }
  return out;
}
