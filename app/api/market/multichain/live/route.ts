/**
 * Server-Sent Events fan-out of real market events -- one Postgres tail
 * per process (lib/market/multichain/edge/live-feed.ts) shared by every
 * connected browser. GET /api/market/multichain/live?chainSlug=&collectionKey=
 *
 * Read-only, public, rate-limited per IP on connect. Sends a heartbeat
 * comment every 20s so proxies keep the stream open. Writers stay scripts.
 */
import { NextRequest } from "next/server";
import { rateLimit } from "@/lib/security";
import { subscribeLiveFeed } from "@/lib/market/multichain/edge/live-feed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 20_000;

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-live", limit: 20, windowMs: 60_000 });
  if (limited) return limited;
  const chainSlug = req.nextUrl.searchParams.get("chainSlug");
  const collectionKey = req.nextUrl.searchParams.get("collectionKey");
  const encoder = new TextEncoder();

  let detach: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      write(`event: hello\ndata: ${JSON.stringify({ chainSlug, collectionKey, at: new Date().toISOString() })}\n\n`);
      detach = subscribeLiveFeed({ chainSlug, collectionKey }, (event) => {
        write(`event: market\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      heartbeat = setInterval(() => {
        try {
          write(`: ping ${Date.now()}\n\n`);
        } catch {
          /* closed */
        }
      }, HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => {
        detach?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      detach?.();
      if (heartbeat) clearInterval(heartbeat);
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
