import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Community Meme Vault proxy — https://memes.smoothbrain.app/developers
 *
 * Server-side rather than fetched from the browser, for three reasons:
 *
 * 1. The key never reaches the client. Reads work unauthenticated, so a
 *    missing key degrades to a lower rate limit rather than an outage — but a
 *    submit-capable key in a browser bundle would be a real credential leak,
 *    and their docs say so explicitly. Same handling as UNISWAP_API_KEY and
 *    ZEROX_API_KEY.
 * 2. Their limits are per-IP for anonymous reads. Proxying means our visitors
 *    share one server-side budget we can cache in front of, instead of each
 *    browser spending its own and a popular moment tripping 429s.
 * 3. It pins `project=plank`. This page is the RobinWood meme vault, not a
 *    general browser for someone else's project.
 */

const UPSTREAM = "https://memes.smoothbrain.app/api/v1/assets";
const PROJECT = "plank";

/**
 * Server-side cache, because the budget is 1,000 reads/hour for the whole
 * site — roughly 16/minute shared by every visitor at once. Next's
 * `revalidate` alone is not enough: it keys on the URL, so each filter
 * combination (type × search × page) is its own entry and a handful of people
 * changing filters can outspend the budget between them.
 *
 * Five minutes is generous for a moderated, newest-first feed — a meme
 * approved upstream shows up within one cache cycle — and it bounds the worst
 * case to 12 upstream reads per hour per distinct query.
 */
const TTL_MS = 5 * 60_000;
/** Bounded so a crafted query string cannot grow this without limit. */
const MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; payload: unknown }>();

function readCache(key: string): unknown | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function writeCache(key: string, payload: unknown): void {
  if (cache.size >= MAX_ENTRIES) {
    // Oldest insertion first — Map preserves insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), payload });
}

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "memes", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const params = new URL(req.url).searchParams;
  const page = Number(params.get("page") ?? "1");
  const type = params.get("type");
  const q = (params.get("q") ?? "").trim();

  // Validate before forwarding. Their API caps limit at 50; anything outside
  // the documented range is our bug to catch, not theirs to reject.
  const qs = new URLSearchParams({
    project: PROJECT,
    limit: "24",
    page: String(Number.isFinite(page) && page > 0 ? Math.min(page, 200) : 1),
  });
  if (type === "image" || type === "video") qs.set("type", type);
  if (q) qs.set("q", q.slice(0, 100));

  const cacheKey = qs.toString();
  const cached = readCache(cacheKey);
  if (cached) return cachedPublicJson(cached, "token");

  // Named for the secret the owner created. Reads work without it — the key
  // only raises the rate limit — so an unset value degrades to a smaller
  // budget, never to an outage.
  const key = process.env.MEMES_VAULT_API?.trim();
  try {
    const res = await fetch(`${UPSTREAM}?${qs.toString()}`, {
      headers: {
        Accept: "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      // Their feed is moderated and newest-first; a minute of staleness is
      // invisible to a visitor and keeps us well inside their budget.
      next: { revalidate: 60 },
    });

    if (res.status === 429) {
      // Serve stale over failing: an expired entry is still a real feed, and
      // the alternative is an empty page while we are rate limited.
      const stale = cache.get(cacheKey);
      if (stale) return cachedPublicJson(stale.payload, "token");
      return publicJson(
        { error: "RATE_LIMITED", message: "The meme vault is busy — try again shortly." },
        429
      );
    }
    if (!res.ok) throw new Error(`meme vault HTTP ${res.status}`);

    const data = (await res.json()) as {
      assets?: unknown[];
      page?: number;
      hasMore?: boolean;
      attribution?: { text?: string; url?: string; required?: boolean };
      // Upstream reports whether OUR key was accepted. Passed through because
      // a key that is merely present is not a key that works: reads succeed
      // unauthenticated, so without this a revoked or mistyped key looks
      // identical to a good one right up until a submission fails.
      authenticated?: boolean;
    };

    // Attribution is flagged `required: true` upstream and is passed through
    // verbatim so the page can render it. Not optional, and not ours to strip.
    const payload = {
      assets: Array.isArray(data.assets) ? data.assets : [],
      page: data.page ?? 1,
      hasMore: Boolean(data.hasMore),
      attribution: data.attribution ?? null,
      authenticated: Boolean(data.authenticated),
    };
    // Never cache an empty success — that is the shape that poisoned the
    // marketplace order book and the vault history before it.
    if (payload.assets.length > 0) writeCache(cacheKey, payload);
    return cachedPublicJson(payload, "token");
  } catch (error) {
    const stale = cache.get(cacheKey);
    if (stale) return cachedPublicJson(stale.payload, "token");
    return publicError(error, "Could not reach the meme vault.");
  }
}
