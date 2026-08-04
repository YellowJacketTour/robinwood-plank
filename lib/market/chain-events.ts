/**
 * Permanent on-chain event ledger — storage layer.
 *
 * See deploy/inmotion/postgres/migrations/008_chain_events.sql for why this
 * exists. In short: the Activity read path used to live-fetch a 40-event
 * (or 800-event, in `full=1` mode) window on every request, so anything older
 * than that window had no record anywhere and was permanently invisible to the
 * app — a real 0.11 ETH sale went missing that way. This module owns the
 * append-only table that fixes it, plus the resumable per-contract cursor that
 * lets the 2-minute cron backfill and live-sync through one code path.
 *
 * The write path is idempotent by construction: (tx_hash, log_index) is unique
 * for a log on an EVM chain, so `ON CONFLICT DO NOTHING` makes re-indexing any
 * range a no-op. Nothing here ever updates or deletes an event row.
 */

import { formatEther } from "ethers";
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import type { ActivityEvent, ActivityKind } from "@/lib/market/activity";
import type { VaultTradeEvent } from "@/lib/market/vault-activity";
import { resolveIpfsUrl } from "@/lib/ipfs";

/** Which log stream a row came from. */
export type ChainEventSource = "nft" | "vault";

/** One persisted log, in the shape the writer hands to Postgres. */
export type ChainEventRow = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** ISO string, or null when the block header could not be read. */
  blockTimestamp: string | null;
  source: ChainEventSource;
  /** Lowercased address of the contract that emitted the log. */
  contract: string;
  /** ActivityKind or VaultTradeKind — see the migration. */
  kind: string;
  tokenId: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  priceWei: string | null;
  sharesWei: string | null;
  venueKind: string | null;
  venueContract: string | null;
  confirmed: boolean;
};

export function hasChainEventStore(): boolean {
  return hasPostgresConfig();
}

/* ------------------------------------------------------------------ *
 * Pure mappers — no I/O, so they are unit-testable without a database *
 * ------------------------------------------------------------------ */

/**
 * Normalise an address for storage. Addresses are stored lowercased so a
 * checksummed value from one source and a lowercase value from another never
 * produce two different-looking rows for the same wallet.
 */
export function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** A uint256 decimal string, or null when the value is absent/zero/garbage. */
function normalizeWei(value: string | null | undefined): string | null {
  if (value == null) return null;
  try {
    const wei = BigInt(value);
    return wei > BigInt(0) ? wei.toString() : null;
  } catch {
    return null;
  }
}

/**
 * An ActivityEvent (collection Transfer/mint/sale) as a ledger row.
 *
 * ActivityEvent itself carries no logIndex — it was designed for a
 * display-only feed — so the indexer, which reads raw logs and therefore does
 * have one, passes it in. That is the whole reason the ledger indexes from
 * eth_getLogs rather than from Blockscout's token-transfer REST feed: the REST
 * feed cannot supply the second half of the idempotency key.
 */
export function activityEventToRow(
  event: ActivityEvent,
  logIndex: number,
  contract: string
): ChainEventRow {
  return {
    txHash: event.txHash.toLowerCase(),
    logIndex,
    blockNumber: event.blockNumber,
    blockTimestamp: event.timestamp,
    source: "nft",
    contract: contract.toLowerCase(),
    kind: event.kind,
    tokenId: event.tokenId,
    fromAddress: normalizeAddress(event.from),
    toAddress: normalizeAddress(event.to),
    priceWei: normalizeWei(event.priceWei),
    sharesWei: null,
    venueKind: event.venue?.kind ?? null,
    venueContract: event.venue ? normalizeAddress(event.venue.contract) : null,
    confirmed: true,
  };
}

/** A VaultTradeEvent (buy/sell/deposit/redeem/LP) as a ledger row. */
export function vaultEventToRow(event: VaultTradeEvent, contract: string): ChainEventRow {
  return {
    txHash: event.txHash.toLowerCase(),
    logIndex: event.logIndex,
    blockNumber: event.blockNumber,
    blockTimestamp: event.timestamp,
    source: "vault",
    contract: (event.vaultAddress || contract).toLowerCase(),
    kind: event.kind,
    tokenId: event.tokenId,
    // A vault event names one counterparty, not a from/to pair. Storing it as
    // `from` keeps a single column meaningful for both sources rather than
    // inventing a third address column only one source ever fills.
    fromAddress: normalizeAddress(event.address),
    toAddress: null,
    priceWei: normalizeWei(event.ethWei),
    sharesWei: normalizeWei(event.sharesWei),
    venueKind: "vault",
    venueContract: normalizeAddress(event.vaultAddress || contract),
    confirmed: true,
  };
}

/* ---------------- *
 * Write path       *
 * ---------------- */

/**
 * Postgres caps a statement at 65,535 bound parameters and this project's pool
 * sets statement_timeout=15s, so rows go in bounded batches. 15 columns per
 * row means 300 rows is ~4,500 parameters — comfortably inside both limits.
 */
const INSERT_BATCH_SIZE = 300;
const COLUMN_COUNT = 15;

