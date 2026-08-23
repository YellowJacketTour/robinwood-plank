import { Interface } from "ethers";
import { postgresQuery, withPostgresTransaction } from "@/lib/postgres";
import { rpcCall } from "@/lib/market/multichain/discovery/evm-log-scan";
import { foreignRpcUrls } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { recordFloorObservation, updateCollectionSupplyFields } from "@/lib/market/multichain/store";

export const CRYPTOPUNKS_CONTRACT = "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb";
const CHAIN_SLUG = "eth-mainnet";
const VENUE_ID = "cryptopunks-native";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const SUPPLY = 10_000;
const BATCH_SIZE = 200;

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

export function decodePunkOffer(tokenId: number, success: boolean, returnData: string): CryptoPunkOffer | null {
  if (!success || !returnData || returnData === "0x") return null;
  const [isForSale, punkIndex, seller, minValue, onlySellTo] = punks.decodeFunctionResult("punksOfferedForSale", returnData);
  if (!isForSale || Number(punkIndex) !== tokenId) return null;
  return { tokenId: String(tokenId), seller: String(seller).toLowerCase(), minValue: String(minValue), onlySellTo: String(onlySellTo).toLowerCase() };
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
  await withPostgresTransaction(async (client) => {
    await client.query(`DELETE FROM plank_market_live_orders WHERE chain_slug = $1 AND venue_id = $2`, [CHAIN_SLUG, VENUE_ID]);
    if (offers.length) {
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
        [CHAIN_SLUG, VENUE_ID, CRYPTOPUNKS_CONTRACT, JSON.stringify(offers.map((offer) => ({
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

export async function syncCryptoPunksNativeBook(): Promise<{ listed: number; publicListed: number; floorWei: string | null; rpcUrl: string }> {
  const urls = foreignRpcUrls(CHAIN_SLUG);
  let lastError: unknown = new Error("No Ethereum RPC URL configured");
  for (const rpcUrl of urls) {
    try {
      const offers = await readBook(rpcUrl);
      await persistBook(offers);
      const publicOffers = offers.filter((offer) => /^0x0{40}$/.test(offer.onlySellTo));
      const floorWei = publicOffers.reduce<string | null>((floor, offer) => floor == null || BigInt(offer.minValue) < BigInt(floor) ? offer.minValue : floor, null);
      await updateCollectionSupplyFields(CHAIN_SLUG, CRYPTOPUNKS_CONTRACT, { listedCount: offers.length, totalSupply: SUPPLY });
      await recordFloorObservation(CHAIN_SLUG, CRYPTOPUNKS_CONTRACT, {
        priceAtomic: floorWei, currency: "ETH", marketplace: VENUE_ID,
        listedCount: offers.length, source: "cryptopunks-contract-state",
      });
      return { listed: offers.length, publicListed: publicOffers.length, floorWei, rpcUrl };
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
