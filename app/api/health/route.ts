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
    return publicJson({
      ok: true,
      storage: backend,
      version: process.env.DEPLOYMENT_VERSION || "unknown",
      serverNow: new Date().toISOString(),
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
