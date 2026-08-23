/**
 * Alchemy NFT API adapter -- covers any EVM chain Alchemy indexes (Ethereum,
 * Polygon, Arbitrum, Base, Optimism, and others; NOT Solana or non-EVM
 * chains, which need their own adapter -- see this directory's other files
 * as they're added).
 *
 * Verified live against the real endpoint before writing this (not assumed
 * from memory): getContractMetadata and getFloorPrice both confirmed working
 * with Alchemy's public "demo" key against Bored Ape Yacht Club
 * (0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d) on 2026-08-17. The "demo" key
 * is Alchemy's own shared, heavily-rate-limited docs key -- fine for proving
 * this adapter works, NOT a production credential. Set ALCHEMY_API_KEY for
 * real use; sync.ts logs a warning (not a hard failure) when it falls back
 * to "demo", so a misconfigured deploy is visible in logs rather than
 * silently rate-limited into uselessness.
 */
import type { ChainAdapter, CollectionSnapshot } from "@/lib/market/multichain/types";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { checkSourceBudget, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
// Dynamically imported (not a top-level import) because control-plane.ts
// pulls in lib/postgres.ts's real `pg` client, which is server-only --
// this file is reachable from CLIENT code via foreign-chain-registry.ts ->
// wallet.ts -> wallet-context.tsx -> app/layout.tsx. A top-level import
// here leaked `pg` into the browser bundle and broke the client build
// (real error: "Module not found: Can't resolve 'util/types'" in
// node_modules/pg/lib/utils.js). A dynamic import inside each async
// function defers resolution to runtime, server-side only, and never gets
// bundled for the browser.
type ControlPlane = typeof import("@/lib/market/multichain/control-plane");
let controlPlanePromise: Promise<ControlPlane> | null = null;
function controlPlane(): Promise<ControlPlane> {
  controlPlanePromise ??= import("@/lib/market/multichain/control-plane");
  return controlPlanePromise;
}

const ALCHEMY_NFT_SOURCE = "alchemy-nft";
const ALCHEMY_NFT_PROVIDER_ACCOUNT = "alchemy-nft:default";
/**
 * No DAILY_CEILING entry exists for "alchemy-nft" in source-budget.ts --
 * that module only tracks this source's monthly-quota JAIL (see
 * jailAlchemyNftUntilMonthReset below), never a daily call ceiling.
 * rpc-meter.ts also carries no daily/monthly ceiling constant to defer
 * to -- it is pure compute-unit metering with no gate of its own.
 *
 * The real, documented Alchemy constraint for this key is CU-based (the
 * same 30M CU/month free-tier figure alchemy-key-pool.ts's own
 * ALCHEMY_DAILY_ALLOWANCE derives from) and is already enforced by the real
 * monthly-quota jail below (jailAlchemyNftUntilMonthReset, triggered off a
 * real 429/quota response) -- that is the actual safety valve. The
 * previous value here (2,000/day) was an APPROXIMATED request-count number
 * with no real per-request citation, self-admittedly "not a claim that
 * 2,000/day is Alchemy's real documented limit," yet it still gated real
 * requests via reserveProviderCapacity below every single day regardless of
 * whether the real CU quota was anywhere near exhausted. Per the same "no
 * self-imposed ceiling without a real citation" fix already applied to
 * ordinalswallet-collection-scan.ts and hydrate-all-collection-art.ts's
 * magiceden-solana lane, this is now set far above any realistic real
 * usage so it can never actually block a request -- only the real,
 * reproduced monthly-quota jail does that now.
 */
const ALCHEMY_NFT_DAILY_ALLOWANCE = 100_000_000_000;

function nextUtcMonthStartMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function jailAlchemyNftUntilMonthReset(): void {
  recordSourceFailure(ALCHEMY_NFT_SOURCE, true, Math.max(60_000, nextUtcMonthStartMs() - Date.now()));
}

function assertAlchemyNftNotJailed(): void {
  const gate = checkSourceBudget(ALCHEMY_NFT_SOURCE);
  if (!gate.allowed) {
    throw new Error(`alchemy-nft: jailed after HTTP 429 (monthly quota); skipping`);
  }
}

function isAlchemyQuotaStatus(status: number, bodyText: string): boolean {
  if (status === 429) return true;
  return /monthly capacity|capacity limit exceeded|too many requests|rate limit|quota/i.test(bodyText);
}

// ALCHEMY_NETWORK_SUBDOMAIN and apiKey() now live in alchemy-network.ts --
// a client-safe, dependency-free file, split out specifically so
// foreign-chain-registry.ts (client-reachable) never has to import this
// file (server-only, via control-plane.ts -> lib/postgres.ts's real `pg`
// client) just to get two pure constants. Re-exported here for any
// existing caller that still imports them from this file's own path.
export { ALCHEMY_NETWORK_SUBDOMAIN, apiKey } from "@/lib/market/multichain/adapters/alchemy-network";
import { ALCHEMY_NETWORK_SUBDOMAIN, apiKey } from "@/lib/market/multichain/adapters/alchemy-network";

function baseUrl(chainSlug: string): string {
  const subdomain = ALCHEMY_NETWORK_SUBDOMAIN[chainSlug];
  if (!subdomain) {
    throw new Error(
      `alchemy-nft adapter has no network mapping for chainSlug "${chainSlug}" -- ` +
        `add it to ALCHEMY_NETWORK_SUBDOMAIN once confirmed live against Alchemy's docs.`
    );
  }
  return `https://${subdomain}.g.alchemy.com/nft/v3/${apiKey()}`;
}

type AlchemyContractMetadata = {
  name?: string | null;
  totalSupply?: string | null;
  /** Real on-chain deployer address, from Alchemy's own contract metadata -- never fabricated. */
  contractDeployer?: string | null;
  openSeaMetadata?: {
    collectionName?: string | null;
    imageUrl?: string | null;
    externalUrl?: string | null;
    floorPrice?: number | null;
  } | null;
};

type AlchemyFloorPriceMarketplace = {
  floorPrice?: number | null;
  priceCurrency?: string | null;
  error?: string | null;
};

type AlchemyFloorPriceResponse = {
  openSea?: AlchemyFloorPriceMarketplace | null;
  looksRare?: AlchemyFloorPriceMarketplace | null;
};

async function fetchJson<T>(url: string): Promise<T> {
  assertAlchemyNftNotJailed();
  const { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } = await controlPlane();
  const window = utcDayWindow(ALCHEMY_NFT_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(ALCHEMY_NFT_PROVIDER_ACCOUNT, window))) {
    throw new Error("alchemy-nft: durable daily ceiling");
  }
  let settled = false;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    await settleProviderCapacity(ALCHEMY_NFT_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      if (isAlchemyQuotaStatus(res.status, bodyText)) {
        jailAlchemyNftUntilMonthReset();
      }
      throw new Error(`alchemy-nft: ${res.status} ${res.statusText} fetching ${url}`);
    }
    return (await res.json()) as T;
  } catch (error) {
    if (!settled) await settleProviderCapacity(ALCHEMY_NFT_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    throw error;
  }
}

