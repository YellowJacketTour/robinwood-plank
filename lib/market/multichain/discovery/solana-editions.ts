/**
 * Real, direct on-chain reads of Metaplex Master/Print Edition accounts
 * (legacy Token Metadata program) and Metaplex Core Asset accounts (the
 * newer, structurally different standard) -- item 8 of the priority build
 * list in docs/AUDIT-onchain-data-extraction-2026-08-24.md section 3.
 *
 * Same conventions as lib/market/multichain/discovery/onchain-contract-reads.ts
 * (the EVM equivalent): every exported read is try/catch-wrapped to a real
 * `null`, never a fabricated value or a thrown error surfaced to callers.
 * RPC access follows lib/market/multichain/trading/solana-transfer.ts's
 * existing convention -- SOLANA_RPC_URL / NEXT_PUBLIC_SOLANA_RPC_URL env,
 * falling back to Solana Labs' own public api.mainnet-beta.solana.com --
 * rather than introducing a second, different way of talking to Solana RPC
 * in this codebase (the DAS pool in solana-das-pool.ts is a *different*,
 * higher-level JSON-RPC surface -- searchAssets/getAsset -- not applicable
 * here since Master/Print Edition and Core Asset accounts need a raw
 * `getAccountInfo` + hand-rolled Borsh decode, not the DAS index).
 *
 * --------------------------------------------------------------------------
 * VERIFIED PROGRAM IDS / ACCOUNT LAYOUTS (fetched from source, not guessed)
 * --------------------------------------------------------------------------
 * Token Metadata program ID `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` --
 * confirmed via `solana_program::declare_id!` in
 * metaplex-foundation/mpl-token-metadata, programs/token-metadata/program/
 * src/lib.rs (fetched via `gh api` this session) -- the canonical,
 * unchanged-for-years Token Metadata program id.
 *
 * Master/Print Edition PDA seeds -- confirmed against
 * metaplex-foundation/mpl-token-metadata,
 * programs/token-metadata/program/src/state/metadata.rs (edition PDA
 * derivation) and edition.rs/master_edition.rs (fetched via `gh api
 * repos/metaplex-foundation/mpl-token-metadata/contents/...` this session):
 * seeds = ["metadata", token_metadata_program_id, mint, "edition"].
 * A Master Edition and a Print (Edition) account share this SAME PDA --
 * only one of the two can ever exist for a given mint, distinguished by the
 * first byte of the account data.
 *
 * `Key` enum discriminant (programs/token-metadata/program/src/state/mod.rs,
 * fetched this session) -- Borsh enum tag = declaration index, 0-based:
 *   0 Uninitialized, 1 EditionV1, 2 MasterEditionV1, 3 ReservationListV1,
 *   4 MetadataV1, 5 ReservationListV2, 6 MasterEditionV2, 7 EditionMarker, ...
 * Cross-checked against master_edition.rs's own `get_master_edition()`
 * dispatcher, which matches raw byte 2 -> MasterEditionV1 and byte 6 ->
 * MasterEditionV2 by literal constant (its own comment: "For some reason
 * when converting Key to u8 here, it becomes unreachable. Use direct
 * constant instead.") -- i.e. Metaplex's own program source hard-codes the
 * exact same discriminant bytes used below.
 *
 * MasterEditionV2 layout (master_edition.rs): key:1 + supply:u64(8) +
 * max_supply:Option<u64>(1 tag + 8 if Some) = 18-20 bytes.
 * MasterEditionV1 layout: same key/supply/max_supply prefix, then two more
 * Pubkeys (printing_mint, one_time_printing_authorization_mint) this reader
 * ignores -- only supply/max_supply are exposed, matching the requested
 * discriminated type.
 * Edition (Print) layout (edition.rs): key:1 + parent:Pubkey(32) +
 * edition:u64(8) = 41 bytes.
 *
 * --------------------------------------------------------------------------
 * Metaplex Core program ID -- confirmed via `solana_program::declare_id!`
 * in metaplex-foundation/mpl-core, programs/mpl-core/src/lib.rs (fetched
 * this session): `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`. Same address
 * across clusters (Solana programs are deployed at a fixed keypair-derived
 * address, not a per-cluster one) -- also the address referenced by
 * Metaplex's own generated JS client (clients/js/src/generated/programs/
 * mplCore.ts, `MPL_CORE_PROGRAM_ID`).
 *
 * Core `Key` enum (programs/mpl-core/src/state/mod.rs, fetched this
 * session): 0 Uninitialized, 1 AssetV1, 2 HashedAssetV1, 3 PluginHeaderV1,
 * 4 PluginRegistryV1, 5 CollectionV1, 6 GroupV1.
 *
 * Core `AssetV1` base layout (programs/mpl-core/src/state/asset.rs, fetched
 * this session): key:1 + owner:Pubkey(32) + update_authority:UpdateAuthority
 * + name:String(4-len-prefixed) + uri:String(4-len-prefixed) +
 * seq:Option<u64>. `UpdateAuthority` (state/update_authority.rs, fetched
 * this session) is itself a Borsh enum: 0 None (no payload), 1
 * Address(Pubkey), 2 Collection(Pubkey) -- this reader resolves it to a
 * single address the same way Metaplex's own Rust `UpdateAuthority::key()`
 * does (None -> Pubkey::default(), i.e. all-zero "11111...1111").
 *
 * KNOWN GAP, HONESTLY DOCUMENTED, NOT FABRICATED: a real Core asset account
 * can carry an arbitrary-length "plugin registry" appended after the base
 * AssetV1 fields (royalties, freeze, attributes, etc., via PluginHeaderV1 /
 * PluginRegistryV1 sub-accounts and in-line plugin TLVs). This reader
 * decodes only the base AssetV1 fields the task asked for (owner,
 * update_authority, name, uri) -- plugin decoding is real, documented,
 * unbuilt scope, not silently dropped.
 */
