import {
  durableKv,
  durableKvBackend,
} from "@/lib/market/durable-kv";
import { publicJson } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
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

    // Presence-only booleans -- never the values themselves. Lets us verify
    // a deploy actually has the config the new code expects (added 2026-08-24
    // ahead of the dev->master catch-up merge, PR #112) without ever SSHing
    // in to read shared/.env.production by hand.
    const envKeys = {
      RPC_URL: Boolean(process.env.RPC_URL?.trim()),
      ENVIO_API_TOKEN: Boolean(process.env.ENVIO_API_TOKEN?.trim()),
      HELIUS_API_KEY: Boolean(process.env.HELIUS_API_KEY?.trim()),
      SOLANA_RPC_URL: Boolean(process.env.SOLANA_RPC_URL?.trim()),
      MAGICEDEN_API_KEY: Boolean(process.env.MAGICEDEN_API_KEY?.trim()),
      UNISAT_API_KEY: Boolean(process.env.UNISAT_API_KEY?.trim()),
      ORDISCAN_API_KEY: Boolean(process.env.ORDISCAN_API_KEY?.trim()),
      GLOBAL_MARKET_ENABLED:
        process.env.NEXT_PUBLIC_GLOBAL_MARKET_ENABLED?.trim().toLowerCase() === "true",
    };

    return publicJson({
      ok: true,
      storage: backend,
      version: process.env.DEPLOYMENT_VERSION || "unknown",
      serverNow: new Date().toISOString(),
      ...(openSea ? { openSeaKey: openSea } : {}),
      envKeys,
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