type OwnersForContractResponse = { owners: string[]; pageKey?: string | null };

/**
 * Real distinct-owner count via Alchemy's getOwnersForContract. Verified
 * live 2026-08-20: the response's own documented `totalCount` field comes
 * back null (not populated) -- there is no cheap count-only mode, the full
 * owners array (already deduped, one entry per unique holder) has to be
 * paginated and counted. For a real collection this size (BAYC, ~10k
 * supply) that was a single call, 5,597 owners, pageKey null -- cheap
 * enough for ON-DEMAND use (one collection at a time, when its detail page
 * is viewed), but NOT wired into fetchSnapshot/fetchSnapshotsBatch, which
 * run in bulk over every one of thousands of tracked collections every
 * sync pass -- that would multiply this call by the whole index for no
 * real reason, since a rankings-table row doesn't need a live holder count.
 * The real termination signal is Alchemy's own pageKey cursor going null --
 * that's what actually marks end-of-data, not a page count. A tuned "20
 * pages" (~10k owners at ~500/page) is well within reach of real large
 * collections (widely-held PFP/gaming collections routinely clear that),
 * which would silently truncate the holder count. MAX_OWNER_PAGES here is
 * only a crash guard against a malformed response that never nulls its
 * pageKey -- set far above anything a real collection could ever hit.
 */
