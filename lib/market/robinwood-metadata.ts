import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { fetchNftMetadata } from "@/lib/ipfs";
import type { NftAttribute } from "@/lib/ipfs";
import { ethCallDisplay } from "@/lib/market/fetch-rpc";
import { ROBINWOOD_METADATA_CID, robinwoodTokenUri } from "@/lib/market/robinwood-uri";
import { pickCanonicalTraits } from "@/lib/rarity";
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";

/**
 * Canonical, IPFS-sourced RobinWood metadata store — Postgres table
 * `robinwood_token_metadata` (migration 004).
 *
 * RobinWood is a fixed, fully-minted 1,542-token collection. Its metadata
 * (name, description, image path, traits) is immutable after reveal, but
 * every metadata/rarity read used to be derived from Blockscout on each cold
 * rebuild — a MUTABLE, rate-limited third party. Blockscout served
 * pre-reveal stubs ([{trait_type:"Status", value:"Unrevealed"}]) for planks
 * #1-180 long after reveal, which both showed wrong data for those 180
 * tokens AND shrank the sample used to rank every other token from 1,542 to
 * 1,362.
 *
 * This module is the single write path (via `buildRobinwoodMetadataStore`,
 * driven by `scripts/refresh-market-data.ts --metadata`) and single read
 * path (`getRobinwoodMetadataMap`) for that data. Source is IPFS ONLY —
 * never Blockscout. Blockscout remains legitimate for transfers/activity/
 * owners (lib/market/blockscout.ts), which are genuinely mutable; this
 * module does not touch that.
 */

export const ROBINWOOD_SUPPLY = 1542;

export type RobinwoodMetadataEntry = {
  tokenId: number;
  name: string;
  description: string;
  imageUri: string;
  attributes: NftAttribute[];
};

export type RobinwoodMetadataBuildReport = {
  totalSupply: number;
  alreadyStored: number;
  newlyStored: number;
  failed: number[];
  /** True only when every token 1..totalSupply is stored with real traits. */
  complete: boolean;
};

function hasStore(): boolean {
  return hasPostgresConfig();
}

function requireStore(): void {
  if (!hasStore()) {
    throw new Error(
      "PostgreSQL is required to build or read the canonical RobinWood metadata store " +
        "(PGHOST/PGDATABASE/PGUSER/PGPASSWORD)."
    );
  }
}

/** Read the on-chain tokenURI(tokenId) directly — bypasses the hardcoded CID
 * entirely, so it can be used to verify that CID instead of trusting it. */
async function readOnChainTokenUri(tokenId: number): Promise<string> {
  const idHex = BigInt(tokenId).toString(16).padStart(64, "0");
  // tokenURI(uint256) selector 0xc87b56dd.
  const result = await ethCallDisplay(NFT_CONTRACT_ADDRESS, `0xc87b56dd${idHex}`);
  if (!result || result.length < 130) {
    throw new Error(`tokenURI(${tokenId}) returned no data from chain`);
  }
  const hex = result.slice(2);
  const len = parseInt(hex.slice(64, 128), 16);
  if (!Number.isFinite(len) || len <= 0) {
    throw new Error(`tokenURI(${tokenId}) decoded to an empty string`);
  }
  const uri = Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
  if (!uri) throw new Error(`tokenURI(${tokenId}) decoded to an empty string`);
  return uri;
}

