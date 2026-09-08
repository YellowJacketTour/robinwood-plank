/**
 * Viewport nonces: the admission gate for visitor-couriered data.
 *
 * Without this, the hydrate endpoint is an open write API and anyone can post
 * metadata for any token. With it, a report is only admissible for a target
 * the client was actually shown, which means poisoning costs rendering the
 * row -- and rendering is rate-limited, attention-visible, and auditable.
 *
 * The nonce is HMAC'd server-side and never stored, so this holds no state a
 * botnet can exhaust and no PII: sessions and networks appear only as keyed
 * hashes.
 */
import type { Hex } from "../shared/hex.ts";

export interface NonceClaims {
  target: string;
  sessionHmac: string;
  issuedAt: number;
  expiresAt: number;
}

export interface IssuedNonce {
  nonce: string;
  claims: NonceClaims;
}

/** Nonces are short-lived: a viewport is a live thing, not a bearer token. */
export const NONCE_TTL_MS = 5 * 60_000;

/** Per session, per window, so one browser cannot mint unlimited write rights. */
export const MAX_NONCES_PER_SESSION_PER_MIN = 60;

export interface NonceDeps {
  hmac: (key: string, msg: string) => Hex;
  now: () => number;
  serverKey: string;
}

export class NonceIssuer {
  private issued = new Map<string, number[]>(); // sessionHmac -> issue times

  private deps: NonceDeps;

  constructor(deps: NonceDeps) {
    this.deps = deps;
  }

  private prune(sessionHmac: string, now: number): number[] {
    const times = (this.issued.get(sessionHmac) ?? []).filter((t) => now - t < 60_000);
    this.issued.set(sessionHmac, times);
    return times;
  }

  /**
   * Issue a nonce for a target the client claims to be displaying.
   *
   * `onScreen` is supplied by the caller from the SERVER's own record of what
   * it rendered for this session -- never from the client's assertion. A
   * client that could name its own on-screen set defeats the whole gate.
   */
  issue(target: string, sessionHmac: string, onScreen: (t: string) => boolean): IssuedNonce | null {
    const now = this.deps.now();
    if (!onScreen(target)) return null;

    const times = this.prune(sessionHmac, now);
    if (times.length >= MAX_NONCES_PER_SESSION_PER_MIN) return null;
    times.push(now);
    this.issued.set(sessionHmac, times);

    const claims: NonceClaims = {
      target,
      sessionHmac,
      issuedAt: now,
      expiresAt: now + NONCE_TTL_MS,
    };
    const payload = `${claims.target}|${claims.sessionHmac}|${claims.issuedAt}|${claims.expiresAt}`;
    return { nonce: `${payload}|${this.deps.hmac(this.deps.serverKey, payload)}`, claims };
  }

  /** Verify a returned nonce: signature, expiry, and target binding. */
  verify(nonce: string, target: string): NonceClaims | null {
    const parts = nonce.split("|");
    if (parts.length !== 5) return null;
    const [t, session, issuedAt, expiresAt, mac] = parts as [string, string, string, string, string];
    const payload = `${t}|${session}|${issuedAt}|${expiresAt}`;
    if (this.deps.hmac(this.deps.serverKey, payload) !== mac) return null;
    if (t !== target) return null; // bound to ONE target: no replay elsewhere
    const exp = Number(expiresAt);
    if (!Number.isFinite(exp) || this.deps.now() > exp) return null;
    return { target: t, sessionHmac: session, issuedAt: Number(issuedAt), expiresAt: exp };
  }
}
