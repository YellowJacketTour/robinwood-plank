import { isMoonPayConfigured, MOONPAY_ENABLED, moonpayEnv } from "@/lib/moonpay-server";
import { publicJson } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public status probe -- same shape/purpose as /api/zerox/status: lets
 * MoonPayPanel no-op cleanly (hide itself) when the feature flag is off or
 * the server has no API key configured yet, without attempting a widget-URL
 * build first. Nothing here is secret (no key value, just booleans).
 */
export function GET() {
  return publicJson({
    enabled: MOONPAY_ENABLED,
    configured: isMoonPayConfigured(),
    sandbox: moonpayEnv() !== "production",
  });
}
