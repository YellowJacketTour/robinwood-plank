/**
 * Tensor on-chain ACTIVE-LISTING scanner -- tensor-settlement-scan.ts's
 * sibling. Where that file reads SETTLED buy/takeBid instructions off
 * transaction history, this file reads Tensor's OPEN listings directly out
 * of live Solana account state via `getProgramAccounts`. See migration
 * 061_tensor_onchain_listings.sql's own header for the full "why" and the
 * honest scope disclosure -- summarized again here since it drives every
 * decode decision below.
 *
 * READ-ONLY LIVE-ACCOUNT SCAN. NOT TENSOR'S OWN OFF-CHAIN RANKED BOOK.
 * ---------------------------------------------------------------------------
 * Tensor's off-chain order-book/stats GraphQL API is confirmed key-gated
 * with no free tier (venue-registry.ts's "tensor-solana" entry, settled
 * 2026-08-24 -- unchanged and untouched by this file). This module never
 * calls that API. Instead it reads Tensor's real `ListState` accounts --
 * ordinary, publicly-readable Solana accounts owned by the real, live
 * Tensor Marketplace program -- directly off a public Solana RPC. This is
 * real chain state, not a scrape and not an API response: completeness is
 * bounded only by whatever the chosen RPC's own `getProgramAccounts` index
 * currently returns, which is disclosed rather than claimed as
 * Tensor's-own-index-complete.
 *
 * REAL ACCOUNT TYPE AND DISCRIMINATOR -- FROM THE INSTALLED PACKAGE, NOT GUESSED
 * ---------------------------------------------------------------------------
 * `ListState` is a real, current Anchor-style account type generated into
 * the installed @tensor-foundation/marketplace package
 * (dist/types/generated/accounts/listState.d.ts) -- its own doc comment
 * ("Owner is the rent payer when this is None" / "Cosigner") matches the
 * real, current Tensor listing shape (owner, assetId, amount, currency,
 * expiry, privateTaker, makerBroker, rentPayer, cosigner). Its real 8-byte
 * discriminator is read directly from that same package's compiled output
 * (dist/src/index.js's `LIST_STATE_DISCRIMINATOR = new Uint8Array([78, 242,
 * 89, 138, 161, 221, 176, 75])`, i.e. hex `4ef2598aa1ddb04b` / base58
 * `ECt8xkbczt2`), not derived by guessing an Anchor sighash from a name --
 * this exact byte sequence is what the real deployed program itself writes
 * as the first 8 bytes of every real ListState account, and what this
 * module's `getProgramAccounts` memcmp filter matches against at offset 0.
 * `getListStateDecoder()`, also imported directly from the installed
 * package (not reimplemented here), performs the actual field decode --
 * the same decoder Tensor's own generated SDK would use to read this
 * account, so field layout drift between this file and the real program is
 * structurally impossible short of upgrading the package itself.
 *
 * REAL, LIVE-VERIFIED getProgramAccounts RESULT (2026-08-25)
 * ---------------------------------------------------------------------------
 * A real `getProgramAccounts` call against the real, live Tensor Marketplace
 * program (TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp) on the public
 * api.mainnet-beta.solana.com RPC, filtered with `{ memcmp: { offset: 0,
 * bytes: "ECt8xkbczt2" } }` (base58-encoded discriminator -- the public RPC
 * rejected a base64-encoded memcmp filter with `-32602
 * INVALID_PARAMS_WITH_MESSAGE`; base58 is the encoding this RPC's deployed
 * version actually accepts for a bare `bytes` field), returned 115,370 real
 * accounts on a single unindexed pass -- it did NOT time out or get
 * rate-limited for this specific query shape. Decoding the first several
 * with the installed package's own `getListStateDecoder()` produced real,
 * well-formed fields, e.g. (pubkey `12ZJJDgPSSqThpJuDkeY7342vFY7z7yt4pHFGuaYwxn`):
 * `owner: "BhUzP2nuFRNGJJGcAGJsdMxvjMGrzQhYD9N1vGy1pyYq"`,
 * `assetId: "2YPVS86yFGfKv7QhsNojMi9qALVo3bqomEKQ4JCne1K1"`,
 * `amount: 7449000n` (lamports), `expiry: 1818842540n`,
 * `currency: { __option: "None" }` (native SOL) -- all 5 sampled accounts
 * decoded cleanly with plausible, real-looking values (owner/assetId
 * pubkeys, amounts in the 10^6-10^8 lamport range, expiries as real future
 * unix timestamps). See this module's own test fixture
 * (test/market/fixtures/tensor-listing-real-accounts.json) for the exact
 * raw RPC response this was verified against.
 *
 * FULL-SNAPSHOT SCAN, SELF-THROTTLED -- NOT AN INCREMENTAL CURSOR
 * ---------------------------------------------------------------------------
 * Unlike getSignaturesForAddress (tensor-settlement-scan.ts's own
 * incremental, cursor-based shape), getProgramAccounts has no incremental
 * window: every call re-reads the program's ENTIRE current listing set.
 * Given the ~115K-account, tens-of-megabytes response size observed above,
 * this must run far less often than the per-tick EVM/settlement scanners.
 * This module self-throttles via `tensor_onchain_listing_scan_state`: a
 * call to `scanTensorListings()` is a real no-op (returns
 * `{ skipped: true }`) unless at least MIN_SCAN_INTERVAL_MS has elapsed
 * since the last completed pass, so it is safe to invoke from the same
 * per-tick loop refresh-market-data.ts already runs for every other
 * scanner without actually hammering the RPC every tick.
 *
 * SNAPSHOT UPSERT + REAP, NOT A DIFF
 * ---------------------------------------------------------------------------
 * Every account seen in a pass is upserted (INSERT ... ON CONFLICT DO
 * UPDATE) with a fresh `fetched_at`/`slot`. A row not seen in the CURRENT
 * pass but marked active from a PRIOR pass is reaped (`is_active = false`)
 * -- it no longer exists as an open ListState account (bought, delisted, or
 * expired), so continuing to display it as live would be a fabrication.
 * This mirrors an ordinary "full resync" pattern, not the append-only
 * settlement ledger shape.
 *
 * COLLECTION GROUPING: FILTERED IN-APP AGAINST ALREADY-TRACKED MINTS
 * ---------------------------------------------------------------------------
 * `ListState` carries no collection id field (only `assetId`, the mint/
 * asset pubkey itself) -- Tensor's real on-chain listing account genuinely
 * does not cheaply expose which collection a listing belongs to, so a
 * cheap collection-level memcmp shard is not available. This module
 * therefore scans the FULL program broadly (as verified above, one pass
 * completes without RPC failure) and filters in application code against
 * `plank_collection_tokens` -- the same "known member set" scope limitation
 * tensor-settlement-scan.ts's own `readTensorSettlementActivity` already
 * documents and accepts: a mint this app has never discovered via its own
 * Solana collection pipelines is simply invisible to a collection's feed
 * here, never mis-attributed.
 */
