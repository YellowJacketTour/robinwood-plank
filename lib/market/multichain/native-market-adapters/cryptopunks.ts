import { Interface } from "ethers";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";
import { rpcCall } from "@/lib/market/multichain/discovery/evm-log-scan";
import { foreignRpcUrls } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { recordFloorObservation, updateCollectionSupplyFields } from "@/lib/market/multichain/store";
import { computeGenericRaritySnapshot, type GenericRarityInput } from "@/lib/rarity-generic";
import { replaceForeignRarity, type ForeignTraitIndex } from "@/lib/market/multichain/foreign-rarity-store";
import { upsertCollectionTokenProjection } from "@/lib/market/multichain/collection-token-store";

export const CRYPTOPUNKS_CONTRACT = "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb";
const CHAIN_SLUG = "eth-mainnet";
const VENUE_ID = "cryptopunks-native";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const SUPPLY = 10_000;
const BATCH_SIZE = 200;
const ATTRIBUTES_CSV = "https://raw.githubusercontent.com/cryptopunksnotdead/punks.attributes/master/original/cryptopunks.csv";

const punks = new Interface([
  "function punksOfferedForSale(uint256) view returns (bool isForSale,uint256 punkIndex,address seller,uint256 minValue,address onlySellTo)",
]);
const multicall = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);

export type CryptoPunkOffer = {
  tokenId: string;
  seller: string;
  minValue: string;
  onlySellTo: string;
};

export function isPublicCryptoPunkAsk(offer: CryptoPunkOffer): boolean {
  return BigInt(offer.minValue) > 0n && /^0x0{40}$/.test(offer.onlySellTo);
}

export async function getCryptoPunksNativeBookStats(): Promise<{ listedCount: number; floorWei: string | null }> {
  const result = await postgresQuery<{ listed_count: string; floor_wei: string | null }>(
    `SELECT COUNT(*)::text AS listed_count, MIN(amount_atomic)::text AS floor_wei
     FROM plank_market_live_orders
     WHERE chain_slug = $1 AND venue_id = $2 AND side = 'ask'
       AND amount_atomic > 0
       AND COALESCE(raw_order->>'onlySellTo', '0x0000000000000000000000000000000000000000')
           = '0x0000000000000000000000000000000000000000'`,
    [CHAIN_SLUG, VENUE_ID]
  );
  return {
    listedCount: Number(result.rows[0]?.listed_count ?? 0),
    floorWei: result.rows[0]?.floor_wei ?? null,
  };
}

/** Durable current-state book for request paths; the request never scans 10k contract slots. */
export async function getCryptoPunksNativeBook(limit = 200): Promise<CryptoPunkOffer[]> {
  const result = await postgresQuery<{
    token_id: string; maker: string; amount_atomic: string; only_sell_to: string | null;
  }>(
    `SELECT token_id, maker, amount_atomic::text,
            raw_order->>'onlySellTo' AS only_sell_to
     FROM plank_market_live_orders
     WHERE chain_slug = $1 AND venue_id = $2 AND side = 'ask'
       AND amount_atomic > 0
       AND COALESCE(raw_order->>'onlySellTo', '0x0000000000000000000000000000000000000000')
           = '0x0000000000000000000000000000000000000000'
     ORDER BY amount_atomic ASC, token_id
     LIMIT $3`,
    [CHAIN_SLUG, VENUE_ID, Math.min(Math.max(limit, 1), 2_000)]
  );
  return result.rows.map((row) => ({
    tokenId: row.token_id,
    seller: row.maker,
    minValue: row.amount_atomic,
    onlySellTo: row.only_sell_to ?? "0x0000000000000000000000000000000000000000",
  }));
}

export function decodePunkOffer(tokenId: number, success: boolean, returnData: string): CryptoPunkOffer | null {
  if (!success || !returnData || returnData === "0x") return null;
  const [isForSale, punkIndex, seller, minValue, onlySellTo] = punks.decodeFunctionResult("punksOfferedForSale", returnData);
  if (!isForSale || Number(punkIndex) !== tokenId) return null;
  return { tokenId: String(tokenId), seller: String(seller).toLowerCase(), minValue: String(minValue), onlySellTo: String(onlySellTo).toLowerCase() };
}

/**
 * CryptoPunks has no ERC-721 tokenURI. Hydrate its immutable 10k trait
 * universe from the CC0 tabular reconstruction and reject the entire import
 * unless every canonical id is present exactly once.
 */
