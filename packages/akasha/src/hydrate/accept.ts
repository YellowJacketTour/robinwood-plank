/**
 * What the archive will accept from a visitor, and what it refuses.
 *
 * THE RULE THAT WAS WRONG
 * -----------------------
 * The superseded design accepted metadata when "two independent visitors
 * report the same body hash". That is unsound: IPs are a market. Two browsers
 * is a rental, not independence, so a two-browser attacker confirms garbage
 * and the archive badges it as rarity. `TWO_HASHES_ARE_NOT_CONFIRMATION`
 * below exists so that rule cannot be reintroduced by someone who did not
 * read this comment.
 *
 * THE RULE THAT REPLACES IT
 * -------------------------
 * Split on whether the object can authenticate ITSELF:
 *
 *   content_addressed  H(body) must equal the on-chain commitment. Sybil-proof
 *                      by construction; the visitor is a modem. One honest
 *                      report is enough, and a million dishonest ones are worth
 *                      nothing.
 *   signed_order       signature + unspent inputs verify against the chain.
 *                      Same property, same reason.
 *   https_mutable      CANNOT authenticate. It is an OBSERVATION, never a fact:
 *                      unconfirmed until a server fetch matches, or K reports
 *                      with pairwise-distinct networks span Δt. Any clash makes
 *                      it disputed and forces a server fetch.
 *
 * This deliberately does NOT produce truth for unwatched HTTPS tokens. It
 * produces truth for watched ones and for everything that can authenticate.
 * That is the whole demand that is achievable; claiming more would be a lie
 * the UI then repeats.
 */
import type { Hex } from "../shared/hex.ts";
import type { ObservationStatus, UriClass } from "../shared/types.ts";

export interface Observation {
  target: string;
  uri: string;
  bodySha256: Hex;
  observedAt: number;
  sessionHmac: string;
  asnHmac: string;
  status: ObservationStatus;
}

export interface AcceptDeps {
  now: () => number;
  sha256: (b: Uint8Array) => Hex;
  /** Verifies a Seaport-style order: signature, counter, not cancelled/filled. */
  verifySignedOrder?: (body: Uint8Array, target: string) => boolean;
  /** Server-side fetch, used for promotion and forced on any clash. */
  serverFetch?: (uri: string) => Promise<Uint8Array | null>;
}

/** Promotion knobs. K distinct networks spanning Δt, or one server fetch. */
export const K_DISTINCT_ASN = 3;
export const QUORUM_WINDOW_MS = 15 * 60_000;
/** Metadata bodies are small; anything larger is a bomb, not a token. */
export const MAX_BODY_BYTES = 256 * 1024;

export type AcceptResult =
  | { accepted: true; canonical: true; reason: "content_addressed" | "signed_order" }
  | { accepted: true; canonical: false; status: ObservationStatus; reason: string }
  | { accepted: false; reason: string };

/**
 * Classify a URI by whether it commits to its own bytes.
 *
 * Deliberately conservative: anything not provably content-addressed is
 * treated as mutable. A false "content_addressed" would let a visitor write
 * canonical data, so ambiguity must resolve toward the weaker claim.
 */
export function classifyUri(uri: string): UriClass {
  const u = uri.trim().toLowerCase();
  if (u.startsWith("ipfs://")) return "content_addressed";
  if (u.startsWith("ar://")) return "content_addressed";
  if (u.startsWith("sha256://")) return "content_addressed";
  if (u.startsWith("data:")) return "content_addressed";
  // An HTTPS gateway URL that embeds a CID still commits to its bytes.
  if (/\/ipfs\/(ba[a-z2-7]{57,}|qm[1-9a-hj-np-z]{44,})/i.test(u)) return "content_addressed";
  return "https_mutable";
}

/**
 * Extract the digest a content-addressed URI commits to.
 *
 * Returns null for CIDv0/v1 multihash forms we cannot verify without a
 * multihash decoder -- and null MUST mean "reject", never "trust". A URI that
 * looks content-addressed but whose digest we cannot check is exactly the
 * case an attacker would construct.
 */
export function committedDigest(uri: string): { algo: "sha256"; hex: string } | null {
  const m = /^sha256:\/\/([0-9a-f]{64})$/i.exec(uri.trim());
  if (m) return { algo: "sha256", hex: (m[1] as string).toLowerCase() };
  return null;
}

/**
 * The single refusal point for the superseded rule. Calling this is a bug by
 * definition, so it throws rather than returning false.
 */
export function TWO_HASHES_ARE_NOT_CONFIRMATION(): never {
  throw new Error(
    "two matching body hashes from two browsers is NOT confirmation: IPs are a market. " +
      "Use content-addressed verification, signed-order verification, or the ASN-diverse quorum."
  );
}