const MAX_OWNER_PAGES = 100_000;

export async function fetchHolderCount(chainSlug: string, contractAddress: string): Promise<number | null> {
  const base = baseUrl(chainSlug);
  let owners = new Set<string>();
  let pageKey: string | null = null;
  for (let page = 0; page < MAX_OWNER_PAGES; page++) {
    const url = new URL(`${base}/getOwnersForContract`);
    url.searchParams.set("contractAddress", contractAddress);
    url.searchParams.set("withTokenBalances", "false");
    if (pageKey) url.searchParams.set("pageKey", pageKey);
    const data = await fetchJson<OwnersForContractResponse>(url.toString());
    for (const owner of data.owners ?? []) owners.add(owner.toLowerCase());
    pageKey = data.pageKey ?? null;
    if (!pageKey) break;
  }
  return owners.size > 0 ? owners.size : null;
}

/**
 * A human-currency floor price (Alchemy reports these as decimal ETH/MATIC/
 * etc, not wei) converted to a wei-equivalent string for storage alongside
 * the Robinhood-chain ledger's own NUMERIC(78,0) price columns -- so every
 * price in the multichain snapshot table is comparable without a per-row
 * unit lookup. Assumes 18 decimals, true for every network this adapter
 * currently maps (ETH-denominated L1s/L2s); a non-18-decimal native token
 * would need its own conversion here, not a silent wrong answer.
 */
/**
 * Real, confirmed live 2026-08-18: a base-mainnet contract's Alchemy floor
 * response decoded to 2.592e+29 "ETH" -- obviously corrupt upstream data
 * (more ETH than will ever exist), not a real floor. Unguarded, that
 * reached Postgres as literal scientific-notation text and failed the
 * NUMERIC(78,0) column with "invalid input syntax for type bigint". 10
 * million ETH-equivalent is comfortably above any real floor price this
 * app will ever see (ETH's own total supply is ~120M) while still well
 * below the corrupt value -- a sanity ceiling, not a business rule.
 */
const MAX_PLAUSIBLE_FLOOR_ETH = 10_000_000;

/**
 * Same class of bug as MAX_PLAUSIBLE_FLOOR_ETH above, confirmed live
 * 2026-08-19 on real arb-mainnet contracts: `metadata.totalSupply` is a
 * string Alchemy passes through from whatever the contract's own
 * totalSupply() (or an indexer artifact) reports, with no sanity bound --
 * seen returning "1e+24", a 6.8e7-magnitude float artifact, and
 * 10000000000000000000 (1e19). `total_supply` is a Postgres BIGINT column
 * (max ~9.22e18), and Number(hugeString).toString() serializes to
 * scientific-notation text ("1e+24") once magnitude crosses 1e21, which
 * BIGINT's input parser rejects outright regardless of magnitude -- both
 * failure modes hit the same real INSERT and blocked the sync entirely for
 * every affected contract, not just clamped one bad value. No real NFT
 * collection has anywhere near this many tokens (the largest legitimate
 * collections this app tracks run in the tens of thousands), so this is a
 * sanity ceiling on a corrupt/malicious contract, not a business rule.
 */
const MAX_PLAUSIBLE_TOTAL_SUPPLY = 100_000_000;

function toWeiString(decimalAmount: number): string | null {
  if (!Number.isFinite(decimalAmount) || decimalAmount <= 0 || decimalAmount > MAX_PLAUSIBLE_FLOOR_ETH) return null;
  // Avoid floating-point drift on the multiplication by working in
  // fixed-point: shift 18 decimals via string math on a scaled integer.
  const scaled = Math.round(decimalAmount * 1e9); // 9 of the 18 decimals now integral
  return (BigInt(scaled) * BigInt(1_000_000_000)).toString(); // remaining 1e9 as a bigint multiply
}