import { postgresQuery } from "@/lib/postgres";
import { getListStateDecoder, type ListState } from "@tensor-foundation/marketplace";
import { TENSOR_MARKETPLACE_PROGRAM_ADDRESS } from "./tensor-settlement-scan";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL?.trim() ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
  "https://api.mainnet-beta.solana.com";

/** Real, verified live discriminator for Tensor's ListState account -- see this file's own header for the citation. */
export const LIST_STATE_DISCRIMINATOR_BASE58 = "ECt8xkbczt2";

const SCAN_KEY = "solana-mainnet::tensor-marketplace-list-state-v1";

/**
 * Minimum spacing between two real getProgramAccounts passes. A full pass
 * observed ~115K accounts / tens of MB in one call -- real, working, but
 * expensive enough that this must be a slow lane (5-15 min band the task
 * called for), never a per-tick call. 10 minutes chosen as the midpoint.
 */
const MIN_SCAN_INTERVAL_MS = 10 * 60 * 1000;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(input: string): Uint8Array {
  let bytes: number[] = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`tensor-listing-scan: invalid base58 character "${char}"`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "plank-tensor-listing", method, params }),
  });
  if (!res.ok) throw new Error(`tensor-listing-scan: HTTP ${res.status} calling ${method}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`tensor-listing-scan: ${method} — ${body.error.code} ${body.error.message}`);
  return body.result as T;
}

type RawProgramAccount = {
  pubkey: string;
  account: { data: [string, string]; lamports: number; owner: string };
};

/** Real address type stub -- ListState's own generated type declares `owner`/`assetId` as branded `Address` strings; a plain string is structurally identical for every use this module makes of them. */
type DecodableListState = Omit<ListState, "currency" | "privateTaker" | "makerBroker" | "rentPayer" | "cosigner" | "reserved1" | "discriminator" | "bump" | "version">;

export type DecodedTensorListing = {
  listingAccount: string;
  mint: string;
  owner: string;
  priceLamports: string;
  currency: string | null;
  expirySeconds: string | null;
};

/**
 * Pure decode of one already-fetched raw `getProgramAccounts` row into a
 * real Tensor listing, using the installed package's own
 * `getListStateDecoder()`. No I/O -- unit-tested directly against real
 * fetched account data (see test/market/tensor-listing-scan.test.ts).
 * Returns null only if the row's data does not actually decode as a
 * well-formed ListState (never fabricated as a partial/best-effort row).
 */
export function decodeListingAccount(raw: RawProgramAccount): DecodedTensorListing | null {
  if (raw.account.data[1] !== "base64") return null;
  const bytes = Buffer.from(raw.account.data[0], "base64");
  let decoded: ListState;
  try {
    decoded = getListStateDecoder().decode(bytes) as unknown as ListState;
  } catch {
    return null;
  }
  const currency = decoded.currency && (decoded.currency as { __option: string; value?: string }).__option === "Some"
    ? ((decoded.currency as { __option: string; value?: string }).value ?? null)
    : null;
  const expiryBigint = typeof decoded.expiry === "bigint" ? decoded.expiry : BigInt(decoded.expiry ?? 0);
  return {
    listingAccount: raw.pubkey,
    mint: String(decoded.assetId),
    owner: String(decoded.owner),
    priceLamports: String(decoded.amount),
    currency,
    expirySeconds: expiryBigint > 0n ? String(expiryBigint) : null,
  };
}

async function readScanState(): Promise<{ lastScannedAt: Date | null }> {
  const result = await postgresQuery<{ last_scanned_at: Date | null }>(
    `SELECT last_scanned_at FROM tensor_onchain_listing_scan_state WHERE scan_key = $1`,
    [SCAN_KEY]
  );
  return { lastScannedAt: result.rows[0]?.last_scanned_at ?? null };
}

async function writeScanState(slot: number, accountCount: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO tensor_onchain_listing_scan_state (scan_key, last_scanned_at, last_slot, last_account_count, updated_at)
     VALUES ($1, NOW(), $2, $3, NOW())
     ON CONFLICT (scan_key) DO UPDATE SET
       last_scanned_at = NOW(),
       last_slot = EXCLUDED.last_slot,
       last_account_count = EXCLUDED.last_account_count,
       updated_at = NOW()`,
    [SCAN_KEY, slot, accountCount]
  );
}

