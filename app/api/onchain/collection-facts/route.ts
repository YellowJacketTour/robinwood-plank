/**
 * Same-origin, live on-chain fact sheet for a collection -- the cheap
 * (single eth_call), page-load-safe subset of the on-chain data extraction
 * suite (lib/market/multichain/discovery/onchain-contract-reads.ts,
 * onchain-extensions.ts). Deliberately does NOT run Transfer-log-history
 * scans, Seaport fill scans, or holder-distribution derivation here --
 * those require walking potentially millions of historical blocks and
 * belong in a background job writing to a table (the same pattern this
 * app already uses for rarity/token projections), not a live per-request
 * fetch. This route is only for facts a single real-time contract read can
 * answer: royalty split (ERC-2981) and whether the contract signals
 * dynamic/refreshable metadata (ERC-4906).
 */
import { NextRequest, NextResponse } from "next/server";
import { publicError, rateLimit } from "@/lib/security";
import { readRoyaltyInfo } from "@/lib/market/multichain/discovery/onchain-contract-reads";
import { hasMetadataUpdateSupport } from "@/lib/market/multichain/discovery/onchain-extensions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "onchain-collection-facts", limit: 300, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const contractAddress = searchParams.get("contractAddress");
  if (!chainSlug || !contractAddress || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
    return NextResponse.json({ error: "BAD_REQUEST", message: "chainSlug and a real 0x contractAddress are required." }, { status: 400 });
  }

  try {
    // REAL BUG CAUGHT AND FIXED BEFORE MERGE (2026-08-24): this used to
    // gate royaltyInfo() behind a supportsInterface(0x2a55205a) check --
    // live-tested against Moonbirds (0x23581767a106ae21c074b2276d25e5c3e136a68b),
    // a contract confirmed EARLIER THIS SESSION to genuinely implement
    // ERC-2981 (a real 1% royalty split reads back successfully), and the
    // gate produced a false negative: Moonbirds answers royaltyInfo()
    // correctly but doesn't answer supportsInterface for it truthfully, a
    // known real-world mismatch (ERC-165 registration is a separate,
    // sometimes-forgotten step from actually implementing a function).
    // Matches this codebase's existing contractURI() convention -- try the
    // real call directly, a revert is itself the honest "not supported"
    // signal, never gated behind a declaration that can be wrong.
    // royaltyInfo() needs a real sample sale price to quote a real bps
    // split -- 1 ETH is an arbitrary but honest probe value (the returned
    // amount is a linear function of salePrice, so any nonzero value
    // reveals the real percentage).
    const [royalty, dynamicMetadata] = await Promise.all([
      readRoyaltyInfo(chainSlug, contractAddress, 0, 1_000_000_000_000_000_000n).catch(() => null),
      hasMetadataUpdateSupport(chainSlug, contractAddress),
    ]);
    const royaltyBps = royalty ? Number((royalty.royaltyAmountWei * 10_000n) / 1_000_000_000_000_000_000n) : null;
    return NextResponse.json(
      {
        royaltySupported: Boolean(royalty),
        royaltyReceiver: royalty?.receiver ?? null,
        royaltyBps,
        dynamicMetadataSupported: dynamicMetadata,
      },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" } }
    );
  } catch (error) {
    return publicError(error, "Could not read on-chain collection facts right now.");
  }
}
