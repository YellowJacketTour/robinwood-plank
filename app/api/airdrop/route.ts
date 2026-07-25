import {
  attachNftStats,
  buildAirdropSnapshot,
  compactRows,
  lookupAllocation,
  recomputeByNftHoldings,
} from "@/lib/airdrop-engine";
import {
  buildNftWalletStats,
  getCachedNftWalletStats,
  statsFor,
} from "@/lib/nft-wallet-stats";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/airdrop
 *  ?nft=1  → full ownerOf holdings + PLANK weighted by NFT count
 *  ?mode=equal|nft  (default nft once stats ready)
 */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "airdrop", limit: 40, windowMs: 60_000 });
    if (limited) return limited;

    const url = new URL(req.url);
    const address = url.searchParams.get("address")?.trim() || "";
    const listParam = url.searchParams.get("list");
    const wantList = listParam !== "0" && listParam !== "false";
    const nftParam = url.searchParams.get("nft");
    const wantNft = nftParam !== "0" && nftParam !== "false";
    const modeParam = (url.searchParams.get("mode") || "nft").toLowerCase();
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const limit = Math.min(
      5_000,
      Math.max(1, Number(url.searchParams.get("limit") || "5000") || 5000)
    );
    const offset = Math.max(0, Number(url.searchParams.get("offset") || "0") || 0);

    const snap = await buildAirdropSnapshot();

    let nftReady = false;
    let nftBag = getCachedNftWalletStats();

    if (wantNft) {
      try {
        if (address && !nftBag) {
          nftBag = await buildNftWalletStats([address], { force: true });
        } else if (!nftBag || Date.now() - nftBag.at > 90_000) {
          const addrs = snap.allocations.map((r) => r.address);
          nftBag = await buildNftWalletStats(addrs);
        }
        nftReady = Boolean(nftBag?.ready);
      } catch {
        nftReady = Boolean(nftBag?.ready);
      }
    }

    const useNftWeight =
      wantNft &&
      nftReady &&
      nftBag &&
      modeParam !== "equal" &&
      (nftBag.totalNfts || 0) > 0;

    let rows = snap.allocations;
    let allocationMode: "equal" | "nft" = "equal";
    let holdersWithNfts = 0;
    let totalNftsWeighted = 0;

    if (nftBag) {
      if (useNftWeight) {
        const recomputed = recomputeByNftHoldings({
          rows: snap.allocations,
          byAddress: nftBag.byAddress,
          poolHuman: snap.config.airdropPoolTokens,
          airdropPercentOfSupply: snap.config.airdropPercentOfSupply,
          includeAllHolders: true,
        });
        rows = recomputed.rows;
        holdersWithNfts = recomputed.holdersWithNfts;
        totalNftsWeighted = recomputed.totalNftsWeighted;
        allocationMode = "nft";
      } else {
        rows = attachNftStats(rows, nftBag.byAddress);
      }
    }

    // Equal-share display when still in equal mode
    const equalExpected =
      allocationMode === "equal" ? snap.equalExpectedTokens : null;

    const summary = {
      updatedAt: snap.updatedAt,
      config: snap.config,
      counts: {
        ...snap.counts,
        // When NFT-weighted, approved = rows shown
        approved: rows.length,
        holdersWithNfts,
        totalNfts: totalNftsWeighted || nftBag?.totalNfts || 0,
      },
      equalWeight: allocationMode === "equal" ? snap.equalWeight : false,
      equalPctOfAirdrop:
        allocationMode === "equal" ? snap.equalPctOfAirdrop : null,
      equalPctOfSupply:
        allocationMode === "equal" ? snap.equalPctOfSupply : null,
      equalExpectedTokens: equalExpected,
      allocationMode,
      woodListRoot: snap.woodListRoot,
      woodListCount: snap.woodListCount,
      nft: {
        ready: nftReady,
        scannedAt: nftBag?.at ? new Date(nftBag.at).toISOString() : null,
        addresses: nftBag?.addresses ?? 0,
        uniqueHolders: nftBag?.uniqueHolders ?? 0,
        totalNfts: nftBag?.totalNfts ?? 0,
      },
      live: {
        stream: "/api/airdrop/stream",
        pollMs: 12_000,
      },
    };

    if (address) {
      const a = address.toLowerCase();
      let row = rows.find((r) => r.address === a) || null;
      if (!row) {
        const base = lookupAllocation(snap, address);
        if (base && nftBag) {
          const st = statsFor(nftBag, address);
          row = {
            ...base,
            nfts: st.nfts,
            freeMinted: st.free,
            woodMinted: st.wood,
            paidMinted: st.paid,
          };
          if (useNftWeight && nftBag.totalNfts > 0) {
            const share = st.nfts / nftBag.totalNfts;
            const pool = BigInt(snap.config.airdropPoolTokens);
            const expected =
              st.nfts > 0
                ? (pool * BigInt(st.nfts)) / BigInt(nftBag.totalNfts)
                : BigInt(0);
            row = {
              ...row,
              shareOfAirdrop: share,
              pctOfAirdrop: Number((share * 100).toFixed(8)),
              pctOfSupply: Number(
                (snap.config.airdropPercentOfSupply * share).toFixed(10)
              ),
              expectedTokens: expected.toString(),
              weight: st.nfts,
            };
          }
        } else {
          row = base;
        }
      }
      return publicJson({
        ...summary,
        query: a,
        found: Boolean(row),
        allocation: row,
      });
    }

    if (!wantList) {
      return publicJson(summary);
    }

    if (q) {
      rows = rows.filter((r) => r.address.includes(q));
    }
    const total = rows.length;
    const page = rows.slice(offset, offset + limit);

    return publicJson({
      ...summary,
      list: {
        total,
        offset,
        limit,
        q: q || null,
        rows: compactRows(page),
      },
    });
  } catch (err) {
    return publicError(err, "Failed to load airdrop allocations.");
  }
}
