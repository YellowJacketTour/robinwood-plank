import { listRecentJobRuns } from "@/lib/market/contest-job-observability";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Track B of the 2026-08-26 KOTH data-plane rework -- see
 * contest-job-observability.ts's own header. No secrets exposed (job
 * status/counts/cursor only), so no auth beyond rate-limiting, matching
 * this app's other read-only admin health routes (opensea-pool-health,
 * alchemy-pool-health).
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "admin-contest-job-runs",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const runs = await listRecentJobRuns(30);
    return publicJson({ fetchedAt: new Date().toISOString(), runs });
  } catch (err) {
    return publicError(err, "Could not read contest job run history.");
  }
}
