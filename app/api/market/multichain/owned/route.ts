/**
 * Real owned-token lookup for a wallet, on a foreign chain, for one
 * collection -- powers "My tokens"/Send on the multichain browse surface.
 * Server-side so the Alchemy key path stays consistent with every other
 * multichain route (this one can run on the free "demo" key even so, but
 * keeping it server-side avoids yet another client-exposed key path).
 */
import { NextRequest, NextResponse } from "next/server";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALCHEMY_SUBDOMAIN: Record<string, string> = {
  "eth-mainnet": "eth-mainnet",
  "polygon-mainnet": "polygon-mainnet",
  "arb-mainnet": "arb-mainnet",
  "base-mainnet": "base-mainnet",
  "opt-mainnet": "opt-mainnet",
  "bnb-mainnet": "bnb-mainnet",
  "avax-mainnet": "avax-mainnet",
};

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-owned", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const owner = searchParams.get("owner");
  const contractAddress = searchParams.get("contractAddress");

  if (!chainSlug || !owner || !contractAddress) {
    return NextResponse.json({ error: "chainSlug, owner, and contractAddress are required" }, { status: 400 });
  }
  if (!foreignChainByChainSlug(chainSlug)) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }
  const subdomain = ALCHEMY_SUBDOMAIN[chainSlug];
  if (!subdomain) {
    return NextResponse.json({ error: `No Alchemy NFT API mapping for "${chainSlug}"` }, { status: 400 });
  }

  const apiKey = process.env.ALCHEMY_API_KEY?.trim() || "demo";
  const url = new URL(`https://${subdomain}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`);
  url.searchParams.set("owner", owner);
  url.searchParams.append("contractAddresses[]", contractAddress);
  // withMetadata=true -- the "My NFTs" tab renders real card art (matching
  // the native MyNfts.tsx grid), not just a bare list of token ids.
  url.searchParams.set("withMetadata", "true");

  const res = await fetch(url.toString());
  if (!res.ok) {
    return NextResponse.json({ error: `Alchemy ${res.status}` }, { status: 502 });
  }
  const data = (await res.json()) as {
    ownedNfts?: Array<{ tokenId: string; name?: string; image?: { cachedUrl?: string; originalUrl?: string } }>;
  };
  const items = (data.ownedNfts ?? []).map((n) => ({
    tokenId: n.tokenId,
    name: n.name ?? null,
    imageUrl: n.image?.cachedUrl ?? n.image?.originalUrl ?? null,
  }));
  return NextResponse.json(
    { tokenIds: items.map((i) => i.tokenId), items },
    { headers: { "Cache-Control": "no-store" } }
  );
}
