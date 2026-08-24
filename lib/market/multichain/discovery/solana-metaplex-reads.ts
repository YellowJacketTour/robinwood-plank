/**
 * Real, direct on-chain reads for Solana's legacy Token Metadata standard --
 * the Solana-side parity baseline to onchain-contract-reads.ts's EVM
 * ERC721 name()/tokenURI() reads (see docs/AUDIT-onchain-data-extraction-
 * 2026-08-24.md section 3). No indexer, no Metaplex/Helius DAS API --
 * plain JSON-RPC `getAccountInfo`/`getParsedProgramAccounts` against the
 * same public RPC endpoint already used by solana-transfer.ts and
 * foreign-fulfill.ts (api.mainnet-beta.solana.com, overridable via
 * SOLANA_RPC_URL / NEXT_PUBLIC_SOLANA_RPC_URL). Deliberately does not
 * introduce a second parallel Solana RPC config.
 *
 * LIBRARY CHOICE: this repo already depends on @solana/web3.js (used by
 * solana-transfer.ts/foreign-fulfill.ts) and @solana/spl-token, so PDA
 * derivation and account fetching reuse those rather than hand-rolled
 * base58/RPC plumbing. There is NO borsh (or any Metaplex SDK) dependency
 * in package.json, and this repo's own convention (onchain-contract-reads.ts)
 * is to decode raw account/log bytes by hand rather than pull in a
 * general-purpose ABI/schema library for one fixed, well-documented struct
 * shape. The Metadata account's Borsh layout is fixed-order and entirely
 * primitives/Options/Strings/Vecs of one small struct (Creator) -- exactly
 * the "very feasible to hand-roll" case the audit calls out, so this file
 * hand-writes the specific deserialization instead of adding a `borsh`
 * dependency for ~80 lines of decode logic.
 *
 * Struct layout verified against metaplex-foundation/mpl-token-metadata
 * (programs/token-metadata/program/src/state/metadata.rs) and
 * developers.metaplex.com/token-metadata:
 *
 *   Metadata {
 *     key: u8,                          // enum discriminant, MetadataV1 = 4
 *     update_authority: Pubkey,         // 32 bytes
 *     mint: Pubkey,                     // 32 bytes
 *     data: Data {
 *       name: String,                   // borsh String (u32 len + bytes),
 *                                        // content itself null-padded to 32B
 *                                        // at write time -- MUST trim \0
 *       symbol: String,                 // same pattern, padded to 10B
 *       uri: String,                    // same pattern, padded to 200B
 *       seller_fee_basis_points: u16,
 *       creators: Option<Vec<Creator>>, // 1-byte tag, then u32 len + entries
 *     },
 *     primary_sale_happened: bool,      // 1 byte
 *     is_mutable: bool,                 // 1 byte
 *     edition_nonce: Option<u8>,
 *     token_standard: Option<u8>,       // enum discriminant
 *     collection: Option<Collection { verified: bool, key: Pubkey }>,
 *     uses: Option<Uses>,               // not decoded here, low priority
 *     ...                               // collection_details, programmable_config -- not needed
 *   }
 *
 * Option<T> encoding (Borsh, used throughout): 1-byte discriminant
 * (0 = None, 1 = Some) followed by T's bytes iff Some.
 */
import { Connection, PublicKey } from "@solana/web3.js";

/** The SPL Token program itself (legacy, non-Token-2022) -- every classic Solana NFT's holding token account is owned by this program. */
const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
  "https://api.mainnet-beta.solana.com";

/**
 * Metaplex Token Metadata program ID -- verified against Metaplex's own
 * GitHub (metaplex-foundation/mpl-token-metadata) and Solscan's program
 * page (solscan.io/account/metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s),
 * not trusted from memory alone.
 */
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

function getConnection(): Connection {
  return new Connection(SOLANA_RPC_URL, "confirmed");
}

/**
 * Derives the Metaplex Metadata PDA for a given mint --
 * seeds = ['metadata', TOKEN_METADATA_PROGRAM_ID, mint], owned by the
 * Token Metadata program itself. Pure local computation, no RPC call;
 * async only to keep the call shape consistent with the other reads here.
 */
export async function deriveMetadataPda(mint: string): Promise<string> {
  const mintKey = new PublicKey(mint);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintKey.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda.toBase58();
}

export type SolanaTokenMetadata = {
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  creators: Array<{ address: string; verified: boolean; share: number }> | null;
  collection: { key: string; verified: boolean } | null;
  primarySaleHappened: boolean;
  isMutable: boolean;
};

/** Small cursor over a Buffer for hand-rolled Borsh decoding -- no dependency, just offset bookkeeping. */
class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  u8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  pubkey(): string {
    const slice = this.buf.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(slice).toBase58();
  }
  /** Borsh String: u32 length prefix + raw bytes. Metaplex pads name/symbol/uri content with trailing null bytes to their fixed max length at write time, so those must be trimmed after decode. */
  string(): string {
    const len = this.u32();
    const slice = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    const nullChar = String.fromCharCode(0);
    return slice.toString("utf-8").split(nullChar).join("").trim();
  }
  /** Option<T> discriminant: 0 = None, 1 = Some. Returns whether a value follows. */
  optionTag(): boolean {
    return this.u8() === 1;
  }
  hasRemaining(): boolean {
    return this.offset < this.buf.length;
  }
}

