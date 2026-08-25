/**
 * Real recent activity (sales, transfers) for ONE collection on a foreign
 * chain -- the Activity-tab equivalent for the multichain surface.
 *
 * Live-verified 2026-08-18 against GRiBBiTS on Base:
 * GET /events/collection/{slug}?event_type=sale&event_type=transfer returns
 * real asset_events with a real transaction hash, real payment amount, and
 * real buyer/seller/from/to addresses -- confirmed with a real API key
 * (unauthenticated requests get a clean 401, not silently-empty data, so a
 * misconfigured deployment fails loud here rather than showing a fake
 * "no activity" state).
 */
import { NextRequest, NextResponse } from "next/server";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { resolveOpenSeaCollectionSlug } from "@/lib/market/multichain/trading/foreign-orders";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { getCollectionAsync } from "@/lib/market/collections-server";
import { TRANSFER_TOPIC, rpcCall } from "@/lib/market/multichain/discovery/evm-log-scan";
import { ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";
import { publicError, rateLimit } from "@/lib/security";
import { isSolanaChainSlug, isBitcoinChainSlug, isRobinhoodChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { activityValue } from "@/lib/market/activity-value";
import { readSeaportFillHistory } from "@/lib/market/multichain/seaport-fill-history";
import { readLedgerActivity } from "@/lib/market/multichain/ledger-activity";
import { isCompleteVenueCoverage, venuesForChain } from "@/lib/market/multichain/venue-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPENSEA = "https://api.opensea.io/api/v2";

function venueCoverage(chainSlug: string) {
  const venues = venuesForChain(chainSlug);
  return {
    completeMarketHistory: isCompleteVenueCoverage(venues),
    venues: venues.map(({ id, label, protocol, versions, capabilities, coverage, notes }) => ({
      id, label, protocol, versions, capabilities, coverage, notes,
    })),
  };
}

/**
 * How far back a Robinhood-Chain activity read scans, in blocks. There is no
 * permanent ledger for an arbitrary auto-discovered Robinhood-Chain
 * collection the way readChainActivity() has for RobinWood itself
 * (lib/market/chain-events.ts's own `contract` field comment: "Only
 * RobinWood is indexed under source='nft' today") -- so this reads real,
 * live Transfer logs directly from the chain instead, the same rpcCall/
 * TRANSFER_TOPIC primitives robinhood-chain-scan.ts already uses for
 * discovery. Bounded so one request can't fan out into an unbounded
 * eth_getLogs scan.
 *
 * WAS 50,000 -- a real, live-verified bug, not just a conservative default.
 * Robinhood Chain (chainId 4663) produces blocks far faster than a typical
 * L1/L2: live-checked 2026-08-23 by comparing eth_getBlockByNumber
 * timestamps ~60,178 blocks apart, that span covered barely 100 real
 * minutes (~7 blocks/sec). 50,000 blocks is therefore only ~2 hours of real
 * activity -- MUGS (0xab75f3d72509cd3b3a386a03de2b82854f0060e5)'s most
 * recent real on-chain transfer, live-confirmed via eth_getLogs, sat right
 * outside that window (~100 minutes old), so its Activity tab rendered
 * empty even though real, recent activity genuinely existed on-chain.
 * 1,000,000 blocks (~40 real hours) is confirmed live-safe as a SINGLE
 * eth_getLogs call against this exact address/topic filter (84 real logs
 * back in 89ms); 5,000,000 blocks in one call hits this RPC's own
 * `"log query timed out"` error, so this stays address-filtered and
 * single-call rather than chunking further out -- honest coverage
 * improvement over the old 2-hour window, not a claim of full history (that
 * still needs a real permanent ledger, same as RobinWood has).
 */
const ACTIVITY_SCAN_BLOCKS = 1_000_000;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type RawTransferLog = {
  address: string;
  topics: string[];
  transactionHash: string;
  blockNumber: string;
};

function topicToAddress(topic: string): string {
  return "0x" + topic.slice(-40);
}

type OpenSeaEvent = {
  event_type: "sale" | "transfer" | string;
  event_timestamp: number;
  transaction: string | null;
  payment?: { quantity: string; token_address: string; decimals: number; symbol: string } | null;
  seller?: string | null;
  buyer?: string | null;
  from_address?: string | null;
  to_address?: string | null;
  nft?: { identifier?: string; name?: string; image_url?: string } | null;
};

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-activity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  const limitParam = Number(searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 100;

  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }

  // Robinhood Chain: no OpenSea events endpoint, and no permanent ledger for
  // an arbitrary auto-discovered collection (see ACTIVITY_SCAN_BLOCKS's own
  // comment) -- so this scans real raw Transfer logs directly. HONEST
  // LIMITATION, DELIBERATELY NOT WORKED AROUND: the ONLY thing fetched
  // below is eth_getLogs against the NFT contract's own Transfer topic --
  // no native-value, no ERC-20 "payment" log, and no marketplace/Seaport
  // event from the same transaction is fetched alongside it. That means
  // there genuinely is no real sale-vs-gift signal available from this
  // data alone: distinguishing a real sale would need at least one more
  // RPC call per candidate tx (eth_getTransactionByHash for its `value`,
  // or a second eth_getLogs pass for a paired ERC-20/Seaport
  // OrderFulfilled log in the same transactionHash) to see whether real
  // payment moved alongside the Transfer -- work this pass does not do.
  // So every event here is reported as a plain "transfer" with
  // priceWei: null rather than guessing which transfers were sales; this
  // is why Volume/Highest-sale can never populate for a Robinhood-Chain
  // collection today, not a bug to silently work around with a fabricated
  // heuristic (same "honest gap over fabricated data" discipline as
  // ACTIVITY_SCAN_BLOCKS's own comment above).
  if (isRobinhoodChainSlug(chainSlug)) {
    try {
      const collection = await getCollectionAsync(collectionSlug);
      if (!collection) {
        return NextResponse.json({ error: "NOT_FOUND", message: "Unknown Robinhood-Chain collection." }, { status: 404 });
      }
      const rpcUrl = ROBINHOOD_RPC_URLS[0];
      if (!rpcUrl) {
        return NextResponse.json({ error: "Robinhood Chain RPC is not configured on this deployment." }, { status: 503 });
      }
      const latestHex = await rpcCall<string>(rpcUrl, "eth_blockNumber", []);
      const latest = Number.parseInt(latestHex, 16);
      const fromBlock = Math.max(0, latest - ACTIVITY_SCAN_BLOCKS);

      const logs = await rpcCall<RawTransferLog[]>(rpcUrl, "eth_getLogs", [
        {
          address: collection.contractAddress,
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + latest.toString(16),
          topics: [TRANSFER_TOPIC],
        },
      ]);

      const sorted = logs
        .filter((l) => l.topics.length === 4) // ERC-20 Transfer shares the same topic0 with only 3 topics -- excluded, same filter evm-log-scan.ts uses.
        .sort((a, b) => Number.parseInt(b.blockNumber, 16) - Number.parseInt(a.blockNumber, 16))
        .slice(0, limit);

      const events = sorted.map((log) => {
        const from = topicToAddress(log.topics[1]);
        // The real, canonical on-chain shape of an ERC-721 mint: a Transfer
        // FROM the zero address. Same signal transfer-ledger.ts's
        // eventTypeFor() now uses for the 8 foreign EVM chains -- checked
        // here too rather than lumping every genuine mint into "transfer".
        const kind = from === ZERO_ADDRESS ? ("mint" as const) : ("transfer" as const);
        return {
          type: kind,
          // Real block timestamps would need one eth_getBlockByNumber call per
          // distinct block -- real work, deferred rather than faked; null is
          // honest here, not a placeholder value.
          timestamp: null,
          transaction: log.transactionHash,
          priceWei: null,
          priceSymbol: null,
          from,
          to: topicToAddress(log.topics[2]),
          tokenId: BigInt(log.topics[3]).toString(),
          tokenName: null,
          imageUrl: null,
        };
      });

      return NextResponse.json({ events, marketCoverage: venueCoverage(chainSlug) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return publicError(error, "Failed to load Robinhood-Chain activity");
    }
  }

  // SOLANA -- real, keyless Magic Eden collection activities. Confirmed live
  // 2026-08-18: GET /v2/collections/{symbol}/activities needs no API key,
  // returning real buy/list/bid/delist events with real SOL prices. Mapped
  // into the same shape the EVM/OpenSea branch below returns.
  if (isSolanaChainSlug(chainSlug)) {
    try {
      type MeActivity = {
        signature: string;
        type: string;
        blockTime?: number;
        buyer?: string | null;
        seller?: string | null;
        price?: number | null;
        tokenMint?: string | null;
      };
      const res = await fetch(
        `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(collectionSlug)}/activities?limit=${limit}`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) {
        return NextResponse.json({ error: `Magic Eden ${res.status}` }, { status: 502 });
      }
      const raw = (await res.json()) as MeActivity[];
      const events = await Promise.all(raw.map(async (a) => ({
        type: a.type === "buyNow" ? "sale" : a.type,
        timestamp: a.blockTime ? new Date(a.blockTime * 1000).toISOString() : null,
        transaction: a.signature,
        priceWei: a.price != null ? (BigInt(Math.round(a.price * 1_000_000_000)) * BigInt(1_000_000_000)).toString() : null,
        ...(await activityValue({
          atomic: a.price != null ? String(Math.round(a.price * 1_000_000_000)) : null,
          decimals: 9,
          symbol: a.price != null ? "SOL" : null,
        })),
        from: a.seller ?? null,
        to: a.buyer ?? null,
        tokenId: a.tokenMint ?? null,
        tokenName: null,
        imageUrl: null,
      })));
      return NextResponse.json({ events, marketCoverage: venueCoverage(chainSlug) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return publicError(error, "Failed to load Solana activity");
    }
  }

  // BITCOIN ORDINALS -- same honest-empty posture as listings/route.ts's
  // "bitcoin" branch: no keyless/documented activity-query endpoint was
  // found for UniSat's Marketplace API during this research pass.
  if (isBitcoinChainSlug(chainSlug)) {
    return NextResponse.json({ events: [], marketCoverage: venueCoverage(chainSlug) }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!foreignChainByChainSlug(chainSlug)) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }

  try {
    const tracked = await getCollectionAsync(collectionSlug);
    const contractAddress = /^0x[0-9a-fA-F]{40}$/.test(collectionSlug)
      ? collectionSlug
      : tracked?.contractAddress;
    if (contractAddress) {
      // Real, unioned, multi-venue first-party ledger (transfers + all 8
      // on-chain fill indexes: Seaport/Wyvern/LooksRare/Blur/X2Y2/
      // Foundation/Sudoswap/Rarible/CryptoKitties) -- see
      // ledger-activity.ts's own header. Tried before the Seaport-only
      // ledger and the OpenSea live-API fallback below: a real multi-venue
      // union is strictly more complete than either.
      const unioned = await readLedgerActivity({ chainSlug, contractAddress, limit });
      if (unioned && unioned.events.length > 0) {
        // Real per-token art/name/rarity for an "at a glance" feed -- the
        // EXACT SAME store + call shape listings/route.ts already uses to
        // enrich the buy/sell grid (readProjectedTokensByIds(chainSlug,
        // collection.contractAddress, tokenIds), see that route's own
        // comment: "Joining the sparse book to the canonical projection by
        // token id prevents every missing image from falling through to
        // the collection logo"). No new resolution path, no live OpenSea
        // fetch per row -- one batched DB read against whatever this
        // collection's background indexer has already projected. A token
        // this store hasn't indexed yet stays honestly imageless/nameless,
        // same as an unindexed row in the grid itself.
        const { readProjectedTokensByIds } = await import("@/lib/market/multichain/collection-token-store");
        const tokenIds = [...new Set(unioned.events.map((e) => e.tokenId).filter((id): id is string => Boolean(id)))];
        const projected = await readProjectedTokensByIds(chainSlug, contractAddress, tokenIds).catch(() => new Map());

        // Reshaped onto the same event envelope every other branch in this
        // route already returns (type/timestamp/transaction/priceWei/...)
        // so ForeignActivityFeed.tsx needs no per-source special-casing --
        // `kind`/`venueId` ride along as real extra fields the feed's
        // color/venue-label map reads directly, not a lossy conversion.
        const events = unioned.events.map((e) => {
          const token = e.tokenId ? projected.get(e.tokenId) : undefined;
          return {
            type: e.kind,
            kind: e.kind,
            venueId: e.venueId,
            timestamp: e.timestamp,
            transaction: e.transaction,
            logIndex: e.logIndex,
            blockNumber: e.blockNumber,
            priceWei: e.priceWei,
            priceSymbol: e.priceSymbol,
            priceAmount: e.priceAmount,
            priceUsd: e.priceUsd,
            from: e.from,
            to: e.to,
            tokenId: e.tokenId,
            tokenName: token?.name ?? null,
            imageUrl: token?.imageUrl ?? null,
            // Same real, pre-computed rarity fields the grid's own sort/badge
            // reads (rarityScore/rarityRank/rarityTier) -- a second, honest
            // source alongside the client's own /rarity-endpoint Map so a
            // token indexed only in the token-projection store still shows
            // its real tier at a glance rather than silently blank.
            rarityRank: token?.rarityRank ?? null,
            rarityTier: token?.rarityTier ?? null,
            batchSize: e.batchSize ?? null,
            evidenceSource: e.evidenceSource,
          };
        });
        return NextResponse.json(
          { events, coverage: unioned.coverage, marketCoverage: venueCoverage(chainSlug) },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      const ledger = await readSeaportFillHistory({ chainSlug, contractAddress, limit });
      if (ledger && ledger.events.length > 0) {
        return NextResponse.json({ ...ledger, marketCoverage: venueCoverage(chainSlug) }, { headers: { "Cache-Control": "no-store" } });
      }
    }
    const key = (await pickOpenSeaKey("live"))?.apiKey ?? null;
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }
    // See resolveOpenSeaCollectionSlug's header (foreign-orders.ts) --
    // every card links here with a contract address, but OpenSea's
    // /events/collection/{slug} endpoint needs OpenSea's own slug.
    const chainForSlug = foreignChainByChainSlug(chainSlug)!;
    // No OpenSea orderbook for this chain (zkSync today) -- there is no
    // OpenSea activity to fetch, so an empty feed is the correct, expected
    // answer, not an error. Marketplank's own native-order activity is a
    // separate concern this route was never wired to anyway.
    if (!chainForSlug.openSeaChain) {
      return NextResponse.json({ events: [], marketCoverage: venueCoverage(chainSlug) }, { headers: { "Cache-Control": "no-store" } });
    }
    const openSeaSlug = /^0x[0-9a-fA-F]{40}$/.test(collectionSlug)
      ? ((await resolveOpenSeaCollectionSlug(chainForSlug.openSeaChain, collectionSlug)) ?? collectionSlug)
      : collectionSlug;
    const url =
      `${OPENSEA}/events/collection/${encodeURIComponent(openSeaSlug)}` +
      `?event_type=sale&event_type=transfer&limit=${Math.min(limit, 50)}`;
    const res = await fetch(url, { headers: { "x-api-key": key, accept: "application/json" } });
    if (!res.ok) {
      return NextResponse.json({ error: `OpenSea ${res.status}` }, { status: 502 });
    }
    const data = (await res.json()) as { asset_events?: OpenSeaEvent[] };
    const events = await Promise.all((data.asset_events ?? []).map(async (e) => ({
      type: e.event_type,
      timestamp: new Date(e.event_timestamp * 1000).toISOString(),
      transaction: e.transaction,
      priceWei: e.payment?.quantity ?? null,
      ...(await activityValue({
        atomic: e.payment?.quantity,
        decimals: e.payment?.decimals,
        symbol: e.payment?.symbol,
        tokenAddress: e.payment?.token_address,
        chain: chainSlug,
      })),
      from: e.seller ?? e.from_address ?? null,
      to: e.buyer ?? e.to_address ?? null,
      tokenId: e.nft?.identifier ?? null,
      tokenName: e.nft?.name ?? null,
      imageUrl: e.nft?.image_url ?? null,
    })));
    return NextResponse.json({
      events,
      marketCoverage: venueCoverage(chainSlug),
      coverage: {
        source: "opensea-single-page",
        scope: "opensea-single-page",
        indexedEvents: events.length,
        timestampedEvents: events.filter((event) => event.timestamp).length,
        oldestTimestamp: events.at(-1)?.timestamp ?? null,
        newestTimestamp: events[0]?.timestamp ?? null,
        completeThroughGenesis: false,
        completeMarketHistory: false,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to load multichain activity");
  }
}
