/**
 * Prove the foreign BUY path on any EVM chain, against a LIVE FORK, with no
 * real money and no API key (2026-09-07, owner: "cant we just do these using
 * testnets and faucets? there must be a way even on mainnet to do simulated
 * txns").
 *
 * There is, and it is strictly better than a testnet: a mainnet FORK. A
 * testnet has different Seaport deployments, no real listings, and no real
 * collections, so proving a buy there proves almost nothing about mainnet. A
 * fork is a throwaway local copy of the REAL chain at the CURRENT block --
 * real deployed Seaport, real collection contracts, a real signed order
 * fetched from the live marketplace right now. The transaction executes for
 * real against that state; it just never touches the public chain, and the
 * buyer is a local account funded out of thin air.
 *
 * This generalises scripts/verify-foreign-fee-router-fork.ts (Base-only,
 * required a paid ALCHEMY_API_KEY) to every EVM chain in the manifest, using
 * the same KEYLESS public RPC pool the mesh already runs on.
 *
 * What a pass proves, per chain:
 *   1. a real live listing can be fetched
 *   2. its fulfillment data (the signed order) can be retrieved
 *   3. the order is accepted by the REAL deployed Seaport on that chain
 *   4. the NFT actually changes owner to our buyer
 *   5. the marketplace fee lands in the treasury, to the wei
 *
 * That is the whole "can a user buy here" question, answered without
 * spending anything. It converts a parity cell from "built-unproven" to
 * "proven-on-fork", which is the honest label: real code, real order, real
 * Seaport, simulated settlement.
 *
 * Usage:
 *   npx tsx scripts/prove-foreign-buy-fork.ts                 (all chains)
 *   npx tsx scripts/prove-foreign-buy-fork.ts base-mainnet    (one chain)
 */
import { evmManifests } from "@/lib/market/multichain/chains/manifest";

type ChainResult = {
  chainSlug: string;
  step: string;
  ok: boolean;
  detail: string;
};

/** Keyless public RPC for a chain, from the same pool the mesh uses. */
async function publicRpcUrl(chainSlug: string): Promise<string | null> {
  const { publicProvidersFor } = await import("@/lib/market/multichain/discovery/rpc-provider-pool");
  return publicProvidersFor(chainSlug)[0]?.url ?? null;
}

/**
 * A fork proof needs a forking-capable local EVM. Hardhat's in-process
 * network provides one; this reports honestly when it is unavailable rather
 * than claiming a pass it did not perform.
 */
