import { isAdminAddress } from "@/lib/admin-auth";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Is this address on the admin allowlist?
 *
 * Purely so the console can avoid rendering management tools to someone who
 * cannot use them. It grants nothing: every mutation is still verified by
 * signature server-side, and answering "yes" here does not make a save
 * succeed. Treat it as presentation, never as authorization.
 *
 * Membership is not a secret — the allowlist defaults to the treasury wallets
 * published in lib/constants.ts, and /api/admin/status already exposes the
 * action log with admin addresses in it. This exposes no more than that, and
 * only for an address the caller already knows. Rate limited anyway, so it is
 * not a comfortable way to sweep a list of candidates.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "admin-whoami",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const address = new URL(req.url).searchParams.get("address") ?? "";
    return publicJson({ isAdmin: isAdminAddress(address) });
  } catch (err) {
    return publicError(err, "Could not check the admin allowlist.");
  }
}
