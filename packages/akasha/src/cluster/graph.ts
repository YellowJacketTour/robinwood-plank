/**
 * The announcement graph: collection identity from chain events alone.
 *
 * A collection is NOT a row in someone's catalog. It is an equivalence class
 * over artifacts, closed under a small set of HARD provenance edges, whose
 * id is a hash of the genesis witnesses that created it. That definition is
 * checkable by a stranger and cannot be revoked by a vendor -- which is the
 * whole point, given that on 2026-09-08 Ordiscan answered 402, Magic Eden
 * 503, UniSat 404, and Hiro had already returned 410 Gone.
 *
 * THE LOAD-BEARING DISTINCTION
 * ----------------------------
 * Hard edges define identity. Soft edges only ever attach CANDIDATES.
 *
 * If a soft edge could merge clusters, one bad guess is permanent: Bitcoin
 * common-input clustering merges two projects that used the same inscription
 * service, and sequence clustering merges unrelated mints that happened to
 * land in the same busy block. There is no safe unmerge after the id is a
 * hash of the merged witness set, so the rule is enforced by construction
 * here rather than by reviewer discipline.
 */
import type { ChainId } from "../shared/types.ts";

export type HardEdgeKind =
  | "PARENT" // ordinals tag-3 parent, or Solana verified collection
  | "SAME_REVEAL" // inscriptions revealed in one tx
  | "CLONE_OF" // EIP-1167 clone tied to its factory event
  | "CONTRACT" // one ERC-721/1155 contract, when it is NOT a mall
  | "STOREFRONT_SLICE"; // a slice key re-derived from chain, not from a vendor

export type SoftEdgeKind = "FUNDED_BY" | "SCHEMA" | "SEQUENCE" | "TEMPLATE";

export const SOFT_WEIGHT: Record<SoftEdgeKind, number> = {
  FUNDED_BY: 0.7,
  TEMPLATE: 0.6,
  SCHEMA: 0.5,
  SEQUENCE: 0.3,
};

/** Confidence at which a candidate may be promoted to a member. */
export const PROMOTION_THRESHOLD = 1.0;

export interface HardEdge {
  kind: HardEdgeKind;
  a: string;
  b: string;
  /** The chain object that justifies this edge -- a stranger can re-fetch it. */
  witness: { blockHash: string; loc: number };
}

export interface SoftEdge {
  kind: SoftEdgeKind;
  a: string;
  b: string;
  weight: number;
}

export interface Candidate {
  artifactId: string;
  edges: SoftEdge[];
  confidence: number;
}

export type JournalEntry =
  | { op: "merge"; at: number; clusters: string[]; via: HardEdge }
  | { op: "split"; at: number; from: string; to: string[]; reason: string }
  | { op: "promote"; at: number; cluster: string; artifactId: string; reason: string };

export interface Cluster {
  clusterId: string;
  chain: ChainId;
  members: string[];
  candidates: Candidate[];
  announcementKind: "parent" | "reveal" | "factory" | "market" | "slice" | "contract";
  journal: JournalEntry[];
}

/**
 * Union-find over HARD edges only.
 *
 * `add` is deliberately the only way an artifact joins a set, and it takes an
 * edge, not a pair -- so there is no code path that unions two artifacts
 * without a chain witness to point at.
 */
export class HardUnionFind {
  private parent = new Map<string, string>();
  private witnesses = new Map<string, HardEdge[]>();

  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root); // path compression
    return root;
  }

  add(edge: HardEdge): void {
    const ra = this.find(edge.a);
    const rb = this.find(edge.b);
    if (ra !== rb) this.parent.set(rb, ra);
    const key = this.find(edge.a);
    const list = this.witnesses.get(key) ?? [];
    list.push(edge);
    this.witnesses.set(key, list);
  }

  /** Every artifact seen, grouped by root. */
  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const list = out.get(root) ?? [];
      list.push(node);
      out.set(root, list);
    }
    return out;
  }

  witnessesFor(root: string): HardEdge[] {
    return this.witnesses.get(this.find(root)) ?? [];
  }
}

/**
 * cluster_id = H(chain || sorted genesis witnesses).
 *
 * Deriving the id from witnesses rather than from a name is what makes
 * membership provable: a stranger re-fetches the witness objects and
 * recomputes the same id. It is also why a display name can never be part of
 * identity -- production shipped a "verified creator" badge sourced from a
 * marketplace's own account and had to retract it. Names are a retractable
 * overlay; witnesses are not.
 */
export function clusterId(
  chain: ChainId,
  witnesses: Array<{ blockHash: string; loc: number }>,
  sha256Hex: (s: string) => string
): string {
  const canonical = witnesses
    .map((w) => `${w.blockHash}:${w.loc}`)
    .sort()
    .join("|");
  return sha256Hex(`${chain}||${canonical}`);
}

/**
 * A candidate is promoted only when a SECOND independent signal appears:
 * either its soft weights reach the threshold, or a market announcement
 * names it alongside an existing member. One soft edge is never enough.
 */
export function shouldPromote(c: Candidate, marketNamed: boolean): boolean {
  if (marketNamed) return true;
  const kinds = new Set(c.edges.map((e) => e.kind));
  if (kinds.size < 2) return false; // two edges of the SAME kind is one signal
  return c.confidence >= PROMOTION_THRESHOLD;
}

export function candidateConfidence(edges: SoftEdge[]): number {
  // Independent-ish evidence combines, but never certainly: 1 - Π(1 - w).
  let residual = 1;
  for (const e of edges) residual *= 1 - Math.min(0.95, e.weight);
  return Number((1 - residual).toFixed(4));
}

/**
 * Attention may SCHEDULE which candidates get scored. It may never create an
 * edge. If coview could imply identity, a competitor would move our clusters
 * by browsing, so this function exists to be the single documented refusal.
 */
export function attentionMayCreateEdge(): never {
  throw new Error(
    "attention is a scheduler, not a source of identity: it may not create graph edges"
  );
}
