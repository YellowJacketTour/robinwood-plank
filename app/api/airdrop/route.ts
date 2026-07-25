import {
  buildAirdropSnapshot,
  compactRows,
  lookupAllocation,
} from "@/lib/airdrop-engine";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/airdrop
 *  ?address=0x…     → single wallet lookup + summary
 *  ?list=1          → full compact allocation list (default)
 *  ?list=0          → summary only (tiny)
 *  ?q=0xabc         → filter list by prefix/substring
 *  ?limit=100&offset=0 → page the list
 */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "airdrop", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const url = new URL(req.url);
    const address = url.searchParams.get("address")?.trim() || "";
    const listParam = url.searchParams.get("list");
    const wantList = listParam !== "0" && listParam !== "false";
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const limit = Math.min(
      5_000,
      Math.max(1, Number(url.searchParams.get("limit") || "500") || 500)
    );
    const offset = Math.max(0, Number(url.searchParams.get("offset") || "0") || 0);

    const snap = await buildAirdropSnapshot();

    const summary = {
      updatedAt: snap.updatedAt,
      config: snap.config,
      counts: snap.counts,
      equalWeight: snap.equalWeight,
      equalPctOfAirdrop: snap.equalPctOfAirdrop,
      equalPctOfSupply: snap.equalPctOfSupply,
      woodListRoot: snap.woodListRoot,
      woodListCount: snap.woodListCount,
      live: {
        stream: "/api/airdrop/stream",
        pollMs: 12_000,
      },
    };

    if (address) {
      const row = lookupAllocation(snap, address);
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
