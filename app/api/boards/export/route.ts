import { listAllBadBoards, venueLabelFor } from "@/lib/boards-store";
import { formatEth3 } from "@/lib/eth-price";
import { rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * One-click blacklist export for 20lab / ops dashboards.
 *
 * GET /api/boards/export?format=csv        → full CSV (default)
 * GET /api/boards/export?format=addresses  → one address per line
 * GET /api/boards/export?format=json       → JSON array
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "boards-export", limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") || "csv").toLowerCase();
  const rows = await listAllBadBoards();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "addresses" || format === "txt") {
    const body = rows.map((r) => r.address).join("\n") + (rows.length ? "\n" : "");
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="plank-blacklist-${stamp}.txt"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (format === "json") {
    return new Response(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          count: rows.length,
          addresses: rows.map((r) => r.address),
          rows: rows.map((r) => ({
            address: r.address,
            venue: r.venue || "death_trap",
            venueLabel: r.venueLabel || venueLabelFor(r.venue || "death_trap"),
            reason: r.reason,
            wasGoodWood: r.wasGoodWood,
            ethSpent: formatEth3(r.ethSpentWei || "0"),
            ethSpentWei: r.ethSpentWei || "0",
            firstSeenAt: r.firstSeenAt,
            lastSeenAt: r.lastSeenAt,
            sources: r.sources,
            txHashes: r.txHashes,
          })),
        },
        null,
        2
      ),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="plank-blacklist-${stamp}.json"`,
          "Cache-Control": "no-store",
        },
      }
    );
  }

  // CSV — first column is address for simple 20lab / dashboard import
  const header = [
    "address",
    "venue",
    "venue_label",
    "reason",
    "was_good_wood",
    "fallen",
    "eth_spent",
    "eth_spent_wei",
    "first_seen_at",
    "last_seen_at",
    "sources",
    "tx_count",
  ].join(",");

  const lines = rows.map((r) => {
    const venue = r.venue || "death_trap";
    return [
      r.address,
      venue,
      csvEscape(r.venueLabel || venueLabelFor(venue)),
      csvEscape(r.reason || ""),
      r.wasGoodWood ? "true" : "false",
      r.wasGoodWood ? "true" : "false",
      formatEth3(r.ethSpentWei || "0"),
      r.ethSpentWei || "0",
      r.firstSeenAt,
      r.lastSeenAt,
      csvEscape((r.sources || []).join("|")),
      String((r.txHashes || []).length),
    ].join(",");
  });

  const body = [header, ...lines].join("\n") + "\n";

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="plank-blacklist-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
