/**
 * A wallet's owned NFTs across EVERY foreign chain this app tracks -- the
 * global "My NFTs" tab's data source (as opposed to owned/route.ts, which
 * is scoped to one collection+chain for the per-collection Send flow).
 *
 * Calls Alchemy's getNFTsForOwner per chain WITHOUT a contractAddresses
 * filter (that param is what scopes owned/route.ts to one collection) --
 * confirmed live 2026-08-18: the same endpoint accepts owner-only and
 * returns every contract the wallet holds on that chain, with
 * pageSize/excludeFilters keeping the response bounded. Fan-out is 7 calls
 * (one per FOREIGN_CHAINS entry), run in parallel, each independently
 * fault-tolerant -- one chain's API hiccup doesn't blank the whole tab.
 */
import { NextRequest, NextResponse } from "next/server";
import { FOREIGN_CHAINS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { rateLimit } from "@/lib/security";
import { pickAlchemyKey } from "@/lib/market/multichain/discovery/alchemy-key-pool";

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

type OwnedItem = { chainSlug: string; contractAddress: string; collectionName: string | null; tokenId: string };

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-owned-all", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const owner = searchParams.get("owner");
  if (!owner) {
    return NextResponse.json({ error: "owner is required" }, { status: 400 });
  }

  const apiKey = (await pickAlchemyKey("live"))?.apiKey || "demo";

  const results = await Promise.all(
    FOREIGN_CHAINS.map(async (chain): Promise<OwnedItem[]> => {
      const subdomain = ALCHEMY_SUBDOMAIN[chain.chainSlug];
      if (!subdomain) return [];
      try {
        const url = new URL(`https://${subdomain}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`);
        url.searchParams.set("owner", owner);
        url.searchParams.set("withMetadata", "true");
        url.searchParams.set("pageSize", "50");
        const res = await fetch(url.toString());
        if (!res.ok) return [];
        const data = (await res.json()) as {
          ownedNfts?: Array<{ tokenId: string; contract?: { address: string; name?: string | null } }>;
        };
        return (data.ownedNfts ?? []).map((n) => ({
          chainSlug: chain.chainSlug,
          contractAddress: n.contract?.address ?? "",
          collectionName: n.contract?.name ?? null,
          tokenId: n.tokenId,
        }));
      } catch {
        return [];
      }
    })
  );

  return NextResponse.json({ items: results.flat() }, { headers: { "Cache-Control": "no-store" } });
}
