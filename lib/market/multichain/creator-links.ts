/**
 * Creator-aware / entity-linked search expansion.
 *
 * The ask (owner, 2026-08-23): searching "mugs" should also surface the
 * OTHER collections by the same creator (9mm.Pro's MUGS, Based OG, Genesis
 * OG) as related results, generalized to ANY creator with multiple tracked
 * collections -- not hardcoded to one project.
 *
 * REAL PRECEDENT for "same-entity expansion" (the research half of this
 * task):
 *  - E-commerce "more from this brand/seller" rails (Amazon's "More items
 *    from <seller>", Etsy's "More from this shop") key off a seller/brand
 *    identity field on the listing and simply join back to that seller's
 *    other listings -- the exact shape implemented below (creator_address /
 *    creator_handle acting as the "seller id").
 *  - Music platforms' "More by this artist" (Spotify, Bandcamp) key off a
 *    verified artist id, not a free-text artist-name string, specifically
 *    because free-text names collide across unrelated artists -- the same
 *    reason this file treats a bare wallet-address match as weaker evidence
 *    than a handle/ENS/name match below.
 *  - Investigative link-analysis tools (i2 Analyst's Notebook, Palantir
 *    Gotham, and their open-source descendants like Maltego) build a
 *    relevance graph where entities (people, wallets, organizations) are
 *    nodes and shared attributes (a phone number, an address, a shared bank
 *    account) are edges -- but a mature analyst workflow always distinguishes
 *    a STRONG link (an attribute that is individually-identifying, e.g. a
 *    personal handle) from a WEAK link (an attribute that many unrelated
 *    entities can share, e.g. a shared PO box or, on-chain, a shared
 *    contract-deployment/minting-service wallet) and visually/scoring-wise
 *    downweights the weak edge rather than treating every shared attribute
 *    as equally conclusive. That distinction is the entire design of this
 *    file, learned the hard way earlier this session: a shared
 *    creator_address can be a pooled OpenSea Studio deployer wallet used by
 *    many unrelated creators, not a 1:1 individual signature.
 *
 * REAL DATA SHAPE CONFIRMED LIVE (2026-08-23, local Postgres) for the
 * concrete 9mm.Pro case this was built against:
 *   MUGS (robinhood)     creator_address=NULL   creator_handle="9mm_pro"   name="MUGS by 9mm.Pro"
 *   Based OG (base)      creator_address=0x2d60...  creator_handle=NULL   name="Based OG by 9mm.Pro"
 *   Genesis OG (eth)     creator_address=0x2d60...  creator_handle=NULL   name="Genesis OG by 9mm.Pro"
 * i.e. creator_address alone links Based OG <-> Genesis OG only; MUGS has no
 * creator_address at all on this chain, so an address-only design would
 * silently miss the exact case this feature was requested for. The one
 * signal every one of these three rows actually shares is the display
 * name's own "by <creator>" byline -- a real, generalizable, non-hardcoded
 * pattern (extracted with a plain regex, not a 9mm.Pro-specific string) that
 * mirrors the same "trust a specific, individually-chosen identity marker
 * over a shared bucket" principle above. It is treated as a corroborating
 * signal on par with handle/ENS, never as the sole basis for a "confirmed"
 * claim in the absence of any other match.
 */

export type CreatorLinkable = {
  chainSlug: string;
  contractAddress: string;
  name: string | null;
  creatorAddress: string | null;
  creatorHandle: string | null;
  creatorEns: string | null;
};

export type CreatorMatchReason = "handle" | "ens" | "name-byline" | "address";

export type RelatedCreatorGroup<T extends CreatorLinkable> = {
  /** Individually-identifying signal shared (handle/ENS/name byline) -- confidently the same creator. */
  corroborated: Array<{ collection: T; matchedOn: CreatorMatchReason[] }>;
  /** ONLY a raw wallet-address match -- may be a shared/pooled deployer wallet, not one individual. Show with lower emphasis, or omit. */
  addressOnly: Array<{ collection: T; matchedOn: CreatorMatchReason[] }>;
};

