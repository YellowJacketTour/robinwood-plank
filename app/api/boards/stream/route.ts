import {
  getTrapWindow,
  isListingWindowActive,
  isOfficialWidgetOpen,
  isSniperCaptureActive,
  SNIPER_TRAP_MINUTES,
  WALLET_COOLDOWN_MINUTES,
} from "@/lib/boards";
import {
  getLastScanAgeMs,
  publicBoardsSnapshot,
  withVolumeDecorators,
} from "@/lib/boards-store";
import { scanPlankTransfers } from "@/lib/boards-scanner";
import { getEthUsdPrice } from "@/lib/eth-price";
import { rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Keep SSE open long enough for a live session; client reconnects if capped. */
export const maxDuration = 300;

const AUTO_SCAN_EVERY_MS = 12_000;
/** Tick cadence for ETH/USD + ledger push (tick-by-tick feel). */
const TICK_MS = 1_000;
/** Max open time per connection before client reconnects. */
const MAX_STREAM_MS = 240_000;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function buildPayload() {
  const trap = getTrapWindow();
  const snap = await publicBoardsSnapshot();
  const decorated = await withVolumeDecorators(snap);
  return {
    trap: {
      active: isListingWindowActive(),
      phase: trap.phase,
      trapStartsAt: trap.trapStartsAt.toISOString(),
      tradeOpensAt: trap.tradeOpensAt.toISOString(),
      cooldownsEndAt: trap.cooldownsEndAt.toISOString(),
      sniperTrapMinutes: SNIPER_TRAP_MINUTES,
      walletCooldownMinutes: WALLET_COOLDOWN_MINUTES,
      serverNow: new Date().toISOString(),
    },
    counts: {
      goodWood: snap.goodWoodCount,
      badBoards: Object.keys(snap.state.badBoards).length,
      widgetVerified: Object.keys(snap.state.widgetSessions).length,
      fallen: snap.fallenCount,
    },
    recentBadBoards: decorated.recentBad,
    naughtyLedger: decorated.recentBad,
    niceLedger: snap.niceLedger,
    volume: decorated.volume,
    scan: {
      lastScannedBlock: snap.state.lastScannedBlock,
      notes: snap.state.scanNotes,
      updatedAt: snap.state.updatedAt,
    },
    live: {
      autoScanEveryMs: AUTO_SCAN_EVERY_MS,
      listingActive: isListingWindowActive(),
      sniperCapture: isSniperCaptureActive(),
      widgetOpen: isOfficialWidgetOpen(),
      stream: "/api/boards/stream",
    },
  };
}

/**
 * Server-Sent Events live feed for Bad Boards ETH + USD volume.
 * Emits:
 *  - `snapshot` full ledger + volume (~every scan / first connect)
 *  - `tick`     volume + price every ~1s (ETH 3dp + USD)
 *  - `ping`     keep-alive
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "boards-stream", limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  const encoder = new TextEncoder();
  let closed = false;
  const started = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const push = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          closed = true;
        }
      };

      const abort = () => {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal.addEventListener("abort", abort);

      // Immediate snapshot
      try {
        // Only chain-scan while widget is locked (sniper capture)
        if (isSniperCaptureActive()) {
          const age = await getLastScanAgeMs();
          if (age >= AUTO_SCAN_EVERY_MS) {
            try {
              await scanPlankTransfers({ maxBlocks: 2_000 });
            } catch {
              // still stream existing state
            }
          }
        }
        const payload = await buildPayload();
        push("snapshot", payload);
        push("tick", payload.volume);
      } catch (e) {
        push("error", {
          message: e instanceof Error ? e.message : "stream init failed",
        });
      }

      let lastFull = Date.now();

      while (!closed && Date.now() - started < MAX_STREAM_MS) {
        await new Promise((r) => setTimeout(r, TICK_MS));
        if (closed) break;

        try {
          // Periodic chain scan only while death trap / widget locked
          if (isSniperCaptureActive()) {
            const age = await getLastScanAgeMs();
            if (age >= AUTO_SCAN_EVERY_MS) {
              try {
                await scanPlankTransfers({ maxBlocks: 2_000 });
              } catch {
                // ignore scan blip
              }
            }
          }

          // Full snapshot every ~4s so new snipers appear without waiting for reconnect
          if (Date.now() - lastFull >= 4_000) {
            const payload = await buildPayload();
            push("snapshot", payload);
            push("tick", payload.volume);
            lastFull = Date.now();
          } else {
            // Price-only tick for USD flicker live feel
            const snap = await publicBoardsSnapshot();
            const price = await getEthUsdPrice();
            const { formatEth3, formatUsd, weiToUsd } = await import("@/lib/eth-price");
            const totalWei = snap.totalEthSpentWei || "0";
            const totalUsd = weiToUsd(totalWei, price.usd);
            push("tick", {
              serverNow: new Date().toISOString(),
              ethUsd: price.usd,
              ethUsdSource: price.source,
              totalEthSpent: formatEth3(totalWei),
              totalEthSpentWei: totalWei,
              totalUsd,
              totalUsdLabel: formatUsd(totalUsd),
              badBoards: Object.keys(snap.state.badBoards).length,
              fallen: snap.fallenCount,
            });
          }

          push("ping", { t: Date.now() });
        } catch (e) {
          push("error", {
            message: e instanceof Error ? e.message : "tick failed",
          });
        }
      }

      push("reconnect", { reason: "max_duration" });
      abort();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
