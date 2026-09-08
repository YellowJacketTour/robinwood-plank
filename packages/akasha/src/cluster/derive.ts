/**
 * Deriving hard edges from the tape, including the mall problem.
 *
 * THE MALL PROBLEM
 * ----------------
 * "One contract = one collection" is true for most ERC-721s and false for the
 * ones that matter most. OpenSea's Shared Storefront and its descendants let
 * thousands of unrelated creators mint from a single contract. If CONTRACT is
 * applied blindly, every one of those becomes ONE collection with a six-digit
 * supply, and the archive is wrong in a way no downstream fix repairs.
 *
 * The inverse failure is just as bad: slicing a normal collection because a
 * few tokens were minted by a second address explodes it into fragments.
 *
 * So malls are detected from the chain -- minter diversity plus URI forking --
 * and never from a vendor flag, because the vendor flag is exactly the
 * dependency this whole design exists to remove.
 */
import type { ChainEvent, ChainId } from "../shared/types.ts";
import type { HardEdge } from "./graph.ts";

export interface MallVerdict {
  isMall: boolean;
  distinctMinters: number;
  tokenCount: number;
  uriPrefixes: number;
  reason: string;
}

/**
 * Thresholds. A real collection usually mints from one or two addresses (the
 * deployer, maybe a minter contract). A mall has many unrelated creators AND
 * forking metadata paths. BOTH conditions are required: a popular collection
 * with open minting has many minters but ONE uri prefix, and must not slice.
 */
export const MALL_MIN_MINTERS = 8;
export const MALL_MIN_URI_PREFIXES = 4;
export const MALL_MIN_TOKENS = 50;

/**
 * The stable namespace a tokenURI lives under, or null if unusable.
 *
 * For `ipfs://` the CID alone is the namespace: one directory CID means one
 * publisher, and the filename after it varies per token by design.
 *
 * For HTTP this deliberately keeps the host PLUS its first path segment.
 * Host-only was wrong in a way that defeated the whole mall check: OpenSea's
 * Shared Storefront serves every unrelated creator from a single host and
 * distinguishes them by path, so a host-only prefix reports "1 prefix" for a
 * mall of thousands and lets it collapse into one collection. Keeping one
 * path segment separates those creators while still ignoring the per-token
 * filename, so an ordinary collection under one directory stays at one prefix.
 */
