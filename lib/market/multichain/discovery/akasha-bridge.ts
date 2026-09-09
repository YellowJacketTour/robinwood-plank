/**
 * The bridge: akasha tape -> the catalog the UI reads.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The archive and the catalog were two sealed rooms. The hose wrote six
 * `akasha_*` tables; the UI read `plank_multichain_collections`, whose only
 * writer is store.ts; and NO file in the repo imported both. The hose's own
 * header said so out loud -- "It never writes plank_*."
 *
 * That made the Bitcoin cutover a trap. Setting AKASHA_HOSE_OWNS_BITCOIN=1
 * retires four vendor catalog pagers and hands existence discovery to a
 * worker that had no path to create a collection, so Bitcoin would have had
 * NO writer at all. matrix.ts anticipated exactly this ("an accidental
 * cutover leaves Bitcoin with NO writer") but guarded it only with a
 * default-off flag rather than a check that the bridge exists. It was armed
 * on production on 2026-09-09 and disarmed once measured.
 *
 * IDENTITY: WHAT COUNTS AS A COLLECTION
 * -------------------------------------
 * An inscription is a TOKEN, not a collection. The only collection signal
 * that is a chain fact rather than a vendor opinion is the Ordinals
 * parent-child declaration -- envelope tag 3, decoded from tapscript, which
 * the archive already treats as its strongest hard edge (cluster/derive.ts).
 * A child names its parent on-chain; that parent inscription IS the
 * collection, and its id is the catalog key.
 *
 * So this bridge mints a collection ONLY for a parent that children actually
 * declare. An inscription with no parent is a token we hold and cannot yet
 * attribute -- it stays in the tape as a typed hole rather than becoming a
 * one-item "collection" that inflates the count with noise. That is the
 * difference between an archive and a number that goes up.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * No floors, no listings, no traits, no names beyond the parent id. Those are
 * different claim kinds on different evidence, and the order is fixed:
 * existence, then present-completeness, then bandwidth, then speech. This
 * lane answers existence only.
 */
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { upsertTrackedCollection } from "@/lib/market/multichain/store";

/** Ordinals inscription ids look like <64-hex txid>i<index>. */
const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/i;

export interface AkashaBridgeResult {
  /** Parent inscriptions that children declared, seen this pass. */
  parentsSeen: number;
  /** Catalog rows created or re-confirmed. */
  upserted: number;
  /** Children whose declared parent was not a well-formed inscription id. */
  malformedParents: number;
  /** True when the tape holds no parent declarations at all yet. */
  tapeEmpty: boolean;
  reason?: string;
}

/**
 * One pass. Reads parent declarations out of the tape and mints a catalog row
 * per distinct parent.
 *
 * `limit` bounds the work per tick, and the ORDER BY makes the pass
 * deterministic so a repeated run walks the same ground rather than sampling
 * randomly -- a lane whose output depends on row order cannot be reasoned
 * about when it disagrees with itself.
 */
export async function bridgeAkashaBitcoinCollections(
  limit = 500
): Promise<AkashaBridgeResult> {
  const empty: AkashaBridgeResult = {
    parentsSeen: 0,
    upserted: 0,
    malformedParents: 0,
    tapeEmpty: true,
  };
  if (!hasPostgresConfig()) return { ...empty, reason: "NOT_CONFIGURED" };

  // The parent rides in the event's raw JSON, written by the envelope parser
  // (adapters/bitcoin.ts). Count children per parent in the same query: a
  // parent's child count is real evidence about the collection's size, and
  // computing it here avoids a second pass over the same rows.
  let rows;
  try {
    rows = await postgresQuery<{ parent: string; children: string }>(
      `SELECT e.raw->>'parent' AS parent, COUNT(DISTINCT e.token_or_inscription)::text AS children
         FROM akasha_event e
        WHERE e.chain = 'bitcoin'
          AND e.kind = 'envelope'
          AND e.raw->>'parent' IS NOT NULL
        GROUP BY e.raw->>'parent'
        ORDER BY COUNT(DISTINCT e.token_or_inscription) DESC, e.raw->>'parent' ASC
        LIMIT $1`,
      [limit]
    );
  } catch (err) {
    // The akasha_* tables are created by migration 104. A deploy that has not
    // applied it yet must report that plainly instead of looking like an
    // empty tape -- "no rows" and "no table" are different facts.
    const message = err instanceof Error ? err.message : String(err);
    if (/akasha_event/.test(message) && /does not exist/i.test(message)) {
      return { ...empty, reason: "TAPE_MISSING" };
    }
    throw err;
  }

  if (rows.rows.length === 0) return empty;

  let upserted = 0;
  let malformed = 0;
  for (const row of rows.rows) {
    const parent = row.parent?.trim();
    if (!parent || !INSCRIPTION_ID.test(parent)) {
      // A parent that is not a well-formed inscription id is a decode
      // problem, not a collection. Counted so it is visible rather than
      // silently skipped -- a bridge that quietly drops rows is how a
      // catalog goes stale while every log line looks healthy.
      malformed += 1;
      continue;
    }
    await upsertTrackedCollection({
      chainSlug: "bitcoin-mainnet",
      chainId: null,
      contractAddress: parent.toLowerCase(),
      adapter: "akasha-hose",
      nameHint: null,
    });
    upserted += 1;
  }

  return {
    parentsSeen: rows.rows.length,
    upserted,
    malformedParents: malformed,
    tapeEmpty: false,
  };
}
