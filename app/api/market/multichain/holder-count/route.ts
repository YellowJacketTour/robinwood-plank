/**
 * On-demand real holder count for a single EVM collection (see
 * fetchHolderCount in alchemy-nft.ts's own header for why this is never
 * run in bulk sync -- Alchemy's getOwnersForContract has no cheap
 * count-only mode, only worth paying for when a real visitor is actually
 * looking at this one collection's detail page).
 *
 * Cached: returns the already-stored value from a prior call instead of
 * re-fetching Alchemy every page view; the client can pass force=1 to
 * bypass that cache (not currently used, reserved for a future "refresh"
 * affordance).
 */
import { NextRequest, NextResponse } from "next/server";
import { getCollectionSupplyStats, updateHolderCount } from "@/lib/market/multichain/store";
import { fetchHolderCount } from "@/lib/market/multichain/adapters/alchemy-nft";
import { deriveApproxHolderCountFromLedger } from "@/lib/market/multichain/ledger-activity";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-holder-count", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const chainSlug = req.nextUrl.searchParams.get("chainSlug");
  const contractAddress = req.nextUrl.searchParams.get("contractAddress");
  const force = req.nextUrl.searchParams.get("force") === "1";
  if (!chainSlug || !contractAddress) {
    return NextResponse.json({ error: "chainSlug and contractAddress are required" }, { status: 400 });
  }

  try {
    if (!force) {
      const existing = await getCollectionSupplyStats(chainSlug, contractAddress);
      if (existing?.holderCount != null) {
        return NextResponse.json({ holderCount: existing.holderCount, cached: true });
      }
    }
    // Alchemy throws (rate limit, jailed monthly quota, network error) at
    // least as often as it cleanly returns null -- catching it here, not
    // just checking for a null return, is what actually lets the free
    // ledger-derived fallback below run instead of the whole request
    // dying on Alchemy's failure.
    const holderCount = await fetchHolderCount(chainSlug, contractAddress).catch(() => null);
    if (holderCount != null) {
      await updateHolderCount(chainSlug, contractAddress, holderCount);
      return NextResponse.json({ holderCount, cached: false });
    }
    // REAL FALLBACK 2026-08-24 ("wire our functions into intel wherever
    // advantageous"): Alchemy's getOwnersForContract has no free
    // alternative endpoint, but this app's own first-party activity
    // ledger (transfer-ledger.ts + every self-hosted fill indexer,
    // already unioned by ledger-activity.ts for the Activity tab) lets a
    // real, free, on-chain-derived estimate be computed instead of
    // returning nothing. Deliberately NOT written to the authoritative
    // holder_count column (updateHolderCount) -- an under-covered ledger
    // could undercount a real total, and silently overwriting a real
    // value with an approximation would be a regression, not a fix. It's
    // surfaced only in this response, clearly labeled as an estimate.
    const approx = await deriveApproxHolderCountFromLedger(chainSlug, contractAddress).catch(() => null);
    return NextResponse.json({
      holderCount: null,
      cached: false,
      holderCountApprox: approx?.holderCount ?? null,
      holderCountApproxSampleSize: approx?.sampleSize ?? null,
    });
  } catch (error) {
    return publicError(error, "Failed to load holder count.");
  }
}