export function uriPrefix(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const ipfs = /^ipfs:\/\//i.test(uri);
  const cleaned = uri.replace(/^ipfs:\/\//i, "").replace(/^https?:\/\//i, "");
  const parts = cleaned.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  // A CID is the publisher; deeper segments are that publisher's own layout.
  if (ipfs) return parts[0]!.slice(0, 64);
  // Host alone is not a namespace on shared infrastructure.
  const segments = parts.length >= 3 ? parts.slice(0, 2) : parts.slice(0, 1);
  return segments.join("/").slice(0, 128) || null;
}

export function detectMall(
  events: ChainEvent[],
  uriFor?: (tokenId: string) => string | null
): MallVerdict {
  const minters = new Set<string>();
  const tokens = new Set<string>();
  const prefixes = new Set<string>();

  for (const e of events) {
    if (e.kind !== "transfer721" && e.kind !== "transfer1155") continue;
    // A mint is a transfer out of the zero address.
    if (/^0x0{40}$/i.test(e.fromAddr)) {
      minters.add(e.toAddr.toLowerCase());
      tokens.add(e.tokenOrInscription);
      const p = uriPrefix(uriFor?.(e.tokenOrInscription) ?? null);
      if (p) prefixes.add(p);
    }
  }

  const isMall =
    minters.size >= MALL_MIN_MINTERS &&
    prefixes.size >= MALL_MIN_URI_PREFIXES &&
    tokens.size >= MALL_MIN_TOKENS;

  return {
    isMall,
    distinctMinters: minters.size,
    tokenCount: tokens.size,
    uriPrefixes: prefixes.size,
    reason: isMall
      ? `mall: ${minters.size} minters across ${prefixes.size} uri prefixes`
      : `single collection: ${minters.size} minters, ${prefixes.size} uri prefixes`,
  };
}

/**
 * Slice key for a mall token, re-derived from chain data only.
 *
 * Order of preference: the address that minted it (the true creator), then
 * the URI prefix. Never a marketplace's collection id -- that is the vendor
 * dependency we are removing, and it is also how a wrong "creator" gets
 * attached to a collection.
 */
export function sliceKey(
  e: ChainEvent,
  uriFor?: (tokenId: string) => string | null
): string | null {
  if (/^0x0{40}$/i.test(e.fromAddr)) return e.toAddr.toLowerCase();
  const p = uriPrefix(uriFor?.(e.tokenOrInscription) ?? null);
  return p;
}

export interface DeriveInput {
  chain: ChainId;
  events: ChainEvent[];
  /** Optional metadata URI lookup; absent for chains where we have no body yet. */
  uriFor?: (tokenId: string) => string | null;
  /** Ordinals parent declarations, from the envelope parser (tag 3). */
  parents?: Array<{ child: string; parent: string; blockHash: string; loc: number }>;
  /** EIP-1167 clones tied to a factory event. */
  clones?: Array<{ clone: string; implementation: string; blockHash: string; loc: number }>;
}

/**
 * Hard edges for one chain's slice of tape.
 *
 * The mall check runs BEFORE any CONTRACT edge is emitted, which is the
 * ordering that keeps Shared Storefront from collapsing into one cluster.
 * Emitting CONTRACT first and slicing afterwards cannot work: the union is
 * already made, and un-merging a witness-hashed id is not possible.
 */
export function deriveHardEdges(input: DeriveInput): HardEdge[] {
  const edges: HardEdge[] = [];

  // 1. Ordinals parent-child: a protocol-level declaration, the strongest
  //    signal Bitcoin offers, and the reason we can cluster inscriptions
  //    without anyone publishing a list.
  for (const p of input.parents ?? []) {
    edges.push({
      kind: "PARENT",
      a: p.parent,
      b: p.child,
      witness: { blockHash: p.blockHash, loc: p.loc },
    });
  }

  // 2. Same-reveal batches: inscriptions revealed in one transaction are one
  //    act of publication.
  const byReveal = new Map<string, ChainEvent[]>();
  for (const e of input.events) {
    if (e.kind !== "envelope") continue;
    const list = byReveal.get(e.txHash) ?? [];
    list.push(e);
    byReveal.set(e.txHash, list);
  }
  for (const [, group] of byReveal) {
    if (group.length < 2) continue;
    const first = group[0]!;
    for (let i = 1; i < group.length; i++) {
      const g = group[i]!;
      edges.push({
        kind: "SAME_REVEAL",
        a: first.tokenOrInscription,
        b: g.tokenOrInscription,
        witness: { blockHash: g.blockHash, loc: g.loc },
      });
    }
  }

  // 3. Factory clones.
  for (const c of input.clones ?? []) {
    edges.push({
      kind: "CLONE_OF",
      a: c.implementation,
      b: c.clone,
      witness: { blockHash: c.blockHash, loc: c.loc },
    });
  }

  // 4. EVM contracts -- mall-checked FIRST.
  const byContract = new Map<string, ChainEvent[]>();
  for (const e of input.events) {
    if (e.kind !== "transfer721" && e.kind !== "transfer1155") continue;
    const key = e.contractOrProgram.toLowerCase();
    const list = byContract.get(key) ?? [];
    list.push(e);
    byContract.set(key, list);
  }

  for (const [contract, evs] of byContract) {
    const verdict = detectMall(evs, input.uriFor);
    if (verdict.isMall) {
      // Slice: group by creator, and union only WITHIN a slice.
      const bySlice = new Map<string, ChainEvent[]>();
      for (const e of evs) {
        const k = sliceKey(e, input.uriFor);
        if (!k) continue;
        const list = bySlice.get(k) ?? [];
        list.push(e);
        bySlice.set(k, list);
      }
      for (const [k, sliceEvents] of bySlice) {
        const first = sliceEvents[0]!;
        for (let i = 1; i < sliceEvents.length; i++) {
          const s = sliceEvents[i]!;
          edges.push({
            kind: "STOREFRONT_SLICE",
            a: `${contract}#${k}:${first.tokenOrInscription}`,
            b: `${contract}#${k}:${s.tokenOrInscription}`,
            witness: { blockHash: s.blockHash, loc: s.loc },
          });
        }
      }
      continue; // never emit CONTRACT for a mall
    }

    const first = evs[0]!;
    for (let i = 1; i < evs.length; i++) {
      const e = evs[i]!;
      edges.push({
        kind: "CONTRACT",
        a: `${contract}:${first.tokenOrInscription}`,
        b: `${contract}:${e.tokenOrInscription}`,
        witness: { blockHash: e.blockHash, loc: e.loc },
      });
    }
  }

  return edges;
}
