import { buildAirdropSnapshot, compactRows } from "@/lib/airdrop-engine";
import { rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const TICK_MS = 3_000;
const MAX_STREAM_MS = 180_000;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Live airdrop allocation feed.
 * Emits summary ticks + full list when the approved set / config changes.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "airdrop-stream", limit: 15, windowMs: 60_000 });
  if (limited) return limited;

  const encoder = new TextEncoder();
  let closed = false;
  const started = Date.now();
  let lastFingerprint = "";

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
          /* */
        }
      };
      req.signal.addEventListener("abort", abort);

      while (!closed && Date.now() - started < MAX_STREAM_MS) {
        try {
          const snap = await buildAirdropSnapshot({ force: false, cacheMs: 5_000 });
          const fingerprint = [
            snap.counts.approved,
            snap.counts.totalWeight,
            snap.config.totalSupply,
            snap.config.airdropPercentOfSupply,
            snap.config.airdropPoolTokens,
            snap.woodListCount,
          ].join("|");

          const summary = {
            updatedAt: snap.updatedAt,
            config: snap.config,
            counts: snap.counts,
            equalWeight: snap.equalWeight,
            equalPctOfAirdrop: snap.equalPctOfAirdrop,
            equalPctOfSupply: snap.equalPctOfSupply,
            equalExpectedTokens: snap.equalExpectedTokens,
            woodListRoot: snap.woodListRoot,
            woodListCount: snap.woodListCount,
            serverNow: new Date().toISOString(),
          };

          if (fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            // Full compact list on change (cap for safety)
            const rows = compactRows(snap.allocations.slice(0, 5_000));
            push("snapshot", {
              ...summary,
              list: { total: snap.allocations.length, rows },
            });
          } else {
            push("tick", summary);
          }
          push("ping", { t: Date.now() });
        } catch (e) {
          push("error", {
            message: e instanceof Error ? e.message : "tick failed",
          });
        }

        await new Promise((r) => setTimeout(r, TICK_MS));
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
