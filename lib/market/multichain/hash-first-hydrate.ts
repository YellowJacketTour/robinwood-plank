/**
 * Hash-First Multi-Source Hydration Doctrine -- Grok findings, docs/
 * marketplank/GROK-FINDINGS-intelligence-agency-maximal-vision-2026-08-26.md.
 *
 * An `ipfs://<CID>` (or `ar://<txid>`) IS ALREADY a real cryptographic
 * fingerprint of the bytes it points to -- same content produces the same
 * CID/txid; any real metadata change produces a NEW one. This means a
 * stored fingerprint that still matches the current on-chain pointer is
 * PROOF the body is unchanged -- not a probabilistic guess, not a TTL
 * expiry heuristic, a real content-addressing fact. Re-fetching the body
 * anyway would be pure waste.
 *
 * `data:` and plain `https://` pointers are NOT content-addressed (their
 * bytes can change without the URI changing at all), so a matching
 * fingerprint for those two kinds is only weak evidence, not proof --
 * `needsBodyFetch` never claims otherwise, and a caller doing periodic
 * re-verification (see the ERC-4906-driven lane this module was built
 * for) should still occasionally re-check those two kinds regardless of
 * fingerprint match.
 */
import { createHash } from "crypto";

export type PointerKind = "ipfs" | "arweave" | "data" | "http" | "unknown";

export function normalizeIpfsCid(uri: string): string | null {
  const s = uri.trim();
  const m = s.match(/^ipfs:\/\/(ipfs\/)?([a-zA-Z0-9]+)/i) || s.match(/\/ipfs\/([a-zA-Z0-9]+)/i);
  return m?.[2] ?? m?.[1] ?? null;
}

export function pointerFingerprint(uri: string): { kind: PointerKind; fp: string } {
  const u = uri.trim();
  const cid = normalizeIpfsCid(u);
  if (cid) return { kind: "ipfs", fp: `ipfs:${cid}` };

  const ar = u.match(/^ar:\/\/([a-zA-Z0-9_-]+)/i) || u.match(/arweave\.net\/([a-zA-Z0-9_-]+)/i);
  if (ar?.[1]) return { kind: "arweave", fp: `ar:${ar[1]}` };

  if (u.startsWith("data:")) {
    return { kind: "data", fp: `data:${createHash("sha256").update(u).digest("hex")}` };
  }
  if (/^https?:\/\//i.test(u)) {
    return { kind: "http", fp: `http:${createHash("sha256").update(u).digest("hex")}` };
  }
  return { kind: "unknown", fp: `raw:${createHash("sha256").update(u).digest("hex")}` };
}

/**
 * Returns whether a real IPFS/Arweave/data/HTTP body fetch is required.
 * `fetch: false` for ipfs/arweave/data is a real content-addressing PROOF
 * of "unchanged," not a guess. `fetch: false` for `http` is weaker
 * evidence (a centralized URL's bytes CAN change silently) -- honest
 * about that distinction via the returned `kind`, not glossed over.
 */
export function needsBodyFetch(
  onChainUri: string,
  storedFingerprint: string | null
): { fetch: boolean; fp: string; kind: PointerKind } {
  const { kind, fp } = pointerFingerprint(onChainUri);
  if (!storedFingerprint) return { fetch: true, fp, kind };
  if (storedFingerprint !== fp) return { fetch: true, fp, kind };
  return { fetch: false, fp, kind };
}
