import { getVaultStats } from "@/lib/market/vault-stats";
import { getVaultActivity } from "@/lib/market/vault-activity";
import { rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** How often a connected client receives a tick. */
const TICK_MS = 4_000;
/** How often the underlying chain data is actually re-read — the vault
 * replay (reserves + fee-revenue log walk) is real RPC work, not free, so
 * every open tab shares one server-side refresh cadence instead of each
 * triggering its own. */
const REFRESH_MS = 10_000;
/** Cap per-connection lifetime, just under maxDuration's ceiling — Vercel
 * Node serverless functions aren't guaranteed to sustain a stream past
 * their configured maxDuration, so this proactively recycles the
 * connection instead of risking the platform killing it mid-tick. The
 * client (lib/market/useVaultLive.ts) reconnects quickly, so this cycle
 * should be a brief, unnoticed blip, not a visible drop. */
const MAX_STREAM_MS = 290_000;

let cache: { at: number; stats: unknown; activity: unknown[] } | null = null;
let inflight: Promise<void> | null = null;

async function refresh() {
  if (cache && Date.now() - cache.at < REFRESH_MS) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [stats, activity] = await Promise.all([getVaultStats(), getVaultActivity(30)]);
      cache = { at: Date.now(), stats, activity };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Live vault feed — stats + trade activity, pushed on a tick so
 * VaultDashboard / VaultTradeHistory / LivingLiquidityViz update without a
 * manual refresh. See lib/market/useVaultLive.ts for the shared client-side
 * subscriber (one EventSource per tab, reused across every consumer).
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-stream", limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const tick = async () => {
        if (closed) return;
        try {
          await refresh();
          if (cache) {
            send(sse("vault", { stats: cache.stats, activity: cache.activity }));
          }
        } catch (error) {
          send(sse("error", { message: error instanceof Error ? error.message : "Vault stream error." }));
        }
      };

      await tick();
      const interval = setInterval(tick, TICK_MS);
      const stopTimer = setTimeout(() => {
        clearInterval(interval);
        closed = true;
        try {
          controller.close();
        } catch {}
      }, MAX_STREAM_MS);

      req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        clearTimeout(stopTimer);
        closed = true;
        try {
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
