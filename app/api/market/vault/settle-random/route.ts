import { settleRandomRedeems } from "@/lib/market/server-settle-random";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Gas-sponsored finish for random redeem (relay target round + claimFor).
 *
 * Auth:
 *  - Authorization: Bearer <CRON_SECRET>  (cron / ops)
 *  - or x-plank-settle: <CRON_SECRET>
 *  - If CRON_SECRET is unset, open but heavily rate-limited (dev only).
 *
 * Query:
 *  - vault=0x… optional single vault
 *  - for=0x… optional preferred requester (still settles whoever holds the slot)
 *
 * Idle (no pending): free (RPC reads only, no txs).
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    // No secret configured — allow but rely on rate limit (local / early setup).
    return true;
  }
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-plank-settle") === secret) return true;
  // Allow same-origin browser kicks after redeem without exposing secret:
  // only when ?public=1 and rate-limited — settles whatever is pending (safe,
  // permissionless on-chain anyway). Optional public path for Instant Swap.
  const url = new URL(req.url);
  if (url.searchParams.get("public") === "1") return true;
  return false;
}

async function handle(req: Request) {
  const limited = rateLimit(req, { key: "vault-settle-random", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  if (!authorized(req)) {
    return publicJson({ error: "UNAUTHORIZED", message: "Missing settle auth." }, 401);
  }

  const url = new URL(req.url);
  const vault = url.searchParams.get("vault");
  const forRequester = url.searchParams.get("for");

  try {
    const report = await settleRandomRedeems({
      vault,
      forRequester,
    });
    return publicJson({ ...report, spentGas: report.spentGas });
  } catch (error) {
    return publicError(error, "Could not settle random redeem.");
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
