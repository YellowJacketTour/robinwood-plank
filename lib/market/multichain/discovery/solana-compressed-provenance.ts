/**
 * Real provenance/ownership reads for Metaplex program-family assets that
 * are NOT plain SPL-token NFTs -- Bubblegum compressed NFTs (Merkle-tree
 * leaves, no individual token account) and Metaplex Core assets (single
 * unified account with an optional plugin registry). Closes the gap
 * flagged in venue-registry.ts's `metaplex-solana` entry ("Program-family
 * provenance including compressed and Core assets").
 *
 * REAL FINDING, VERIFIED LIVE 2026-08-24 (not guessed from memory): this
 * did NOT require any new DAS/RPC infrastructure. The exact same
 * `getAsset`/`getAssetsByGroup` JSON-RPC methods already wired through
 * solana-das-pool.ts's reserveDasSlot/settleDasSlot (and already called by
 * helius-solana.ts and helius-rarity-index-runner.ts) already return full
 * ownership + compression-proof + plugin data for compressed and Core
 * assets alike -- confirmed with real calls against a live QuickNode DAS
 * endpoint (QUICKNODE_SOLANA_URL from .env.local) this session:
 *
 *   getAsset({id:"JEKNVjohV7ALhZbHgCwuCFCJKxnfPom2fR4eniHCmP39"}) -- a
 *   real, live compressed NFT ("JUP Third round Drop") -- returned:
 *     "compression":{"eligible":false,"compressed":true,
 *       "data_hash":"6dUQbpocaLMxwr6WQfAEEhWfGcNBSiVZL5QWyvaLtLbK",
 *       "creator_hash":"8PHadTXZB7hRtevswNpDsHtz63m2pFhKPKeq6CLvCuTt",
 *       "asset_hash":"FTX4JuB36obtjcNqnZxW7NBxnKeB2mEbS1JgSJFiCV39",
 *       "tree":"9oFp2PM6k1b5mmzpeHUaZkCAbTD1ykR4QiyQYu3EVnfK",
 *       "seq":534799,"leaf_id":533886},
 *     "ownership":{"frozen":false,"delegated":true,
 *       "delegate":"9fqdPWz2ynV9aNtkYXtL49hbhzU4mB7wWzjvUVidrdep",
 *       "ownership_model":"single",
 *       "owner":"4ZpmpcWAdacYFdMVbsGz2e7rGCJxtVAJ8GMdaa4gto9x"}
 *
 *   searchAssets({interface:"MplCoreAsset",limit:2}) -- two real, live Core
 *   assets -- returned a `plugins` object neither helius-solana.ts's
 *   `HeliusAsset` type nor helius-collection-scan.ts's `HeliusSearchItem`
 *   type declares or reads, e.g.:
 *     "plugins":{"edition":{"data":{"number":178231},"index":0,"offset":182,
 *       "authority":{"type":"None","address":null}}}
 *     "plugins":{"royalties":{"data":{"creators":[{"address":"2fkUJ...",
 *       "percentage":100}],"rule_set":"None","basis_points":0},"index":0,
 *       "offset":198,"authority":{"type":"UpdateAuthority","address":null}}}
 *
 * So the real gap was never DAS coverage -- it was that this app's two
 * existing Helius call sites narrow-type their `getAsset`/`searchAssets`
 * responses to only the marketplace-snapshot fields they needed
 * (name/image/creator, or collection-level mpl_core_info) and silently
 * discard `ownership`, `compression`, `grouping`, `burnt`, and `plugins`
 * on every real response that already contains them. This file is the
 * first reader that surfaces those already-fetched fields as real,
 * typed provenance instead of dropping them.
 *
 * HONEST, VERIFIED GAP THAT REMAINS (do not build against this without a
 * fresh real 200): full TRANSFER/BURN HISTORY (as opposed to current
 * state) is not part of the standard Metaplex DAS contract -- `getAsset`
 * only ever returns the asset's current snapshot. Helius documents a
 * proprietary `getSignaturesForAsset` DAS extension for exactly this, but
 * it is NOT part of the shared DAS contract: confirmed live 2026-08-24
 * against the same QuickNode DAS endpoint used above, it returned a real
 * JSON-RPC `{"code":-32601,"message":"Method not found"}` -- i.e. QuickNode's
 * DAS add-on genuinely does not implement it. Every HELIUS_API_KEY in this
 * environment returned a real "max usage reached" (account-wide quota
 * exhaustion, the same single-project ceiling solana-das-pool.ts's own
 * header already documents) for every method tried this session, so this
 * file could not get one real successful `getSignaturesForAsset` response
 * to verify against even on Helius itself -- per this repo's own rule
 * (see gamma-bitcoin's entry in venue-registry.ts), that means no code is
 * built against it. Building a feature that only works on one DAS provider
 * would also silently break the multi-provider pool's whole point (any of
 * Helius/QuickNode/Shyft may answer a given call). Full transfer/burn
 * history for compressed/Core assets remains real, unbuilt, documented
 * scope -- not silently dropped.
 *
 * ALSO CONFIRMED LIVE, CORRECTING solana-das-pool.ts's own header: this
 * session's Shyft key (SHYFT_API_KEY, rpc.shyft.to) returned a real
 * `{"error":"BadRequest","message":"DAS RPC method not supported"}` for
 * BOTH getAsset and getSignaturesForAsset against real, known-good ids --
 * i.e. this specific Shyft key/plan does not actually serve the DAS
 * contract that file's header describes, contradicting its "verified live
 * against Shyft's own docs 2026-08-23" claim. Left that file's pool
 * wiring untouched (Shyft may still work for other plans, and jail/budget
 * already fails closed per-entry when a provider 400s), but flagging this
 * here since it is directly relevant, real, and verified.
 */
