import { postgresQuery } from "@/lib/postgres";
import { durableKv } from "@/lib/market/durable-kv";
import { decodeM2TradeState } from "@/lib/market/multichain/adapters/magiceden-m2-onchain";

/**
 * Magic Eden M2 listings, program-wide, keyless, BOUNDED (2026-09-07).
 *
 * The earlier reader (adapters/magiceden-m2-onchain.ts) proved the seller
 * trade-state PDA and layout against a live listing but deliberately did
 * not scan the program: an unfiltered getProgramAccounts over M2 is the
 * unbounded call that once 429'd a keyed RPC. This sweep makes the scan
 * bounded by SHARDING ON THE FIRST BYTE OF tokenMint: every call carries
 * a dataSize filter (384 bytes, verified live) plus the account
 * discriminator (a40e5c647b39eacc, verified live from a real DeGods listing)
 * plus one memcmp byte at the tokenMint offset, so each call returns about
 * 1/256th of the open listings. A durable cursor walks the 256 shards; a
 * full sweep is 256 calls spread across passes, and a shard is re-read
 * before its rows can go stale (rows unseen for two full sweeps are reaped).
 *
 * Layout (after the 8-byte discriminator): auctionHouse(32) wallet(32)
 * referral(32) price(u64) tokenMint(32) tokenAccount(32) tokenSize(u64)
 * bump(u8) expiry(i64). tokenMint therefore starts at 8 + 96 + 8 = 112.
 */
export const M2_PROGRAM = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
export const M2_SELLER_STATE_SIZE = 384;
const DISC_HEX = "a40e5c647b39eacc";
const TOKEN_MINT_OFFSET = 112;
const CURSOR_KEY = "plank:market:m2-sweep-cursor";
const SHARDS_PER_PASS = 12;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const b of bytes) {
    if (b !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

export const DISCRIMINATOR_BASE58 = base58Encode(Buffer.from(DISC_HEX, "hex"));

/**
 * Server-side only, so no NEXT_PUBLIC_ variable here: Next inlines those at
 * build time, which makes them build-frozen rather than a real runtime knob
 * (test/market/server-feature-flags.test.ts enforces this). The free public
 * mainnet endpoint is the honest default and is what the shard probe was
 * measured against.
 */
function solanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(solanaRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "plank-m2-sweep", method, params }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`m2-sweep: HTTP ${res.status} calling ${method}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`m2-sweep: ${method} -- ${body.error.code} ${body.error.message}`);
  return body.result as T;
}

type RawAccount = { pubkey: string; account: { data: [string, string]; owner: string } };

export type M2SweepResult = { shardsScanned: number; fromShard: number; accountsFetched: number; written: number; reaped: number; error?: string };

/** One shard: every open listing whose tokenMint starts with `prefix` (0..255). */
export async function fetchM2Shard(prefix: number): Promise<RawAccount[]> {
  return rpc<RawAccount[]>("getProgramAccounts", [
    M2_PROGRAM,
    {
      encoding: "base64",
      filters: [
        { dataSize: M2_SELLER_STATE_SIZE },
        { memcmp: { offset: 0, bytes: DISCRIMINATOR_BASE58 } },
        { memcmp: { offset: TOKEN_MINT_OFFSET, bytes: base58Encode(Uint8Array.from([prefix])) } },
      ],
    },
  ]);
}

export async function runM2Sweep(opts: { shards?: number; deadline?: number } = {}): Promise<M2SweepResult> {
  const shards = opts.shards ?? SHARDS_PER_PASS;
  const deadline = opts.deadline ?? Date.now() + 80_000;
  const start = ((await durableKv.get<number>(CURSOR_KEY)) ?? 0) % 256;
  const out: M2SweepResult = { shardsScanned: 0, fromShard: start, accountsFetched: 0, written: 0, reaped: 0 };
  let shard = start;
  const slot = await rpc<number>("getSlot", []).catch(() => 0);
  try {
    for (let i = 0; i < shards && Date.now() < deadline - 10_000; i += 1) {
      const scannedAt = new Date();
      const accounts = await fetchM2Shard(shard);
      out.accountsFetched += accounts.length;
      // One bulk upsert per shard (review of the first cut: ~2,900 rows per
      // shard measured live; per-row INSERTs would hold the 4-connection
      // pool for minutes).
      const cols = { account: [] as string[], mint: [] as string[], owner: [] as string[], ah: [] as string[], price: [] as string[], expiry: [] as string[] };
      for (const acc of accounts) {
        let st;
        try {
          st = decodeM2TradeState(acc.pubkey, Buffer.from(acc.account.data[0], "base64"), true);
        } catch {
          continue;
        }
        if (st.expiry !== -1 && st.expiry > 0 && st.expiry * 1000 < Date.now()) continue;
        cols.account.push(acc.pubkey);
        cols.mint.push(st.tokenMint);
        cols.owner.push(st.wallet);
        cols.ah.push(st.auctionHouse);
        cols.price.push(st.priceLamports);
        cols.expiry.push(String(st.expiry > 0 ? st.expiry : 0));
      }
      if (cols.account.length > 0) {
        const r = await postgresQuery(
          `INSERT INTO m2_onchain_listings (chain_slug, listing_account, mint, owner_account, auction_house, price_lamports, expiry, slot, shard, is_active, fetched_at)
           SELECT 'solana-mainnet', a, m, o, h, p::numeric, CASE WHEN e::bigint > 0 THEN to_timestamp(e::bigint) ELSE NULL END, $7, $8, TRUE, NOW()
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u(a, m, o, h, p, e)
           ON CONFLICT (chain_slug, listing_account) DO UPDATE SET
             mint = EXCLUDED.mint, owner_account = EXCLUDED.owner_account, auction_house = EXCLUDED.auction_house,
             price_lamports = EXCLUDED.price_lamports, expiry = EXCLUDED.expiry, slot = EXCLUDED.slot, shard = EXCLUDED.shard, is_active = TRUE, fetched_at = NOW()`,
          [cols.account, cols.mint, cols.owner, cols.ah, cols.price, cols.expiry, slot, shard]
        );
        out.written += r.rowCount ?? 0;
      }
      // Reap: a row in THIS shard that this pass did not see is closed on chain.
      const reaped = await postgresQuery(
        `UPDATE m2_onchain_listings SET is_active = FALSE
          WHERE chain_slug = 'solana-mainnet' AND is_active = TRUE AND shard = $1 AND fetched_at < $2`,
        [shard, scannedAt]
      ).catch(() => ({ rowCount: 0 }));
      out.reaped += reaped.rowCount ?? 0;
      out.shardsScanned += 1;
      shard = (shard + 1) % 256;
      await durableKv.set(CURSOR_KEY, shard);
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    await durableKv.set(CURSOR_KEY, shard);
  }
  return out;
}