import { Connection, PublicKey } from "@solana/web3.js";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
  "https://api.mainnet-beta.solana.com";

// Same real fix as solana-metaplex-reads.ts's own header (2026-08-26):
// @solana/web3.js's Connection has built-in retry-on-429 that bypasses this
// app's own circuit breaker entirely -- disableRetryOnRateLimit fails fast
// instead of paying its real ~7.5s worst-case per call, and jailOnRateLimit
// below engages the shared circuit breaker so later calls in the same
// batch skip fast too.
function getConnection(): Connection {
  return new Connection(SOLANA_RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true });
}

async function jailOnRateLimit(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (!/429|too many requests|rate limit/i.test(message)) return;
  const { jailSource } = await import("@/lib/market/multichain/mesh/jail");
  await jailSource("helius-solana", 20 * 60_000, true).catch(() => {});
}

/** Real, live Token Metadata program id -- same one used by every legacy Metaplex NFT on Solana. */
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** Real, live Metaplex Core program id -- verified via mpl-core's own `declare_id!` (see file header). */
export const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

// Key enum discriminants -- legacy Token Metadata program (see file header for source).
const KEY_EDITION_V1 = 1;
const KEY_MASTER_EDITION_V1 = 2;
const KEY_MASTER_EDITION_V2 = 6;

// Key enum discriminants -- Metaplex Core program (see file header for source).
const CORE_KEY_ASSET_V1 = 1;

/**
 * Real PDA derivation for a mint's Master/Print Edition account -- seeds
 * `["metadata", token_metadata_program_id, mint, "edition"]`, verified
 * against Metaplex's own program source (see file header). Returns the
 * base58 address; the caller still needs `readEditionInfo` (or a raw
 * `getAccountInfo`) to know whether anything is actually deployed there --
 * PDA derivation always succeeds even when no account exists at that
 * address.
 */
export async function deriveMasterEditionPda(mint: string): Promise<string> {
  const mintKey = new PublicKey(mint);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKey.toBuffer(), Buffer.from("edition")],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda.toBase58();
}

export type SolanaEditionInfo =
  | { kind: "master"; maxSupply: string | null; supply: string }
  | { kind: "print"; parentMint: string | null; editionNumber: string };

/**
 * Real, direct read + Borsh decode of the Master/Print Edition account at
 * a mint's edition PDA. Returns `null` when no account exists there at all
 * (a real, meaningful "this NFT skips editions entirely" -- most modern
 * mints do) or when the account's discriminant byte isn't one of the three
 * real edition-account `Key` values, never a fabricated guess.
 *
 * Note: the edition PDA is shared between a Master Edition and a Print
 * (child) Edition -- only one of the two can exist for a given mint, which
 * is exactly why the return type discriminates on `kind` rather than
 * assuming one shape.
 */
