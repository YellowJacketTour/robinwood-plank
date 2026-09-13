export class RuntimeBootError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = "RuntimeBootError"; }
}

type BootOptions = {
  token: string;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

/** Explicit user-started boot only. Server sets the HttpOnly runtime cookie;
 * this client receives only its expiry and never persists or forwards a ticket.
 * No automatic retry: an uncertain response may already have issued a session.
 */
export const bootRuntimeSession = (options: BootOptions) => runtimeSessionRequest(options, "/api/charmville/runtime-session");
/** Renews the existing cookie without replacing the iframe or issuing another ticket. */
export const renewRuntimeSession = (options: BootOptions) => runtimeSessionRequest(options, "/charmville/runtime/session");

async function runtimeSessionRequest(options: BootOptions, endpoint: string): Promise<{ expiresAt: string }> {
  const cancelled = () => options.signal?.aborted || !(options.isCurrent?.() ?? true);
  const assertCurrent = () => { if (cancelled()) throw new DOMException("Game opening cancelled", "AbortError"); };
  assertCurrent();
  if (!/^[a-f0-9]{64}$/i.test(options.token)) throw new RuntimeBootError("Sign in before opening the game.", 401);
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError("Boot timeout must be between 1 and 30000 milliseconds");
  const abort = new AbortController();
  const cancel = () => abort.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
  try {
    const response = await (options.fetcher ?? fetch)(endpoint, {
      method: "POST", headers: { authorization: `Bearer ${options.token}`, Accept: "application/json" },
      credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: abort.signal,
    });
    assertCurrent();
    if (timedOut) throw new RuntimeBootError("Opening the game took too long. Please try again.", 504);
    if (!response.ok) {
      // Server errors remain bounded, user-facing copy; never echo opaque body data.
      const message = response.status === 401 ? "Your sign-in expired. Sign in again." : response.status === 403 ? "This account cannot enter this Charmville release." : response.status === 429 ? "Too many game openings. Wait a few minutes and try again." : "The game could not open. Please try again.";
      throw new RuntimeBootError(message, response.status);
    }
    const result: unknown = await response.json();
    assertCurrent();
    if (timedOut) throw new RuntimeBootError("Opening the game took too long. Please try again.", 504);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new RuntimeBootError("The game session could not be confirmed.", 502);
    const expiresAt = (result as Record<string, unknown>).expiresAt;
    const now = (options.now ?? Date.now)();
    const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
    // Issuer grants at most ten minutes. Thirty seconds tolerates ordinary clock skew.
    if (typeof expiresAt !== "string" || !Number.isFinite(now) || !Number.isFinite(expiry) || expiry <= now || expiry > now + 630_000)
      throw new RuntimeBootError("The game session expiry could not be confirmed. Check your device clock and try again.", 502);
    return { expiresAt };
  } catch (error) {
    assertCurrent();
    if (timedOut) throw new RuntimeBootError("Opening the game took too long. Please try again.", 504);
    if (error instanceof RuntimeBootError) throw error;
    throw new RuntimeBootError("The game session could not be confirmed. Please try again.", 503);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
