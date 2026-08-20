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
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? "40"), 1), 50);
  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }
  try {
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

async function openSeaTokens(openSeaChain: string, contractOrSlug: string, limit: number): Promise<CollectionToken[]> {
  const key = await getOpenSeaApiKey();
  if (!key) return [];
  const gate = checkSourceBudget("opensea-stats");
  if (!gate.allowed) return [];
  const chainPath = openSeaChain === "matic" ? "matic" : openSeaChain;
  const address = /^0x[0-9a-fA-F]{40}$/.test(contractOrSlug) ? contractOrSlug : null;
  if (!address) return [];
  const res = await fetch(
    `https://api.opensea.io/api/v2/chain/${encodeURIComponent(chainPath)}/contract/${address}/nfts?limit=${limit}`,
    { headers: { "x-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) {
    recordSourceFailure("opensea-stats", res.status === 429);
    return [];
  }
  recordSourceSuccess("opensea-stats");
  const body = (await res.json()) as { nfts?: Array<{ identifier?: string; name?: string | null; image_url?: string | null }> };
  return (body.nfts ?? [])
    .filter((n) => n.identifier)
    .map((n) => ({ tokenId: n.identifier!, name: n.name ?? null, imageUrl: n.image_url ?? null }));
}

async function solanaTokens(symbol: string, limit: number): Promise<CollectionToken[]> {
  const res = await fetch(
    `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/listings?offset=0&limit=${limit}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) return [];
  const raw = (await res.json()) as Array<{ tokenMint?: string; token?: { name?: string; image?: string } }>;
  const seen = new Set<string>();
  const out: CollectionToken[] = [];
  for (const row of raw) {
    if (!row.tokenMint || seen.has(row.tokenMint)) continue;
    seen.add(row.tokenMint);
    out.push({ tokenId: row.tokenMint, name: row.token?.name ?? null, imageUrl: row.token?.image ?? null });
  }
  return out;
}

async function bitcoinTokens(collectionId: string, limit: number): Promise<CollectionToken[]> {
  const key = process.env.UNISAT_API_KEY?.trim();
  if (!key) return [];
  const res = await fetch("https://open-api.unisat.io/v3/market/collection/auction/collection_item_list", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ collectionId, start: 0, limit }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as {
    code?: number;
    data?: { list?: Array<{ inscriptionId?: string; name?: string; content?: string; collectionItemName?: string }> };
  };
  if (body.code !== 0) return [];
  return (body.data?.list ?? [])
    .filter((i) => i.inscriptionId)
    .map((i) => ({
      tokenId: i.inscriptionId!,
      name: i.collectionItemName ?? i.name ?? null,
      imageUrl: `https://ordinals.com/content/${i.inscriptionId}`,
    }));
}