export async function syncCryptoPunksTraits(): Promise<{ indexed: number; traits: number }> {
  const response = await fetch(ATTRIBUTES_CSV, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`CryptoPunks attributes ${response.status}`);
  const lines = (await response.text()).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const items: GenericRarityInput[] = [];
  const images = new Map<string, string>();
  const seen = new Set<number>();
  for (const line of lines.slice(1)) {
    const columns = line.split(",").map((value) => value.trim());
    const tokenId = Number(columns[0]);
    if (!Number.isInteger(tokenId) || tokenId < 0 || tokenId >= SUPPLY || seen.has(tokenId)) continue;
    seen.add(tokenId);
    const traits = [
      { traitType: "Type", value: columns[1] },
      { traitType: "Gender", value: columns[2] },
      { traitType: "Skin Tone", value: columns[3] },
      { traitType: "Attribute Count", value: columns[4] },
      ...(columns.slice(5).join(",").split(" / ").map((value) => value.trim()).filter(Boolean)
        .map((value) => ({ traitType: "Attribute", value }))),
    ].filter((trait) => trait.value);
    items.push({
      tokenId: String(tokenId),
      name: `CryptoPunk #${tokenId}`,
      traits,
    });
    images.set(String(tokenId), `https://www.larvalabs.com/cryptopunks/cryptopunk${tokenId}.png`);
  }
  if (items.length !== SUPPLY || seen.size !== SUPPLY) {
    throw new Error(`CryptoPunks attributes incomplete: expected ${SUPPLY}, received ${items.length}`);
  }
  const traitIndex: ForeignTraitIndex = {};
  for (const item of items) for (const trait of item.traits) {
    (traitIndex[trait.traitType] ??= {})[trait.value] ??= [];
    traitIndex[trait.traitType][trait.value].push(item.tokenId);
  }
  const snapshot = { ...computeGenericRaritySnapshot(items), partial: false };
  await replaceForeignRarity(CHAIN_SLUG, CRYPTOPUNKS_CONTRACT, snapshot, traitIndex, ["cryptopunks"], images);
  // Mirror the rarity snapshot into plank_collection_tokens too, the same way
  // the generic OpenSea rarity-index-runner does for every collection it owns
  // (see rarity-index-runner.ts's own upsertCollectionTokenProjection calls
  // right after its replaceForeignRarity calls). The generic scaffold loop is
  // deliberately blocked from touching native-book collections like this one
  // (hasUnindexedNativeBook -- see venue-registry.ts), but that guard only
  // protects the WRITE path from a second, conflicting indexer; it was never
  // meant to leave rarity_rank/rarity_tier permanently NULL in the projection
  // table this adapter itself owns. Anything reading token.rarityRank/
  // rarityTier straight off /api/market/multichain/tokens or /token-search
  // (GlobalMarketHub's "Individual pieces" results, for one) was silently
  // blank for every native-book collection until this backfill exists.
  await upsertCollectionTokenProjection(CHAIN_SLUG, CRYPTOPUNKS_CONTRACT, {
    tokens: [...snapshot.byTokenId.values()].map((token) => ({
      tokenId: token.tokenId, name: token.name, imageUrl: images.get(token.tokenId) ?? null,
      rarityScore: token.score, rarityRank: token.rank,
      rarityPercentile: token.percentile, rarityTier: token.tier,
    })),
    expectedCount: items.length, partial: false,
    provenance: ["cryptopunks-native-book", "bespoke-information-content-rarity"], sourceObservedAt: new Date(),
  });
  return { indexed: items.length, traits: Object.values(traitIndex).reduce((sum, values) => sum + Object.keys(values).length, 0) };
}

async function readBook(rpcUrl: string): Promise<CryptoPunkOffer[]> {
  const offers: CryptoPunkOffer[] = [];
  for (let start = 0; start < SUPPLY; start += BATCH_SIZE) {
    const ids = Array.from({ length: Math.min(BATCH_SIZE, SUPPLY - start) }, (_, offset) => start + offset);
    const data = multicall.encodeFunctionData("aggregate3", [ids.map((id) => ({
      target: CRYPTOPUNKS_CONTRACT,
      allowFailure: true,
      callData: punks.encodeFunctionData("punksOfferedForSale", [id]),
    }))]);
    const raw = await rpcCall<string>(rpcUrl, "eth_call", [{ to: MULTICALL3, data }, "latest"]);
    const [results] = multicall.decodeFunctionResult("aggregate3", raw) as unknown as [Array<{ success: boolean; returnData: string }>];
    results.forEach((result, index) => {
      const offer = decodePunkOffer(ids[index], result.success, result.returnData);
      if (offer) offers.push(offer);
    });
  }
  return offers;
}

