import { isSniperCaptureActive, getTrapWindow } from "@/lib/boards";
import { scanPlankTransfers } from "@/lib/boards-scanner";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Scan chain for off-widget $PLANK transfers during the death trap only
 * (official widget still locked). Once the widget is on, capture is off so
 * official buyers are never auto-logged as Bad Boards.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "boards-scan", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    if (!isSniperCaptureActive()) {
      const trap = getTrapWindow();
      return publicJson({
        ok: true,
        skipped: true,
        live: false,
        sniperCapture: false,
        phase: trap.phase,
        message:
          trap.phase === "cooldown_window" || trap.phase === "free"
            ? "Official widget is open — chain Bad Boards capture is off. Buyers through plank.love are not logged as Bad Boards."
            : "Sniper capture inactive — cooldowns complete, pre-LP, or rules relaxed.",
      });
    }

    const result = await scanPlankTransfers({ maxBlocks: 3_000 });
    return publicJson({
      ok: true,
      live: true,
      sniperCapture: true,
      ...result,
    });
  } catch (err) {
    return publicError(err, "Chain scan failed.");
  }
}

export async function GET(req: Request) {
  return POST(req);
}