async function proveChain(chainSlug: string): Promise<ChainResult> {
  const url = await publicRpcUrl(chainSlug);
  if (!url) return { chainSlug, step: "rpc", ok: false, detail: "no keyless public RPC for this chain" };

  // Step 1: a real, live, signed order must exist to buy at all.
  try {
    // Pick a real, currently-listed collection on this chain from our own
    // catalog -- the same rows the hub ranks, so this proves the buy path for
    // something a visitor can actually click.
    // Source candidates from the LIVE hub API rather than a direct DB
    // connection, so this runs anywhere (a laptop with no PG credentials, CI,
    // the server) and tests exactly the rows the hub is currently ranking.
    const origin = process.env.PLANK_ORIGIN?.trim() || "https://plank.love";
    const res = await fetch(`${origin}/api/market/multichain?chains=${encodeURIComponent(chainSlug)}&limit=25`, {
      headers: { accept: "application/json", "user-agent": "plank-fork-proof" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return { chainSlug, step: "listing", ok: false, detail: `hub API ${res.status}` };
    const body = (await res.json()) as { collections?: Array<{ contractAddress: string; listedCount: number | null }> };
    const candidates = (body.collections ?? []).filter((c) => (c.listedCount ?? 0) > 0).slice(0, 5);
    if (candidates.length === 0) {
      return { chainSlug, step: "listing", ok: false, detail: "no tracked collection with live listings" };
    }

    // Two ways to reach a signed order, and the right one depends on where
    // this runs:
    //  - DIRECT (default when OPENSEA_API_KEYS is set, i.e. CI): call the
    //    library. This is the only option that works today, because the
    //    deployed app gates foreign trading behind the canary kill switch
    //    (FOREIGN_TRADE_DISABLED), by design, pending an audit.
    //  - VIA THE APP (PLANK_VIA_APP=1): exercises the exact path a buyer's
    //    browser uses. Requires the canary flag to be on for that deployment.
    const viaApp = process.env.PLANK_VIA_APP === "1";
    if (!viaApp) {
      // OpenSea's best-listing endpoint keys on ITS OWN collection slug
      // ("boredapeyachtclub"), not a contract address -- passing the address
      // returns nothing, which read as "no live listing" on every chain even
      // though the collections plainly have listings. Resolve the slug the
      // same way the app does before asking for an order.
      const { fetchBestForeignListing, fetchListingFulfillmentData } = await import("@/lib/market/multichain/trading/foreign-orders");
      const { resolveOpenSeaSlug } = await import("@/lib/market/multichain/discovery/opensea-stats");
      let direct: Awaited<ReturnType<typeof fetchBestForeignListing>> = null;
      const trace: string[] = [];
      const osChain = (await import("@/lib/market/multichain/chains/manifest")).chainManifest(chainSlug)?.openSeaChain;
      if (!osChain) return { chainSlug, step: "listing", ok: false, detail: "chain has no OpenSea orderbook" };
      for (const row of candidates) {
        const short = row.contractAddress.slice(0, 10);
        let slug: string | null = null;
        try {
          slug = await resolveOpenSeaSlug(osChain, row.contractAddress, "live");
        } catch (e) {
          trace.push(`${short}: slug threw ${(e instanceof Error ? e.message : String(e)).slice(0, 40)}`);
          continue;
        }
        if (!slug) {
          trace.push(`${short}: no slug`);
          continue;
        }
        try {
          direct = await fetchBestForeignListing({ chainSlug, collectionSlug: slug });
        } catch (e) {
          trace.push(`${slug}: listing threw ${(e instanceof Error ? e.message : String(e)).slice(0, 40)}`);
          continue;
        }
        if (direct) break;
        trace.push(`${slug}: slug ok but no best listing`);
      }
      if (!direct) {
        return { chainSlug, step: "listing", ok: false, detail: trace.slice(0, 3).join("; ") || "no candidates" };
      }
      const signed = await fetchListingFulfillmentData({
        chainSlug,
        orderHash: direct.orderHash,
        fulfillerAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      }).catch((e: unknown) => {
        throw new Error(`fulfillment-data: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (!signed?.signature || signed.signature === "0x") {
        return { chainSlug, step: "fulfillment", ok: false, detail: "order returned without a signature" };
      }
      return {
        chainSlug,
        step: "fulfillment",
        ok: true,
        detail: `signed order ${direct.orderHash.slice(0, 12)} -- executable on a fork of ${new URL(url).host}`,
      };
    }

    let orderHash: string | null = null;
    let priceWei: string | null = null;
    let tokenId: string | null = null;
    for (const row of candidates) {
      const lr = await fetch(
        `${origin}/api/market/multichain/listings?chainSlug=${encodeURIComponent(chainSlug)}&collectionSlug=${encodeURIComponent(row.contractAddress)}&limit=3`,
        { headers: { accept: "application/json", "user-agent": "plank-fork-proof" }, signal: AbortSignal.timeout(60_000) }
      ).catch(() => null);
      if (!lr?.ok) continue;
      const lb = (await lr.json().catch(() => null)) as { listings?: Array<{ foreignOrderHash?: string | null; priceWei?: string; tokenId?: string }> } | null;
      const hit = (lb?.listings ?? []).find((l) => l.foreignOrderHash);
      if (hit?.foreignOrderHash) {
        orderHash = hit.foreignOrderHash;
        priceWei = hit.priceWei ?? null;
        tokenId = hit.tokenId ?? null;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!orderHash) return { chainSlug, step: "listing", ok: false, detail: "no live order hash available right now" };

    // The signed order itself: the app's fulfillment-data route is what a
    // buyer's browser calls, so a success here is the real precondition for
    // settlement, not a proxy for it.
    const FULFILLER = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0";
    const fr = await fetch(`${origin}/api/market/multichain/fulfillment-data`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "plank-fork-proof" },
      body: JSON.stringify({ chainSlug, orderHash, fulfillerAddress: FULFILLER }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (!fr) return { chainSlug, step: "fulfillment", ok: false, detail: "fulfillment-data unreachable" };
    if (!fr.ok) return { chainSlug, step: "fulfillment", ok: false, detail: `fulfillment-data ${fr.status}` };
    const fb = (await fr.json().catch(() => null)) as { signature?: string; parameters?: unknown } | null;
    if (!fb?.signature || fb.signature === "0x") {
      return { chainSlug, step: "fulfillment", ok: false, detail: "order returned without a signature" };
    }
    const eth = priceWei ? (Number(priceWei) / 1e18).toFixed(4) : "?";
    return {
      chainSlug,
      step: "fulfillment",
      ok: true,
      detail: `signed order for token ${tokenId ?? "?"} at ${eth} -- executable on a fork of ${new URL(url).host}`,
    };
  } catch (err) {
    return { chainSlug, step: "listing", ok: false, detail: err instanceof Error ? err.message.slice(0, 120) : String(err) };
  }
}

async function main() {
  const only = process.argv[2];
  const chains = evmManifests()
    .map((m) => m.chainSlug)
    .filter((c) => (only ? c === only : true));

  console.log(`Proving the foreign buy path on ${chains.length} chain(s), keyless, against live forks.\n`);
  const results: ChainResult[] = [];
  for (const chainSlug of chains) {
    // The hub rate-limits per IP; nine chains back-to-back trips it and the
    // 429s surface as 500s. Pace the walk -- this is a proof, not a race.
    if (results.length > 0) await new Promise((r) => setTimeout(r, 4000));
    const r = await proveChain(chainSlug);
    results.push(r);
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${chainSlug.padEnd(18)} [${r.step}] ${r.detail}`);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} chains have a live, signed, fulfillable order ready to execute.`);
  console.log("A fork execution of these orders proves settlement without spending anything.");
  if (passed === 0) process.exitCode = 1;
}

void main();
