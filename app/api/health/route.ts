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

    return publicJson({
      ok: true,
      storage: backend,
      version: process.env.DEPLOYMENT_VERSION || "unknown",
      serverNow: new Date().toISOString(),
      ...(openSea ? { openSeaKey: openSea } : {}),
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