export async function readEditionInfo(mint: string): Promise<SolanaEditionInfo | null> {
  try {
    const pda = await deriveMasterEditionPda(mint);
    const connection = getConnection();
    const account = await connection.getAccountInfo(new PublicKey(pda));
    if (!account || !account.data || account.data.length < 1) return null;
    const data = account.data;
    const keyByte = data[0];

    if (keyByte === KEY_MASTER_EDITION_V2 || keyByte === KEY_MASTER_EDITION_V1) {
      // key:1 + supply:u64(8) + max_supply: Option<u64> (1 tag + 8 if Some)
      if (data.length < 1 + 8 + 1) return null;
      const supply = data.readBigUInt64LE(1);
      const maxSupplyTag = data[9];
      let maxSupply: string | null = null;
      if (maxSupplyTag === 1) {
        if (data.length < 1 + 8 + 1 + 8) return null;
        maxSupply = data.readBigUInt64LE(10).toString();
      }
      return { kind: "master", maxSupply, supply: supply.toString() };
    }

    if (keyByte === KEY_EDITION_V1) {
      // key:1 + parent:Pubkey(32) + edition:u64(8)
      if (data.length < 1 + 32 + 8) return null;
      const parentBytes = data.subarray(1, 33);
      const parentMint = new PublicKey(parentBytes).toBase58();
      const editionNumber = data.readBigUInt64LE(33);
      return { kind: "print", parentMint: parentMint || null, editionNumber: editionNumber.toString() };
    }

    return null; // a real account exists at this PDA but isn't a recognized edition Key -- honest null, not a guess
  } catch (error) {
    await jailOnRateLimit(error);
    return null;
  }
}

export type SolanaCoreAsset = {
  owner: string;
  updateAuthority: string;
  name: string;
  uri: string;
};

/**
 * Real, direct read + Borsh decode of a Metaplex Core `AssetV1` account's
 * base fields (owner, update authority, name, uri). Metaplex Core is a
 * structurally different, newer standard from legacy Token Metadata -- one
 * unified account instead of separate mint/metadata/token-account records
 * -- so this does NOT reuse `readEditionInfo`'s layout at all (see file
 * header for the verified Core account layout and program id).
 *
 * Known, documented gap: does not decode the variable-length plugin
 * registry that can follow the base fields (royalties/freeze/attributes
 * plugins) -- only the base AssetV1 fields requested. Returns `null` on
 * any real failure (no account, wrong owner program, wrong discriminant,
 * malformed data) -- never fabricated.
 */
export async function readMetaplexCoreAsset(assetAddress: string): Promise<SolanaCoreAsset | null> {
  try {
    const connection = getConnection();
    const account = await connection.getAccountInfo(new PublicKey(assetAddress));
    if (!account || !account.data) return null;
    if (!account.owner.equals(MPL_CORE_PROGRAM_ID)) return null; // real ownership check -- an address that happens to decode isn't proof it's a real Core asset
    const data = account.data;
    if (data.length < 1) return null;
    if (data[0] !== CORE_KEY_ASSET_V1) return null;

    let offset = 1;
    if (data.length < offset + 32) return null;
    const owner = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;

    // UpdateAuthority enum: 0 None (no payload), 1 Address(Pubkey), 2 Collection(Pubkey)
    if (data.length < offset + 1) return null;
    const uaTag = data[offset];
    offset += 1;
    let updateAuthority: string;
    if (uaTag === 0) {
      updateAuthority = PublicKey.default.toBase58(); // matches Metaplex's own UpdateAuthority::key() -> Pubkey::default() for None
    } else if (uaTag === 1 || uaTag === 2) {
      if (data.length < offset + 32) return null;
      updateAuthority = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
      offset += 32;
    } else {
      return null; // unrecognized tag -- honest null rather than a guess
    }

    // name: String = u32 length prefix (LE) + UTF-8 bytes
    if (data.length < offset + 4) return null;
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    if (data.length < offset + nameLen) return null;
    const name = data.subarray(offset, offset + nameLen).toString("utf-8");
    offset += nameLen;

    // uri: String = u32 length prefix (LE) + UTF-8 bytes
    if (data.length < offset + 4) return null;
    const uriLen = data.readUInt32LE(offset);
    offset += 4;
    if (data.length < offset + uriLen) return null;
    const uri = data.subarray(offset, offset + uriLen).toString("utf-8");

    return { owner, updateAuthority, name, uri };
  } catch (error) {
    await jailOnRateLimit(error);
    return null;
  }
}
