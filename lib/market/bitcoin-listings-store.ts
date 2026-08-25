/**
 * Storage for Marketplank-native Bitcoin Ordinals listings
 * (deploy/inmotion/postgres/migrations/026_native_bitcoin_listings.sql).
 * Same non-custodial store-and-forward model as every other native order
 * table in this app -- this module stores and serves the seller's own
 * signed PSBT leg verbatim, never constructs or alters one. See that
 * migration's own header and native-bitcoin-listing.ts's module header for
 * the protocol this stores half of.
 *
 * ONLY THE SELLER'S SIGNED LEG IS EVER STORED. The fulfillment PSBT (the
 * buyer's dummy/payment inputs, Marketplank's fee output, buyer's change)
 * is always built fresh per purchase attempt from live UTXO data -- see
 * native-bitcoin-listing.ts's buildFulfillmentPsbt -- because storing it
 * would go stale the instant any input UTXO is spent elsewhere.
 */
import { postgresQuery } from "@/lib/postgres";

export type NativeBitcoinListingStatus = "active" | "sold" | "cancelled";

export type NativeBitcoinListing = {
  id: string;
  sellerAddress: string;
  inscriptionId: string;
  utxoTxid: string;
  utxoVout: number;
  utxoValueSats: number;
  priceSats: number;
  sellerPsbtBase64: string;
  status: NativeBitcoinListingStatus;
  createdAt: string;
  /**
   * Set only once status is "sold" -- the real broadcast transaction id
   * (audit finding, 2026-08-19: the migration's own schema already stored
   * this, via markNativeBitcoinListingSold, but it was never exposed here,
   * so confirming a real purchase meant manually hunting the transaction
   * down on a block explorer instead of reading it from this app's own
   * response).
   */
  soldTxid: string | null;
  soldAt: string | null;
};

type ListingRow = {
  id: string;
  seller_address: string;
  inscription_id: string;
  utxo_txid: string;
  utxo_vout: number;
  utxo_value_sats: string;
  price_sats: string;
  seller_psbt_base64: string;
  status: NativeBitcoinListingStatus;
  created_at: string;
  sold_txid: string | null;
  sold_at: string | null;
};

function rowToListing(row: ListingRow): NativeBitcoinListing {
  return {
    id: row.id,
    sellerAddress: row.seller_address,
    inscriptionId: row.inscription_id,
    utxoTxid: row.utxo_txid,
    utxoVout: row.utxo_vout,
    utxoValueSats: Number(row.utxo_value_sats),
    priceSats: Number(row.price_sats),
    sellerPsbtBase64: row.seller_psbt_base64,
    status: row.status,
    createdAt: row.created_at,
    soldTxid: row.sold_txid,
    soldAt: row.sold_at,
  };
}

/**
 * Returns false (not an error) if a listing for this exact id is already
 * ACTIVE -- the caller should report a conflict rather than silently
 * overwrite a live listing. The id is deterministic
 * (`native-btc-${sellerAddress}-${utxoTxid}-${utxoVout}`), so a seller who
 * cancels and re-lists the same inscription reuses the same id; the
 * conditional ON CONFLICT lets that succeed (only when the prior row is
 * NOT active) instead of hitting a hard primary-key violation, which is
 * what a plain INSERT would do on every re-list (audit finding,
 * 2026-08-19 -- this used to be a plain INSERT with no conflict handling
 * at all).
 */
export async function putNativeBitcoinListing(input: {
  id: string;
  sellerAddress: string;
  inscriptionId: string;
  utxoTxid: string;
  utxoVout: number;
  utxoValueSats: number;
  priceSats: number;
  sellerPsbtBase64: string;
}): Promise<boolean> {
  const result = await postgresQuery(
    `INSERT INTO market_native_bitcoin_listings
       (id, seller_address, inscription_id, utxo_txid, utxo_vout, utxo_value_sats, price_sats, seller_psbt_base64, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
     ON CONFLICT (id) DO UPDATE SET
       inscription_id = EXCLUDED.inscription_id,
       utxo_value_sats = EXCLUDED.utxo_value_sats,
       price_sats = EXCLUDED.price_sats,
       seller_psbt_base64 = EXCLUDED.seller_psbt_base64,
       status = 'active',
       updated_at = NOW(),
       sold_at = NULL,
       sold_txid = NULL
     WHERE market_native_bitcoin_listings.status != 'active'`,
    [
      input.id,
      input.sellerAddress,
      input.inscriptionId,
      input.utxoTxid,
      input.utxoVout,
      input.utxoValueSats,
      input.priceSats,
      input.sellerPsbtBase64,
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getActiveNativeBitcoinListings(limit = 200): Promise<NativeBitcoinListing[]> {
  const result = await postgresQuery<ListingRow>(
    `SELECT * FROM market_native_bitcoin_listings WHERE status = 'active' ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map(rowToListing);
}

export async function getNativeBitcoinListingsBySeller(sellerAddress: string): Promise<NativeBitcoinListing[]> {
  const result = await postgresQuery<ListingRow>(
    `SELECT * FROM market_native_bitcoin_listings WHERE seller_address = $1 ORDER BY created_at DESC`,
    [sellerAddress]
  );
  return result.rows.map(rowToListing);
}

export async function getNativeBitcoinListingById(id: string): Promise<NativeBitcoinListing | null> {
  const result = await postgresQuery<ListingRow>(`SELECT * FROM market_native_bitcoin_listings WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? rowToListing(row) : null;
}

/** Active-only count, mirroring countSwapListingsByMaker's per-maker cap reasoning -- a real ceiling so one wallet can't flood the book. */
export async function countActiveNativeBitcoinListingsBySeller(sellerAddress: string): Promise<number> {
  const result = await postgresQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM market_native_bitcoin_listings WHERE seller_address = $1 AND status = 'active'`,
    [sellerAddress]
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Atomically flips an active listing to sold, recording the real broadcast
 * txid. Returns false (not an error) if the listing was already
 * sold/cancelled by the time this ran -- the caller (the broadcast route)
 * treats that as "someone else already fulfilled this," not a fault of
 * the current request; the underlying UTXO's own spent status is the real
 * source of truth regardless of what this row says.
 */
export async function markNativeBitcoinListingSold(id: string, soldTxid: string): Promise<boolean> {
  const result = await postgresQuery(
    `UPDATE market_native_bitcoin_listings
       SET status = 'sold', sold_at = NOW(), sold_txid = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'active'`,
    [id, soldTxid]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function cancelNativeBitcoinListing(id: string, sellerAddress: string): Promise<boolean> {
  const result = await postgresQuery(
    `UPDATE market_native_bitcoin_listings
       SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND seller_address = $2 AND status = 'active'`,
    [id, sellerAddress]
  );
  return (result.rowCount ?? 0) > 0;
}