/** Picks the lowest real (non-error, positive) floor across marketplaces. */
function pickLowestFloor(
  floors: AlchemyFloorPriceResponse
): { priceWei: string | null; currency: string | null; marketplace: string | null } {
  const candidates: Array<[string, AlchemyFloorPriceMarketplace | null | undefined]> = [
    ["opensea", floors.openSea],
    ["looksrare", floors.looksRare],
  ];
  let best: { priceWei: string; currency: string; marketplace: string; raw: number } | null = null;
  for (const [marketplace, entry] of candidates) {
    if (!entry || entry.error || entry.floorPrice == null) continue;
    const priceWei = toWeiString(entry.floorPrice);
    if (!priceWei) continue;
    if (!best || entry.floorPrice < best.raw) {
      best = { priceWei, currency: entry.priceCurrency ?? "ETH", marketplace, raw: entry.floorPrice };
    }
  }
  return best
    ? { priceWei: best.priceWei, currency: best.currency, marketplace: best.marketplace }
    : { priceWei: null, currency: null, marketplace: null };
}

/**
 * Alchemy's own openSeaMetadata pass-through carries a real, confirmed
 * upstream data bug: some collections' imageUrl/externalUrl/twitterUsername
 * fields come back as the LITERAL 4-character string "null" (and
 * bannerImageUrl similarly) rather than a real JSON null -- verified live
 * 2026-08-19 via a direct getContractMetadata call for a real registered
 * Base collection (0x76c346...) that returned `"imageUrl": "null"`. This is
 * dirty data OpenSea's own indexer is passing through, not a bug in this
 * app's own code -- but it's exactly what broke Next's <Image> component
 * ("invalid src prop") on the collection detail page, since a truthy
 * 4-char string sails right past every `!imageUrl` falsy check this app
 * had. Sanitized once, here, at the source, so every downstream reader
 * (collection detail pages, the hub, the rankings table) never has to
 * special-case this upstream quirk itself.
 */
function cleanMetadataString(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || trimmed.toLowerCase() === "undefined") return null;
  return trimmed;
}

/**
 * Batch metadata resolution -- getContractMetadataBatch, up to 100
 * contracts per call (Alchemy's own documented cap). Built specifically
 * to fix a real, measured bottleneck: HyperSync discovery
 * (hypersync-evm-scan.ts) can surface 1,000+ candidates in one pass, and
 * resolving them one at a time via fetchSnapshot took ~90 seconds for
 * ~1,350 candidates on eth-mainnet alone, confirmed live 2026-08-20. This
 * collapses that into one HTTP round-trip per 100 contracts.
 *
 * Verified live against the real endpoint before writing this, not
 * assumed from docs (which had it wrong on two points): the response
 * wraps in `{ contracts: [...] }`, NOT a bare array, and the field is
 * `openSeaMetadata` (capital S) -- exactly matching AlchemyContractMetadata
 * above, not the lowercase the docs page's own summary showed. Bonus found
 * live: openSeaMetadata.floorPrice is bundled in this same response, so
 * this one call replaces BOTH fetchSnapshot's getContractMetadata AND its
 * separate getFloorPrice call for every contract in the batch.
 */
const BATCH_SIZE = 100;

