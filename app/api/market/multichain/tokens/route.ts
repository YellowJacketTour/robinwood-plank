/**
 * Browse tokens in a collection (art + token id), independent of whether
 * they are listed. Listings overlay happens on the client. Vaults/Instant
 * Swap for foreign collections are out of scope (owner: later).
 */
import { NextRequest, NextResponse } from "next/server";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
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
};

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-tokens", limit: 40, windowMs: 60_000 });
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? "40"), 1), 2000);
  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }
  try {
    const { hasForeignRarityStore, listForeignRarityTokens } = await import("@/lib/market/multichain/foreign-rarity-store");
    if (hasForeignRarityStore()) {
      const indexed = await listForeignRarityTokens(chainSlug, collectionSlug, limit).catch(() => []);
      if (indexed.length > 0) {
        const missing = indexed.filter((t) => !t.imageUrl).length;
        if (missing > 0) {
          let extras: CollectionToken[] = [];
          if (isBitcoinChainSlug(chainSlug)) extras = await bitcoinTokens(collectionSlug, Math.min(limit, 80)).catch(() => []);
          else if (isSolanaChainSlug(chainSlug)) extras = await solanaTokens(collectionSlug, Math.min(limit, 80)).catch(() => []);
          else {
            const chain = foreignChainByChainSlug(chainSlug);
            if (chain?.openSeaChain) extras = await openSeaTokens(chain.openSeaChain, collectionSlug, Math.min(limit, 200)).catch(() => []);
          }
          const byId = new Map(extras.map((t) => [t.tokenId, t.imageUrl]));
          const filled: Array<{ tokenId: string; imageUrl: string }> = [];
          for (const t of indexed) {
            if (t.imageUrl) continue;
            const img = byId.get(t.tokenId);
            if (img) {
              t.imageUrl = img;
              filled.push({ tokenId: t.tokenId, imageUrl: img });
            }
          }
          if (filled.length > 0) {
            const { updateForeignRarityImages } = await import("@/lib/market/multichain/foreign-rarity-store");
            void updateForeignRarityImages(chainSlug, collectionSlug, filled).catch(() => {});
          }
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
      return NextResponse.json({ tokens: [] }, { headers: { "Cache-Control": "no-store" } });
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

function mapOpenSeaNfts(nfts: Array<{ identifier?: string; name?: string | null; image_url?: string | null }>): CollectionToken[] {
  return nfts
    .filter((n) => n.identifier)
    .map((n) => ({ tokenId: n.identifier!, name: n.name ?? null, imageUrl: n.image_url ?? null }));
}

async function openSeaTokens(openSeaChain: string, contractOrSlug: string, limit: number): Promise<CollectionToken[]> {
  const key = await getOpenSeaApiKey();
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
      imageUrl: `https://ordinals.com/content/${i.inscriptionId}`,
    }));
}

async function bitcoinTokens(collectionId: string, limit: number): Promise<CollectionToken[]> {
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
