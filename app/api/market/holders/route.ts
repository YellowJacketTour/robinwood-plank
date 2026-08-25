import { NFT_CONTRACT_ADDRESS, ROBINWOOD_TOTAL_SUPPLY } from "@/lib/mint-contract";
import { getOwnerIndex, uniqueWalletCount } from "@/lib/market/owner-index";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Distinct RobinWood wallets from the durable owner index (not Alchemy). */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-holders", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  try {
    const index = await getOwnerIndex(NFT_CONTRACT_ADDRESS);
    const holders = index ? uniqueWalletCount(index.owners) : 0;
    return publicJson({
      contractAddress: NFT_CONTRACT_ADDRESS,
      holders: holders > 0 ? holders : null,
      tokensIndexed: index?.count ?? null,
      totalSupply: ROBINWOOD_TOTAL_SUPPLY,
      source: index?.source ?? null,
    });
  } catch (error) {
    return publicError(error, "Could not load holder count.");
  }
}
