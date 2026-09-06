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
import { edgeRead } from "@/lib/market/multichain/edge/read-gateway";
import { meteredFetch } from "@/lib/market/multichain/edge/provider-ledger";

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

  const keyEntry = await pickAlchemyKey("live");
  const apiKey = keyEntry?.apiKey || "demo";

  const results = await Promise.all(
    FOREIGN_CHAINS.map(async (chain): Promise<OwnedItem[]> => {
      const subdomain = ALCHEMY_SUBDOMAIN[chain.chainSlug];
      if (!subdomain) return [];
      try {
        // Single point: one Alchemy call per (chain, wallet) per TTL window
        // regardless of how many tabs open "My NFTs".
        const { value } = await edgeRead<OwnedItem[]>(
          { kind: "owned", chainSlug: chain.chainSlug, subject: owner.toLowerCase(), variant: { scope: "all", pageSize: 50 } },
          async () => {
            const url = new URL(`https://${subdomain}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`);
            url.searchParams.set("owner", owner);
            url.searchParams.set("withMetadata", "true");
            url.searchParams.set("pageSize", "50");
            const res = await meteredFetch(url.toString(), undefined, { source: "alchemy-nft", keyId: keyEntry?.id ?? null, chainSlug: chain.chainSlug, costUnits: 480 });
            if (!res.ok) throw new Error(`Alchemy ${res.status}`);
            const data = (await res.json()) as {
              ownedNfts?: Array<{ tokenId: string; contract?: { address: string; name?: string | null } }>;
            };
            return (data.ownedNfts ?? []).map((n) => ({
              chainSlug: chain.chainSlug,
              contractAddress: n.contract?.address ?? "",
              collectionName: n.contract?.name ?? null,
              tokenId: n.tokenId,
            }));
          },
          { provider: "alchemy" }
        );
        return value;
      } catch {
        return [];
      }
    })
  );

  return NextResponse.json({ items: results.flat() }, { headers: { "Cache-Control": "no-store" } });
}