function extractCid(tokenUri: string): string | null {
  const match = tokenUri.match(/^ipfs:\/\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Assert ROBINWOOD_METADATA_CID (lib/market/token-image.ts) actually matches
 * a REAL on-chain tokenURI() read, for the given sample of token ids.
 * Defaults to the first and last token id, which is enough to catch both "CID
 * was always wrong" and "collection migrated to a new directory partway
 * through." A hardcoded CID that silently goes stale is exactly the class of
 * bug this whole module exists to fix, so this fails loudly rather than
 * falling back silently.
 */
export async function verifyMetadataCid(
  sampleTokenIds: number[] = [1, ROBINWOOD_SUPPLY]
): Promise<{ tokenId: number; onChainCid: string }[]> {
  const results: { tokenId: number; onChainCid: string }[] = [];
  for (const tokenId of sampleTokenIds) {
    const uri = await readOnChainTokenUri(tokenId);
    const cid = extractCid(uri);
    if (!cid) {
      throw new Error(
        `tokenURI(${tokenId}) = "${uri}" is not an ipfs://<cid>/<id> URI — cannot verify ROBINWOOD_METADATA_CID.`
      );
    }
    if (cid !== ROBINWOOD_METADATA_CID) {
      throw new Error(
        `ROBINWOOD_METADATA_CID has gone stale: on-chain tokenURI(${tokenId}) resolves to CID "${cid}", ` +
          `but lib/market/token-image.ts hardcodes "${ROBINWOOD_METADATA_CID}". ` +
          `Update ROBINWOOD_METADATA_CID before rebuilding metadata — do not proceed on a mismatch.`
      );
    }
    results.push({ tokenId, onChainCid: cid });
  }
  return results;
}

/** A pre-reveal stub (or a bad gateway response) is not a usable metadata
 * record even if it parses — see the module comment. Only a payload with at
 * least one canonical trait (Base/Background/Holographic) counts. */
function hasCanonicalTraits(attributes: NftAttribute[]): boolean {
  return pickCanonicalTraits(attributes).length > 0;
}

async function fetchTokenMetadata(tokenId: number): Promise<RobinwoodMetadataEntry> {
  const tokenUri = robinwoodTokenUri(tokenId);
  // force: true — this is an offline rebuild, not a per-request read; never
  // want a stale in-process metadata cache entry from an earlier run.
  const meta = await fetchNftMetadata(tokenUri, { force: true });
  const attributes = Array.isArray(meta.attributes) ? meta.attributes : [];
  if (!hasCanonicalTraits(attributes)) {
    throw new Error(
      `token ${tokenId}: metadata has no canonical trait (Base/Background/Holographic) — ` +
        `looks like a pre-reveal stub or a bad gateway response; refusing to store it as complete`
    );
  }
  const imageUri = typeof meta.image === "string" ? meta.image.trim() : "";
  if (!imageUri) throw new Error(`token ${tokenId}: metadata has no image`);
  const name =
    typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : `Plank #${tokenId}`;
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  return { tokenId, name, description, imageUri, attributes };
}

async function upsertTokenMetadata(entry: RobinwoodMetadataEntry): Promise<void> {
  await postgresQuery(
    `INSERT INTO robinwood_token_metadata
       (token_id, name, description, image_uri, attributes, metadata_cid, token_uri, fetched_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW())
     ON CONFLICT (token_id) DO UPDATE
       SET name = EXCLUDED.name,
           description = EXCLUDED.description,
           image_uri = EXCLUDED.image_uri,
           attributes = EXCLUDED.attributes,
           metadata_cid = EXCLUDED.metadata_cid,
           token_uri = EXCLUDED.token_uri,
           fetched_at = NOW()`,
    [
      entry.tokenId,
      entry.name,
      entry.description,
      entry.imageUri,
      JSON.stringify(entry.attributes),
      ROBINWOOD_METADATA_CID,
      robinwoodTokenUri(entry.tokenId),
    ]
  );
}

async function readStoredTokenIds(): Promise<Set<number>> {
  const result = await postgresQuery<{ token_id: number }>(
    `SELECT token_id FROM robinwood_token_metadata`
  );
  return new Set(result.rows.map((row) => Number(row.token_id)));
}

type MetadataRow = {
  token_id: number;
  name: string;
  description: string;
  image_uri: string;
  attributes: NftAttribute[] | null;
};

async function readAllStored(): Promise<Map<number, RobinwoodMetadataEntry>> {
  const result = await postgresQuery<MetadataRow>(
    `SELECT token_id, name, description, image_uri, attributes
       FROM robinwood_token_metadata`
  );
  const map = new Map<number, RobinwoodMetadataEntry>();
  for (const row of result.rows) {
    map.set(Number(row.token_id), {
      tokenId: Number(row.token_id),
      name: row.name,
      description: row.description,
      imageUri: row.image_uri,
      attributes: Array.isArray(row.attributes) ? row.attributes : [],
    });
  }
  return map;
}

/**
 * Walk tokens 1..totalSupply from IPFS and upsert each into
 * `robinwood_token_metadata`. Idempotent and resumable: tokens already
 * stored are skipped (unless `force`), so re-running after a partial failure
 * only fetches what is still missing. There is deliberately NO cap on how
 * many tokens one run processes — a prior version of this backfill (in
 * lib/market/rarity-snapshot.ts) capped itself at 400/run, which let a
 * single pass report success on a 1,000/1,542-token snapshot. `complete` in
 * the returned report is the only thing callers should trust; a script must
 * keep re-running this until it says `complete: true`.
 */
export async function buildRobinwoodMetadataStore(opts?: {
  totalSupply?: number;
  concurrency?: number;
  /** Verify ROBINWOOD_METADATA_CID against a live tokenURI() read before
   * writing anything. Defaults to true; only disable for tests. */
  verify?: boolean;
  /** Re-fetch and overwrite tokens that are already stored. */
  force?: boolean;
}): Promise<RobinwoodMetadataBuildReport> {
  requireStore();
  const totalSupply = opts?.totalSupply ?? ROBINWOOD_SUPPLY;
  const concurrency = Math.max(1, opts?.concurrency ?? 10);

  if (opts?.verify !== false) {
    await verifyMetadataCid();
  }

  const already = opts?.force ? new Set<number>() : await readStoredTokenIds();
  const need: number[] = [];
  for (let id = 1; id <= totalSupply; id += 1) {
    if (!already.has(id)) need.push(id);
  }

  const failed: number[] = [];
  let newlyStored = 0;

  for (let i = 0; i < need.length; i += concurrency) {
    const slice = need.slice(i, i + concurrency);
    const outcomes = await Promise.allSettled(slice.map((tokenId) => fetchTokenMetadata(tokenId)));
    for (let k = 0; k < outcomes.length; k += 1) {
      const outcome = outcomes[k];
      const tokenId = slice[k];
      if (outcome.status === "fulfilled") {
        await upsertTokenMetadata(outcome.value);
        newlyStored += 1;
      } else {
        failed.push(tokenId);
      }
    }
  }

  const finalStoredCount = already.size + newlyStored;
  return {
    totalSupply,
    alreadyStored: already.size,
    newlyStored,
    failed,
    complete: finalStoredCount >= totalSupply && failed.length === 0,
  };
}

let cachedMap: { at: number; map: Map<number, RobinwoodMetadataEntry> } | null = null;
let inflight: Promise<Map<number, RobinwoodMetadataEntry>> | null = null;

/**
 * Runtime read path — one Postgres scan per isolate, then in-memory forever
 * (the source data is immutable post-reveal; see module comment). Empty map
 * when no store is configured or nothing has been built yet — callers must
 * treat an empty/incomplete map as "not ready" rather than crash.
 */
export async function getRobinwoodMetadataMap(): Promise<Map<number, RobinwoodMetadataEntry>> {
  if (cachedMap) return cachedMap.map;
  if (inflight) return inflight;
  if (!hasStore()) return new Map();

  inflight = readAllStored()
    .then((map) => {
      cachedMap = { at: Date.now(), map };
      return map;
    })
    .catch(() => new Map<number, RobinwoodMetadataEntry>())
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test-only: clear the in-memory cache between cases. */
export function __resetRobinwoodMetadataCacheForTests(): void {
  cachedMap = null;
  inflight = null;
}

export function isRobinwoodMetadataComplete(
  map: Map<number, RobinwoodMetadataEntry>,
  totalSupply: number = ROBINWOOD_SUPPLY
): boolean {
  if (map.size < totalSupply) return false;
  for (let id = 1; id <= totalSupply; id += 1) {
    const entry = map.get(id);
    if (!entry || !hasCanonicalTraits(entry.attributes)) return false;
  }
  return true;
}