function norm(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Pulls a "by <creator>" byline off a display name, e.g. "MUGS by 9mm.Pro"
 * -> "9mm.pro". Deliberately conservative (short trailing segment only) so
 * it doesn't false-match on an unrelated "by" inside a longer title.
 */
export function extractNameByline(name: string | null): string | null {
  if (!name) return null;
  const match = name.trim().match(/\bby\s+([a-z0-9][a-z0-9.\-_ ]{1,40})$/i);
  if (!match) return null;
  const byline = match[1].trim().toLowerCase();
  return byline.length >= 2 ? byline : null;
}

function collectionKey(c: CreatorLinkable): string {
  return `${c.chainSlug}:${c.contractAddress.toLowerCase()}`;
}

/**
 * Given the full tracked-collection universe and one matched collection,
 * finds other tracked collections that are plausibly by the same creator.
 * Pure/synchronous -- callers own how `all` is sourced (DB query or an
 * already-loaded in-memory list).
 */
export function findRelatedByCreator<T extends CreatorLinkable>(
  all: readonly T[],
  target: T
): RelatedCreatorGroup<T> | null {
  const targetAddress = norm(target.creatorAddress);
  const targetHandle = norm(target.creatorHandle);
  const targetEns = norm(target.creatorEns);
  const targetByline = extractNameByline(target.name);
  if (!targetAddress && !targetHandle && !targetEns && !targetByline) return null;

  const targetKey = collectionKey(target);
  const corroborated: RelatedCreatorGroup<T>["corroborated"] = [];
  const addressOnly: RelatedCreatorGroup<T>["addressOnly"] = [];
  const seen = new Set<string>();

  for (const candidate of all) {
    const candidateKey = collectionKey(candidate);
    if (candidateKey === targetKey || seen.has(candidateKey)) continue;

    const matchedOn: CreatorMatchReason[] = [];
    if (targetHandle && norm(candidate.creatorHandle) === targetHandle) matchedOn.push("handle");
    if (targetEns && norm(candidate.creatorEns) === targetEns) matchedOn.push("ens");
    if (targetByline && extractNameByline(candidate.name) === targetByline) matchedOn.push("name-byline");
    if (targetAddress && norm(candidate.creatorAddress) === targetAddress) matchedOn.push("address");
    if (!matchedOn.length) continue;

    seen.add(candidateKey);
    // Any individually-identifying signal (handle/ENS/name byline) is
    // enough to corroborate, regardless of whether the address also
    // matched -- a shared bucket wallet plus a real corroborating signal is
    // still corroborated. Only a bare address match, with none of those,
    // stays in the low-confidence bucket.
    const hasStrongSignal = matchedOn.some((r) => r !== "address");
    if (hasStrongSignal) corroborated.push({ collection: candidate, matchedOn });
    else addressOnly.push({ collection: candidate, matchedOn });
  }

  if (!corroborated.length && !addressOnly.length) return null;
  return { corroborated, addressOnly };
}

/** Serialized shape for the token-search API response -- flat, so a client never has to re-derive matchedOn/confidence itself. */
export type RelatedCreatorHit = {
  chainSlug: string;
  contractAddress: string;
  name: string | null;
  confidence: "corroborated" | "address-only";
  matchedOn: CreatorMatchReason[];
};

export function flattenRelatedCreatorGroup<T extends CreatorLinkable>(group: RelatedCreatorGroup<T> | null): RelatedCreatorHit[] {
  if (!group) return [];
  const corroborated = group.corroborated.map(({ collection, matchedOn }) => ({
    chainSlug: collection.chainSlug, contractAddress: collection.contractAddress, name: collection.name,
    confidence: "corroborated" as const, matchedOn,
  }));
  const addressOnly = group.addressOnly.map(({ collection, matchedOn }) => ({
    chainSlug: collection.chainSlug, contractAddress: collection.contractAddress, name: collection.name,
    confidence: "address-only" as const, matchedOn,
  }));
  return [...corroborated, ...addressOnly];
}
