import {
  durableKv,
  durableKvBackend,
} from "@/lib/market/durable-kv";
import { publicJson } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Same Bearer/header CRON_SECRET pattern as
 * app/api/market/vault/settle-random/route.ts. Flagged in security review
 * 2026-08-25: this endpoint is public/unauthenticated, so even presence-only
 * booleans of which vendor keys are configured is real recon value to an
 * attacker (narrows which of ~7 third-party integrations are live). Gate the
 * envKeys block behind ops auth instead of returning it to anyone.
 */
function opsAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-plank-settle") === secret;
}

export async function GET(req: Request) {
  try {
    const backend = durableKvBackend();
    if (!backend) {
      return publicJson(
        {
          ok: false,
          storage: null,
          version: process.env.DEPLOYMENT_VERSION || "unknown",
        },
        503
      );
    }

    // A missing key is expected. The read proves that the selected durable
    // backend, credentials, connection pool, and migrated KV table are usable.
    await durableKv.get("plank:health:read-probe");

    // Credential state only — never the key. Free OpenSea keys expire after 30
    // days and the cron renews them; if that stops working, daysRemaining
    // counting down to zero is the warning. Not part of `ok`: OpenSea data is
    // supplementary, and the site is healthy without it.
    const { openSeaKeyStatus } = await import("@/lib/market/opensea");
    const openSea = await openSeaKeyStatus().catch(() => null);

    // Presence-only booleans -- never the values themselves -- and only for
    // an authorized ops caller (see opsAuthorized's header comment). Lets us
    // verify a deploy actually has the config the new code expects (added
    // 2026-08-24 ahead of the dev->master catch-up merge, PR #112) without
    // ever SSHing in to read shared/.env.production by hand, and without
    // handing an unauthenticated caller a map of which of ~7 vendor
    // integrations are live.
    const envKeys = opsAuthorized(req)
      ? {
          RPC_URL: Boolean(process.env.RPC_URL?.trim()),
          ENVIO_API_TOKEN: Boolean(process.env.ENVIO_API_TOKEN?.trim()),
          HELIUS_API_KEY: Boolean(process.env.HELIUS_API_KEY?.trim()),
          SOLANA_RPC_URL: Boolean(process.env.SOLANA_RPC_URL?.trim()),
          MAGICEDEN_API_KEY: Boolean(process.env.MAGICEDEN_API_KEY?.trim()),
          UNISAT_API_KEY: Boolean(process.env.UNISAT_API_KEY?.trim()),
          ORDISCAN_API_KEY: Boolean(process.env.ORDISCAN_API_KEY?.trim()),
          GLOBAL_MARKET_ENABLED:
            process.env.NEXT_PUBLIC_GLOBAL_MARKET_ENABLED?.trim().toLowerCase() === "true",
        }
      : null;

    return publicJson({
      ok: true,
      storage: backend,
      version: process.env.DEPLOYMENT_VERSION || "unknown",
      serverNow: new Date().toISOString(),
      ...(openSea ? { openSeaKey: openSea } : {}),
      ...(envKeys ? { envKeys } : {}),
    });
  } catch {
    return publicJson(
      {
        ok: false,
        storage: "unavailable",
        version: process.env.DEPLOYMENT_VERSION || "unknown",
      },
      503
    );
  }
}