/**
 * Upsert a full pass's worth of listings, then reap anything active from a
 * prior pass that this pass did not see. Every row this scanner writes
 * carries an implicit `source: "tensor_onchain_list_state"` label at the
 * read side (see readTensorOnchainListings below) -- the label lives at
 * the read boundary, matching tensor-settlement-scan.ts's own
 * `TensorSettlementActivityEvent.source` shape, rather than a redundant
 * column on every row.
 */
export async function upsertTensorListings(rows: DecodedTensorListing[], slot: number): Promise<number> {
  let written = 0;
  for (const r of rows) {
    const result = await postgresQuery(
      `INSERT INTO tensor_onchain_listings
         (chain_slug, listing_account, mint, owner_account, price_lamports, currency, expiry, slot, is_active, fetched_at)
       VALUES ('solana-mainnet', $1, $2, $3, $4::numeric, $5, to_timestamp($6::bigint), $7, TRUE, NOW())
       ON CONFLICT (chain_slug, listing_account) DO UPDATE SET
         mint = EXCLUDED.mint,
         owner_account = EXCLUDED.owner_account,
         price_lamports = EXCLUDED.price_lamports,
         currency = EXCLUDED.currency,
         expiry = EXCLUDED.expiry,
         slot = EXCLUDED.slot,
         is_active = TRUE,
         fetched_at = NOW()`,
      [r.listingAccount, r.mint, r.owner, r.priceLamports, r.currency, r.expirySeconds, slot]
    );
    written += (result.rowCount ?? 0) > 0 ? 1 : 0;
  }
  return written;
}

export async function reapStaleListings(seenAccounts: string[], scanStartedAt: Date): Promise<number> {
  const result = await postgresQuery(
    `UPDATE tensor_onchain_listings
     SET is_active = FALSE
     WHERE chain_slug = 'solana-mainnet'
       AND is_active = TRUE
       AND fetched_at < $1
       AND NOT (listing_account = ANY($2::text[]))`,
    [scanStartedAt.toISOString(), seenAccounts]
  );
  return result.rowCount ?? 0;
}

export type TensorListingScanResult = {
  skipped: boolean;
  accountsFetched: number;
  listingsDecoded: number;
  listingsWritten: number;
  listingsReaped: number;
  error?: string;
};