/**
 * Fetches the Metadata PDA account for a mint and Borsh-deserializes the
 * fields the marketplace actually needs (name/symbol/uri/royalty/creators/
 * collection/primary-sale/mutability). Returns null on any real failure
 * (account doesn't exist, wrong owner, malformed data) -- never fabricates.
 */
export async function readTokenMetadata(mint: string): Promise<SolanaTokenMetadata | null> {
  try {
    const pda = await deriveMetadataPda(mint);
    const connection = getConnection();
    const accountInfo = await connection.getAccountInfo(new PublicKey(pda), "confirmed");
    if (!accountInfo || !accountInfo.data || accountInfo.data.length === 0) return null;
    if (!accountInfo.owner.equals(TOKEN_METADATA_PROGRAM_ID)) return null;

    const r = new BorshReader(accountInfo.data);

    const key = r.u8(); // Key enum discriminant -- MetadataV1 = 4
    if (key !== 4) return null; // not a real Metadata account (wrong PDA/wrong account shape)

    r.pubkey(); // update_authority -- not surfaced yet, skip
    r.pubkey(); // mint -- redundant with the input, skip

    const name = r.string();
    const symbol = r.string();
    const uri = r.string();
    const sellerFeeBasisPoints = r.u16();

    let creators: Array<{ address: string; verified: boolean; share: number }> | null = null;
    if (r.optionTag()) {
      const count = r.u32();
      const list: Array<{ address: string; verified: boolean; share: number }> = [];
      for (let i = 0; i < count; i++) {
        const address = r.pubkey();
        const verified = r.bool();
        const share = r.u8();
        list.push({ address, verified, share });
      }
      creators = list;
    }

    const primarySaleHappened = r.bool();
    const isMutable = r.bool();

    // edition_nonce: Option<u8>
    if (r.optionTag()) r.u8();

    // token_standard: Option<u8> (enum discriminant) -- not surfaced yet
    if (r.optionTag()) r.u8();

    let collection: { key: string; verified: boolean } | null = null;
    if (r.hasRemaining() && r.optionTag()) {
      // Collection { verified: bool, key: Pubkey }
      const verified = r.bool();
      const collKey = r.pubkey();
      collection = { key: collKey, verified };
    }

    return {
      name,
      symbol,
      uri,
      sellerFeeBasisPoints,
      creators,
      collection,
      primarySaleHappened,
      isMutable,
    };
  } catch {
    return null; // malformed/short account data or an RPC hiccup is a normal, honest "couldn't read it" -- never a hard error
  }
}

/**
 * Resolves the real current holder of a legacy-standard (non-Core) Solana
 * NFT. The Metadata account never stores ownership -- that lives on a
 * separate SPL Token account holding balance=1 of this mint (direct
 * analogue of EVM's `ownerOf`).
 *
 * Tried `getTokenLargestAccounts` first (the "simpler alternative" the
 * audit called out) against the live public mainnet-beta endpoint during
 * development of this file, live: that specific RPC method came back
 * `429 Too Many Requests` on EVERY call, including for an unrelated,
 * extremely high-traffic mint (USDC) -- i.e. the method itself is
 * throttled/deprioritized on this free public endpoint, not rate-limited
 * per-caller. `getProgramAccounts` (SPL Token program, `dataSize: 165`
 * legacy token-account filter + `memcmp` on the mint at offset 0,
 * `encoding: "jsonParsed"` so the RPC node parses the account for us) was
 * verified live against the same endpoint and returned a real result
 * immediately -- so that's the standard pattern used here instead, same
 * one documented in Solana's own cookbook for "find token accounts by
 * mint." For a real NFT (supply == 1) this returns at most one account;
 * we defensively pick the one with a non-zero balance in case a burned
 * empty account also matches the filter.
 */
export async function readSplTokenOwner(mint: string): Promise<string | null> {
  try {
    const connection = getConnection();
    const mintKey = new PublicKey(mint);
    const accounts = await connection.getParsedProgramAccounts(SPL_TOKEN_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [
        { dataSize: 165 }, // legacy SPL Token account size
        { memcmp: { offset: 0, bytes: mintKey.toBase58() } }, // mint field is the first 32 bytes
      ],
    });

    for (const { account } of accounts) {
      const parsed = account.data;
      if (!parsed || typeof parsed !== "object" || !("parsed" in parsed)) continue;
      const info = (parsed as { parsed?: { info?: { owner?: string; tokenAmount?: { uiAmount?: number } } } }).parsed
        ?.info;
      if (info?.owner && Number(info?.tokenAmount?.uiAmount ?? 0) > 0) return info.owner;
    }
    return null; // no outstanding holder found -- burned, or not actually minted
  } catch {
    return null;
  }
}