/**
 * Append rows to the ledger, skipping any (tx_hash, log_index) already stored.
 *
 * Returns the number of rows that were genuinely NEW. Re-running the exact
 * same range therefore returns 0 and changes nothing, which is the property the
 * cron depends on to be safely re-runnable.
 */
export async function appendChainEvents(rows: ChainEventRow[]): Promise<number> {
  if (!hasChainEventStore() || rows.length === 0) return 0;

  // Deduplicate within the batch too. ON CONFLICT DO NOTHING cannot resolve two
  // conflicting rows inside ONE statement — Postgres raises "ON CONFLICT DO
  // UPDATE command cannot affect row a second time"-class errors for that — and
  // a single tx can legitimately surface the same log twice when two sources
  // overlap.
  const byKey = new Map<string, ChainEventRow>();
  for (const row of rows) {
    if (!row.txHash || !Number.isInteger(row.logIndex)) continue;
    byKey.set(`${row.txHash}:${row.logIndex}`, row);
  }
  const unique = [...byKey.values()];

  let inserted = 0;
  for (let start = 0; start < unique.length; start += INSERT_BATCH_SIZE) {
    const batch = unique.slice(start, start + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const tuples = batch.map((row, index) => {
      const base = index * COLUMN_COUNT;
      values.push(
        row.txHash,
        row.logIndex,
        row.blockNumber,
        row.blockTimestamp,
        row.source,
        row.contract,
        row.kind,
        row.tokenId,
        row.fromAddress,
        row.toAddress,
        row.priceWei,
        row.sharesWei,
        row.venueKind,
        row.venueContract,
        row.confirmed
      );
      const p = (offset: number) => `$${base + offset}`;
      return (
        `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ` +
        `${p(9)}, ${p(10)}, ${p(11)}::numeric, ${p(12)}::numeric, ${p(13)}, ${p(14)}, ${p(15)})`
      );
    });

    const result = await postgresQuery(
      `INSERT INTO plank_chain_events
         (tx_hash, log_index, block_number, block_timestamp, source, contract,
          kind, token_id, from_address, to_address, price_wei, shares_wei,
          venue_kind, venue_contract, confirmed)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      values
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/* ---------------- *
 * Cursor           *
 * ---------------- */

export type ChainIndexCursor = {
  sourceKey: string;
  source: ChainEventSource;
  contract: string;
  lastIndexedBlock: number;
  headBlock: number | null;
};

/** Stable primary key for a cursor row. */
export function cursorKey(source: ChainEventSource, contract: string): string {
  return `${source}:${contract.toLowerCase()}`;
}

export async function readChainCursor(
  source: ChainEventSource,
  contract: string
): Promise<ChainIndexCursor | null> {
  if (!hasChainEventStore()) return null;
  const result = await postgresQuery<{
    source_key: string;
    source: string;
    contract: string;
    last_indexed_block: string | number;
    head_block: string | number | null;
  }>(
    `SELECT source_key, source, contract, last_indexed_block, head_block
       FROM plank_chain_index_cursor
      WHERE source_key = $1`,
    [cursorKey(source, contract)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sourceKey: row.source_key,
    source: row.source as ChainEventSource,
    contract: row.contract,
    lastIndexedBlock: Number(row.last_indexed_block),
    headBlock: row.head_block == null ? null : Number(row.head_block),
  };
}

/**
 * Advance the cursor. MONOTONIC BY CONSTRUCTION: the `GREATEST` in the conflict
 * clause means a worker holding a stale value can never move it backwards, so a
 * concurrent Passenger process (or an overlapping cron tick) cannot cause the
 * next run to skip blocks nobody ever read.
 */
export async function writeChainCursor(
  source: ChainEventSource,
  contract: string,
  lastIndexedBlock: number,
  headBlock: number | null
): Promise<void> {
  if (!hasChainEventStore()) return;
  if (!Number.isFinite(lastIndexedBlock) || lastIndexedBlock < 0) return;
  await postgresQuery(
    `INSERT INTO plank_chain_index_cursor
       (source_key, source, contract, last_indexed_block, head_block, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (source_key) DO UPDATE
       SET last_indexed_block =
             GREATEST(plank_chain_index_cursor.last_indexed_block, EXCLUDED.last_indexed_block),
           head_block = EXCLUDED.head_block,
           updated_at = NOW()`,
    [cursorKey(source, contract), source, contract.toLowerCase(), lastIndexedBlock, headBlock]
  );
}

export async function readAllChainCursors(): Promise<ChainIndexCursor[]> {
  if (!hasChainEventStore()) return [];
  const result = await postgresQuery<{
    source_key: string;
    source: string;
    contract: string;
    last_indexed_block: string | number;
    head_block: string | number | null;
  }>(
    `SELECT source_key, source, contract, last_indexed_block, head_block
       FROM plank_chain_index_cursor
      ORDER BY source_key`
  );
  return result.rows.map((row) => ({
    sourceKey: row.source_key,
    source: row.source as ChainEventSource,
    contract: row.contract,
    lastIndexedBlock: Number(row.last_indexed_block),
    headBlock: row.head_block == null ? null : Number(row.head_block),
  }));
}

/* ---------------- *
 * Read path        *
 * ---------------- */

export type ChainEventQuery = {
  limit: number;
  offset: number;
  /** Restrict to specific kinds (e.g. ["sale"]). Empty/undefined = all. */
  kinds?: string[];
  source?: ChainEventSource;
  tokenId?: string;
};

export type ChainActivityPage = {
  events: ActivityEvent[];
  total: number;
  limit: number;
  offset: number;
  /** Offset to pass for the next page, or null when this was the last one. */
  nextOffset: number | null;
};

type ActivityRow = {
  tx_hash: string;
  log_index: number;
  block_number: string | number;
  block_timestamp: Date | string | null;
  kind: string;
  token_id: string | null;
  from_address: string | null;
  to_address: string | null;
  price_wei: string | null;
  venue_kind: string | null;
  venue_contract: string | null;
  image_uri: string | null;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ACTIVITY_KINDS = new Set<string>(["mint", "sale", "transfer"]);

function rowToActivityEvent(row: ActivityRow): ActivityEvent {
  let priceWei: string | null = null;
  try {
    if (row.price_wei != null) {
      const wei = BigInt(row.price_wei);
      priceWei = wei > BigInt(0) ? wei.toString() : null;
    }
  } catch {
    priceWei = null;
  }

  const timestamp =
    row.block_timestamp == null
      ? null
      : row.block_timestamp instanceof Date
        ? row.block_timestamp.toISOString()
        : new Date(row.block_timestamp).toISOString();

  return {
    kind: (ACTIVITY_KINDS.has(row.kind) ? row.kind : "transfer") as ActivityKind,
    tokenId: row.token_id ?? "",
    from: row.from_address ?? ZERO_ADDRESS,
    to: row.to_address ?? ZERO_ADDRESS,
    priceWei,
    priceEth: priceWei == null ? null : formatEther(priceWei),
    txHash: row.tx_hash,
    blockNumber: Number(row.block_number),
    timestamp,
    // Resolved from the canonical IPFS metadata store (migration 004) by the
    // join below, so a display read costs no IPFS or RPC round-trip. Null until
    // that store has been built for the token, exactly as before.
    imageUrl: row.image_uri ? resolveIpfsUrl(row.image_uri) : null,
    venue:
      row.venue_kind == null
        ? null
        : {
            kind: row.venue_kind as NonNullable<ActivityEvent["venue"]>["kind"],
            contract: row.venue_contract ?? "",
          },
  };
}

/**
 * Read collection activity from the permanent ledger, newest first.
 *
 * There is deliberately NO fixed maximum history here — that cap was the bug.
 * `limit` bounds one PAGE; `offset` walks the whole ledger, however far back it
 * goes.
 */
export async function readChainActivity(query: ChainEventQuery): Promise<ChainActivityPage> {
  const limit = Math.min(1_000, Math.max(1, Math.floor(query.limit) || 1));
  const offset = Math.max(0, Math.floor(query.offset) || 0);

  if (!hasChainEventStore()) {
    return { events: [], total: 0, limit, offset, nextOffset: null };
  }

  const where: string[] = ["e.source = $1"];
  const params: unknown[] = [query.source ?? "nft"];

  if (query.kinds && query.kinds.length > 0) {
    params.push(query.kinds);
    where.push(`e.kind = ANY($${params.length}::text[])`);
  }
  if (query.tokenId) {
    params.push(query.tokenId);
    where.push(`e.token_id = $${params.length}`);
  }
  const whereSql = where.join(" AND ");

  const countResult = await postgresQuery<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM plank_chain_events e WHERE ${whereSql}`,
    params
  );
  const total = Number(countResult.rows[0]?.total ?? "0");

  params.push(limit, offset);
  const rows = await postgresQuery<ActivityRow>(
    `SELECT e.tx_hash, e.log_index, e.block_number, e.block_timestamp, e.kind,
            e.token_id, e.from_address, e.to_address, e.price_wei,
            e.venue_kind, e.venue_contract, m.image_uri
       FROM plank_chain_events e
       LEFT JOIN robinwood_token_metadata m
              ON m.token_id = CASE
                   WHEN e.token_id ~ '^[0-9]{1,9}$' THEN e.token_id::integer
                 END
      WHERE ${whereSql}
      ORDER BY e.block_number DESC, e.log_index DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const events = rows.rows.map(rowToActivityEvent);
  return {
    events,
    total,
    limit,
    offset,
    nextOffset: offset + events.length < total ? offset + events.length : null,
  };
}

/** Total ledger rows for a source — used to decide whether the ledger is warm. */
export async function countChainEvents(source?: ChainEventSource): Promise<number> {
  if (!hasChainEventStore()) return 0;
  const result = source
    ? await postgresQuery<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM plank_chain_events WHERE source = $1`,
        [source]
      )
    : await postgresQuery<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM plank_chain_events`
      );
  return Number(result.rows[0]?.total ?? "0");
}
