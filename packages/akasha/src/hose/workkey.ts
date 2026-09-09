/**
 * Content-addressed work keys, and attention as a scheduler.
 *
 * TWO IDEAS, ONE FILE, BECAUSE THEY ANSWER THE SAME QUESTION
 * ---------------------------------------------------------
 * Sharding makes one chain's past fast. These make TEN chains affordable, and
 * aim the whole machine at what people are actually looking at. Both are about
 * which work to do, never about what is true.
 *
 * 1. CONTENT-ADDRESSED WORK KEYS
 *
 * The same ERC-721 deployed on eight chains is fetched and parsed eight times
 * today, because work is keyed by WHERE a thing lives. An IPFS directory CID
 * shared by a whole collection is re-fetched per token for the same reason.
 *
 * Key work by WHAT it is instead. A CID parsed once is known everywhere,
 * forever; a bytecode hash seen on Base is not re-analysed on Arbitrum. Across
 * ten chains, cross-chain redundancy stops being a cost multiplier and becomes
 * a discount.
 *
 * This is already the archive's own doctrine -- objects that authenticate
 * themselves are canonical from ONE report, mutable HTTPS never is. It was
 * simply never applied to the work queue.
 *
 * The doctrine's limit is load-bearing and is enforced here: a location-keyed
 * (mutable) source can never be deduped across chains, because two hosts
 * serving the same path may serve different bytes. `workKey` refuses to
 * produce a shared key for one.
 *
 * 2. ATTENTION AS A SCHEDULER
 *
 * The owner's beam: "all visitors act as one persistent fingerprint... with
 * respect to flushing out the entire catalog". Made literal, that is a
 * PRIORITY, not a job. Twenty browsers on one collection raise the priority of
 * the shard covering it; they do not multiply fetches. They raise confidence.
 *
 * `attentionMayCreateEdge()` still throws. Attention schedules; it never
 * creates identity, and it never invents a subject the chain did not name.
 */
import type { ChainId } from "../shared/types.ts";
import type { Shard } from "./shard.ts";

/**
 * A source of bytes, classified by whether it authenticates itself.
 *
 * `content` -- the identifier IS the hash of the bytes (IPFS/Arweave CIDs,
 * contract bytecode, an inscription envelope). Two reports of the same key
 * cannot disagree without one of them failing verification, so one fetch is
 * canonical everywhere.
 *
 * `location` -- an HTTPS URL, a vendor endpoint. The identifier says where to
 * look, not what will be there. Two hosts may serve different bytes for the
 * same path, and the same host may serve different bytes tomorrow.
 */
export type SourceKind = "content" | "location";

export interface WorkSubject {
  kind: SourceKind;
  /** CID, bytecode hash, inscription id -- or the URL for a location. */
  id: string;
  chain: ChainId;
}

/**
 * The key work is deduped under, or null when it may not be shared.
 *
 * A content-addressed subject keys on its content alone, so the same CID on
 * ten chains is one unit of work. A location-addressed subject keys on
 * (chain, url) at best and is therefore never shared -- returning null says
 * "this cannot be deduped", which is different from and safer than inventing a
 * key that silently merges two different bodies.
 */
export function workKey(s: WorkSubject): string | null {
  const id = s.id.trim();
  if (id.length === 0) return null;
  if (s.kind === "location") return null;
  return `content:${id.toLowerCase()}`;
}

/**
 * Has this content already been done, anywhere, on any chain?
 *
 * `seen` is the set of completed content keys. A location-addressed subject
 * always answers false: it has no shared key, so there is nothing to have
 * seen, and treating "I fetched this URL on another chain" as "I know this
 * body" is exactly the two-matching-hashes fallacy the archive refuses.
 */
export function alreadyDone(s: WorkSubject, seen: ReadonlySet<string>): boolean {
  const key = workKey(s);
  return key !== null && seen.has(key);
}

/**
 * Gaze pressure per collection or contract, 0..1.
 *
 * Supplied by the demand layer. Absent means nobody is looking, which is the
 * common case and must cost nothing.
 */
export type Gaze = (subject: string) => number;

export interface ShardPriority {
  shard: Shard;
  /** Higher is claimed sooner. */
  score: number;
}

/**
 * Order shards by attention, with a floor so nothing starves.
 *
 * THE FLOOR IS THE POINT. A pure attention sort would leave unwatched history
 * permanently unclaimed -- the archive would become a cache of whatever is
 * popular, which is the opposite of an archive. Every shard keeps a baseline
 * score from its recency (newer first, since that is what visitors ask about),
 * and attention ADDS to it rather than replacing it.
 *
 * So: the beam aims the machine, it does not fence it in. Watched ground fills
 * first; everything else still fills.
 */
export function prioritiseShards(
  shards: Shard[],
  gaze?: Gaze,
  gazeWeight = 4,
): ShardPriority[] {
  if (shards.length === 0) return [];
  const highest = Math.max(...shards.map((s) => s.to));
  const lowest = Math.min(...shards.map((s) => s.from));
  const span = Math.max(1, highest - lowest);
  return shards
    .map((shard) => {
      // Recency floor in [0, 1]: the newest shard scores 1, the oldest ~0.
      const recency = (shard.to - lowest) / span;
      const pressure = gaze ? Math.max(0, Math.min(1, gaze(`${shard.chain}:${shard.from}`))) : 0;
      return { shard, score: recency + pressure * gazeWeight };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Attention may raise a shard's priority. It may never mint a shard.
 *
 * The mirror of `attentionMayCreateEdge`. A gaze at a height the planner did
 * not produce is a request to archive something no chain named, and the only
 * correct response is to refuse -- otherwise a visitor could steer the archive
 * into fabricating coverage of a range that does not exist.
 */
export function attentionMayCreateShard(): never {
  throw new Error(
    "attention may reprioritise a shard, never create one: a gaze is not a chain fact",
  );
}