/**
 * One full pass: self-throttled via tensor_onchain_listing_scan_state (see
 * MIN_SCAN_INTERVAL_MS above), then a single real getProgramAccounts call
 * against the real Tensor Marketplace program filtered to ListState
 * accounts only, decoded via the installed package's own decoder, upserted,
 * and reaped for anything no longer present. Safe to call every tick from
 * refresh-market-data.ts the same way scanTensorSettlements is -- the
 * throttle, not the caller, controls the real RPC cadence.
 */
export async function scanTensorListings(): Promise<TensorListingScanResult> {
  const state = await readScanState();
  if (state.lastScannedAt && Date.now() - state.lastScannedAt.getTime() < MIN_SCAN_INTERVAL_MS) {
    return { skipped: true, accountsFetched: 0, listingsDecoded: 0, listingsWritten: 0, listingsReaped: 0 };
  }

  const scanStartedAt = new Date();
  try {
    const accounts = await rpcCall<RawProgramAccount[]>("getProgramAccounts", [
      TENSOR_MARKETPLACE_PROGRAM_ADDRESS,
      {
        encoding: "base64",
        filters: [{ memcmp: { offset: 0, bytes: LIST_STATE_DISCRIMINATOR_BASE58 } }],
      },
    ]);

    const decoded: DecodedTensorListing[] = [];
    for (const acc of accounts) {
      const listing = decodeListingAccount(acc);
      if (listing) decoded.push(listing);
    }

    const slot = await rpcCall<number>("getSlot", []).catch(() => 0);
    const written = await upsertTensorListings(decoded, slot);
    const reaped = await reapStaleListings(
      decoded.map((d) => d.listingAccount),
      scanStartedAt
    );
    await writeScanState(slot, accounts.length);

    return {
      skipped: false,
      accountsFetched: accounts.length,
      listingsDecoded: decoded.length,
      listingsWritten: written,
      listingsReaped: reaped,
    };
  } catch (err) {
    return {
      skipped: false,
      accountsFetched: 0,
      listingsDecoded: 0,
      listingsWritten: 0,
      listingsReaped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type TensorOnchainListingEvent = {
  source: "tensor_onchain_list_state";
  mint: string;
  owner: string;
  priceLamports: string;
  currency: string | null;
  expirySeconds: string | null;
  listingAccount: string;
  slot: string;
  fetchedAt: string;
};

type ListingRow = {
  listing_account: string;
  mint: string;
  owner_account: string;
  price_lamports: string;
  currency: string | null;
  expiry: Date | null;
  slot: string;
  fetched_at: Date;
};

/**
 * Reads this app's own real Tensor active-listing snapshot for the mints
 * belonging to one tracked Solana collection -- the read side of this
 * scanner. Same "known member set" scope this file's own header discloses:
 * only mints already present in `plank_collection_tokens` for this
 * collection are matched. Every row is explicitly tagged
 * `source: "tensor_onchain_list_state"` so it is never confused with
 * Tensor's own official ranked/aggregated stats (see this module's header
 * and venue-registry.ts's updated tensor-solana entry).
 */
export async function readTensorOnchainListings(input: {
  chainSlug: string;
  collectionSlug: string;
  limit: number;
}): Promise<TensorOnchainListingEvent[]> {
  if (input.chainSlug !== "solana-mainnet") return [];
  const mintsResult = await postgresQuery<{ token_id: string }>(
    `SELECT token_id FROM plank_collection_tokens WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`,
    [input.chainSlug, input.collectionSlug]
  );
  const mints = mintsResult.rows.map((r) => r.token_id);
  if (mints.length === 0) return [];

  const listingsResult = await postgresQuery<ListingRow>(
    `SELECT listing_account, mint, owner_account, price_lamports::text, currency, expiry, slot::text, fetched_at
     FROM tensor_onchain_listings
     WHERE chain_slug = $1 AND is_active = TRUE AND mint = ANY($2::text[])
     ORDER BY price_lamports ASC
     LIMIT $3`,
    [input.chainSlug, mints, input.limit]
  );

  return listingsResult.rows.map((r) => ({
    source: "tensor_onchain_list_state" as const,
    mint: r.mint,
    owner: r.owner_account,
    priceLamports: r.price_lamports,
    currency: r.currency,
    expirySeconds: r.expiry ? String(Math.floor(new Date(r.expiry).getTime() / 1000)) : null,
    listingAccount: r.listing_account,
    slot: r.slot,
    fetchedAt: r.fetched_at.toISOString(),
  }));
}
