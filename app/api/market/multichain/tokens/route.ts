/**
 * Browse tokens in a collection (art + token id), independent of whether
 * they are listed. Listings overlay happens on the client. Vaults/Instant
 * Swap for foreign collections are out of scope (owner: later).
 */
import { NextRequest, NextResponse } from "next/server";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { isSolanaChainSlug, isBitcoinChainSlug, isRobinhoodChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { publicError, rateLimit } from "@/lib/security";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type CollectionToken = {
  tokenId: string;
  name: string | null;
  imageUrl: string | null;
  animationUrl?: string | null;
  mediaType?: string | null;
};

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-tokens", limit: 40, windowMs: 60_000 });
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  // Bounded response page, not a collection-size limit. Projection cursors
  // provide lossless traversal for collections of any cardinality.
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? "40"), 1), 800);
  const sortRaw = (searchParams.get("sort") ?? "id").toLowerCase();
  const sort = sortRaw === "rank" || sortRaw === "rank-desc" ? sortRaw : "id";
  const tier = searchParams.get("tier");
  const cursor = searchParams.get("cursor");
  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }
  try {
    // Live commit delivery is a read of stored data, never a new demand job.
    if (searchParams.get("projection") === "1") {
      const { readCollectionTokenProjection } = await import("@/lib/market/multichain/collection-token-store");
      const projected = await readCollectionTokenProjection({ chainSlug, collectionSlug, limit, cursor, sort, tier });
      return NextResponse.json(projected ? { ...projected, building: projected.partial && projected.tokens.length === 0 } :
        { tokens: [], nextCursor: null, building: true, partial: true, projectedCount: 0 },
      { headers: { "Cache-Control": "no-store" } });
    }
    // Projection-first: page loads never spend a provider request when a
    // background worker has already materialized real collection members.
    const { hasCollectionTokenStore, readCollectionTokenProjection } = await import("@/lib/market/multichain/collection-token-store");
    if (hasCollectionTokenStore()) {
      const projected = await readCollectionTokenProjection({
        chainSlug, collectionSlug, limit, cursor, sort, tier,
      }).catch(() => null);
      if (projected) {
        // A partial projection is useful enough to render, but it is not a
        // terminal cache hit. Renew the demand job whenever somebody is
        // actively viewing it so the mesh keeps walking the provider cursor
        // instead of rotating away after the first 50-token page.
        if (projected.partial && /^0x[0-9a-fA-F]{40}$/.test(collectionSlug)) {
          const eligible = isRobinhoodChainSlug(chainSlug) || Boolean(foreignChainByChainSlug(chainSlug)?.openSeaChain);
          if (eligible) {
            const { enqueueDataJob } = await import("@/lib/market/multichain/control-plane");
            const source = isRobinhoodChainSlug(chainSlug) ? "robinhood-membership" : "opensea-membership";
            await enqueueDataJob({
              jobKey: `demand:membership:${chainSlug}:${collectionSlug.toLowerCase()}`,
              kind: `mesh-lane:${chainSlug}`,
              source,
              chainSlug,
              subject: collectionSlug.toLowerCase(),
              priority: 90,
            }).catch(() => {});
          }
        }
        if (projected.partial && isBitcoinChainSlug(chainSlug)) {
          const { enqueueDataJob } = await import("@/lib/market/multichain/control-plane");
          await enqueueDataJob({
            jobKey: `demand:membership:${chainSlug}:${collectionSlug}`,
            kind: `mesh-lane:${chainSlug}`,
            source: "unisat-membership",
            chainSlug,
            subject: collectionSlug,
            priority: 90,
          }).catch(() => {});
        }
        // Zero rows can be the correct result of a tier filter. Returning the
        // projection metadata is what distinguishes "no matching Legendary"
        // from "this collection has never been indexed".
        return NextResponse.json({ ...projected, building: projected.partial && projected.tokens.length === 0 }, {
          headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=120" },
        });
      }
    }
    // A cold projection never performs provider work in this request. It
    // records exact demand so the isolated mesh hydrates this contract ahead
    // of the background round-robin on its next tick.
    // THE DEMAND SIGNAL ITSELF WAS SHAPE-GATED.
    //
    // This is the enqueue that tells the mesh "a visitor is looking at this
    // collection right now". Requiring the slug to BE an address meant a
    // page opened by name recorded no demand at all -- so visiting and
    // refreshing genuinely could not cause hydration, no matter how long.
    const { resolveEvmContractAddress: resolveForDemand } = await import("@/lib/market/multichain/resolve-contract-address");
    const contractAddress = (await resolveForDemand(chainSlug, collectionSlug))?.toLowerCase() ?? null;
    if (contractAddress && (isRobinhoodChainSlug(chainSlug) || foreignChainByChainSlug(chainSlug)?.openSeaChain)) {
      const { enqueueDataJob } = await import("@/lib/market/multichain/control-plane");
      const source = isRobinhoodChainSlug(chainSlug) ? "robinhood-membership" : "opensea-membership";
      await enqueueDataJob({
        jobKey: `demand:membership:${chainSlug}:${contractAddress}`,
        kind: `mesh-lane:${chainSlug}`,
        source,
        chainSlug,
        subject: contractAddress,
        priority: 90,
      }).catch(() => {});
    }
    if (isBitcoinChainSlug(chainSlug)) {
      const { enqueueDataJob } = await import("@/lib/market/multichain/control-plane");
      await enqueueDataJob({
        jobKey: `demand:membership:${chainSlug}:${collectionSlug}`,
        kind: `mesh-lane:${chainSlug}`,
        source: "unisat-membership",
        chainSlug,
        subject: collectionSlug,
        priority: 90,
      }).catch(() => {});
    }
    const { hasForeignRarityStore, listForeignRarityTokens } = await import("@/lib/market/multichain/foreign-rarity-store");
    if (hasForeignRarityStore()) {
      const indexed = await listForeignRarityTokens(chainSlug, collectionSlug, limit, { sort, tier }).catch(() => []);
      if (indexed.length > 0) {
        const { templatedErc721Image } = await import("@/lib/market/multichain/token-art");
        // Resolve the address instead of demanding the slug BE one. When the
        // page addresses a collection by name -- which is how the app links
        // to it -- this used to be null, which silently disabled the entire
        // image backfill below: templating skipped, page resolution skipped,
        // every tile rendered with a null image forever. Nothing was missing
        // from the archive; the route declined to fill it in.
        const { resolveEvmContractAddress } = await import("@/lib/market/multichain/resolve-contract-address");
        const contractHint = await resolveEvmContractAddress(chainSlug, collectionSlug);
        const templated: Array<{ tokenId: string; imageUrl: string }> = [];
        for (const t of indexed) {
          if (t.imageUrl || !contractHint) continue;
          const img = templatedErc721Image(contractHint, t.tokenId);
          if (!img) continue;
          t.imageUrl = img;
          templated.push({ tokenId: t.tokenId, imageUrl: img });
        }
        if (templated.length > 0) {
          const { updateForeignRarityImages } = await import("@/lib/market/multichain/foreign-rarity-store");
          void updateForeignRarityImages(chainSlug, collectionSlug, templated).catch(() => {});
        }
        const missing = indexed.filter((t) => !t.imageUrl).length;
        if (missing > 0) {
          // TWO VENDOR PASSES USED TO RUN INSIDE THE VISITOR'S REQUEST.
          //
          // Templating above is free -- a pure string build -- and fills the
          // whole page for any collection that has a template. What follows
          // did not: a catalog fetch (up to 200 rows from OpenSea / 80 from
          // UniSat or Helius) and then up to 16 per-token image lookups, both
          // awaited before the response was written, on a route that answers
          // `Cache-Control: no-store`.
          //
          // So every visitor paid both passes again, and the page could not
          // paint until vendors that are rate-limited by design had answered.
          // Measured shape, not theory: token-art.ts's own comment records the
          // budget as "16 against a grid of 400 tiles" -- the page was never
          // going to be complete from this path anyway.
          //
          // The work itself is worth doing: updateForeignRarityImages writes
          // the resolved URLs into plank_foreign_rarity DURABLY, so whatever
          // this resolves is free for every later visitor. That is exactly why
          // it does not need to block THIS one.
          //
          // So it is detached. The response ships the rows already indexed --
          // including everything templating just filled -- and the vendor
          // passes run after, writing their results to the store for the next
          // read. A tile without an image is a typed hole the client already
          // handles (it calls hydrate-token), not a broken render.
          const runVendorBackfill = async () => {
            let extras: CollectionToken[] = [];
            if (isBitcoinChainSlug(chainSlug)) extras = await bitcoinTokens(collectionSlug, Math.min(limit, 80)).catch(() => []);
            else if (isSolanaChainSlug(chainSlug)) extras = await solanaTokens(collectionSlug, Math.min(limit, 80)).catch(() => []);
            else {
              const chain = foreignChainByChainSlug(chainSlug);
              if (chain?.openSeaChain) extras = await openSeaTokens(chain.openSeaChain, collectionSlug, Math.min(limit, 200)).catch(() => []);
            }
            const byId = new Map(extras.map((t) => [t.tokenId, t.imageUrl]));
            const filled: Array<{ tokenId: string; imageUrl: string }> = [];
            // Work against a COPY of the page's shape, never the `indexed`
            // array itself: that array has already been serialised into the
            // response by the time this runs, and mutating it afterwards would
            // be a write to state nobody reads -- harmless today, and exactly
            // the kind of thing that becomes a bug when the response is later
            // built lazily.
            const pending = indexed
              .filter((t) => !t.imageUrl)
              .map((t) => ({ tokenId: t.tokenId, name: t.name, imageUrl: t.imageUrl }));
            for (const t of pending) {
              const img = byId.get(t.tokenId);
              if (img) {
                t.imageUrl = img;
                filled.push({ tokenId: t.tokenId, imageUrl: img });
              }
            }
            const { updateForeignRarityImages } = await import("@/lib/market/multichain/foreign-rarity-store");
            if (filled.length > 0) {
              await updateForeignRarityImages(chainSlug, collectionSlug, filled).catch(() => {});
            }
            if (pending.some((t) => !t.imageUrl)) {
              const chain = foreignChainByChainSlug(chainSlug);
              const { resolveTokenImagesForPage } = await import("@/lib/market/multichain/token-art");
              const more = await resolveTokenImagesForPage({
                openSeaChain: chain?.openSeaChain ?? null,
                contractAddress: contractHint,
                tokens: pending,
                maxRemote: 16,
              });
              if (more.length > 0) {
                await updateForeignRarityImages(chainSlug, collectionSlug, more).catch(() => {});
              }
            }
          };
          void runVendorBackfill().catch(() => {});
        }
        return NextResponse.json(
          { tokens: indexed.map((t) => ({ tokenId: t.tokenId, name: t.name, imageUrl: t.imageUrl })) },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
    }
    if (isBitcoinChainSlug(chainSlug)) {
      return NextResponse.json({ tokens: await bitcoinTokens(collectionSlug, limit) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (isSolanaChainSlug(chainSlug)) {
      return NextResponse.json({ tokens: await solanaTokens(collectionSlug, limit) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (isRobinhoodChainSlug(chainSlug)) {
      return NextResponse.json({ tokens: [], partial: true, building: true },
        { headers: { "Cache-Control": "no-store" } });
    }
    const chain = foreignChainByChainSlug(chainSlug);
    if (!chain?.openSeaChain) {
      return NextResponse.json({ tokens: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(
      { tokens: await openSeaTokens(chain.openSeaChain, collectionSlug, limit) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Failed to load collection tokens");
  }
}

/**
 * Real gap found live 2026-08-25 ("many visitors one fingerprint" audit):
 * this is the token-grid fetch rendered on every collection page load --
 * likely THIS app's single highest-traffic surface -- and it ran raw, on
 * every request, with zero coalescing across all three chains (OpenSea/
 * Magic Eden/UniSat). N concurrent visitors on the same popular collection
 * each independently paid the full real upstream cost. Wrapped in the same
 * getOrRefresh singleflight/SWR mechanism the rest of this app's live
 * routes already use.
 */
async function openSeaTokens(openSeaChain: string, contractOrSlug: string, limit: number): Promise<CollectionToken[]> {
  const { getOrRefresh } = await import("@/lib/market/multichain/singleflight-cache");
  return getOrRefresh<CollectionToken[]>(
    `opensea-tokens:${openSeaChain}:${contractOrSlug.toLowerCase()}:${limit}`,
    { softTtlMs: 30_000, hardTtlMs: 5 * 60_000, provider: "opensea" },
    () => openSeaTokensUncached(openSeaChain, contractOrSlug, limit)
  );
}

async function openSeaTokensUncached(openSeaChain: string, contractOrSlug: string, limit: number): Promise<CollectionToken[]> {
  const key = (await pickOpenSeaKey("live"))?.apiKey ?? null;
  if (!key) return [];
  const chainPath = openSeaChain === "matic" ? "matic" : openSeaChain;
  const address = /^0x[0-9a-fA-F]{40}$/.test(contractOrSlug) ? contractOrSlug : null;
  const out: CollectionToken[] = [];
  let cursor: string | null = null;
  const pageSize = Math.min(50, Math.max(limit, 1));
  const maxPages = Math.min(8, Math.ceil(limit / pageSize) || 1);
  for (let page = 0; page < maxPages && out.length < limit; page++) {
    const gate = checkSourceBudget("opensea-stats");
    if (!gate.allowed) break;
    const url = new URL(
      address
        ? `https://api.opensea.io/api/v2/chain/${encodeURIComponent(chainPath)}/contract/${address}/nfts`
        : `https://api.opensea.io/api/v2/collection/${encodeURIComponent(contractOrSlug)}/nfts`
    );
    url.searchParams.set("limit", String(pageSize));
    if (cursor) url.searchParams.set("next", cursor);
    const res = await fetch(url.toString(), {
      headers: { "x-api-key": key, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      recordSourceFailure("opensea-stats", res.status === 429);
      break;
    }
    recordSourceSuccess("opensea-stats");
    const body = (await res.json()) as {
      nfts?: Array<{ identifier?: string; name?: string | null; image_url?: string | null; display_image_url?: string | null }>;
      next?: string | null;
    };
    for (const n of body.nfts ?? []) {
      if (!n.identifier) continue;
      out.push({
        tokenId: n.identifier,
        name: n.name ?? null,
        imageUrl: n.display_image_url || n.image_url || null,
      });
    }
    cursor = body.next ?? null;
    if (!cursor) break;
  }
  return out.slice(0, limit);
}

async function solanaTokens(symbol: string, limit: number): Promise<CollectionToken[]> {
  const { getOrRefresh } = await import("@/lib/market/multichain/singleflight-cache");
  return getOrRefresh<CollectionToken[]>(
    `magiceden-tokens:${symbol}:${limit}`,
    { softTtlMs: 30_000, hardTtlMs: 5 * 60_000, provider: "magiceden" },
    () => solanaTokensUncached(symbol, limit)
  );
}

async function solanaTokensUncached(symbol: string, limit: number): Promise<CollectionToken[]> {
  const nftsRes = await fetch(
    `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/listings?offset=0&limit=${limit}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
  );
  const seen = new Set<string>();
  const out: CollectionToken[] = [];
  if (nftsRes.ok) {
    const raw = (await nftsRes.json()) as Array<{ tokenMint?: string; token?: { name?: string; image?: string } }>;
    for (const row of raw) {
      if (!row.tokenMint || seen.has(row.tokenMint)) continue;
      seen.add(row.tokenMint);
      out.push({ tokenId: row.tokenMint, name: row.token?.name ?? null, imageUrl: row.token?.image ?? null });
    }
  }
  if (out.length > 0) return out;
  const activities = await fetch(
    `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/activities?offset=0&limit=${limit}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
  );
  if (!activities.ok) return out;
  const acts = (await activities.json()) as Array<{ tokenMint?: string; token?: { name?: string; image?: string } }>;
  for (const row of acts) {
    if (!row.tokenMint || seen.has(row.tokenMint)) continue;
    seen.add(row.tokenMint);
    out.push({ tokenId: row.tokenMint, name: row.token?.name ?? null, imageUrl: row.token?.image ?? null });
  }
  return out;
}

type UniSatItem = { inscriptionId?: string; name?: string; collectionItemName?: string; contentType?: string };

function mapUniSatItems(list: UniSatItem[]): CollectionToken[] {
  return list
    .filter((i) => i.inscriptionId)
    .map((i) => ({
      tokenId: i.inscriptionId!,
      name: i.collectionItemName ?? i.name ?? null,
      imageUrl: /^image\//i.test(i.contentType ?? "")
        ? `https://ordinals.com/content/${i.inscriptionId}` : null,
      animationUrl: /^(video|audio)\//i.test(i.contentType ?? "")
        ? `https://ordinals.com/content/${i.inscriptionId}` : null,
      mediaType: i.contentType ?? null,
    }));
}

async function bitcoinTokens(collectionId: string, limit: number): Promise<CollectionToken[]> {
  const { getOrRefresh } = await import("@/lib/market/multichain/singleflight-cache");
  return getOrRefresh<CollectionToken[]>(
    `unisat-tokens:${collectionId}:${limit}`,
    { softTtlMs: 30_000, hardTtlMs: 5 * 60_000, provider: "unisat" },
    () => bitcoinTokensUncached(collectionId, limit)
  );
}

async function bitcoinTokensUncached(collectionId: string, limit: number): Promise<CollectionToken[]> {
  const { fetchOrdinalsWalletCatalog } = await import("@/lib/market/multichain/adapters/ordinalswallet-catalog");
  const ow = await fetchOrdinalsWalletCatalog(collectionId).catch(() => ({ tokens: [] as CollectionToken[] }));
  if (ow.tokens.length > 0) return ow.tokens.slice(0, limit);

  const key = process.env.UNISAT_API_KEY?.trim();
  if (!key) return [];
  const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };

  const indexer = await fetch(
    `https://open-api.unisat.io/v1/collection-indexer/collection/${encodeURIComponent(collectionId)}/items?start=0&limit=${limit}`,
    { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }
  );
  if (indexer.ok) {
    const body = (await indexer.json()) as { code?: number; data?: { list?: UniSatItem[]; items?: UniSatItem[] } };
    const list = body.data?.list ?? body.data?.items ?? [];
    if (body.code === 0 && list.length > 0) return mapUniSatItems(list);
  }

  const itemList = await fetch("https://open-api.unisat.io/v3/market/collection/auction/collection_item_list", {
    method: "POST",
    headers,
    body: JSON.stringify({ filter: { collectionId }, start: 0, limit }),
    signal: AbortSignal.timeout(15_000),
  });
  if (itemList.ok) {
    const body = (await itemList.json()) as { code?: number; data?: { list?: UniSatItem[] } };
    if (body.code === 0 && (body.data?.list?.length ?? 0) > 0) return mapUniSatItems(body.data!.list!);
  }

  const actions = await fetch("https://open-api.unisat.io/v3/market/collection/auction/actions", {
    method: "POST",
    headers,
    body: JSON.stringify({ filter: { collectionId }, start: 0, limit }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!actions.ok) return [];
  const body = (await actions.json()) as { code?: number; data?: { list?: UniSatItem[] } };
  if (body.code !== 0) return [];
  const seen = new Set<string>();
  const out: CollectionToken[] = [];
  for (const row of body.data?.list ?? []) {
    if (!row.inscriptionId || seen.has(row.inscriptionId)) continue;
    seen.add(row.inscriptionId);
    out.push({
      tokenId: row.inscriptionId,
      name: row.collectionItemName ?? row.name ?? null,
      imageUrl: `https://ordinals.com/content/${row.inscriptionId}`,
    });
  }
  return out;
}
