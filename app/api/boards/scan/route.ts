import {
  getTrapWindow,
  isOffWidgetCaptureActive,
  isSniperCaptureActive,
} from "@/lib/boards";
import { scanPlankTransfers } from "@/lib/boards-scanner";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Scan chain for off-widget $PLANK transfers.
 * Death trap: all EOAs. Cooldown: non–plank.love widget buyers only.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "boards-scan", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    if (!isOffWidgetCaptureActive()) {
      const trap = getTrapWindow();
      return publicJson({
        ok: true,
        skipped: true,
        live: false,
        sniperCapture: false,
        offWidgetCapture: false,
        phase: trap.phase,
        message:
          "Off-widget capture inactive — free trade, pre-LP, or rules relaxed. plank.love buyers are never blacklisted.",
      });
    }

    const result = await scanPlankTransfers({ maxBlocks: 3_000 });
    return publicJson({
      ok: true,
      live: true,
      sniperCapture: isSniperCaptureActive(),
      offWidgetCapture: true,
      ...result,
    });
  } catch (err) {
    return publicError(err, "Chain scan failed.");
  }
}

export async function GET(req: Request) {
  return POST(req);
}