export async function fetchSnapshotsBatch(
  chainSlug: string,
  contractAddresses: string[]
): Promise<Map<string, CollectionSnapshot>> {
  assertAlchemyNftNotJailed();
  const base = baseUrl(chainSlug);
  const results = new Map<string, CollectionSnapshot>();

  for (let i = 0; i < contractAddresses.length; i += BATCH_SIZE) {
    const chunk = contractAddresses.slice(i, i + BATCH_SIZE);
    const { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } = await controlPlane();
    const window = utcDayWindow(ALCHEMY_NFT_DAILY_ALLOWANCE);
    if (!(await reserveProviderCapacity(ALCHEMY_NFT_PROVIDER_ACCOUNT, window))) {
      throw new Error("alchemy-nft: durable daily ceiling");
    }
    let res: Response;
    let settled = false;
    try {
      res = await fetch(`${base}/getContractMetadataBatch`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ contractAddresses: chunk }),
      });
      await settleProviderCapacity(ALCHEMY_NFT_PROVIDER_ACCOUNT, window, 1, true);
      settled = true;
    } catch (error) {
      if (!settled) await settleProviderCapacity(ALCHEMY_NFT_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
      throw error;
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      if (isAlchemyQuotaStatus(res.status, bodyText)) {
        jailAlchemyNftUntilMonthReset();
      }
      throw new Error(`alchemy-nft: ${res.status} ${res.statusText} fetching getContractMetadataBatch`);
    }
    const data = (await res.json()) as { contracts: (AlchemyContractMetadata & { address: string })[] };
    for (const metadata of data.contracts ?? []) {
      const totalSupply = metadata.totalSupply != null ? Number(metadata.totalSupply) : null;
      const openSea = metadata.openSeaMetadata as
        | (AlchemyContractMetadata["openSeaMetadata"] & { floorPrice?: number | null })
        | null
        | undefined;
      const floorPriceWei = openSea?.floorPrice != null ? toWeiString(openSea.floorPrice) : null;
      // OpenSea quotes floor price in each chain's own native token (POL on
      // Polygon, BNB on BSC, AVAX on Avalanche, ETH elsewhere) -- hardcoding
      // "ETH" here mislabeled every non-ETH-native chain's floor. Real fix:
      // the same per-chain symbol foreign-chain-registry.ts already carries
      // for on-chain trading, reused here for display.
      const nativeSymbol = foreignChainByChainSlug(chainSlug)?.nativeCurrencySymbol ?? "ETH";
      results.set(metadata.address.toLowerCase(), {
        name: cleanMetadataString(openSea?.collectionName) ?? cleanMetadataString(metadata.name),
        imageUrl: cleanMetadataString(openSea?.imageUrl),
        externalUrl: cleanMetadataString(openSea?.externalUrl),
        floorPriceWei,
        floorPriceCurrency: floorPriceWei != null ? nativeSymbol : null,
        floorPriceMarketplace: floorPriceWei != null ? "opensea" : null,
        totalSupply:
          Number.isFinite(totalSupply) && totalSupply! > 0 && totalSupply! <= MAX_PLAUSIBLE_TOTAL_SUPPLY
            ? totalSupply
            : null,
        listedCount: null,
        creatorAddress: cleanMetadataString(metadata.contractDeployer),
        creatorHandle: null,
      });
    }
  }
  return results;
}

export const alchemyNftAdapter: ChainAdapter = {
  name: "alchemy-nft",
  async fetchSnapshot({ chainSlug, contractAddress }): Promise<CollectionSnapshot> {
    const base = baseUrl(chainSlug);
    const [metadata, floors] = await Promise.all([
      fetchJson<AlchemyContractMetadata>(
        `${base}/getContractMetadata?contractAddress=${contractAddress}`
      ),
      fetchJson<AlchemyFloorPriceResponse>(
        `${base}/getFloorPrice?contractAddress=${contractAddress}`
      ).catch(() => ({}) as AlchemyFloorPriceResponse), // floor pricing is best-effort, metadata is not
    ]);

    const floor = pickLowestFloor(floors);
    const totalSupply = metadata.totalSupply != null ? Number(metadata.totalSupply) : null;

    return {
      name: cleanMetadataString(metadata.openSeaMetadata?.collectionName) ?? cleanMetadataString(metadata.name),
      imageUrl: cleanMetadataString(metadata.openSeaMetadata?.imageUrl),
      externalUrl: cleanMetadataString(metadata.openSeaMetadata?.externalUrl),
      floorPriceWei: floor.priceWei,
      floorPriceCurrency: floor.currency,
      floorPriceMarketplace: floor.marketplace,
      totalSupply:
        Number.isFinite(totalSupply) && totalSupply! > 0 && totalSupply! <= MAX_PLAUSIBLE_TOTAL_SUPPLY
          ? totalSupply
          : null,
      // Alchemy's NFT API does not expose a live listed-count in these two
      // calls -- left null rather than guessed. A future adapter revision
      // could add getNFTsForContract pagination totals if this matters.
      listedCount: null,
      creatorAddress: cleanMetadataString(metadata.contractDeployer),
      creatorHandle: null,
    };
  },
};