export class ObservationLedger {
  private byTarget = new Map<string, Observation[]>();

  private deps: AcceptDeps;

  constructor(deps: AcceptDeps) {
    this.deps = deps;
  }

  all(target: string): Observation[] {
    return this.byTarget.get(target) ?? [];
  }

  status(target: string): ObservationStatus | null {
    const obs = this.all(target);
    if (obs.length === 0) return null;
    if (obs.some((o) => o.status === "disputed")) return "disputed";
    if (obs.some((o) => o.status === "confirmed")) return "confirmed";
    return "unconfirmed";
  }

  /**
   * Record a report. `nonceValid` is the caller's verification result -- this
   * class never trusts a client-supplied target.
   */
  report(
    o: Omit<Observation, "status">,
    nonceValid: boolean
  ): { status: ObservationStatus; forcedFetch: boolean } | { rejected: string } {
    if (!nonceValid) return { rejected: "no valid viewport nonce for this target" };

    const existing = this.all(o.target);
    const clash = existing.some((e) => e.bodySha256 !== o.bodySha256);

    const record: Observation = { ...o, status: "unconfirmed" };
    const next = [...existing, record];
    this.byTarget.set(o.target, next);

    if (clash) {
      // The origin is serving different bytes to different vantages, or
      // someone is lying. Either way the archive must not pick a winner on
      // its own -- mark disputed and go look.
      for (const e of next) e.status = "disputed";
      return { status: "disputed", forcedFetch: true };
    }

    // Quorum: K reports, pairwise-distinct networks, spanning the window.
    const agreeing = next.filter((e) => e.bodySha256 === o.bodySha256);
    const networks = new Set(agreeing.map((e) => e.asnHmac));
    const oldest = Math.min(...agreeing.map((e) => e.observedAt));
    const spans = o.observedAt - oldest >= QUORUM_WINDOW_MS;

    if (networks.size >= K_DISTINCT_ASN && spans) {
      for (const e of agreeing) e.status = "confirmed";
      return { status: "confirmed", forcedFetch: false };
    }
    return { status: "unconfirmed", forcedFetch: false };
  }

  /** A server fetch is authoritative for mutable URIs. */
  confirmByServer(target: string, bodySha: Hex): ObservationStatus {
    const obs = this.all(target);
    for (const o of obs) o.status = o.bodySha256 === bodySha ? "confirmed" : "disputed";
    if (obs.length === 0) {
      this.byTarget.set(target, []);
    }
    return this.status(target) ?? "unconfirmed";
  }
}

/**
 * The accept decision for one couriered body.
 *
 * Note the asymmetry: a content-addressed body is accepted as CANONICAL from a
 * single anonymous report because the chain commitment does the trusting. An
 * HTTPS body is never canonical no matter how many reports agree.
 */
export function acceptReport(
  input: {
    target: string;
    uri: string;
    body: Uint8Array;
    nonceValid: boolean;
    sessionHmac: string;
    asnHmac: string;
  },
  ledger: ObservationLedger,
  deps: AcceptDeps
): AcceptResult {
  if (!input.nonceValid) return { accepted: false, reason: "no valid viewport nonce" };
  if (input.body.length > MAX_BODY_BYTES) {
    return { accepted: false, reason: `body exceeds ${MAX_BODY_BYTES} bytes` };
  }

  const cls = classifyUri(input.uri);
  const digest = deps.sha256(input.body);

  if (cls === "content_addressed") {
    const committed = committedDigest(input.uri);
    if (!committed) {
      // Looks content-addressed but we cannot check it. Refuse rather than
      // silently downgrade to canonical -- this is the attacker's best move.
      return {
        accepted: false,
        reason: "content-addressed URI whose digest cannot be verified here",
      };
    }
    if (digest.replace(/^0x/, "").toLowerCase() !== committed.hex) {
      return { accepted: false, reason: "body does not match the committed digest" };
    }
    return { accepted: true, canonical: true, reason: "content_addressed" };
  }

  if (cls === "signed_order") {
    if (!deps.verifySignedOrder?.(input.body, input.target)) {
      return { accepted: false, reason: "order signature did not verify" };
    }
    return { accepted: true, canonical: true, reason: "signed_order" };
  }

  const outcome = ledger.report(
    {
      target: input.target,
      uri: input.uri,
      bodySha256: digest,
      observedAt: deps.now(),
      sessionHmac: input.sessionHmac,
      asnHmac: input.asnHmac,
    },
    input.nonceValid
  );
  if ("rejected" in outcome) return { accepted: false, reason: outcome.rejected };
  return {
    accepted: true,
    canonical: false,
    status: outcome.status,
    reason: outcome.forcedFetch ? "clash: server fetch forced" : "observation recorded",
  };
}
