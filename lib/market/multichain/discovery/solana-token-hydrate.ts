/**
 * Real-time, single-token hydration for Solana -- the Solana counterpart
 * to hydrateSpecificToken in rarity-index-runner.ts (EVM). Fixes a real
 * gap flagged live 2026-08-24 ("hydration on demand isnt working on sol
 * collections"): the EVM click-hydration path built earlier this session
 * was explicitly gated to `!isNonEvm` on the client, so a Solana token a
 * visitor clicked into with missing metadata got zero live hydration --
 * not a bug in the EVM code, just a real, honest gap that was never
 * extended to this chain.
 *
 * Real DAS getAsset response shape confirmed live before writing this
 * (2026-08-24, via a real QuickNode DAS call against a real Mad Lads
 * mint): `result.content.metadata.attributes` is a real, populated
 * `{trait_type, value}[]` array -- the same shape helius-solana.ts's
 * existing fetchSnapshot already reads name/image/creators from, just
 * never extracted traits (that function is collection-adapter-shaped,
 * this one is token-detail-shaped and needs them).
 *
 * Same DAS-first, free-on-chain-fallback discipline as helius-solana.ts's
 * own onchainFallbackSnapshot -- reuses the exact same free readers
 * (solana-metaplex-reads.ts, solana-editions.ts) this session already
 * built and proved. The on-chain fallback is honestly name/creator only
 * (no image -- resolving the off-chain JSON the on-chain URI points to is
 * a real, separate scope, same limitation already documented for
 * helius-solana.ts's own fallback).
 */
import { reserveDasSlot, settleDasSlot } from "@/lib/market/multichain/discovery/solana-das-pool";
import { readTokenMetadata } from "@/lib/market/multichain/discovery/solana-metaplex-reads";
import { readMetaplexCoreAsset } from "@/lib/market/multichain/discovery/solana-editions";
import { upsertCollectionTokenProjection, readProjectedTokensByIds } from "@/lib/market/multichain/collection-token-store";
import { recordArchivalHydration, maybeExpandSiblingTokens } from "@/lib/market/multichain/archival-ledger";

type HeliusAssetDetail = {
  content?: {
    json_uri?: string | null;
    metadata?: { name?: string | null; attributes?: Array<{ trait_type?: string; value?: unknown }> };
    links?: { image?: string | null };
  };
};

export type SolanaTrait = { traitType: string; value: string };

/** Pure: Metaplex-standard `attributes` -> this app's trait rows. Exported
 * for tests and shared with helius-rarity-index-runner.ts. Non-scalar
 * values and blank trait types are dropped, never stringified to
 * "[object Object]". */
export function traitsFromAttributes(attributes: unknown): SolanaTrait[] {
  if (!Array.isArray(attributes)) return [];
  const out: SolanaTrait[] = [];
  for (const a of attributes as Array<{ trait_type?: unknown; value?: unknown }>) {
    if (!a || typeof a !== "object") continue;
    const traitType = typeof a.trait_type === "string" ? a.trait_type.trim() : "";
    const value = a.value;
    if (!traitType) continue;
    if (typeof value === "string") { const v = value.trim(); if (v) out.push({ traitType, value: v }); }
    else if (typeof value === "number" || typeof value === "boolean") out.push({ traitType, value: String(value) });
  }
  return out;
}

const OFFCHAIN_URI = /^(https?:\/\/|ipfs:\/\/|ar:\/\/)/i;

/**
 * AUDIT lens 4 #9 (Batch F9): DAS `content.metadata.attributes` is
 * frequently EMPTY even when the off-chain JSON the asset points at
 * (`content.json_uri`) carries a full Metaplex-standard `attributes`
 * array -- the indexer only mirrors what it parsed at index time. This
 * fetches that JSON under lib/ipfs.ts's own gateway discipline (rotation,
 * per-host token bucket, bounded timeout; https / ar:// / ipfs:// pointers
 * all handled there) and returns the traits/name/image it really carries.
 * Never throws; a fetch failure is an honest null.
 */
export async function resolveSolanaOffchainMetadata(jsonUri: string | null | undefined): Promise<{
  name: string | null; imageUrl: string | null; traits: SolanaTrait[];
} | null> {
  const uri = typeof jsonUri === "string" ? jsonUri.trim() : "";
  if (!uri || !OFFCHAIN_URI.test(uri)) return null;
  try {
    const { fetchNftMetadata } = await import("@/lib/ipfs");
    const body = await fetchNftMetadata(uri);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    const imageUrl = typeof body.image === "string" && body.image.trim() ? body.image.trim() : null;
    return { name, imageUrl, traits: traitsFromAttributes(body.attributes) };
  } catch {
    return null;
  }
}

/** Pure decision, exported for tests: DAS gave us no traits but a real
 * pointer exists -> the fallback is worth one fetch. */
export function shouldFetchJsonUriFallback(dasTraits: SolanaTrait[], jsonUri: string | null | undefined): boolean {
  return dasTraits.length === 0 && typeof jsonUri === "string" && OFFCHAIN_URI.test(jsonUri.trim());
}

