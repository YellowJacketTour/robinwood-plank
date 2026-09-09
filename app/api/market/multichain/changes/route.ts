import { NextRequest } from "next/server";
import { rateLimit } from "@/lib/security";
import { marketChangeFeed } from "@/lib/market/multichain/edge/change-feed";
import { parseScopes } from "@/lib/market/multichain/edge/change-protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-changes", limit: 30, windowMs: 60_000 });
  if (limited) return limited;
  let scopes;
  try { scopes = parseScopes(JSON.parse(req.nextUrl.searchParams.get("scopes") ?? "[]")); }
  catch { scopes = null; }
  if (!scopes) return Response.json({ error: "Invalid scopes; maximum 64." }, { status: 400 });
  let dispose = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let detach = () => {};
      dispose = () => {
        if (closed) return;
        closed = true;
        detach();
        clearInterval(timer);
        req.signal.removeEventListener("abort", dispose);
        try { controller.close(); } catch { /* consumer already canceled */ }
      };
      const write = (text: string) => {
        if (closed) return;
        // A slow reader reconnects and gets resync instead of unbounded RAM.
        if ((controller.desiredSize ?? 0) <= 0) { dispose(); return; }
        controller.enqueue(encoder.encode(text));
      };
      const timer = setInterval(() => write(": heartbeat\n\n"), 20_000);
      detach = marketChangeFeed().subscribe(scopes, (change) => write(`data: ${JSON.stringify(change)}\n\n`));
      req.signal.addEventListener("abort", dispose, { once: true });
      if (req.signal.aborted) dispose();
    },
    cancel() { dispose(); },
  }, { highWaterMark: 64 });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no",
  } });
}
