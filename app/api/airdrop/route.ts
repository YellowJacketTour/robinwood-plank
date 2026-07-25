import {
  attachNftStats,
  buildAirdropSnapshot,
  compactRows,
  lookupAllocation,
} from "@/lib/airdrop-engine";
import {
  buildNftWalletStats,
  getCachedNftWalletStats,
  statsFor,
} from "@/lib/nft-wallet-stats";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** NFT scan can take a while cold; keep room for batch RPC. */
export const maxDuration = 60;

/**
 * GET /api/airdrop
 *  ?address=0x…     → single wallet lookup + summary
 *  ?list=1          → full compact allocation list (default)
 *  ?list=0          → summary only
 *  ?nft=1           → include NFT counts (uses cache; builds if cold)
 *  ?nft=0           → skip NFT scan (fast)
 *  ?q=… &limit= &offset=
 */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "airdrop", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const url = new URL(req.url);
    const address = url.searchParams.get("address")?.trim() || "";
    const listParam = url.searchParams.get("list");
    const wantList = listParam !== "0" && listParam !== "false";
    const nftParam = url.searchParams.get("nft");
    const wantNft = nftParam !== "0" && nftParam !== "false";
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
      if (!nftBag) {
        try {
          const addrs = snap.allocations.map((r) => r.address);
          // If single-address lookup, only scan that wallet (fast)
          if (address) {
            nftBag = await buildNftWalletStats([address], { force: true });
          } else {
            nftBag = await buildNftWalletStats(addrs);
          }
          nftReady = true;
        } catch {
          nftReady = false;
        }
      } else {
        nftReady = true;
      }
    }

    const summary = {
      updatedAt: snap.updatedAt,
      config: snap.config,
      counts: snap.counts,
      equalWeight: snap.equalWeight,
      equalPctOfAirdrop: snap.equalPctOfAirdrop,
      equalPctOfSupply: snap.equalPctOfSupply,
      equalExpectedTokens: snap.equalExpectedTokens,
      woodListRoot: snap.woodListRoot,
      woodListCount: snap.woodListCount,
      nft: {
        ready: nftReady,
        scannedAt: nftBag?.at ? new Date(nftBag.at).toISOString() : null,
        addresses: nftBag?.addresses ?? 0,
      },
      live: {
        stream: "/api/airdrop/stream",
        pollMs: 12_000,
      },
    };

    if (address) {
      let row = lookupAllocation(snap, address);
      if (row && nftBag) {
        const st = statsFor(nftBag, address);
        row = {
          ...row,
          nfts: st.nfts,
          freeMinted: st.free,
          woodMinted: st.wood,
          paidMinted: st.paid,
        };
      }
      return publicJson({
        ...summary,
        query: address.toLowerCase(),
        found: Boolean(row),
        allocation: row,
      });
    }

    if (!wantList) {
      return publicJson(summary);
    }

    let rows = snap.allocations;
    if (nftBag) {
      rows = attachNftStats(rows, nftBag.byAddress);
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