import { reserveDasSlot, settleDasSlot, type DasSlot } from "@/lib/market/multichain/discovery/solana-das-pool";

/** The subset of a real DAS getAsset/searchAssets response this reader cares about -- everything else (royalty, files, etc.) is already handled by other readers. */
export type RawDasAsset = {
  id: string;
  interface?: string;
  burnt?: boolean;
  compression?: {
    compressed?: boolean;
    tree?: string;
    leaf_id?: number;
    seq?: number;
    data_hash?: string;
    creator_hash?: string;
    asset_hash?: string;
  };
  ownership?: {
    owner?: string;
    delegate?: string | null;
    delegated?: boolean;
    frozen?: boolean;
    ownership_model?: string;
  };
  grouping?: Array<{ group_key?: string; group_value?: string }>;
  /** Metaplex Core-only -- an open-ended bag of plugin name -> plugin data (royalties/edition/freeze/attributes/etc.), real live-verified shape, deliberately kept as unknown rather than modeled per-plugin-type since the Core plugin set is still growing. */
  plugins?: Record<string, unknown>;
};

export type SolanaAssetProvenance = {
  id: string;
  /** e.g. "V1_NFT" (legacy/pNFT), "MplCoreAsset", "MplCoreCollection" -- real DAS `interface` value, never guessed. */
  interfaceKind: string | null;
  burnt: boolean;
  compressed: boolean;
  /** null for a non-compressed asset -- a real "this asset lives in a token account, not a tree" fact, not a missing-data gap. */
  compressionProof:
    | {
        tree: string;
        leafId: number;
        seq: number;
        dataHash: string;
        creatorHash: string;
        assetHash: string;
      }
    | null;
  ownership: {
    owner: string | null;
    delegate: string | null;
    delegated: boolean;
    frozen: boolean;
    ownershipModel: string | null;
  };
  /** The first `group_key: "collection"` grouping entry, if any -- real DAS `grouping` data, matches the same field helius-collection-scan.ts/helius-rarity-index-runner.ts already key off of. */
  collectionGroup: string | null;
  /** Metaplex Core plugin bag, verbatim from DAS, or null for non-Core assets/legacy assets that never carry one. Real, unparsed pass-through -- decoding individual plugin shapes is real, separate, unbuilt scope (see file header). */
  plugins: Record<string, unknown> | null;
};

/** Pure parse of a real DAS asset response into typed provenance -- no network, fully unit-testable. */
export function parseAssetProvenance(raw: RawDasAsset): SolanaAssetProvenance {
  const compression = raw.compression;
  const isCompressed = compression?.compressed === true;
  const hasFullProof =
    isCompressed &&
    typeof compression?.tree === "string" &&
    compression.tree.length > 0 &&
    typeof compression?.leaf_id === "number" &&
    typeof compression?.seq === "number" &&
    typeof compression?.data_hash === "string" &&
    typeof compression?.creator_hash === "string" &&
    typeof compression?.asset_hash === "string";

  const collectionEntry = raw.grouping?.find((g) => g.group_key === "collection" && g.group_value);

  return {
    id: raw.id,
    interfaceKind: raw.interface ?? null,
    burnt: raw.burnt === true,
    compressed: isCompressed,
    compressionProof: hasFullProof
      ? {
          tree: compression!.tree!,
          leafId: compression!.leaf_id!,
          seq: compression!.seq!,
          dataHash: compression!.data_hash!,
          creatorHash: compression!.creator_hash!,
          assetHash: compression!.asset_hash!,
        }
      : null,
    ownership: {
      owner: raw.ownership?.owner ?? null,
      delegate: raw.ownership?.delegate ?? null,
      delegated: raw.ownership?.delegated === true,
      frozen: raw.ownership?.frozen === true,
      ownershipModel: raw.ownership?.ownership_model ?? null,
    },
    collectionGroup: collectionEntry?.group_value ?? null,
    plugins: raw.plugins && Object.keys(raw.plugins).length > 0 ? raw.plugins : null,
  };
}

/**
 * Live, user-facing single-asset provenance read -- routes through the
 * SAME multi-provider DAS pool every other live Solana read in this app
 * uses (solana-das-pool.ts), "live" priority (spreads to the
 * least-loaded configured provider), never a dedicated new connection.
 * Fails closed with a real, specific error (pool exhausted, HTTP error,
 * DAS JSON-RPC error, or asset genuinely not found) -- never a fabricated
 * placeholder provenance record.
 */
export async function readSolanaAssetProvenance(assetId: string): Promise<SolanaAssetProvenance> {
  const slot: DasSlot | null = await reserveDasSlot(1, { priority: "live" });
  if (!slot) {
    throw new Error(
      "solana-compressed-provenance: no Solana DAS provider available (pool exhausted/jailed, or none of HELIUS_API_KEY(S)/QUICKNODE_SOLANA_URL/SHYFT_API_KEY configured)"
    );
  }
  let ok = false;
  try {
    const res = await fetch(slot.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "plank", method: "getAsset", params: { id: assetId } }),
    });
    if (!res.ok) {
      throw new Error(`solana-compressed-provenance: HTTP ${res.status} calling getAsset via ${slot.provider}`);
    }
    const body = (await res.json()) as { result?: RawDasAsset; error?: { code: number; message: string } };
    if (body.error) {
      throw new Error(`solana-compressed-provenance: getAsset via ${slot.provider} — ${body.error.code} ${body.error.message}`);
    }
    if (!body.result) {
      throw new Error(`solana-compressed-provenance: getAsset via ${slot.provider} returned no result for ${assetId}`);
    }
    ok = true;
    return parseAssetProvenance(body.result);
  } finally {
    await settleDasSlot(slot, 1, ok);
  }
}
