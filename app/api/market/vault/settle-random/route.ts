import { SITE_URL } from "@/lib/constants";
import { durableKv, hasDurableKv } from "@/lib/market/durable-kv";
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
  // SAME-ORIGIN ONLY, AND BUDGETED. This path exists so a visitor can finish
  // their OWN redeem right after clicking, without the site handing a secret
  // to the browser -- a real need, and the on-chain action is permissionless
  // anyway.
  //
  // But it was an unconditional `return true` before the secret check could
  // matter, so anyone anywhere could make the server spend RELAYER_PRIVATE_KEY
  // gas. Bounded only by a per-IP rate limit, which a distributed caller
  // ignores, and the relayer had no spend cap at all. Not theft -- the tx is
  // permissionless -- but unbounded gas griefing of our own wallet.
  //
  // Two bounds, because either alone is weak: the request must come from our
  // own pages (a scripted caller has no Origin, or the wrong one), AND the
  // day's public settlements are capped, so even a same-origin XSS or a
  // determined browser loop cannot drain the relayer.
  const url = new URL(req.url);
  if (url.searchParams.get("public") !== "1") return false;
  return isSameOrigin(req);
}

/**
 * Is this request from our own page?
 *
 * A browser always sends Origin on a cross-origin fetch and Referer on a
 * same-origin one; a curl or a bot typically sends neither. Absent BOTH is
 * refused rather than trusted -- "no header" is the scripted case, and the
 * legitimate case (a click on our own page) always has at least one.
 */
function isSameOrigin(req: Request): boolean {
  const site = SITE_URL.replace(/\/$/, "");
  const origin = req.headers.get("origin");
  if (origin) return origin.replace(/\/$/, "") === site;
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === new URL(site).origin;
    } catch {
      return false;
    }
  }
  return false;
}

/** Public settlements allowed per UTC day, across every caller. */
const PUBLIC_SETTLE_DAILY_CAP = 500;

/**
 * Spend one unit of the day's public budget, or refuse.
 *
 * Durable rather than in-process: the rate limiter is per-instance, so on a
 * multi-instance deploy an in-memory counter would be trivially multiplied by
 * the number of instances. Fails OPEN when no durable KV is configured --
 * a missing cache must not break a legitimate user's redeem, and the
 * same-origin check still stands in front of it.
 */
async function takePublicSettleBudget(): Promise<boolean> {
  if (!hasDurableKv()) return true;
  const key = `plank:settle-random:public:${new Date().toISOString().slice(0, 10)}`;
  try {
    const used = (await durableKv.get<number>(key)) ?? 0;
    if (used >= PUBLIC_SETTLE_DAILY_CAP) return false;
    await durableKv.set(key, used + 1, { ex: 2 * 24 * 3600 });
    return true;
  } catch {
    return true;
  }
}

async function handle(req: Request) {
  const limited = rateLimit(req, { key: "vault-settle-random", limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  // The day's budget is spent only by the PUBLIC path; an authenticated cron
  // caller is trusted and uncapped, which is the whole point of the secret.
  const isPublicPath = new URL(req.url).searchParams.get("public") === "1";
  if (isPublicPath && !(await takePublicSettleBudget())) {
    return publicJson(
      { error: "SETTLE_BUDGET_SPENT", message: "Too many public settlements today. Try again tomorrow or contact support." },
      429,
    );
  }

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
