import { isReferralConfigured, REFERRAL_ENABLED } from "@/lib/referral-server";
import { publicJson } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public status probe -- same shape/purpose as /api/zerox/status and
 * /api/moonpay/status: lets ReferralPanel no-op cleanly when the flag is
 * off or Postgres isn't configured, without attempting a claim first.
 */
export function GET() {
  return publicJson({
    enabled: REFERRAL_ENABLED,
    configured: isReferralConfigured(),
  });
}