async function persistBook(offers: CryptoPunkOffer[]): Promise<void> {
  // The contract exposes both public asks and address-restricted private
  // offers through the same mapping. Only positive, unrestricted asks form
  // the public order book/floor; persisting private or zero-value records as
  // listings makes them look executable to every visitor when they are not.
  const publicOffers = offers.filter(isPublicCryptoPunkAsk);
  await withPostgresTransaction(async (client) => {
    await client.query(`DELETE FROM plank_market_live_orders WHERE chain_slug = $1 AND venue_id = $2`, [CHAIN_SLUG, VENUE_ID]);
    if (publicOffers.length) {
      await client.query(
        `INSERT INTO plank_market_live_orders
           (chain_slug, venue_id, order_id, side, collection_key, token_id, maker,
            currency_symbol, currency_decimals, amount_atomic, source_updated_at, raw_order)
         SELECT $1, $2, row.token_id, 'ask', $3, row.token_id, row.seller,
                'ETH', 18, row.min_value::numeric, NOW(),
                jsonb_build_object('onlySellTo', row.only_sell_to, 'source', 'punksOfferedForSale')
         FROM jsonb_to_recordset($4::jsonb)
           AS row(token_id text, seller text, min_value text, only_sell_to text)
         ON CONFLICT (chain_slug, venue_id, order_id) DO UPDATE SET
           maker = EXCLUDED.maker, amount_atomic = EXCLUDED.amount_atomic,
           source_updated_at = EXCLUDED.source_updated_at, raw_order = EXCLUDED.raw_order`,
        [CHAIN_SLUG, VENUE_ID, CRYPTOPUNKS_CONTRACT, JSON.stringify(publicOffers.map((offer) => ({
          token_id: offer.tokenId, seller: offer.seller, min_value: offer.minValue, only_sell_to: offer.onlySellTo,
        })))]
      );
    }
    await client.query(
      `INSERT INTO plank_market_coverage
         (chain_slug, venue_id, protocol, protocol_version, capability, status,
          indexed_through_timestamp, last_success_at, last_error, updated_at)
       VALUES ($1,$2,'cryptopunks-native','original','listings','indexed',NOW(),NOW(),NULL,NOW())
       ON CONFLICT (chain_slug, venue_id, protocol_version, capability) DO UPDATE SET
         status = 'indexed', indexed_through_timestamp = NOW(), last_success_at = NOW(),
         last_error = NULL, updated_at = NOW()`,
      [CHAIN_SLUG, VENUE_ID]
    );
  });
}

export async function syncCryptoPunksNativeBook(): Promise<{ listed: number; publicListed: number; floorWei: string | null; rpcUrl: string; traitIndexed: number }> {
  const urls = foreignRpcUrls(CHAIN_SLUG);
  let lastError: unknown = new Error("No Ethereum RPC URL configured");
  for (const rpcUrl of urls) {
    try {
      const offers = await readBook(rpcUrl);
      await persistBook(offers);
      const publicOffers = offers.filter(isPublicCryptoPunkAsk);
      const floorWei = publicOffers.reduce<string | null>((floor, offer) => floor == null || BigInt(offer.minValue) < BigInt(floor) ? offer.minValue : floor, null);
      await updateCollectionSupplyFields(CHAIN_SLUG, CRYPTOPUNKS_CONTRACT, { listedCount: publicOffers.length, totalSupply: SUPPLY });
      await recordFloorObservation(CHAIN_SLUG, CRYPTOPUNKS_CONTRACT, {
        priceAtomic: floorWei, currency: "ETH", marketplace: VENUE_ID,
        listedCount: publicOffers.length, source: "cryptopunks-contract-state",
      });
      const traits = await syncCryptoPunksTraits().catch(() => ({ indexed: 0, traits: 0 }));
      return { listed: offers.length, publicListed: publicOffers.length, floorWei, rpcUrl, traitIndexed: traits.indexed };
    } catch (error) {
      lastError = error;
    }
  }
  await postgresQuery(
    `INSERT INTO plank_market_coverage
       (chain_slug, venue_id, protocol, protocol_version, capability, status, last_error, updated_at)
     VALUES ($1,$2,'cryptopunks-native','original','listings','error',$3,NOW())
     ON CONFLICT (chain_slug, venue_id, protocol_version, capability) DO UPDATE SET
       status = 'error', last_error = EXCLUDED.last_error, updated_at = NOW()`,
    [CHAIN_SLUG, VENUE_ID, lastError instanceof Error ? lastError.message : String(lastError)]
  ).catch(() => undefined);
  throw lastError;
}