export type SolanaTokenHydrateResult = {
  resolved: boolean;
  token?: {
    tokenId: string; name: string | null; imageUrl: string | null;
    animationUrl: string | null; mediaType: string | null;
    traits: Array<{ traitType: string; value: string }>;
  };
};

/**
 * Tries up to 3 real pool attempts before giving up on DAS entirely --
 * this session's earlier jail fix correctly cools a failing provider off
 * (5 min), but that only helps FUTURE calls; a single click-hydrate
 * request that happens to draw the one currently-bad provider (e.g.
 * Shyft, real account-tier gate, not yet jailed on a cold pool) would
 * otherwise fall straight to the slower/also-shared-rate-limit-prone
 * on-chain fallback instead of just trying a different real provider
 * within this same request. Each failed attempt still records/jails via
 * settleDasSlot inside fetchViaDasOnce, so the NEXT attempt's
 * reserveDasSlot() call genuinely routes around it.
 */
async function fetchViaDasOnce(mintAddress: string): Promise<HeliusAssetDetail | null> {
  const slot = await reserveDasSlot(1, { priority: "live" });
  if (!slot) return null;
  let ok = false;
  try {
    const res = await fetch(slot.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "plank", method: "getAsset", params: { id: mintAddress } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: HeliusAssetDetail; error?: unknown };
    if (body.error || !body.result) return null;
    ok = true;
    return body.result;
  } catch {
    return null;
  } finally {
    await settleDasSlot(slot, 1, ok);
  }
}

async function fetchViaDas(mintAddress: string): Promise<HeliusAssetDetail | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fetchViaDasOnce(mintAddress);
    if (result) return result;
  }
  return null;
}

export async function hydrateSpecificSolanaToken(
  chainSlug: string, collectionSlug: string, mintAddress: string
): Promise<SolanaTokenHydrateResult> {
  // Opportunistic Archival Ledger (docs/marketplank/GROK-FINDINGS-
  // sustainable-archival-mining-2026-08-25.md): same "was this exact token
  // already archived" pre-check as hydrateSpecificToken's EVM counterpart,
  // so recordArchivalHydration below can honestly count distinct tokens.
  const priorState = await readProjectedTokensByIds(chainSlug, collectionSlug, [mintAddress]).catch(() => new Map());
  const wasAlreadyArchived = (() => {
    const prior = priorState.get(mintAddress);
    return !!prior && (!!prior.name || !!prior.imageUrl || prior.traits.length > 0);
  })();
  const das = await fetchViaDas(mintAddress);
  if (das) {
    let name = das.content?.metadata?.name?.trim() || null;
    let imageUrl = das.content?.links?.image?.trim() || null;
    let traits = traitsFromAttributes(das.content?.metadata?.attributes);
    const provenance = ["on-demand-click-hydration-das"];
    // F9: json_uri fallback when DAS attributes are empty.
    if (shouldFetchJsonUriFallback(traits, das.content?.json_uri)) {
      const offchain = await resolveSolanaOffchainMetadata(das.content?.json_uri);
      if (offchain) {
        if (offchain.traits.length) { traits = offchain.traits; provenance.push("solana-json-uri-fallback"); }
        name = name ?? offchain.name;
        imageUrl = imageUrl ?? offchain.imageUrl;
      }
    }
    if (name || imageUrl || traits.length > 0) {
      await upsertCollectionTokenProjection(chainSlug, collectionSlug, {
        tokens: [{ tokenId: mintAddress, name, imageUrl, traits }],
        partial: true, preservePartial: true,
        provenance, sourceObservedAt: new Date(),
      });
      await recordArchivalHydration(chainSlug, collectionSlug, { isNewToken: !wasAlreadyArchived }).catch(() => {});
      await maybeExpandSiblingTokens(chainSlug, collectionSlug).catch(() => {});
      return { resolved: true, token: { tokenId: mintAddress, name, imageUrl, animationUrl: null, mediaType: null, traits } };
    }
  }
  // Real, free, no-DAS-provider-required fallback -- same readers/pattern
  // helius-solana.ts's own onchainFallbackSnapshot uses.
  const legacy = await readTokenMetadata(mintAddress).catch(() => null);
  const core = legacy ? null : await readMetaplexCoreAsset(mintAddress).catch(() => null);
  const name = legacy?.name?.trim() || core?.name?.trim() || null;
  if (!name) return { resolved: false };
  await upsertCollectionTokenProjection(chainSlug, collectionSlug, {
    tokens: [{ tokenId: mintAddress, name, traits: [] }],
    partial: true, preservePartial: true,
    provenance: ["on-demand-click-hydration-onchain"], sourceObservedAt: new Date(),
  });
  await recordArchivalHydration(chainSlug, collectionSlug, { isNewToken: !wasAlreadyArchived }).catch(() => {});
  await maybeExpandSiblingTokens(chainSlug, collectionSlug).catch(() => {});
  return { resolved: true, token: { tokenId: mintAddress, name, imageUrl: null, animationUrl: null, mediaType: null, traits: [] } };
}
