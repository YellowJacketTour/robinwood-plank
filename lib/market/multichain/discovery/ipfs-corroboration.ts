/**
 * Cross-source corroboration sampling -- Grok findings, docs/marketplank/
 * GROK-FINDINGS-intelligence-agency-maximal-vision-2026-08-26.md, item #2:
 * "same claim, independent channels," not just sequential fallback.
 *
 * Real intelligence-tradecraft distinction this app already draws
 * elsewhere (never fabricate, fail closed): a single gateway succeeding is
 * NOT proof its bytes are correct, only that A source answered. This
 * samples a small, real, cost-capped fraction of already-hydrated tokens
 * and re-fetches the SAME on-chain-pointed content through a genuinely
 * different gateway operator, flagging (never silently auto-"fixing") a
 * real mismatch for a human/future pass to investigate -- the DB write
 * itself is untouched; this is detection, not correction.
 *
 * Deliberately NEVER doubles real traffic: only ~1% of eligible tokens per
 * invocation, capped small, using the free IPFS_GATEWAYS pool this app
 * already maintains (lib/ipfs.ts) -- no new provider, no new cost center.
 */
import { postgresQuery } from "@/lib/postgres";
import { IPFS_GATEWAYS, ipfsGatewayCandidates } from "@/lib/ipfs";

const SAMPLE_FRACTION = 0.01;

export type CorroborationResult = {
  sampled: number;
  matched: number;
  drifted: Array<{ chainSlug: string; collectionSlug: string; tokenId: string; cid: string }>;
};

async function fetchGatewayBodyHash(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const { createHash } = await import("crypto");
    return createHash("sha256").update(Buffer.from(buf)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Samples up to `limit` real IPFS-content-addressed tokens for one chain,
 * re-fetches the SAME real CID through a second gateway, and compares the
 * raw response body's hash against the first gateway's -- a real,
 * independent confirmation, not a repeated call to the same operator.
 * Real limitation, stated honestly: because a CID is itself a hash of the
 * content, two gateways returning DIFFERENT bytes for the same CID can
 * only mean one is serving corrupted/wrong/malicious data for that CID --
 * this never detects real staleness (content-addressing makes staleness
 * structurally impossible for a matched CID). It also does NOT re-verify
 * the on-chain pointer itself (that's what needsBodyFetch/
 * advanceEvmTokenMetadata's own re-hydrate already does on every real
 * pass) -- this is purely a gateway-integrity check.
 */
export async function sampleIpfsCorroboration(chainSlug: string, limit = 25): Promise<CorroborationResult> {
  const candidates = await postgresQuery<{ collection_slug: string; token_id: string; pointer_fp: string; pointer_uri: string }>(
    `SELECT collection_slug, token_id, pointer_fp, pointer_uri FROM plank_collection_tokens
     WHERE chain_slug = $1 AND pointer_fp LIKE 'ipfs:%' AND pointer_uri IS NOT NULL AND random() < $2
     LIMIT $3`,
    [chainSlug, SAMPLE_FRACTION, limit]
  );

  const result: CorroborationResult = { sampled: 0, matched: 0, drifted: [] };
  if (IPFS_GATEWAYS.length < 2) return result; // corroboration needs a second real operator to compare against

  for (const row of candidates.rows) {
    // Real fix, caught during live verification: the stored CID alone can
    // point to a DIRECTORY (a real, common IPFS pattern -- tokenURI is
    // often "ipfs://<dir-cid>/<tokenId>") -- re-fetching just the bare CID
    // fetches the whole directory listing (or times out on a large one),
    // not the specific per-token file. Use the full stored pointer_uri
    // through ipfsGatewayCandidates (the same real per-gateway URL builder
    // the actual hydrate path uses) so both fetches hit the exact real
    // per-token path on two different gateway hosts.
    const candidateUrls = ipfsGatewayCandidates(row.pointer_uri);
    if (candidateUrls.length < 2) continue;
    const [hashA, hashB] = await Promise.all([
      fetchGatewayBodyHash(candidateUrls[0]),
      fetchGatewayBodyHash(candidateUrls[1]),
    ]);
    if (!hashA || !hashB) continue; // a real fetch failure on either side is not evidence of drift, just skip
    result.sampled += 1;
    if (hashA === hashB) {
      result.matched += 1;
    } else {
      result.drifted.push({ chainSlug, collectionSlug: row.collection_slug, tokenId: row.token_id, cid: row.pointer_fp });
    }
  }
  return result;
}
